import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { auditLogs, departments, employees, equipment, products, serviceFronts, stockExitItems, stockExits, thirdParties, thirdPartyVehicles, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { stockExitNumber } from "./document-numbers";
import { requireDepartment } from "./departments";
import { assertStockAvailable, reverseStockMovements, stockExit, StockError } from "./stock";
import { isIsoDay, localToday, productsById } from "./stock-options";
import { visibleFrontList } from "./products-data";

// Movimentação: saída de produtos do estoque (SAI-000123) para um veículo/equipamento, um
// funcionário e/ou um departamento (pelo menos um dos três) — ou para um Terceiro / Prestador do
// cadastro de terceiros (veículo dele opcional e "Recebido por" obrigatório).

type Db = Awaited<ReturnType<typeof getDb>>;

export type StockExitInput = {
  serviceFrontId: number; exitDate: string; destinationType: "EMPLOYEE" | "EQUIPMENT" | "DEPARTMENT" | "THIRD_PARTY";
  employeeId: number | null; equipmentId: number | null; departmentId: number | null; notes: string | null;
  thirdPartyId: number | null; thirdPartyVehicleId: number | null; receivedBy: string | null;
  items: Array<{ productId: number; quantity: number }>; allowNegative: boolean;
  // "Lançar tudo" do Assistente JC (nunca vem do formulário).
  createdVia?: "ASSISTENTE" | null;
};

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const positiveId = (value: unknown) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; };

export function parseStockExit(body: Record<string, unknown>): StockExitInput {
  const serviceFrontId = Number(body.serviceFrontId);
  if (!Number.isInteger(serviceFrontId) || serviceFrontId <= 0) throw new StockError("Escolha a frente de onde o estoque sai.");
  const exitDate = clean(body.exitDate) || localToday();
  if (!isIsoDay(exitDate)) throw new StockError("Informe uma data válida.");
  if (exitDate > localToday()) throw new StockError("A data da saída não pode ser futura.");
  const toThirdParty = body.destinationType === "THIRD_PARTY";
  const equipmentId = toThirdParty ? null : positiveId(body.equipmentId);
  const employeeId = toThirdParty ? null : positiveId(body.employeeId);
  const departmentId = toThirdParty ? null : positiveId(body.departmentId);
  const thirdPartyId = toThirdParty ? positiveId(body.thirdPartyId) : null;
  const thirdPartyVehicleId = toThirdParty ? positiveId(body.thirdPartyVehicleId) : null;
  const receivedBy = toThirdParty ? clean(body.receivedBy).replace(/\s+/g, " ") || null : null;
  if (toThirdParty) {
    if (!thirdPartyId) throw new StockError("Escolha a empresa/pessoa (Terceiro / Prestador) que recebe os produtos.");
    if (!receivedBy) throw new StockError("Informe quem recebeu os produtos (Recebido por).");
  } else if (!equipmentId && !employeeId && !departmentId) throw new StockError("Informe o destino da saída: veículo, funcionário e/ou departamento.");
  const destinationType = toThirdParty ? "THIRD_PARTY" : equipmentId ? "EQUIPMENT" : employeeId ? "EMPLOYEE" : "DEPARTMENT";
  const rawItems = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  const items = rawItems.map((item) => ({ productId: Number(item.productId), quantity: Number(String(item.quantity ?? "").replace(",", ".")) }));
  if (items.length === 0) throw new StockError("Adicione ao menos um produto.");
  if (items.some((item) => !Number.isInteger(item.productId) || item.productId <= 0)) throw new StockError("Escolha o produto de todos os itens.");
  if (items.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0)) throw new StockError("A quantidade de todos os itens deve ser maior que zero.");
  return { serviceFrontId, exitDate, destinationType, employeeId, equipmentId, departmentId, thirdPartyId, thirdPartyVehicleId, receivedBy, notes: clean(body.notes) || null, items, allowNegative: body.allowNegative === true };
}

export async function createStockExit(db: Db, user: SessionUser, input: StockExitInput) {
  const fronts = await visibleFrontList(db, user);
  if (!fronts.some((front) => front.id === input.serviceFrontId)) throw new StockError("Você não tem acesso ao estoque da frente escolhida.", 400);
  if (input.equipmentId) {
    const item = (await db.select({ id: equipment.id }).from(equipment).where(eq(equipment.id, input.equipmentId)).limit(1))[0];
    if (!item) throw new StockError("Equipamento não encontrado.", 404);
  }
  if (input.employeeId) {
    const person = (await db.select({ id: employees.id, status: employees.status }).from(employees).where(eq(employees.id, input.employeeId)).limit(1))[0];
    if (!person) throw new StockError("Funcionário não encontrado.", 404);
    if (person.status === "DEMITIDO") throw new StockError("Funcionário demitido não pode receber produtos.");
  }
  if (input.departmentId) await requireDepartment(db, input.departmentId);
  if (input.thirdPartyId) {
    const party = (await db.select({ id: thirdParties.id, active: thirdParties.active, name: thirdParties.name }).from(thirdParties).where(eq(thirdParties.id, input.thirdPartyId)).limit(1))[0];
    if (!party) throw new StockError("Terceiro não encontrado.", 404);
    if (!party.active) throw new StockError(`${party.name} está inativo no cadastro de terceiros.`);
    if (input.thirdPartyVehicleId) {
      const vehicle = (await db.select({ thirdPartyId: thirdPartyVehicles.thirdPartyId, active: thirdPartyVehicles.active }).from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, input.thirdPartyVehicleId)).limit(1))[0];
      if (!vehicle || vehicle.thirdPartyId !== input.thirdPartyId) throw new StockError("O veículo escolhido não pertence a este terceiro.");
      if (!vehicle.active) throw new StockError("O veículo escolhido está inativo no cadastro.");
    }
  }
  const catalog = await productsById(db, input.items.map((item) => item.productId));
  const missing = input.items.find((item) => !catalog.get(item.productId)?.active);
  if (missing) throw new StockError("Um dos produtos escolhidos não existe mais ou foi desativado.");
  await assertStockAvailable(db, input.serviceFrontId, input.items.map((item) => ({ ...item, label: `${catalog.get(item.productId)!.tag} ${catalog.get(item.productId)!.name}` })), input.allowNegative, user);

  return db.transaction(async (tx) => {
    const [exit] = await tx.insert(stockExits).values({
      serviceFrontId: input.serviceFrontId, exitDate: input.exitDate, destinationType: input.destinationType,
      employeeId: input.employeeId, equipmentId: input.equipmentId, departmentId: input.departmentId,
      thirdPartyId: input.thirdPartyId, thirdPartyVehicleId: input.thirdPartyVehicleId, receivedBy: input.receivedBy, notes: input.notes, createdVia: input.createdVia ?? null, createdBy: user.id,
    }).returning({ id: stockExits.id });
    const number = stockExitNumber(exit.id);
    for (const item of input.items) {
      const product = catalog.get(item.productId)!;
      const [row] = await tx.insert(stockExitItems).values({ exitId: exit.id, productId: item.productId, quantity: item.quantity, unitPrice: product.price }).returning({ id: stockExitItems.id });
      await stockExit(tx, {
        productId: item.productId, serviceFrontId: input.serviceFrontId, quantity: item.quantity, source: "STOCK_EXIT", reason: `Saída ${number}`,
        userId: user.id, movementDate: input.exitDate, unitPrice: product.price, equipmentId: input.equipmentId, employeeId: input.employeeId, departmentId: input.departmentId,
        refs: { stockExitId: exit.id, stockExitItemId: row.id },
      });
    }
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "STOCK_EXIT", entityId: String(exit.id), action: "SAÍDA DE ESTOQUE LANÇADA", newValue: JSON.stringify({ ...input, number }) });
    return { id: exit.id, number };
  });
}

export async function cancelStockExit(db: Db, user: SessionUser, id: number, reason: string) {
  if (!reason) throw new StockError("Informe o motivo do estorno.");
  const exit = (await db.select().from(stockExits).where(eq(stockExits.id, id)).limit(1))[0];
  if (!exit) throw new StockError("Saída não encontrada.", 404);
  const visible = frentesVisiveis(user);
  if (visible !== "ALL" && !visible.includes(exit.serviceFrontId)) throw new StockError("Você não tem acesso ao estoque desta saída.", 404);
  if (exit.cancelledAt) throw new StockError("Esta saída já foi estornada.", 409);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(stockExits).set({ cancelledAt: now, cancelledBy: user.id, cancelReason: reason, updatedAt: now }).where(eq(stockExits.id, id));
    await reverseStockMovements(tx, { stockExitId: id }, user.id, `Estorno da saída ${stockExitNumber(id)}: ${reason}`);
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "STOCK_EXIT", entityId: String(id), action: "SAÍDA DE ESTOQUE ESTORNADA", newValue: JSON.stringify({ reason }) });
  });
  return stockExitNumber(id);
}

// Saídas (documentos) recentes das frentes que a pessoa enxerga, com os itens.
export async function listStockExits(db: Db, user: SessionUser, filters: { equipmentId?: number | null; employeeId?: number | null; departmentId?: number | null; thirdPartyId?: number | null; thirdPartyVehicleId?: number | null; from?: string | null; to?: string | null; limit?: number }) {
  const visible = frentesVisiveis(user);
  if (visible !== "ALL" && visible.length === 0) return [];
  const creator = alias(users, "exit_creator");
  const conditions = [
    visible === "ALL" ? undefined : inArray(stockExits.serviceFrontId, visible),
    filters.equipmentId ? eq(stockExits.equipmentId, filters.equipmentId) : undefined,
    filters.employeeId ? eq(stockExits.employeeId, filters.employeeId) : undefined,
    filters.departmentId ? eq(stockExits.departmentId, filters.departmentId) : undefined,
    filters.thirdPartyId ? eq(stockExits.thirdPartyId, filters.thirdPartyId) : undefined,
    filters.thirdPartyVehicleId ? eq(stockExits.thirdPartyVehicleId, filters.thirdPartyVehicleId) : undefined,
    filters.from ? gte(stockExits.exitDate, filters.from) : undefined,
    filters.to ? lte(stockExits.exitDate, filters.to) : undefined,
  ].filter(Boolean);
  const rows = await db.select({
    id: stockExits.id, exitDate: stockExits.exitDate, destinationType: stockExits.destinationType, notes: stockExits.notes,
    cancelledAt: stockExits.cancelledAt, cancelReason: stockExits.cancelReason, front: serviceFronts.name,
    equipmentId: stockExits.equipmentId, equipmentPrefix: equipment.prefix, employeeId: stockExits.employeeId, employeeName: employees.name,
    departmentId: stockExits.departmentId, departmentName: departments.name, createdBy: creator.name,
    thirdPartyId: stockExits.thirdPartyId, thirdPartyName: thirdParties.name, thirdPartyVehicleId: stockExits.thirdPartyVehicleId, thirdPartyPlate: thirdPartyVehicles.plate, receivedBy: stockExits.receivedBy,
  }).from(stockExits).innerJoin(serviceFronts, eq(stockExits.serviceFrontId, serviceFronts.id))
    .leftJoin(thirdParties, eq(stockExits.thirdPartyId, thirdParties.id)).leftJoin(thirdPartyVehicles, eq(stockExits.thirdPartyVehicleId, thirdPartyVehicles.id))
    .leftJoin(equipment, eq(stockExits.equipmentId, equipment.id)).leftJoin(employees, eq(stockExits.employeeId, employees.id))
    .leftJoin(departments, eq(stockExits.departmentId, departments.id))
    .leftJoin(creator, eq(stockExits.createdBy, creator.id))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(stockExits.exitDate), desc(stockExits.id)).limit(filters.limit ?? 200);
  const filtered = rows;
  const items = filtered.length ? await db.select({ exitId: stockExitItems.exitId, quantity: stockExitItems.quantity, unitPrice: stockExitItems.unitPrice, tag: products.tag, name: products.name })
    .from(stockExitItems).innerJoin(products, eq(stockExitItems.productId, products.id)).where(inArray(stockExitItems.exitId, filtered.map((row) => row.id))) : [];
  return filtered.map((row) => ({
    ...row, number: stockExitNumber(row.id),
    destination: (row.thirdPartyName ? [row.thirdPartyName, row.thirdPartyPlate, row.receivedBy ? `recebido por ${row.receivedBy}` : null] : [row.equipmentPrefix, row.employeeName, row.departmentName]).filter(Boolean).join(" · ") || null,
    items: items.filter((item) => item.exitId === row.id).map((item) => ({ tag: item.tag, name: item.name, quantity: item.quantity, unitPrice: item.unitPrice })),
  }));
}
