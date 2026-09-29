import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { productFrontStock, productStockMovements } from "../db/schema";
import { activateInFront, productAudit } from "./products-data";

// ---------------------------------------------------------------------------------------------
// SERVIÇO ÚNICO DE ESTOQUE. Toda entrada/saída de produto — Solicitação de Materiais (transferência
// entre frentes), Solicitação de Pedidos/Compras (entrada no recebimento), Movimentação (saída para
// funcionário/equipamento), Ordem de Serviço (peças) e ajuste manual na ficha do produto — passa
// por aqui. Nenhum outro lugar altera product_front_stock ou grava product_stock_movements: assim
// as regras (saldo, rastro, estorno, auditoria) são as mesmas em todos os módulos.
// Todas as funções recebem o `db` ou a transação (`tx`) de quem chama.
// ---------------------------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type StockDb = Db | Tx;

export type StockSource = "MATERIAL_REQUEST" | "PURCHASE" | "STOCK_EXIT" | "WORK_ORDER" | "ADJUSTMENT";
export const STOCK_SOURCE_LABELS: Record<StockSource, string> = {
  MATERIAL_REQUEST: "Solicitação de Materiais", PURCHASE: "Pedido de compra", STOCK_EXIT: "Movimentação (saída)",
  WORK_ORDER: "Ordem de Serviço", ADJUSTMENT: "Ajuste manual",
};

// Documento de origem do movimento (uma chave só por movimento, conforme a origem).
export type StockRefs = {
  materialRequestId?: number; materialRequestItemId?: number;
  purchaseOrderId?: number; purchaseOrderItemId?: number;
  stockExitId?: number; stockExitItemId?: number;
  workOrderId?: number; workOrderItemId?: number;
};

export type StockMovementInput = {
  productId: number;
  serviceFrontId: number;
  source: StockSource;
  reason: string;
  userId: number;
  movementDate?: string | null;
  unitPrice?: number | null;
  equipmentId?: number | null;
  employeeId?: number | null;
  departmentId?: number | null;
  refs?: StockRefs;
};

export class StockError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400, public shortages?: StockShortage[]) { super(message); }
}
export function stockErrorResponse(error: unknown) {
  return error instanceof StockError ? Response.json({ error: error.message, shortages: error.shortages }, { status: error.status }) : null;
}

export type StockShortage = { productId: number; label: string; requested: number; available: number };

// Saldo atual por frente dos produtos informados: Map<productId, Map<frontId, quantidade>>.
export async function productStockByFront(db: StockDb, productIds: number[]) {
  const map = new Map<number, Map<number, number>>();
  if (productIds.length === 0) return map;
  const rows = await db.select({ productId: productFrontStock.productId, serviceFrontId: productFrontStock.serviceFrontId, quantity: productFrontStock.quantity })
    .from(productFrontStock).where(inArray(productFrontStock.productId, [...new Set(productIds)]));
  for (const row of rows) map.set(row.productId, (map.get(row.productId) ?? new Map()).set(row.serviceFrontId, Number(row.quantity)));
  return map;
}

// Itens que ficariam com saldo negativo na frente (quantidade somada por produto).
export async function stockShortages(db: StockDb, frontId: number, lines: Array<{ productId: number; quantity: number; label: string }>): Promise<StockShortage[]> {
  const stock = await productStockByFront(db, lines.map((line) => line.productId));
  const totals = new Map<number, { quantity: number; label: string }>();
  for (const line of lines) totals.set(line.productId, { quantity: (totals.get(line.productId)?.quantity ?? 0) + line.quantity, label: line.label });
  return [...totals].map(([productId, total]) => ({ productId, label: total.label, requested: total.quantity, available: stock.get(productId)?.get(frontId) ?? 0 }))
    .filter((line) => line.available < line.requested);
}

// Saída sem saldo só passa com a confirmação explícita de quem lança (allowNegative) — a mesma
// regra do envio da Solicitação de Materiais — e essa confirmação só vale de ADMIN ou GESTOR
// (estoque negativo é sempre um problema a conferir; quem lança no dia a dia não decide sozinho).
export function canAuthorizeNegativeStock(user: { profile: string }) {
  return user.profile === "ADMIN" || user.profile === "GESTOR";
}

export const NEGATIVE_STOCK_NEEDS_MANAGER = "Saída sem saldo só pode ser confirmada por um gestor ou administrador. Confira o estoque ou peça a um gestor para lançar.";

export async function assertStockAvailable(db: StockDb, frontId: number, lines: Array<{ productId: number; quantity: number; label: string }>, allowNegative: boolean, user?: { profile: string }) {
  if (lines.length === 0) return;
  const shortages = await stockShortages(db, frontId, lines);
  if (!shortages.length) return;
  if (!allowNegative) throw new StockError("Saldo insuficiente no estoque da frente para alguns produtos.", 409, shortages);
  if (user && !canAuthorizeNegativeStock(user)) throw new StockError(NEGATIVE_STOCK_NEEDS_MANAGER, 403, shortages);
}

async function applyBalance(db: StockDb, productId: number, serviceFrontId: number, delta: number, userId: number) {
  // Frente que ainda não tinha o produto passa a tê-lo ativo (mesma regra de "Ativar nesta frente").
  await activateInFront(db, productId, serviceFrontId, userId);
  await db.update(productFrontStock).set({ quantity: sql`${productFrontStock.quantity} + ${delta}`, updatedAt: new Date().toISOString() })
    .where(and(eq(productFrontStock.productId, productId), eq(productFrontStock.serviceFrontId, serviceFrontId)));
}

// Grava um movimento (saldo + rastro + auditoria). delta > 0 entrada, delta < 0 saída.
export async function recordStockMovement(db: StockDb, input: StockMovementInput & { delta: number }) {
  if (!Number.isFinite(input.delta) || input.delta === 0) throw new StockError("Quantidade inválida para movimentar o estoque.");
  await applyBalance(db, input.productId, input.serviceFrontId, input.delta, input.userId);
  const [row] = await db.insert(productStockMovements).values({
    productId: input.productId, serviceFrontId: input.serviceFrontId, delta: input.delta, reason: input.reason, source: input.source,
    movementDate: input.movementDate ?? null, unitPrice: input.unitPrice ?? null, equipmentId: input.equipmentId ?? null, employeeId: input.employeeId ?? null,
    departmentId: input.departmentId ?? null, ...input.refs, createdBy: input.userId,
  }).returning({ id: productStockMovements.id });
  await productAudit(db, input.userId, input.productId, input.delta > 0 ? "ENTRADA NO ESTOQUE" : "SAÍDA DO ESTOQUE", undefined,
    { serviceFrontId: input.serviceFrontId, quantity: Math.abs(input.delta), source: input.source, reason: input.reason, movementId: row.id });
  return row.id;
}

export async function stockEntry(db: StockDb, input: StockMovementInput & { quantity: number }) {
  if (!(input.quantity > 0)) throw new StockError("A quantidade de entrada precisa ser maior que zero.");
  return recordStockMovement(db, { ...input, delta: input.quantity });
}

export async function stockExit(db: StockDb, input: StockMovementInput & { quantity: number }) {
  if (!(input.quantity > 0)) throw new StockError("A quantidade de saída precisa ser maior que zero.");
  return recordStockMovement(db, { ...input, delta: -input.quantity });
}

// Transferência entre frentes (Solicitação de Materiais): sai de uma, entra na outra.
export async function transferStock(db: StockDb, input: Omit<StockMovementInput, "serviceFrontId"> & { fromFrontId: number; toFrontId: number; quantity: number }) {
  const { fromFrontId, toFrontId, quantity, ...rest } = input;
  await stockExit(db, { ...rest, serviceFrontId: fromFrontId, quantity });
  await stockEntry(db, { ...rest, serviceFrontId: toFrontId, quantity });
}

// Ajuste manual (ficha do produto): grava a diferença como movimento, para aparecer no histórico.
export async function setStockLevel(db: StockDb, input: { productId: number; serviceFrontId: number; quantity: number; userId: number; reason?: string }) {
  const current = (await db.select({ quantity: productFrontStock.quantity }).from(productFrontStock)
    .where(and(eq(productFrontStock.productId, input.productId), eq(productFrontStock.serviceFrontId, input.serviceFrontId))).limit(1))[0];
  const delta = input.quantity - Number(current?.quantity ?? 0);
  if (delta === 0) { await activateInFront(db, input.productId, input.serviceFrontId, input.userId); return null; }
  return recordStockMovement(db, { productId: input.productId, serviceFrontId: input.serviceFrontId, delta, source: "ADJUSTMENT", reason: input.reason ?? "Ajuste manual do saldo na ficha do produto", userId: input.userId });
}

const REF_COLUMNS = {
  materialRequestId: productStockMovements.materialRequestId, materialRequestItemId: productStockMovements.materialRequestItemId,
  purchaseOrderId: productStockMovements.purchaseOrderId, purchaseOrderItemId: productStockMovements.purchaseOrderItemId,
  stockExitId: productStockMovements.stockExitId, stockExitItemId: productStockMovements.stockExitItemId,
  workOrderId: productStockMovements.workOrderId, workOrderItemId: productStockMovements.workOrderItemId,
} as const;

// Estorna os movimentos ainda válidos de um documento (reabrir solicitação, cancelar saída, tirar
// peça da O.S.): devolve o saldo e marca reversedAt. Devolve quantos movimentos foram estornados.
export async function reverseStockMovements(db: StockDb, refs: StockRefs, userId: number, reason: string) {
  const conditions: SQL[] = Object.entries(refs).filter(([, value]) => value !== undefined)
    .map(([key, value]) => eq(REF_COLUMNS[key as keyof StockRefs], value as number));
  if (conditions.length === 0) throw new StockError("Documento de origem não informado para o estorno.");
  const movements = await db.select().from(productStockMovements).where(and(...conditions, isNull(productStockMovements.reversedAt)));
  const now = new Date().toISOString();
  for (const movement of movements) {
    await applyBalance(db, movement.productId, movement.serviceFrontId, -movement.delta, userId);
    await db.update(productStockMovements).set({ reversedAt: now, updatedAt: now }).where(eq(productStockMovements.id, movement.id));
    await productAudit(db, userId, movement.productId, "ESTOQUE ESTORNADO", undefined, { serviceFrontId: movement.serviceFrontId, quantity: -movement.delta, reason, movementId: movement.id });
  }
  return movements.length;
}
