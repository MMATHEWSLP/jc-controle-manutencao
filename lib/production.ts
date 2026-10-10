import { and, asc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../db";
import {
  auditLogs, employees, productFrontPrices, productionProjects, productionReasons, productionStageEvents, productionTeamMembers, productionTeams, products, serviceFronts,
} from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { isUniqueViolation } from "./client-request";
import {
  cleanName, compareProjects, FUNCTION_GROUPS, isIsoDay, isProductionStage, nextStageStatus, parseDecimal, parseFrontIds, scopeFrontIds, stageInfo,
  type FunctionGroup, type StageStatus,
} from "./production-rules";

// ---------------------------------------------------------------------------
// PRODUÇÃO — acesso ao banco (Fase 1: projetos, equipes, preços por frente, motivos e a busca de
// funcionários). Toda função recebe as frentes que a pessoa vê (productionFronts) e confere a frente do
// registro antes de ler ou gravar: o filtro de frentes da tela só restringe, nunca amplia.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class ProductionError extends Error {
  constructor(message: string, public status = 400, public field?: string) { super(message); }
}
export function productionErrorResponse(error: unknown) {
  return error instanceof ProductionError ? Response.json({ error: error.message, field: error.field ?? null }, { status: error.status }) : null;
}

// O que a pessoa pode fazer no módulo. O apontador de campo (CAMPO) só lança, pelas rotas /api/producao/campo.
export type ProductionAccess = { view: boolean; costs: boolean; launch: boolean; manage: boolean; admin: boolean };
export function productionAccess(user: SessionUser): ProductionAccess {
  const has = (permission: string) => user.permissions.includes(permission as never);
  const office = user.profile !== "CAMPO";
  const launch = has("producao.lancar");
  const manage = office && has("producao.gerenciar");
  const costs = office && has("producao.custos");
  return { view: office && (has("producao.ver") || costs || launch || manage), costs, launch, manage, admin: user.profile === "ADMIN" };
}
export function requireAccess(user: SessionUser, need: keyof ProductionAccess, message?: string) {
  if (!productionAccess(user)[need]) throw new ProductionError(message ?? "Você não possui permissão para esta ação.", 403);
}

export type ProductionFront = { id: number; name: string };
// Frentes ativas que a pessoa vê (lib/access.ts:frentesVisiveis), em ordem alfabética.
export async function productionFronts(db: Db, user: SessionUser): Promise<ProductionFront[]> {
  const rows = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name));
  const visible = frentesVisiveis(user);
  return visible === "ALL" ? rows : rows.filter((front) => visible.includes(front.id));
}
// Frentes em exibição numa consulta: as que a pessoa vê ∩ ?frentes= da tela.
export function scopedFrontIds(fronts: ProductionFront[], raw: string | null) {
  return scopeFrontIds(fronts.map((front) => front.id), parseFrontIds(raw));
}
function assertFront(fronts: ProductionFront[], frontId: number) {
  if (!fronts.some((front) => front.id === frontId)) throw new ProductionError("Você não tem acesso a esta frente.", 403, "serviceFrontId");
}

async function audit(db: Db | Tx, userId: number, entityType: string, entityId: number | string, action: string, previousValue?: unknown, newValue?: unknown) {
  await db.insert(auditLogs).values({
    userId, entityType, entityId: String(entityId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

const positiveId = (value: unknown) => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null; };
const optionalText = (value: unknown, max = 300) => { const text = String(value ?? "").trim().replace(/\s+/g, " "); return text ? text.slice(0, max) : null; };
const now = () => new Date().toISOString();
// Dia de hoje no fuso das frentes (mesmo do Combustível e da Movimentação).
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------
const projectColumns = {
  id: productionProjects.id, serviceFrontId: productionProjects.serviceFrontId, frontName: serviceFronts.name, name: productionProjects.name, camp: productionProjects.camp,
  active: productionProjects.active, fellingStatus: productionProjects.fellingStatus, skiddingStatus: productionProjects.skiddingStatus,
  measurementStatus: productionProjects.measurementStatus, haulingStatus: productionProjects.haulingStatus,
  fellingNotes: productionProjects.fellingNotes, skiddingNotes: productionProjects.skiddingNotes, measurementNotes: productionProjects.measurementNotes, haulingNotes: productionProjects.haulingNotes,
  createdAt: productionProjects.createdAt, updatedAt: productionProjects.updatedAt,
};
export type ProjectRow = { id: number; serviceFrontId: number; frontName: string; name: string; camp: string | null; active: boolean;
  fellingStatus: StageStatus; skiddingStatus: StageStatus; measurementStatus: StageStatus; haulingStatus: StageStatus;
  fellingNotes: string | null; skiddingNotes: string | null; measurementNotes: string | null; haulingNotes: string | null; createdAt: string; updatedAt: string };

const statusesOf = (row: ProjectRow): StageStatus[] => [row.fellingStatus, row.skiddingStatus, row.measurementStatus, row.haulingStatus];

export async function listProjects(db: Db, frontIds: number[], filter: { active: boolean | null }): Promise<ProjectRow[]> {
  if (frontIds.length === 0) return [];
  const conditions: SQL[] = [inArray(productionProjects.serviceFrontId, frontIds)];
  if (filter.active !== null) conditions.push(eq(productionProjects.active, filter.active));
  const rows = await db.select(projectColumns).from(productionProjects).innerJoin(serviceFronts, eq(serviceFronts.id, productionProjects.serviceFrontId)).where(and(...conditions));
  return rows.sort((a, b) => compareProjects({ name: a.name, statuses: statusesOf(a) }, { name: b.name, statuses: statusesOf(b) }));
}

async function requireProject(db: Db | Tx, fronts: ProductionFront[], id: number) {
  const row = (await db.select(projectColumns).from(productionProjects).innerJoin(serviceFronts, eq(serviceFronts.id, productionProjects.serviceFrontId)).where(eq(productionProjects.id, id)).limit(1))[0];
  if (!row || !fronts.some((front) => front.id === row.serviceFrontId)) throw new ProductionError("Projeto não encontrado.", 404);
  return row;
}

function readProjectFields(body: Record<string, unknown>) {
  const name = cleanName(body.name);
  if (name.length < 2) throw new ProductionError("Informe o nome do projeto (fazenda/UPA).", 400, "name");
  if (name.length > 120) throw new ProductionError("Nome do projeto muito longo.", 400, "name");
  return { name, camp: optionalText(body.camp, 120)?.toUpperCase() ?? null };
}
const duplicateProject = () => new ProductionError("Já existe um projeto com este nome nesta frente.", 409, "name");

export async function createProject(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const serviceFrontId = positiveId(body.serviceFrontId);
  if (!serviceFrontId) throw new ProductionError("Escolha a frente do projeto.", 400, "serviceFrontId");
  assertFront(fronts, serviceFrontId);
  const fields = readProjectFields(body);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(productionProjects).values({ serviceFrontId, ...fields, createdBy: user.id, updatedBy: user.id }).returning({ id: productionProjects.id });
      await audit(tx, user.id, "PRODUCTION_PROJECT", row.id, "PROJETO CRIADO", undefined, { serviceFrontId, ...fields });
      return row.id;
    });
  } catch (error) { if (isUniqueViolation(error)) throw duplicateProject(); throw error; }
}

// Edita nome e alojamento. A frente não muda depois de criado (projeto errado: inative e crie outro).
export async function updateProject(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const current = await requireProject(db, fronts, id);
  const fields = readProjectFields(body);
  try {
    await db.transaction(async (tx) => {
      await tx.update(productionProjects).set({ ...fields, updatedBy: user.id, updatedAt: now() }).where(eq(productionProjects.id, id));
      await audit(tx, user.id, "PRODUCTION_PROJECT", id, "PROJETO EDITADO", { name: current.name, camp: current.camp }, fields);
    });
  } catch (error) { if (isUniqueViolation(error)) throw duplicateProject(); throw error; }
}

export async function setProjectActive(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, active: boolean) {
  requireAccess(user, "manage");
  const current = await requireProject(db, fronts, id);
  if (current.active === active) return;
  await db.transaction(async (tx) => {
    await tx.update(productionProjects).set({ active, updatedBy: user.id, updatedAt: now() }).where(eq(productionProjects.id, id));
    await audit(tx, user.id, "PRODUCTION_PROJECT", id, active ? "PROJETO REATIVADO" : "PROJETO INATIVADO");
  });
}

// Observação do card do projeto em cada aba. Quem lança ou gerencia pode escrever.
export async function setStageNotes(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, stage: unknown, notes: unknown) {
  const access = productionAccess(user);
  if (!access.manage && !access.launch) throw new ProductionError("Você não possui permissão para esta ação.", 403);
  if (!isProductionStage(stage)) throw new ProductionError("Etapa inválida.");
  const current = await requireProject(db, fronts, id);
  const column = stageInfo(stage).notes;
  const value = optionalText(notes, 1000);
  await db.transaction(async (tx) => {
    await tx.update(productionProjects).set({ [column]: value, updatedBy: user.id, updatedAt: now() }).where(eq(productionProjects.id, id));
    await audit(tx, user.id, "PRODUCTION_PROJECT", id, `OBSERVAÇÃO ${stage}`, current[column], value);
  });
}

// Finalizar/reabrir uma etapa: grava quem e quando (production_stage_events + audit_logs).
export async function changeStage(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, stage: unknown, action: unknown, note?: unknown) {
  requireAccess(user, "manage");
  if (!isProductionStage(stage)) throw new ProductionError("Etapa inválida.");
  if (action !== "FINALIZAR" && action !== "REABRIR") throw new ProductionError("Ação inválida.");
  const current = await requireProject(db, fronts, id);
  const column = stageInfo(stage).status;
  const next = nextStageStatus(current[column], action);
  if ("error" in next) throw new ProductionError(next.error, 409);
  await db.transaction(async (tx) => {
    await tx.update(productionProjects).set({ [column]: next.status, updatedBy: user.id, updatedAt: now() }).where(eq(productionProjects.id, id));
    await tx.insert(productionStageEvents).values({ projectId: id, stage, action: action === "FINALIZAR" ? "FINALIZOU" : "REABRIU", note: optionalText(note, 300), userId: user.id });
    await audit(tx, user.id, "PRODUCTION_PROJECT", id, `${action === "FINALIZAR" ? "FINALIZOU" : "REABRIU"} ${stage}`, current[column], next.status);
  });
  return next.status;
}

// Última finalização/reabertura de cada etapa (quem e quando), para os cards.
export async function lastStageEvents(db: Db, projectIds: number[]) {
  if (projectIds.length === 0) return new Map<string, { action: string; userName: string | null; occurredAt: string }>();
  const result = await db.execute(sql`SELECT DISTINCT ON (e.project_id, e.stage) e.project_id, e.stage, e.action, e.occurred_at, u.name AS user_name
    FROM production_stage_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE e.project_id IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY e.project_id, e.stage, e.occurred_at DESC, e.id DESC`);
  const map = new Map<string, { action: string; userName: string | null; occurredAt: string }>();
  for (const row of (result as unknown as { rows: Array<Record<string, unknown>> }).rows)
    map.set(`${row.project_id}:${row.stage}`, { action: String(row.action), userName: row.user_name === null ? null : String(row.user_name), occurredAt: String(row.occurred_at) });
  return map;
}

// ---------------------------------------------------------------------------
// Equipes
// ---------------------------------------------------------------------------
export async function listTeams(db: Db, frontIds: number[], filter: { active: boolean | null }) {
  if (frontIds.length === 0) return [];
  const conditions: SQL[] = [inArray(productionTeams.serviceFrontId, frontIds)];
  if (filter.active !== null) conditions.push(eq(productionTeams.active, filter.active));
  const rows = await db.select({
    id: productionTeams.id, serviceFrontId: productionTeams.serviceFrontId, frontName: serviceFronts.name, name: productionTeams.name, active: productionTeams.active,
    leaderEmployeeId: productionTeams.leaderEmployeeId, leaderName: employees.name, leaderJobTitle: employees.jobTitle,
    activeMembers: sql<number>`(SELECT count(*)::int FROM production_team_members m WHERE m.team_id = ${productionTeams.id} AND m.left_at IS NULL)`,
  }).from(productionTeams).innerJoin(serviceFronts, eq(serviceFronts.id, productionTeams.serviceFrontId)).leftJoin(employees, eq(employees.id, productionTeams.leaderEmployeeId))
    .where(and(...conditions)).orderBy(asc(productionTeams.name));
  return rows.map((row) => ({ ...row, activeMembers: Number(row.activeMembers) }));
}

async function requireTeam(db: Db | Tx, fronts: ProductionFront[], id: number) {
  const row = (await db.select().from(productionTeams).where(eq(productionTeams.id, id)).limit(1))[0];
  if (!row || !fronts.some((front) => front.id === row.serviceFrontId)) throw new ProductionError("Equipe não encontrada.", 404);
  return row;
}
async function requireEmployee(db: Db | Tx, id: number, field: string, allowDismissed = false) {
  const row = (await db.select({ id: employees.id, name: employees.name, status: employees.status }).from(employees).where(eq(employees.id, id)).limit(1))[0];
  if (!row) throw new ProductionError("Funcionário não encontrado.", 404, field);
  if (!allowDismissed && row.status === "DEMITIDO") throw new ProductionError(`${row.name} está desligado.`, 400, field);
  return row;
}
const duplicateTeam = () => new ProductionError("Já existe uma equipe com este nome nesta frente.", 409, "name");

function readTeamFields(body: Record<string, unknown>) {
  const name = cleanName(body.name);
  if (name.length < 2) throw new ProductionError("Informe o nome da equipe.", 400, "name");
  if (name.length > 80) throw new ProductionError("Nome da equipe muito longo.", 400, "name");
  return { name, leaderEmployeeId: positiveId(body.leaderEmployeeId) };
}

export async function createTeam(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const serviceFrontId = positiveId(body.serviceFrontId);
  if (!serviceFrontId) throw new ProductionError("Escolha a frente da equipe.", 400, "serviceFrontId");
  assertFront(fronts, serviceFrontId);
  const fields = readTeamFields(body);
  if (fields.leaderEmployeeId) await requireEmployee(db, fields.leaderEmployeeId, "leaderEmployeeId");
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(productionTeams).values({ serviceFrontId, ...fields, createdBy: user.id, updatedBy: user.id }).returning({ id: productionTeams.id });
      // O responsável já entra como integrante.
      if (fields.leaderEmployeeId) await tx.insert(productionTeamMembers).values({ teamId: row.id, employeeId: fields.leaderEmployeeId, joinedAt: isIsoDay(body.joinedAt) ? body.joinedAt : localToday(), createdBy: user.id });
      await audit(tx, user.id, "PRODUCTION_TEAM", row.id, "EQUIPE CRIADA", undefined, { serviceFrontId, ...fields });
      return row.id;
    });
  } catch (error) { if (isUniqueViolation(error)) throw duplicateTeam(); throw error; }
}

export async function updateTeam(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const current = await requireTeam(db, fronts, id);
  const fields = readTeamFields(body);
  if (fields.leaderEmployeeId && fields.leaderEmployeeId !== current.leaderEmployeeId) await requireEmployee(db, fields.leaderEmployeeId, "leaderEmployeeId");
  try {
    await db.transaction(async (tx) => {
      await tx.update(productionTeams).set({ ...fields, updatedBy: user.id, updatedAt: now() }).where(eq(productionTeams.id, id));
      await audit(tx, user.id, "PRODUCTION_TEAM", id, "EQUIPE EDITADA", { name: current.name, leaderEmployeeId: current.leaderEmployeeId }, fields);
    });
  } catch (error) { if (isUniqueViolation(error)) throw duplicateTeam(); throw error; }
}

export async function setTeamActive(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, active: boolean) {
  requireAccess(user, "manage");
  const current = await requireTeam(db, fronts, id);
  if (current.active === active) return;
  await db.transaction(async (tx) => {
    await tx.update(productionTeams).set({ active, updatedBy: user.id, updatedAt: now() }).where(eq(productionTeams.id, id));
    await audit(tx, user.id, "PRODUCTION_TEAM", id, active ? "EQUIPE REATIVADA" : "EQUIPE INATIVADA");
  });
}

export async function listTeamMembers(db: Db, fronts: ProductionFront[], teamId: number) {
  await requireTeam(db, fronts, teamId);
  return db.select({
    id: productionTeamMembers.id, employeeId: productionTeamMembers.employeeId, name: employees.name, jobTitle: employees.jobTitle, company: employees.company,
    employeeStatus: employees.status, joinedAt: productionTeamMembers.joinedAt, leftAt: productionTeamMembers.leftAt,
  }).from(productionTeamMembers).innerJoin(employees, eq(employees.id, productionTeamMembers.employeeId)).where(eq(productionTeamMembers.teamId, teamId))
    .orderBy(sql`${productionTeamMembers.leftAt} IS NOT NULL`, asc(employees.name));
}

export async function addTeamMember(db: Db, user: SessionUser, fronts: ProductionFront[], teamId: number, body: Record<string, unknown>) {
  requireAccess(user, "manage");
  await requireTeam(db, fronts, teamId);
  const employeeId = positiveId(body.employeeId);
  if (!employeeId) throw new ProductionError("Escolha o funcionário.", 400, "employeeId");
  const joinedAt = String(body.joinedAt ?? "");
  if (!isIsoDay(joinedAt)) throw new ProductionError("Informe a data de entrada.", 400, "joinedAt");
  const person = await requireEmployee(db, employeeId, "employeeId");
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.insert(productionTeamMembers).values({ teamId, employeeId, joinedAt, createdBy: user.id }).returning({ id: productionTeamMembers.id });
      await audit(tx, user.id, "PRODUCTION_TEAM", teamId, "INTEGRANTE INCLUÍDO", undefined, { memberId: row.id, employeeId, name: person.name, joinedAt });
    });
  } catch (error) { if (isUniqueViolation(error)) throw new ProductionError(`${person.name} já está nesta equipe.`, 409, "employeeId"); throw error; }
}

async function requireMember(db: Db, fronts: ProductionFront[], teamId: number, memberId: number) {
  await requireTeam(db, fronts, teamId);
  const row = (await db.select().from(productionTeamMembers).where(and(eq(productionTeamMembers.id, memberId), eq(productionTeamMembers.teamId, teamId))).limit(1))[0];
  if (!row) throw new ProductionError("Integrante não encontrado.", 404);
  return row;
}

// Datas de entrada/saída (saída vazia = volta a ser integrante ativo).
export async function updateTeamMember(db: Db, user: SessionUser, fronts: ProductionFront[], teamId: number, memberId: number, body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const current = await requireMember(db, fronts, teamId, memberId);
  const joinedAt = String(body.joinedAt ?? current.joinedAt);
  const leftAt = body.leftAt === null || body.leftAt === "" ? null : String(body.leftAt ?? current.leftAt ?? "") || null;
  if (!isIsoDay(joinedAt)) throw new ProductionError("Informe a data de entrada.", 400, "joinedAt");
  if (leftAt !== null && !isIsoDay(leftAt)) throw new ProductionError("Data de saída inválida.", 400, "leftAt");
  if (leftAt !== null && leftAt < joinedAt) throw new ProductionError("A saída não pode ser antes da entrada.", 400, "leftAt");
  try {
    await db.transaction(async (tx) => {
      await tx.update(productionTeamMembers).set({ joinedAt, leftAt, updatedAt: now() }).where(eq(productionTeamMembers.id, memberId));
      await audit(tx, user.id, "PRODUCTION_TEAM", teamId, "INTEGRANTE ALTERADO", { memberId, joinedAt: current.joinedAt, leftAt: current.leftAt }, { memberId, joinedAt, leftAt });
    });
  } catch (error) { if (isUniqueViolation(error)) throw new ProductionError("Este funcionário já está ativo nesta equipe.", 409, "leftAt"); throw error; }
}

// Excluir só serve para corrigir um integrante incluído por engano; quem saiu da equipe ganha data de saída.
export async function removeTeamMember(db: Db, user: SessionUser, fronts: ProductionFront[], teamId: number, memberId: number) {
  requireAccess(user, "manage");
  const current = await requireMember(db, fronts, teamId, memberId);
  await db.transaction(async (tx) => {
    await tx.delete(productionTeamMembers).where(eq(productionTeamMembers.id, memberId));
    await audit(tx, user.id, "PRODUCTION_TEAM", teamId, "INTEGRANTE EXCLUÍDO", current);
  });
}

// ---------------------------------------------------------------------------
// Produtos da Produção e preço por frente
// ---------------------------------------------------------------------------
export async function listProductionProducts(db: Db, frontIds: number[]) {
  const rows = await db.select({ id: products.id, tag: products.tag, name: products.name, price: products.price, active: products.active })
    .from(products).where(eq(products.productionUse, true)).orderBy(asc(products.name));
  const prices = rows.length && frontIds.length ? await db.select({ productId: productFrontPrices.productId, serviceFrontId: productFrontPrices.serviceFrontId, price: productFrontPrices.price })
    .from(productFrontPrices).where(and(inArray(productFrontPrices.productId, rows.map((row) => row.id)), inArray(productFrontPrices.serviceFrontId, frontIds))) : [];
  return rows.map((row) => ({
    ...row, price: Number(row.price),
    frontPrices: Object.fromEntries(prices.filter((item) => item.productId === row.id).map((item) => [item.serviceFrontId, Number(item.price)])) as Record<number, number>,
  }));
}

// Busca no cadastro de Produtos (TAG ou nome) para marcar "Usar na Produção".
export async function searchProductsToMark(db: Db, query: string) {
  const term = query.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  return db.select({ id: products.id, tag: products.tag, name: products.name, price: products.price })
    .from(products).where(and(eq(products.active, true), eq(products.productionUse, false), or(ilike(products.tag, like), ilike(products.name, like))))
    .orderBy(asc(products.name)).limit(25);
}

export async function setProductionUse(db: Db, user: SessionUser, productId: number, value: boolean) {
  requireAccess(user, "manage");
  requireAccess(user, "costs", "Para mexer nos preços da Produção é preciso ver os custos da Produção.");
  const product = (await db.select({ id: products.id, productionUse: products.productionUse }).from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!product) throw new ProductionError("Produto não encontrado.", 404);
  if (product.productionUse === value) return;
  await db.transaction(async (tx) => {
    await tx.update(products).set({ productionUse: value, updatedAt: now() }).where(eq(products.id, productId));
    await audit(tx, user.id, "PRODUCT", productId, value ? "MARCADO PARA USO NA PRODUÇÃO" : "DESMARCADO DO USO NA PRODUÇÃO");
  });
}

// Preço do produto numa frente. Vazio apaga o preço da frente (volta a valer o preço do produto).
export async function setFrontPrice(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>) {
  requireAccess(user, "manage");
  requireAccess(user, "costs", "Para mexer nos preços da Produção é preciso ver os custos da Produção.");
  const productId = positiveId(body.productId);
  const serviceFrontId = positiveId(body.serviceFrontId);
  if (!productId || !serviceFrontId) throw new ProductionError("Produto ou frente inválidos.");
  assertFront(fronts, serviceFrontId);
  const product = (await db.select({ id: products.id, productionUse: products.productionUse }).from(products).where(eq(products.id, productId)).limit(1))[0];
  if (!product?.productionUse) throw new ProductionError("Marque o produto para uso na Produção antes de definir o preço.", 400);
  const empty = body.price === null || body.price === undefined || String(body.price).trim() === "";
  const price = empty ? null : parseDecimal(body.price);
  if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1_000_000)) throw new ProductionError("Informe um preço válido (zero ou mais).", 400, "price");
  const previous = (await db.select({ price: productFrontPrices.price }).from(productFrontPrices)
    .where(and(eq(productFrontPrices.productId, productId), eq(productFrontPrices.serviceFrontId, serviceFrontId))).limit(1))[0]?.price ?? null;
  await db.transaction(async (tx) => {
    if (price === null) await tx.delete(productFrontPrices).where(and(eq(productFrontPrices.productId, productId), eq(productFrontPrices.serviceFrontId, serviceFrontId)));
    else {
      const value = Math.round(price * 100) / 100;
      await tx.insert(productFrontPrices).values({ productId, serviceFrontId, price: value, updatedBy: user.id })
        .onConflictDoUpdate({ target: [productFrontPrices.productId, productFrontPrices.serviceFrontId], set: { price: value, updatedBy: user.id, updatedAt: now() } });
    }
    await audit(tx, user.id, "PRODUCT", productId, "PREÇO DA PRODUÇÃO NA FRENTE", { serviceFrontId, price: previous }, { serviceFrontId, price });
  });
}

// ---------------------------------------------------------------------------
// Motivos de produção baixa/zero (lista editável só pelo ADMIN)
// ---------------------------------------------------------------------------
export async function listReasons(db: Db, includeInactive: boolean) {
  return db.select({ id: productionReasons.id, code: productionReasons.code, description: productionReasons.description, active: productionReasons.active })
    .from(productionReasons).where(includeInactive ? undefined : eq(productionReasons.active, true)).orderBy(asc(productionReasons.code));
}

function readReason(body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const description = cleanName(body.description);
  if (!code || code.length > 12) throw new ProductionError("Informe o código do motivo (ex.: C.09).", 400, "code");
  if (description.length < 3) throw new ProductionError("Descreva o motivo.", 400, "description");
  return { code, description: description.slice(0, 120) };
}

export async function saveReason(db: Db, user: SessionUser, id: number | null, body: Record<string, unknown>) {
  if (user.profile !== "ADMIN") throw new ProductionError("Só o administrador edita a lista de motivos.", 403);
  const fields = readReason(body);
  const active = body.active === undefined ? true : body.active !== false;
  try {
    await db.transaction(async (tx) => {
      if (id === null) {
        const [row] = await tx.insert(productionReasons).values({ ...fields, active }).returning({ id: productionReasons.id });
        await audit(tx, user.id, "PRODUCTION_REASON", row.id, "MOTIVO CRIADO", undefined, fields);
        return;
      }
      const current = (await tx.select().from(productionReasons).where(eq(productionReasons.id, id)).limit(1))[0];
      if (!current) throw new ProductionError("Motivo não encontrado.", 404);
      await tx.update(productionReasons).set({ ...fields, active, updatedAt: now() }).where(eq(productionReasons.id, id));
      await audit(tx, user.id, "PRODUCTION_REASON", id, "MOTIVO EDITADO", { code: current.code, description: current.description, active: current.active }, { ...fields, active });
    });
  } catch (error) { if (isUniqueViolation(error)) throw new ProductionError("Já existe um motivo com este código.", 409, "code"); throw error; }
}

// ---------------------------------------------------------------------------
// Busca de funcionários (autocompletes da Produção): nome, função, empresa e frente; sem desligados.
// group filtra pela função (OP. DE MOTOSSERRA, AJUDANTE, SKIDDER, MOTORISTA); all = "mostrar todos".
// ---------------------------------------------------------------------------
const FROM_ACCENTS = "áàâãäéèêëíìîïóòôõöúùûüç";
const TO_ACCENTS = "aaaaaeeeeiiiiooooouuuuc";
const foldAccents = (value: string) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export async function lookupProductionEmployees(db: Db, options: { q: string; frontId: number | null; group: FunctionGroup | null; all: boolean }) {
  const term = options.q.trim();
  const conditions: SQL[] = [ne(employees.status, "DEMITIDO")];
  if (term) conditions.push(sql`translate(lower(${employees.name}), ${FROM_ACCENTS}, ${TO_ACCENTS}) LIKE ${`%${foldAccents(term)}%`}`);
  else if (options.frontId) conditions.push(eq(employees.serviceFrontId, options.frontId));
  if (options.group && !options.all) conditions.push(sql`upper(${employees.jobTitle}) ~ ${FUNCTION_GROUPS[options.group].pattern}`);
  const rows = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name })
    .from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)).where(and(...conditions)).orderBy(asc(employees.name)).limit(120);
  return rows.map((row) => ({ ...row, inFront: options.frontId !== null && row.serviceFrontId === options.frontId }))
    .sort((a, b) => Number(b.inFront) - Number(a.inFront) || a.name.localeCompare(b.name, "pt-BR")).slice(0, 40);
}
