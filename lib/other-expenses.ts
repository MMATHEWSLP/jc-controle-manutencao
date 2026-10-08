import { and, desc, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { getDb } from "../db";
import { equipment, otherExpenses, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { canSeeReport } from "./reports-catalog";

// ---------------------------------------------------------------------------
// Outros gastos (RELATÓRIOS → Custos): serviço/mão de obra de fora e outros, por frente e (opcional)
// equipamento. Ver: quem vê os relatórios de custos; lançar/editar/excluir: costs.other_expenses
// (nasce só para ADMIN; o administrador libera por usuário), sempre nas frentes da pessoa.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
export const OTHER_EXPENSE_CATEGORIES = { SERVICO: "Serviço / mão de obra", OUTROS: "Outros" } as const;
export type OtherExpenseCategory = keyof typeof OTHER_EXPENSE_CATEGORIES;

export class OtherExpenseError extends Error {
  constructor(message: string, public status = 400, public field?: string) { super(message); }
}
export function otherExpenseErrorResponse(error: unknown) {
  return error instanceof OtherExpenseError ? Response.json({ error: error.message, field: error.field ?? null }, { status: error.status }) : null;
}

export const canViewOtherExpenses = (user: SessionUser) => canSeeReport(user, "outros-gastos") || canLaunchOtherExpenses(user);
export const canLaunchOtherExpenses = (user: SessionUser) => user.profile !== "CAMPO" && user.permissions.includes("costs.other_expenses");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// "1.234,56", "1234.56" ou número.
export function parseAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? "").trim().replace(/^R\$\s*/i, "");
  if (!text) return NaN;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

export type OtherExpenseInput = { serviceFrontId: number; equipmentId: number | null; expenseDate: string; category: OtherExpenseCategory; amount: number; description: string };
export function validateOtherExpense(body: Record<string, unknown>): OtherExpenseInput {
  const serviceFrontId = Number(body.serviceFrontId);
  if (!Number.isInteger(serviceFrontId) || serviceFrontId <= 0) throw new OtherExpenseError("Escolha a frente.", 400, "serviceFrontId");
  const equipmentId = body.equipmentId === null || body.equipmentId === undefined || body.equipmentId === "" ? null : Number(body.equipmentId);
  if (equipmentId !== null && (!Number.isInteger(equipmentId) || equipmentId <= 0)) throw new OtherExpenseError("Equipamento inválido.", 400, "equipmentId");
  const expenseDate = String(body.expenseDate ?? "");
  if (!ISO.test(expenseDate)) throw new OtherExpenseError("Informe a data do gasto.", 400, "expenseDate");
  const category = String(body.category ?? "") as OtherExpenseCategory;
  if (!(category in OTHER_EXPENSE_CATEGORIES)) throw new OtherExpenseError("Escolha a categoria: serviço/mão de obra ou outros.", 400, "category");
  const amount = parseAmount(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new OtherExpenseError("Informe o valor (maior que zero).", 400, "amount");
  if (amount > 10_000_000) throw new OtherExpenseError("Valor alto demais: confira.", 400, "amount");
  const description = String(body.description ?? "").trim().replace(/\s+/g, " ");
  if (description.length < 3) throw new OtherExpenseError("Descreva o gasto (ex.: mão de obra do torneiro, frete).", 400, "description");
  return { serviceFrontId, equipmentId, expenseDate, category, amount: Math.round(amount * 100) / 100, description: description.slice(0, 300) };
}

function assertFront(user: SessionUser, frontId: number) {
  const visible = frentesVisiveis(user);
  if (visible !== "ALL" && !visible.includes(frontId)) throw new OtherExpenseError("Você não tem acesso a esta frente.", 403, "serviceFrontId");
}
async function assertEquipment(db: Db, equipmentId: number | null) {
  if (equipmentId === null) return;
  const row = (await db.select({ id: equipment.id }).from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
  if (!row) throw new OtherExpenseError("Equipamento não encontrado.", 400, "equipmentId");
}

export type OtherExpenseFilters = { from: string | null; to: string | null; frontId: number | null; equipmentId: number | null; category: OtherExpenseCategory | null };
export function parseOtherExpenseFilters(params: URLSearchParams): OtherExpenseFilters {
  const category = params.get("categoria");
  return {
    from: ISO.test(params.get("de") ?? "") ? params.get("de") : null, to: ISO.test(params.get("ate") ?? "") ? params.get("ate") : null,
    frontId: Number(params.get("frente")) || null, equipmentId: Number(params.get("equipamento")) || null,
    category: category && category in OTHER_EXPENSE_CATEGORIES ? category as OtherExpenseCategory : null,
  };
}

export async function listOtherExpenses(db: Db, fronts: number[] | "ALL", filters: OtherExpenseFilters, limit = 2000) {
  if (fronts !== "ALL" && fronts.length === 0) return [];
  const creator = alias(users, "expense_creator");
  const conditions: SQL[] = [isNull(otherExpenses.deletedAt)];
  if (fronts !== "ALL") conditions.push(inArray(otherExpenses.serviceFrontId, fronts));
  if (filters.frontId) conditions.push(eq(otherExpenses.serviceFrontId, filters.frontId));
  if (filters.equipmentId) conditions.push(eq(otherExpenses.equipmentId, filters.equipmentId));
  if (filters.category) conditions.push(eq(otherExpenses.category, filters.category));
  if (filters.from) conditions.push(gte(otherExpenses.expenseDate, filters.from));
  if (filters.to) conditions.push(lte(otherExpenses.expenseDate, filters.to));
  const rows = await db.select({
    id: otherExpenses.id, serviceFrontId: otherExpenses.serviceFrontId, frontName: serviceFronts.name, equipmentId: otherExpenses.equipmentId, equipmentPrefix: equipment.prefix,
    expenseDate: otherExpenses.expenseDate, category: otherExpenses.category, amount: otherExpenses.amount, description: otherExpenses.description,
    createdByName: creator.name, createdAt: otherExpenses.createdAt, updatedAt: otherExpenses.updatedAt,
  }).from(otherExpenses)
    .innerJoin(serviceFronts, eq(serviceFronts.id, otherExpenses.serviceFrontId))
    .leftJoin(equipment, eq(equipment.id, otherExpenses.equipmentId))
    .leftJoin(creator, eq(creator.id, otherExpenses.createdBy))
    .where(and(...conditions))
    .orderBy(desc(otherExpenses.expenseDate), desc(otherExpenses.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, categoryLabel: OTHER_EXPENSE_CATEGORIES[row.category] }));
}

export async function createOtherExpense(db: Db, user: SessionUser, body: Record<string, unknown>) {
  const input = validateOtherExpense(body);
  assertFront(user, input.serviceFrontId);
  await assertEquipment(db, input.equipmentId);
  const now = new Date().toISOString();
  const [row] = await db.insert(otherExpenses).values({ ...input, createdBy: user.id, updatedBy: user.id, createdAt: now, updatedAt: now }).returning({ id: otherExpenses.id });
  return row.id;
}

async function requireExpense(db: Db, user: SessionUser, id: number) {
  const row = (await db.select().from(otherExpenses).where(and(eq(otherExpenses.id, id), isNull(otherExpenses.deletedAt))).limit(1))[0];
  if (!row) throw new OtherExpenseError("Gasto não encontrado.", 404);
  assertFront(user, row.serviceFrontId);
  return row;
}

export async function updateOtherExpense(db: Db, user: SessionUser, id: number, body: Record<string, unknown>) {
  await requireExpense(db, user, id);
  const input = validateOtherExpense(body);
  assertFront(user, input.serviceFrontId);
  await assertEquipment(db, input.equipmentId);
  await db.update(otherExpenses).set({ ...input, updatedBy: user.id, updatedAt: new Date().toISOString() }).where(eq(otherExpenses.id, id));
}

export async function deleteOtherExpense(db: Db, user: SessionUser, id: number) {
  await requireExpense(db, user, id);
  const now = new Date().toISOString();
  await db.update(otherExpenses).set({ deletedAt: now, deletedBy: user.id, updatedAt: now }).where(eq(otherExpenses.id, id));
}
