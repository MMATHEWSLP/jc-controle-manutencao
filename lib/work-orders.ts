import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import {
  auditLogs, employees, equipment, fleetMechanics, maintenances, maintenanceTypes, products, serviceFronts, users,
  workOrderItems, workOrderMechanics, workOrders,
} from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { workOrderNumber } from "./document-numbers";
import { assertStockAvailable, reverseStockMovements, stockExit, StockError } from "./stock";
import { isIsoDay, localToday } from "./stock-options";

// ---------------------------------------------------------------------------------------------
// Ordem de Serviço (OS-000123). Peças lançadas saem do estoque da frente da O.S. na hora, pelo
// serviço único de estoque (lib/stock.ts), cada uma com a data de lançamento e quem retirou.
// Trocas de óleo feitas pelo QR Code se vinculam à última O.S. do equipamento (maintenances.work_order_id).
// ---------------------------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const MAX_TEXT = 2000;

function canSeeFront(user: SessionUser, frontId: number) {
  const visible = frentesVisiveis(user);
  return visible === "ALL" || visible.includes(frontId);
}

async function audit(db: Db | Tx, userId: number, id: number, action: string, value?: unknown) {
  await db.insert(auditLogs).values({ userId, entityType: "WORK_ORDER", entityId: String(id), action, newValue: value === undefined ? null : JSON.stringify(value) });
}

// Mecânicos: a mesma lista do Status da Frota (cadastro de mecânicos + usuários da Oficina) mais os
// funcionários com função de mecânico.
export async function mechanicNames(db: Db) {
  const [fleet, workshop, staff] = await Promise.all([
    db.select({ name: fleetMechanics.name }).from(fleetMechanics).where(eq(fleetMechanics.active, true)),
    db.select({ name: users.name }).from(users).where(and(eq(users.status, "ACTIVE"), eq(users.role, "OFICINA"))),
    db.select({ name: employees.name }).from(employees).where(and(ilike(employees.jobTitle, "MEC%"), ne(employees.status, "DEMITIDO"))),
  ]);
  return [...new Set([...fleet, ...workshop, ...staff].map((row) => row.name.trim().toUpperCase()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function parseMechanics(value: unknown) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((item) => clean(item).toUpperCase().replace(/\s+/g, " ")).filter(Boolean))].slice(0, 20);
}

async function requireEquipmentForOrder(db: Db | Tx, user: SessionUser, equipmentId: number) {
  const row = (await db.select({ id: equipment.id, prefix: equipment.prefix, serviceFrontId: equipment.serviceFrontId, controlType: equipment.controlType, currentHours: equipment.currentHours, currentKm: equipment.currentKm })
    .from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
  if (!row) throw new StockError("Equipamento não encontrado.", 404);
  if (!row.serviceFrontId) throw new StockError("O equipamento está sem frente de serviço; defina a frente no cadastro antes de abrir a O.S.");
  if (!canSeeFront(user, row.serviceFrontId)) throw new StockError("Você não tem acesso a este equipamento.", 404);
  return row;
}

export async function requireWorkOrder(db: Db | Tx, user: SessionUser, id: number) {
  const row = (await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1))[0];
  if (!row || !canSeeFront(user, row.serviceFrontId)) throw new StockError("Ordem de serviço não encontrada.", 404);
  return row;
}

// ------------------------------------------------------------------------------ consulta

export async function listWorkOrders(db: Db, fronts: number[] | "ALL", filters: { status?: "OPEN" | "CLOSED" | null; equipmentId?: number | null; from?: string | null; to?: string | null }) {
  if (fronts !== "ALL" && fronts.length === 0) return [];
  const conditions: SQL[] = [];
  if (fronts !== "ALL") conditions.push(inArray(workOrders.serviceFrontId, fronts));
  if (filters.status) conditions.push(eq(workOrders.status, filters.status));
  if (filters.equipmentId) conditions.push(eq(workOrders.equipmentId, filters.equipmentId));
  if (filters.from) conditions.push(gte(workOrders.openedAt, filters.from));
  if (filters.to) conditions.push(lte(workOrders.openedAt, filters.to));
  const rows = await db.select({
    id: workOrders.id, equipmentId: workOrders.equipmentId, prefix: equipment.prefix, brand: equipment.brand, model: equipment.model, type: equipment.type,
    front: serviceFronts.name, openedAt: workOrders.openedAt, meterReading: workOrders.meterReading, meterUnit: workOrders.meterUnit,
    description: workOrders.description, status: workOrders.status, closedAt: workOrders.closedAt,
  }).from(workOrders).innerJoin(equipment, eq(workOrders.equipmentId, equipment.id)).innerJoin(serviceFronts, eq(workOrders.serviceFrontId, serviceFronts.id))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(workOrders.openedAt), desc(workOrders.id)).limit(300);
  const ids = rows.map((row) => row.id);
  const [mechanics, totals, oil] = ids.length ? await Promise.all([
    db.select().from(workOrderMechanics).where(inArray(workOrderMechanics.workOrderId, ids)),
    db.select({ workOrderId: workOrderItems.workOrderId, count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${workOrderItems.quantity} * coalesce(${workOrderItems.unitPrice}, 0)), 0)::float8` })
      .from(workOrderItems).where(and(inArray(workOrderItems.workOrderId, ids), isNull(workOrderItems.removedAt))).groupBy(workOrderItems.workOrderId),
    db.select({ workOrderId: maintenances.workOrderId, count: sql<number>`count(*)::int` }).from(maintenances).where(inArray(maintenances.workOrderId, ids)).groupBy(maintenances.workOrderId),
  ]) : [[], [], []];
  return rows.map((row) => ({
    ...row, number: workOrderNumber(row.id), equipmentDescription: [row.brand, row.model].filter(Boolean).join(" ") || row.type,
    mechanics: mechanics.filter((item) => item.workOrderId === row.id).map((item) => item.mechanicName),
    itemCount: totals.find((item) => item.workOrderId === row.id)?.count ?? 0,
    partsTotal: totals.find((item) => item.workOrderId === row.id)?.total ?? 0,
    oilChanges: oil.find((item) => item.workOrderId === row.id)?.count ?? 0,
  }));
}

export async function workOrderDetail(db: Db, user: SessionUser, id: number) {
  const order = await requireWorkOrder(db, user, id);
  const opener = alias(users, "wo_opener");
  const closer = alias(users, "wo_closer");
  const [head] = await db.select({ prefix: equipment.prefix, brand: equipment.brand, model: equipment.model, type: equipment.type, front: serviceFronts.name, openedBy: opener.name, closedByName: closer.name })
    .from(workOrders).innerJoin(equipment, eq(workOrders.equipmentId, equipment.id)).innerJoin(serviceFronts, eq(workOrders.serviceFrontId, serviceFronts.id))
    .leftJoin(opener, eq(workOrders.createdBy, opener.id)).leftJoin(closer, eq(workOrders.closedBy, closer.id)).where(eq(workOrders.id, id));
  const creator = alias(users, "item_creator");
  const [mechanics, items, oil] = await Promise.all([
    db.select({ name: workOrderMechanics.mechanicName }).from(workOrderMechanics).where(eq(workOrderMechanics.workOrderId, id)).orderBy(asc(workOrderMechanics.mechanicName)),
    db.select({
      id: workOrderItems.id, productId: workOrderItems.productId, tag: products.tag, name: products.name, quantity: workOrderItems.quantity,
      launchDate: workOrderItems.launchDate, withdrawnBy: workOrderItems.withdrawnBy, application: workOrderItems.application,
      unitPrice: workOrderItems.unitPrice, removedAt: workOrderItems.removedAt, launchedBy: creator.name,
    }).from(workOrderItems).innerJoin(products, eq(workOrderItems.productId, products.id)).leftJoin(creator, eq(workOrderItems.createdBy, creator.id))
      .where(eq(workOrderItems.workOrderId, id)).orderBy(asc(workOrderItems.launchDate), asc(workOrderItems.id)),
    db.select({ id: maintenances.id, performedAt: maintenances.performedAt, mechanic: maintenances.mechanic, service: maintenanceTypes.name, hours: maintenances.hours, km: maintenances.km })
      .from(maintenances).innerJoin(maintenanceTypes, eq(maintenances.maintenanceTypeId, maintenanceTypes.id)).where(eq(maintenances.workOrderId, id)).orderBy(asc(maintenances.performedAt)),
  ]);
  const active = items.filter((item) => !item.removedAt);
  return {
    ...order, number: workOrderNumber(order.id), equipment: { id: order.equipmentId, prefix: head.prefix, description: [head.brand, head.model].filter(Boolean).join(" ") || head.type },
    front: head.front, openedBy: head.openedBy, closedByName: head.closedByName, mechanics: mechanics.map((row) => row.name),
    items: items.map((item) => ({ ...item, total: item.unitPrice === null ? null : item.unitPrice * item.quantity })),
    partsTotal: active.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0),
    oilChanges: oil,
  };
}

// Última O.S. do equipamento (aberta ou fechada, a mais recente): usada para vincular a troca de
// óleo registrada pelo QR Code.
export async function lastWorkOrderOf(db: Db, equipmentId: number) {
  const row = (await db.select({ id: workOrders.id, status: workOrders.status, openedAt: workOrders.openedAt, closedAt: workOrders.closedAt })
    .from(workOrders).where(eq(workOrders.equipmentId, equipmentId)).orderBy(desc(workOrders.openedAt), desc(workOrders.id)).limit(1))[0];
  return row ? { ...row, number: workOrderNumber(row.id) } : null;
}

// ------------------------------------------------------------------------------ alterações

export type OpenWorkOrderInput = { equipmentId: number; openedAt: string; meterReading: number | null; description: string; mechanics: string[] };

export function parseOpenWorkOrder(body: Record<string, unknown>): OpenWorkOrderInput {
  const equipmentId = Number(body.equipmentId);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) throw new StockError("Selecione o equipamento.");
  const openedAt = clean(body.openedAt) || localToday();
  if (!isIsoDay(openedAt) || openedAt > localToday()) throw new StockError("Informe uma data de abertura válida (não futura).");
  const description = clean(body.description).slice(0, MAX_TEXT);
  if (!description) throw new StockError("Descreva o que está sendo feito / o diagnóstico.");
  const rawReading = clean(String(body.meterReading ?? "")).replace(",", ".");
  const meterReading = rawReading === "" ? null : Number(rawReading);
  if (meterReading !== null && (!Number.isFinite(meterReading) || meterReading < 0)) throw new StockError("Informe um KM/horímetro válido.");
  return { equipmentId, openedAt, meterReading, description, mechanics: parseMechanics(body.mechanics) };
}

export async function openWorkOrder(db: Db, user: SessionUser, input: OpenWorkOrderInput) {
  const item = await requireEquipmentForOrder(db, user, input.equipmentId);
  const meterUnit = item.controlType === "KM" ? "KM" as const : "HOURS" as const;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(workOrders).values({
      equipmentId: item.id, serviceFrontId: item.serviceFrontId!, openedAt: input.openedAt, meterReading: input.meterReading, meterUnit,
      description: input.description, status: "OPEN", createdBy: user.id,
    }).returning({ id: workOrders.id });
    if (input.mechanics.length) await tx.insert(workOrderMechanics).values(input.mechanics.map((mechanicName) => ({ workOrderId: row.id, mechanicName })));
    await audit(tx, user.id, row.id, "O.S. ABERTA", { ...input, number: workOrderNumber(row.id) });
    return { id: row.id, number: workOrderNumber(row.id) };
  });
}

export async function updateWorkOrder(db: Db, user: SessionUser, id: number, body: Record<string, unknown>) {
  const order = await requireWorkOrder(db, user, id);
  if (order.status !== "OPEN") throw new StockError("A O.S. está fechada. Reabra para alterar.", 409);
  const description = body.description === undefined ? order.description : clean(body.description).slice(0, MAX_TEXT);
  if (!description) throw new StockError("Descreva o que está sendo feito / o diagnóstico.");
  const rawReading = body.meterReading === undefined ? null : clean(String(body.meterReading ?? "")).replace(",", ".");
  const meterReading = body.meterReading === undefined ? order.meterReading : rawReading === "" ? null : Number(rawReading);
  if (meterReading !== null && (!Number.isFinite(meterReading) || meterReading < 0)) throw new StockError("Informe um KM/horímetro válido.");
  const mechanics = body.mechanics === undefined ? null : parseMechanics(body.mechanics);
  await db.transaction(async (tx) => {
    await tx.update(workOrders).set({ description, meterReading, updatedAt: new Date().toISOString() }).where(eq(workOrders.id, id));
    if (mechanics) {
      await tx.delete(workOrderMechanics).where(eq(workOrderMechanics.workOrderId, id));
      if (mechanics.length) await tx.insert(workOrderMechanics).values(mechanics.map((mechanicName) => ({ workOrderId: id, mechanicName })));
    }
    await audit(tx, user.id, id, "O.S. ALTERADA", { description, meterReading, mechanics });
  });
}

export type WorkOrderItemInput = { productId: number; quantity: number; launchDate: string; withdrawnBy: string; withdrawnByEmployeeId: number | null; application: string | null; allowNegative: boolean };

export function parseWorkOrderItem(body: Record<string, unknown>): WorkOrderItemInput {
  const productId = Number(body.productId);
  if (!Number.isInteger(productId) || productId <= 0) throw new StockError("Escolha o produto.");
  const quantity = Number(String(body.quantity ?? "").replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) throw new StockError("A quantidade deve ser maior que zero.");
  const launchDate = clean(body.launchDate) || localToday();
  if (!isIsoDay(launchDate) || launchDate > localToday()) throw new StockError("Informe a data de lançamento da peça (não futura).");
  const withdrawnBy = clean(body.withdrawnBy).toUpperCase().slice(0, 120);
  if (!withdrawnBy) throw new StockError("Informe quem retirou a peça para aplicação.");
  const employeeId = Number(body.withdrawnByEmployeeId);
  return {
    productId, quantity, launchDate, withdrawnBy, withdrawnByEmployeeId: Number.isInteger(employeeId) && employeeId > 0 ? employeeId : null,
    application: clean(body.application).slice(0, 200) || null, allowNegative: body.allowNegative === true,
  };
}

export async function addWorkOrderItem(db: Db, user: SessionUser, id: number, input: WorkOrderItemInput) {
  const order = await requireWorkOrder(db, user, id);
  if (order.status !== "OPEN") throw new StockError("A O.S. está fechada. Reabra para lançar peças.", 409);
  if (input.launchDate < order.openedAt) throw new StockError("A data da peça não pode ser antes da abertura da O.S.");
  const product = (await db.select({ id: products.id, tag: products.tag, name: products.name, price: products.price, active: products.active }).from(products).where(eq(products.id, input.productId)).limit(1))[0];
  if (!product?.active) throw new StockError("Produto não encontrado ou desativado.", 404);
  await assertStockAvailable(db, order.serviceFrontId, [{ productId: product.id, quantity: input.quantity, label: `${product.tag} ${product.name}` }], input.allowNegative, user);
  const number = workOrderNumber(id);
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(workOrderItems).values({
      workOrderId: id, productId: product.id, quantity: input.quantity, launchDate: input.launchDate, withdrawnBy: input.withdrawnBy,
      withdrawnByEmployeeId: input.withdrawnByEmployeeId, application: input.application, unitPrice: product.price, createdBy: user.id,
    }).returning({ id: workOrderItems.id });
    await stockExit(tx, {
      productId: product.id, serviceFrontId: order.serviceFrontId, quantity: input.quantity, source: "WORK_ORDER", reason: `Peça da ${number}`,
      userId: user.id, movementDate: input.launchDate, unitPrice: product.price, equipmentId: order.equipmentId, employeeId: input.withdrawnByEmployeeId,
      refs: { workOrderId: id, workOrderItemId: row.id },
    });
    await audit(tx, user.id, id, "PEÇA LANÇADA NA O.S.", { itemId: row.id, ...input });
    return row.id;
  });
}

export async function removeWorkOrderItem(db: Db, user: SessionUser, id: number, itemId: number) {
  const order = await requireWorkOrder(db, user, id);
  if (order.status !== "OPEN") throw new StockError("A O.S. está fechada. Reabra para retirar peças.", 409);
  const item = (await db.select().from(workOrderItems).where(and(eq(workOrderItems.id, itemId), eq(workOrderItems.workOrderId, id))).limit(1))[0];
  if (!item || item.removedAt) throw new StockError("Peça não encontrada nesta O.S.", 404);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(workOrderItems).set({ removedAt: now, removedBy: user.id, updatedAt: now }).where(eq(workOrderItems.id, itemId));
    await reverseStockMovements(tx, { workOrderItemId: itemId }, user.id, `Peça retirada da ${workOrderNumber(id)}`);
    await audit(tx, user.id, id, "PEÇA RETIRADA DA O.S.", { itemId });
  });
}

export async function setWorkOrderStatus(db: Db, user: SessionUser, id: number, status: "OPEN" | "CLOSED", notes: string | null) {
  const order = await requireWorkOrder(db, user, id);
  if (order.status === status) throw new StockError(status === "CLOSED" ? "Esta O.S. já está fechada." : "Esta O.S. já está aberta.", 409);
  const now = new Date().toISOString();
  await db.update(workOrders).set(status === "CLOSED"
    ? { status, closedAt: now, closedBy: user.id, closingNotes: notes, updatedAt: now }
    : { status, closedAt: null, closedBy: null, updatedAt: now }).where(eq(workOrders.id, id));
  await audit(db, user.id, id, status === "CLOSED" ? "O.S. FECHADA" : "O.S. REABERTA", { notes });
  return workOrderNumber(id);
}
