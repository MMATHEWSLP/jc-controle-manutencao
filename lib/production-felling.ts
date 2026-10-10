import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { getDb } from "../db";
import { auditLogs, employees, fuelMovements, fuelTypes, productionFelling, productionProjects, productionReasons, productionTargets, serviceFronts } from "../db/schema";
import type { SessionUser } from "./auth";
import { inIds } from "./daily-reports";
import { fuelAverageCostsOn, type FuelCostQuery } from "./fuel-rules";
import { loadFuelValuations } from "./fuel-valuations";
import { listProjects, ProductionError, productionAccess, requireAccess, type ProductionFront } from "./production";
import {
  acceptsLaunch, fuelValue, isIsoDay, multiFrontSummary, operatorTotals, perDay, reasonLabel, roundTo, statusAfterLaunch, targetResult, TARGET_RESULT_LABELS,
  validateFellingDay, type FellingLineInput, type FellingRecord, type LineError,
} from "./production-rules";

// ---------------------------------------------------------------------------
// PRODUÇÃO → DERRUBA (banco): lançamento do dia em lote, cards dos projetos, acumulado, histórico,
// metas, valor da gasolina (decisão D2: litros × custo médio do estoque da frente, sem saída de
// combustível), análises e produção multi-frente. Toda consulta recebe as frentes em exibição.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Row = Record<string, unknown>;
const rows = async (db: Db, query: SQL) => ((await db.execute(query)) as unknown as { rows: Row[] }).rows;
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const now = () => new Date().toISOString();
export const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export class FellingDayError extends ProductionError {
  constructor(public lineErrors: LineError[]) { super("Corrija as linhas marcadas antes de salvar.", 400); }
}
export function fellingErrorResponse(error: unknown) {
  return error instanceof FellingDayError ? Response.json({ error: error.message, lineErrors: error.lineErrors }, { status: 400 }) : null;
}

export type Period = { from: string; to: string; projectId: number | null };
export function parsePeriod(params: URLSearchParams): Period {
  const today = localToday();
  const from = isIsoDay(params.get("de")) ? params.get("de")! : `${today.slice(0, 7)}-01`;
  const to = isIsoDay(params.get("ate")) ? params.get("ate")! : today;
  return { from: from <= to ? from : to, to: from <= to ? to : from, projectId: Number(params.get("projeto")) || null };
}

// ---------------------------------------------------------------------------
// Metas (árvores por operador por dia, por frente e etapa)
// ---------------------------------------------------------------------------
export async function listTargets(db: Db, frontIds: number[], stage: "DERRUBA" | "ARRASTE") {
  if (frontIds.length === 0) return new Map<number, number>();
  const result = await db.select({ frontId: productionTargets.serviceFrontId, value: productionTargets.treesPerOperatorDay }).from(productionTargets)
    .where(and(inArray(productionTargets.serviceFrontId, frontIds), eq(productionTargets.stage, stage)));
  return new Map(result.map((row) => [row.frontId, row.value]));
}

export async function setTarget(db: Db, user: SessionUser, fronts: ProductionFront[], body: Record<string, unknown>) {
  requireAccess(user, "manage");
  const frontId = Number(body.serviceFrontId);
  if (!fronts.some((front) => front.id === frontId)) throw new ProductionError("Você não tem acesso a esta frente.", 403);
  const stage = body.stage === "ARRASTE" ? "ARRASTE" : "DERRUBA";
  const empty = body.value === null || body.value === undefined || String(body.value).trim() === "";
  const value = empty ? null : Number(String(body.value).trim());
  if (value !== null && (!Number.isInteger(value) || value <= 0 || value > 2000)) throw new ProductionError("A meta é um número inteiro de árvores por operador por dia.", 400, "value");
  await db.transaction(async (tx) => {
    if (value === null) await tx.delete(productionTargets).where(and(eq(productionTargets.serviceFrontId, frontId), eq(productionTargets.stage, stage)));
    else await tx.insert(productionTargets).values({ serviceFrontId: frontId, stage, treesPerOperatorDay: value, updatedBy: user.id })
      .onConflictDoUpdate({ target: [productionTargets.serviceFrontId, productionTargets.stage], set: { treesPerOperatorDay: value, updatedBy: user.id, updatedAt: now() } });
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_TARGET", entityId: `${frontId}:${stage}`, action: "META ALTERADA", newValue: JSON.stringify({ value }) });
  });
}

// ---------------------------------------------------------------------------
// Valor da gasolina (decisão D2): custo médio da gasolina no estoque da frente (Frente; sem valor lá, o do
// Porto) no fim do dia do lançamento. Mesma conta do Combustível (lib/fuel-rules.ts).
// ---------------------------------------------------------------------------
export async function gasolineUnitCosts(db: Db, keys: Array<{ frontId: number; date: string }>) {
  const result = new Map<string, number | null>();
  const unique = [...new Map(keys.map((key) => [`${key.frontId}:${key.date}`, key])).values()];
  if (unique.length === 0) return result;
  const gasoline = (await db.select({ id: fuelTypes.id }).from(fuelTypes).where(sql`${fuelTypes.code} ILIKE 'GASOLINA%'`).orderBy(asc(fuelTypes.sortOrder)).limit(1))[0];
  if (!gasoline) { for (const key of unique) result.set(`${key.frontId}:${key.date}`, null); return result; }
  const movements = await db.select({
    id: fuelMovements.id, serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType,
    movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity, unitPrice: fuelMovements.unitPrice,
  }).from(fuelMovements).where(and(sql`${fuelMovements.deletedAt} IS NULL`, eq(fuelMovements.fuelTypeId, gasoline.id)));
  const valuations = (await loadFuelValuations(db)).filter((valuation) => valuation.fuelTypeId === gasoline.id);
  const queries: FuelCostQuery[] = unique.flatMap((key) => (["FRENTE", "PORTO"] as const).map((location) => ({ key: `${key.frontId}:${key.date}:${location}`, frontId: key.frontId, location, fuelTypeId: gasoline.id, date: key.date })));
  const averages = fuelAverageCostsOn(movements, valuations, queries);
  for (const key of unique) result.set(`${key.frontId}:${key.date}`, averages.get(`${key.frontId}:${key.date}:FRENTE`) ?? averages.get(`${key.frontId}:${key.date}:PORTO`) ?? null);
  return result;
}

// ---------------------------------------------------------------------------
// Projetos com a derruba aberta para lançamento (ativos e não finalizados) e os cards da aba.
// ---------------------------------------------------------------------------
export async function fellingLaunchProjects(db: Db, frontIds: number[]) {
  return (await listProjects(db, frontIds, { active: true })).filter((project) => acceptsLaunch(project.fellingStatus));
}

export async function fellingProjectCards(db: Db, frontIds: number[]) {
  const projects = await listProjects(db, frontIds, { active: true });
  if (projects.length === 0) return [];
  const totals = await rows(db, sql`SELECT f.project_id, sum(f.trees)::int AS trees, sum(f.ipes)::int AS ipes, count(DISTINCT f.felling_date)::int AS days,
      count(DISTINCT f.operator_employee_id)::int AS operators, max(f.updated_at) AS last_update, max(f.felling_date) AS last_day
    FROM production_felling f WHERE ${inIds(sql`f.project_id`, projects.map((project) => project.id))} GROUP BY f.project_id`);
  const byProject = new Map(totals.map((row) => [num(row.project_id), row]));
  return projects.map((project) => {
    const row = byProject.get(project.id);
    const trees = num(row?.trees); const days = num(row?.days);
    return {
      id: project.id, name: project.name, frontName: project.frontName, serviceFrontId: project.serviceFrontId, status: project.fellingStatus, notes: project.fellingNotes,
      trees, ipes: num(row?.ipes), days, operators: num(row?.operators), perDay: perDay(trees, days), lastUpdate: text(row?.last_update), lastDay: text(row?.last_day),
    };
  });
}

// ---------------------------------------------------------------------------
// Dia do projeto: o que já foi lançado (para editar) ou, sem lançamento, os operadores/ajudantes do
// último dia lançado no projeto (sugestão, com os números em branco).
// ---------------------------------------------------------------------------
async function requireLaunchProject(db: Db, fronts: ProductionFront[], projectId: number) {
  const project = (await db.select({ id: productionProjects.id, name: productionProjects.name, serviceFrontId: productionProjects.serviceFrontId, active: productionProjects.active, fellingStatus: productionProjects.fellingStatus })
    .from(productionProjects).where(eq(productionProjects.id, projectId)).limit(1))[0];
  if (!project || !fronts.some((front) => front.id === project.serviceFrontId)) throw new ProductionError("Projeto não encontrado.", 404, "projectId");
  return project;
}

const dayLineColumns = {
  id: productionFelling.id, operatorEmployeeId: productionFelling.operatorEmployeeId, helperEmployeeId: productionFelling.helperEmployeeId,
  trees: productionFelling.trees, ipes: productionFelling.ipes, gasolineLiters: productionFelling.gasolineLiters, reasonId: productionFelling.reasonId, justification: productionFelling.justification,
};

async function employeeCards(db: Db, ids: number[]) {
  if (ids.length === 0) return new Map<number, { id: number; name: string; jobTitle: string; company: string; frontName: string; status: string }>();
  const result = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, frontName: serviceFronts.name, status: employees.status })
    .from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)).where(inArray(employees.id, [...new Set(ids)]));
  return new Map(result.map((row) => [row.id, row]));
}

export async function loadFellingDay(db: Db, fronts: ProductionFront[], projectId: number, date: string) {
  if (!isIsoDay(date)) throw new ProductionError("Data inválida.", 400, "date");
  const project = await requireLaunchProject(db, fronts, projectId);
  let lines = await db.select(dayLineColumns).from(productionFelling).where(and(eq(productionFelling.projectId, projectId), eq(productionFelling.fellingDate, date))).orderBy(asc(productionFelling.id));
  let suggestedFrom: string | null = null;
  if (lines.length === 0) {
    const last = (await db.select({ day: sql<string>`max(${productionFelling.fellingDate})` }).from(productionFelling)
      .where(and(eq(productionFelling.projectId, projectId), sql`${productionFelling.fellingDate} < ${date}`)))[0]?.day ?? null;
    if (last) {
      suggestedFrom = last;
      lines = (await db.select(dayLineColumns).from(productionFelling).where(and(eq(productionFelling.projectId, projectId), eq(productionFelling.fellingDate, last))).orderBy(asc(productionFelling.id)))
        .map((line) => ({ ...line, id: 0, trees: null as unknown as number, ipes: null as unknown as number, gasolineLiters: null as unknown as number, reasonId: null, justification: null }));
    }
  }
  const people = await employeeCards(db, lines.flatMap((line) => [line.operatorEmployeeId, line.helperEmployeeId ?? 0]).filter(Boolean));
  // Sugestão não traz quem foi desligado depois.
  const visible = suggestedFrom ? lines.filter((line) => people.get(line.operatorEmployeeId)?.status !== "DEMITIDO") : lines;
  return {
    project: { id: project.id, name: project.name, serviceFrontId: project.serviceFrontId, status: project.fellingStatus, active: project.active },
    saved: suggestedFrom === null && lines.length > 0, suggestedFrom,
    lines: visible.map((line) => ({
      ...line, operator: people.get(line.operatorEmployeeId) ?? null,
      helper: line.helperEmployeeId && !(suggestedFrom && people.get(line.helperEmployeeId)?.status === "DEMITIDO") ? people.get(line.helperEmployeeId) ?? null : null,
      helperEmployeeId: line.helperEmployeeId && !(suggestedFrom && people.get(line.helperEmployeeId)?.status === "DEMITIDO") ? line.helperEmployeeId : null,
    })),
  };
}

// Grava o dia inteiro do projeto numa transação: atualiza quem já tinha linha, inclui os novos e tira do
// dia quem saiu da grade. Desligado só fica se já estava lançado neste dia.
export async function saveFellingDay(db: Db, user: SessionUser, fronts: ProductionFront[], body: { projectId?: unknown; date?: unknown; lines?: unknown }) {
  requireAccess(user, "launch");
  const projectId = Number(body.projectId);
  const date = String(body.date ?? "");
  if (!isIsoDay(date)) throw new ProductionError("Informe a data.", 400, "date");
  if (date > localToday()) throw new ProductionError("A data não pode ser futura.", 400, "date");
  const project = await requireLaunchProject(db, fronts, projectId);
  if (!project.active) throw new ProductionError("Projeto inativo: reative antes de lançar.", 409);
  if (!acceptsLaunch(project.fellingStatus)) throw new ProductionError("A derruba deste projeto está finalizada. Reabra a etapa para lançar.", 409);
  const { lines, errors } = validateFellingDay(Array.isArray(body.lines) ? body.lines as FellingLineInput[] : []);
  if (errors.length) throw new FellingDayError(errors);
  if (lines.length === 0) throw new ProductionError("Lance pelo menos um operador (ou tire todos e use Excluir no histórico).", 400);
  const existing = await db.select({ id: productionFelling.id, operatorEmployeeId: productionFelling.operatorEmployeeId, helperEmployeeId: productionFelling.helperEmployeeId, trees: productionFelling.trees, ipes: productionFelling.ipes, gasolineLiters: productionFelling.gasolineLiters })
    .from(productionFelling).where(and(eq(productionFelling.projectId, projectId), eq(productionFelling.fellingDate, date)));
  const already = new Set(existing.flatMap((line) => [line.operatorEmployeeId, line.helperEmployeeId ?? 0]));
  const people = await employeeCards(db, lines.flatMap((line) => [line.operatorEmployeeId, line.helperEmployeeId ?? 0]).filter(Boolean));
  const lineErrors: LineError[] = [];
  lines.forEach((line, index) => {
    for (const [field, id] of [["operatorEmployeeId", line.operatorEmployeeId], ["helperEmployeeId", line.helperEmployeeId]] as const) {
      if (!id) continue;
      const person = people.get(id);
      if (!person) lineErrors.push({ line: index + 1, field, message: "Funcionário não encontrado." });
      else if (person.status === "DEMITIDO" && !already.has(id)) lineErrors.push({ line: index + 1, field, message: `${person.name} está desligado.` });
    }
  });
  const reasonIds = [...new Set(lines.map((line) => line.reasonId).filter((id): id is number => id !== null))];
  if (reasonIds.length) {
    const found = new Set((await db.select({ id: productionReasons.id }).from(productionReasons).where(inArray(productionReasons.id, reasonIds))).map((row) => row.id));
    lines.forEach((line, index) => { if (line.reasonId && !found.has(line.reasonId)) lineErrors.push({ line: index + 1, field: "reasonId", message: "Motivo não encontrado." }); });
  }
  if (lineErrors.length) throw new FellingDayError(lineErrors);
  const keep = new Set(lines.map((line) => line.operatorEmployeeId));
  const removed = existing.filter((line) => !keep.has(line.operatorEmployeeId));
  await db.transaction(async (tx) => {
    if (removed.length) await tx.delete(productionFelling).where(inArray(productionFelling.id, removed.map((line) => line.id)));
    for (const line of lines) {
      const values = { ...line, updatedBy: user.id, updatedAt: now() };
      await tx.insert(productionFelling).values({ projectId, fellingDate: date, ...values, createdBy: user.id })
        .onConflictDoUpdate({ target: [productionFelling.projectId, productionFelling.fellingDate, productionFelling.operatorEmployeeId], set: values });
    }
    const next = statusAfterLaunch(project.fellingStatus);
    if (next !== project.fellingStatus) await tx.update(productionProjects).set({ fellingStatus: next, updatedAt: now() }).where(eq(productionProjects.id, projectId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_FELLING_DAY", entityId: `${projectId}:${date}`, action: user.profile === "CAMPO" ? "DERRUBA DO DIA SALVA (APONTADOR)" : "DERRUBA DO DIA SALVA",
      previousValue: existing.length ? JSON.stringify(existing) : null, newValue: JSON.stringify(lines) });
  });
  return { saved: lines.length, removed: removed.length, trees: lines.reduce((sum, line) => sum + line.trees, 0) };
}

// ---------------------------------------------------------------------------
// Registros (histórico, acumulado, análises e multi-frente)
// ---------------------------------------------------------------------------
export async function fellingRecords(db: Db, frontIds: number[], period: Period & { operatorId?: number | null }) {
  if (frontIds.length === 0) return [];
  return (await rows(db, sql`SELECT f.id, f.project_id, p.name AS project_name, p.felling_status, p.service_front_id AS front_id, sf.name AS front_name, f.felling_date,
      f.operator_employee_id, op.name AS operator_name, op.company AS operator_company, f.helper_employee_id, hp.name AS helper_name,
      f.trees, f.ipes, f.gasoline_liters, f.reason_id, r.code AS reason_code, r.description AS reason_description, f.justification, f.updated_at
    FROM production_felling f
    JOIN production_projects p ON p.id = f.project_id JOIN service_fronts sf ON sf.id = p.service_front_id
    JOIN employees op ON op.id = f.operator_employee_id LEFT JOIN employees hp ON hp.id = f.helper_employee_id
    LEFT JOIN production_reasons r ON r.id = f.reason_id
    WHERE ${inIds(sql`p.service_front_id`, frontIds)} AND f.felling_date BETWEEN ${period.from} AND ${period.to}
      ${period.projectId ? sql`AND f.project_id = ${period.projectId}` : sql``} ${period.operatorId ? sql`AND f.operator_employee_id = ${period.operatorId}` : sql``}
    ORDER BY f.felling_date DESC, p.name, op.name LIMIT 20000`)).map((row) => ({
    id: num(row.id), projectId: num(row.project_id), projectName: String(row.project_name), projectStatus: String(row.felling_status), frontId: num(row.front_id), frontName: String(row.front_name),
    date: String(row.felling_date), operatorId: num(row.operator_employee_id), operatorName: String(row.operator_name), operatorCompany: String(row.operator_company ?? ""),
    helperId: row.helper_employee_id === null ? null : num(row.helper_employee_id), helperName: text(row.helper_name),
    trees: num(row.trees), ipes: num(row.ipes), gasolineLiters: num(row.gasoline_liters), reasonId: row.reason_id === null ? null : num(row.reason_id),
    reason: reasonLabel(text(row.reason_code), text(row.reason_description)), justification: text(row.justification), updatedAt: String(row.updated_at),
  }));
}
export type FellingRow = Awaited<ReturnType<typeof fellingRecords>>[number];

// Histórico com meta e resultado; com custos, o valor da gasolina de cada linha.
export async function fellingHistory(db: Db, user: SessionUser, frontIds: number[], period: Period & { operatorId?: number | null }) {
  const records = await fellingRecords(db, frontIds, period);
  const targets = await listTargets(db, frontIds, "DERRUBA");
  const costs = productionAccess(user).costs ? await gasolineUnitCosts(db, records.filter((row) => row.gasolineLiters > 0).map((row) => ({ frontId: row.frontId, date: row.date }))) : null;
  return records.map((row) => {
    const target = targets.get(row.frontId) ?? null;
    const result = targetResult(row.trees, target);
    return { ...row, target, result, resultLabel: TARGET_RESULT_LABELS[result], gasolineValue: costs && row.gasolineLiters > 0 ? fuelValue(row.gasolineLiters, costs.get(`${row.frontId}:${row.date}`) ?? null) : null };
  });
}

export function accumulatedByOperator(records: FellingRow[]) {
  return operatorTotals(records as FellingRecord[]);
}

// Uma linha do histórico (Editar): mesmas regras da grade.
async function requireLine(db: Db, fronts: ProductionFront[], id: number) {
  const line = (await db.select({ id: productionFelling.id, projectId: productionFelling.projectId, fellingDate: productionFelling.fellingDate, operatorEmployeeId: productionFelling.operatorEmployeeId,
    helperEmployeeId: productionFelling.helperEmployeeId, trees: productionFelling.trees, ipes: productionFelling.ipes, gasolineLiters: productionFelling.gasolineLiters, reasonId: productionFelling.reasonId, justification: productionFelling.justification })
    .from(productionFelling).where(eq(productionFelling.id, id)).limit(1))[0];
  if (!line) throw new ProductionError("Lançamento não encontrado.", 404);
  const project = await requireLaunchProject(db, fronts, line.projectId);
  if (!acceptsLaunch(project.fellingStatus)) throw new ProductionError("A derruba deste projeto está finalizada. Reabra a etapa para alterar.", 409);
  return line;
}

export async function updateFellingLine(db: Db, user: SessionUser, fronts: ProductionFront[], id: number, body: FellingLineInput) {
  requireAccess(user, "launch");
  const current = await requireLine(db, fronts, id);
  const { lines, errors } = validateFellingDay([{ ...body, operatorEmployeeId: current.operatorEmployeeId }]);
  if (errors.length) throw new FellingDayError(errors);
  const [line] = lines;
  if (line.helperEmployeeId && line.helperEmployeeId !== current.helperEmployeeId) {
    const helper = (await employeeCards(db, [line.helperEmployeeId])).get(line.helperEmployeeId);
    if (!helper) throw new ProductionError("Ajudante não encontrado.", 404, "helperEmployeeId");
    if (helper.status === "DEMITIDO") throw new ProductionError(`${helper.name} está desligado.`, 400, "helperEmployeeId");
  }
  await db.transaction(async (tx) => {
    await tx.update(productionFelling).set({ ...line, updatedBy: user.id, updatedAt: now() }).where(eq(productionFelling.id, id));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_FELLING", entityId: String(id), action: "DERRUBA ALTERADA", previousValue: JSON.stringify(current), newValue: JSON.stringify(line) });
  });
}

// Excluir do histórico é do gerenciar (plano, seção 5); tirar o operador do dia na grade é correção do dia.
export async function deleteFellingLine(db: Db, user: SessionUser, fronts: ProductionFront[], id: number) {
  requireAccess(user, "manage", "Excluir lançamentos exige a permissão de gerenciar a Produção. Para corrigir, use Editar.");
  const current = await requireLine(db, fronts, id);
  await db.transaction(async (tx) => {
    await tx.delete(productionFelling).where(eq(productionFelling.id, id));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCTION_FELLING", entityId: String(id), action: "DERRUBA EXCLUÍDA", previousValue: JSON.stringify(current) });
  });
}

// ---------------------------------------------------------------------------
// Despesas da derruba por operador/projeto (análises): material e peças (saídas de estoque), outros
// gastos da Produção e a gasolina valorada.
// ---------------------------------------------------------------------------
export type ExpenseLine = { source: "ESTOQUE" | "OUTROS" | "GASOLINA"; id: number; date: string; projectId: number | null; frontId: number; employeeId: number | null; kind: string; value: number | null; quantity: number };
export async function fellingExpenseLines(db: Db, frontIds: number[], period: Period, sector: "DERRUBA" | "ARRASTE" | "SECUNDARIA" = "DERRUBA"): Promise<ExpenseLine[]> {
  if (frontIds.length === 0) return [];
  const project = (column: SQL) => (period.projectId ? sql`AND ${column} = ${period.projectId}` : sql``);
  const stock = await rows(db, sql`SELECT se.id, se.exit_date AS day, se.production_project_id AS project_id, se.service_front_id AS front_id, se.employee_id, se.production_kind AS kind,
      sum(i.quantity * coalesce(i.unit_price, p.price, 0))::float8 AS value, sum(i.quantity)::float8 AS quantity
    FROM stock_exits se JOIN stock_exit_items i ON i.exit_id = se.id JOIN products p ON p.id = i.product_id
    WHERE se.cancelled_at IS NULL AND se.production_sector = ${sector} AND ${inIds(sql`se.service_front_id`, frontIds)} AND se.exit_date BETWEEN ${period.from} AND ${period.to} ${project(sql`se.production_project_id`)}
    GROUP BY se.id, se.exit_date, se.production_project_id, se.service_front_id, se.employee_id, se.production_kind`);
  const others = await rows(db, sql`SELECT o.id, o.expense_date AS day, o.production_project_id AS project_id, o.service_front_id AS front_id, o.employee_id, o.production_kind AS kind, o.amount AS value, coalesce(o.quantity, 1) AS quantity
    FROM other_expenses o WHERE o.deleted_at IS NULL AND o.production_sector = ${sector} AND ${inIds(sql`o.service_front_id`, frontIds)} AND o.expense_date BETWEEN ${period.from} AND ${period.to} ${project(sql`o.production_project_id`)}`);
  const lines: ExpenseLine[] = [
    ...stock.map((row) => ({ source: "ESTOQUE" as const, id: num(row.id), date: String(row.day), projectId: row.project_id === null ? null : num(row.project_id), frontId: num(row.front_id), employeeId: row.employee_id === null ? null : num(row.employee_id), kind: String(row.kind ?? "MATERIAL"), value: roundTo(num(row.value), 2), quantity: num(row.quantity) })),
    ...others.map((row) => ({ source: "OUTROS" as const, id: num(row.id), date: String(row.day), projectId: row.project_id === null ? null : num(row.project_id), frontId: num(row.front_id), employeeId: row.employee_id === null ? null : num(row.employee_id), kind: String(row.kind ?? "CUSTO_OPERACIONAL"), value: roundTo(num(row.value), 2), quantity: num(row.quantity) })),
  ];
  if (sector === "DERRUBA") {
    const records = (await fellingRecords(db, frontIds, period)).filter((row) => row.gasolineLiters > 0);
    const costs = await gasolineUnitCosts(db, records.map((row) => ({ frontId: row.frontId, date: row.date })));
    for (const row of records) lines.push({ source: "GASOLINA", id: row.id, date: row.date, projectId: row.projectId, frontId: row.frontId, employeeId: row.operatorId, kind: "GASOLINA", value: fuelValue(row.gasolineLiters, costs.get(`${row.frontId}:${row.date}`) ?? null), quantity: row.gasolineLiters });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Análises da derruba (aba Análises): KPIs, desempenho por operador, resultado por projeto e o diário
// contra a meta. Média geral = árvores ÷ dias-operador.
// ---------------------------------------------------------------------------
export async function fellingAnalysis(db: Db, frontIds: number[], period: Period) {
  const [records, expenses, targets] = await Promise.all([fellingRecords(db, frontIds, period), fellingExpenseLines(db, frontIds, period), listTargets(db, frontIds, "DERRUBA")]);
  const money = (lines: ExpenseLine[]) => roundTo(lines.reduce((sum, line) => sum + (line.value ?? 0), 0), 2);
  const withoutValue = expenses.filter((line) => line.value === null).reduce((sum, line) => sum + line.quantity, 0);
  const operatorDays = new Set(records.map((row) => `${row.operatorId}:${row.date}`)).size;
  const trees = records.reduce((sum, row) => sum + row.trees, 0);
  const operators = new Map<number, { operatorId: number; operatorName: string; dates: Set<string>; trees: number; ipes: number; gasoline: number }>();
  for (const row of records) {
    const item = operators.get(row.operatorId) ?? { operatorId: row.operatorId, operatorName: row.operatorName, dates: new Set<string>(), trees: 0, ipes: 0, gasoline: 0 };
    item.dates.add(row.date); item.trees += row.trees; item.ipes += row.ipes; item.gasoline += row.gasolineLiters;
    operators.set(row.operatorId, item);
  }
  const byOperator = [...operators.values()].map((item) => {
    const mine = expenses.filter((line) => line.employeeId === item.operatorId);
    const spent = money(mine);
    return {
      operatorId: item.operatorId, operatorName: item.operatorName, days: item.dates.size, trees: item.trees, ipes: item.ipes, perDay: perDay(item.trees, item.dates.size),
      gasolineLiters: roundTo(item.gasoline, 2), maintenance: money(mine.filter((line) => line.kind === "MANUTENCAO")), losses: mine.filter((line) => line.kind === "PERDA_TOTAL").length,
      spent, costPerTree: item.trees > 0 ? roundTo(spent / item.trees, 2) : null,
    };
  }).sort((a, b) => b.trees - a.trees || a.operatorName.localeCompare(b.operatorName, "pt-BR"));
  const projects = new Map<number, { projectId: number; projectName: string; status: string; dates: Set<string>; operators: Set<number>; operatorDays: Set<string>; trees: number; ipes: number }>();
  for (const row of records) {
    const item = projects.get(row.projectId) ?? { projectId: row.projectId, projectName: row.projectName, status: row.projectStatus, dates: new Set<string>(), operators: new Set<number>(), operatorDays: new Set<string>(), trees: 0, ipes: 0 };
    item.dates.add(row.date); item.operators.add(row.operatorId); item.operatorDays.add(`${row.operatorId}:${row.date}`); item.trees += row.trees; item.ipes += row.ipes;
    projects.set(row.projectId, item);
  }
  const byProject = [...projects.values()].map((item) => {
    const spent = money(expenses.filter((line) => line.projectId === item.projectId));
    return { projectId: item.projectId, projectName: item.projectName, status: item.status, days: item.dates.size, operators: item.operators.size, trees: item.trees, ipes: item.ipes,
      perDay: perDay(item.trees, item.operatorDays.size), spent, costPerTree: item.trees > 0 ? roundTo(spent / item.trees, 2) : null };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName, "pt-BR", { numeric: true }));
  const daily = records.map((row) => {
    const target = targets.get(row.frontId) ?? null;
    const result = targetResult(row.trees, target);
    return { date: row.date, projectName: row.projectName, operatorName: row.operatorName, trees: row.trees, ipes: row.ipes, target, result, resultLabel: TARGET_RESULT_LABELS[result], justification: [row.reason, row.justification].filter(Boolean).join(" — ") || null };
  });
  return {
    kpis: { operators: operators.size, trees, perDay: perDay(trees, operatorDays), ipes: records.reduce((sum, row) => sum + row.ipes, 0), cost: money(expenses), litersWithoutValue: roundTo(withoutValue, 2) },
    byOperator, byProject, daily,
  };
}

// Produção multi-frente: só produção, sem despesas (base para premiação por produção).
export async function fellingMultiFront(db: Db, frontIds: number[], period: Period) {
  const [records, targets] = await Promise.all([fellingRecords(db, frontIds, { ...period, projectId: null }), listTargets(db, frontIds, "DERRUBA")]);
  return { ...multiFrontSummary(records as FellingRecord[], targets), targets: Object.fromEntries(targets) as Record<number, number> };
}

// Produtos da Produção com o preço efetivo da frente e o saldo do estoque da frente (selects das despesas).
export async function productionProductOptions(db: Db, frontId: number) {
  const result = await rows(db, sql`SELECT p.id, p.tag, p.name, p.price, fp.price AS front_price, coalesce(st.quantity, 0)::float8 AS balance
    FROM products p LEFT JOIN product_front_prices fp ON fp.product_id = p.id AND fp.service_front_id = ${frontId}
    LEFT JOIN product_front_stock st ON st.product_id = p.id AND st.service_front_id = ${frontId}
    WHERE p.production_use AND p.active ORDER BY p.name`);
  return result.map((row) => ({ id: num(row.id), tag: String(row.tag), name: String(row.name), price: row.front_price === null ? num(row.price) : num(row.front_price), frontPrice: row.front_price !== null, balance: num(row.balance) }));
}
