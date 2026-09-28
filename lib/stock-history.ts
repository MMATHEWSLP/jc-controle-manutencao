import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { employees, equipment, productStockMovements, products, serviceFronts, users, workOrderItems, workOrders } from "../db/schema";
import { materialRequestNumber, purchaseOrderNumber, stockExitNumber, workOrderNumber } from "./document-numbers";
import { STOCK_SOURCE_LABELS, type StockSource } from "./stock";

type Db = Awaited<ReturnType<typeof getDb>>;

// Filtros do histórico de movimentações (aba Histórico do produto e Histórico da Movimentação).
export type StockHistoryFilters = {
  productId?: number | null;
  equipmentId?: number | null;
  employeeId?: number | null;
  sources?: StockSource[];
  // Só saídas (delta < 0).
  exitsOnly?: boolean;
  // Peças de O.S. só entram depois que a O.S. é fechada (Histórico da Movimentação).
  closedWorkOrdersOnly?: boolean;
  from?: string | null;
  to?: string | null;
  fronts: number[] | "ALL";
  limit?: number;
};

// Número do documento de origem do movimento (rastreio): SOL-/PED-/SAI-/OS- ou "Ajuste" (manual).
export function originNumber(row: { source: string; materialRequestId: number | null; purchaseOrderId: number | null; stockExitId: number | null; workOrderId: number | null }) {
  if (row.source === "MATERIAL_REQUEST" && row.materialRequestId) return materialRequestNumber(row.materialRequestId);
  if (row.source === "PURCHASE" && row.purchaseOrderId) return purchaseOrderNumber(row.purchaseOrderId);
  if (row.source === "STOCK_EXIT" && row.stockExitId) return stockExitNumber(row.stockExitId);
  if (row.source === "WORK_ORDER" && row.workOrderId) return workOrderNumber(row.workOrderId);
  return row.source === "ADJUSTMENT" ? "Ajuste" : "—";
}

export async function listStockMovements(db: Db, filters: StockHistoryFilters) {
  if (filters.fronts !== "ALL" && filters.fronts.length === 0) return [];
  const creator = alias(users, "movement_creator");
  const day = sql<string>`coalesce(${productStockMovements.movementDate}, substr(${productStockMovements.createdAt}, 1, 10))`;
  const conditions: SQL[] = [];
  if (filters.fronts !== "ALL") conditions.push(inArray(productStockMovements.serviceFrontId, filters.fronts));
  if (filters.productId) conditions.push(eq(productStockMovements.productId, filters.productId));
  if (filters.equipmentId) conditions.push(eq(productStockMovements.equipmentId, filters.equipmentId));
  if (filters.employeeId) conditions.push(eq(productStockMovements.employeeId, filters.employeeId));
  if (filters.sources?.length) conditions.push(inArray(productStockMovements.source, filters.sources));
  if (filters.exitsOnly) conditions.push(sql`${productStockMovements.delta} < 0`, isNull(productStockMovements.reversedAt));
  if (filters.closedWorkOrdersOnly) conditions.push(or(sql`${productStockMovements.source} <> 'WORK_ORDER'`, eq(workOrders.status, "CLOSED"))!);
  if (filters.from) conditions.push(gte(day, filters.from));
  if (filters.to) conditions.push(lte(day, filters.to));
  const rows = await db.select({
    id: productStockMovements.id, day, createdAt: productStockMovements.createdAt, delta: productStockMovements.delta, reason: productStockMovements.reason,
    source: productStockMovements.source, unitPrice: productStockMovements.unitPrice, reversedAt: productStockMovements.reversedAt,
    productId: productStockMovements.productId, productTag: products.tag, productName: products.name, productPrice: products.price,
    serviceFrontId: productStockMovements.serviceFrontId, frontName: serviceFronts.name,
    equipmentId: productStockMovements.equipmentId, equipmentPrefix: equipment.prefix,
    employeeId: productStockMovements.employeeId, employeeName: employees.name,
    materialRequestId: productStockMovements.materialRequestId, purchaseOrderId: productStockMovements.purchaseOrderId,
    stockExitId: productStockMovements.stockExitId, workOrderId: productStockMovements.workOrderId, workOrderStatus: workOrders.status,
    application: workOrderItems.application, withdrawnBy: workOrderItems.withdrawnBy,
    createdByName: creator.name,
  }).from(productStockMovements)
    .innerJoin(products, eq(productStockMovements.productId, products.id))
    .innerJoin(serviceFronts, eq(productStockMovements.serviceFrontId, serviceFronts.id))
    .leftJoin(equipment, eq(productStockMovements.equipmentId, equipment.id))
    .leftJoin(employees, eq(productStockMovements.employeeId, employees.id))
    .leftJoin(workOrders, eq(productStockMovements.workOrderId, workOrders.id))
    .leftJoin(workOrderItems, eq(productStockMovements.workOrderItemId, workOrderItems.id))
    .leftJoin(creator, eq(productStockMovements.createdBy, creator.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(day), desc(productStockMovements.id))
    .limit(Math.min(filters.limit ?? 500, 2000));
  return rows.map((row) => {
    const unitPrice = row.unitPrice ?? null;
    const quantity = Math.abs(row.delta);
    return {
      id: row.id, date: row.day, createdAt: row.createdAt, type: row.delta > 0 ? "ENTRADA" as const : "SAIDA" as const, quantity,
      source: row.source, sourceLabel: STOCK_SOURCE_LABELS[row.source as StockSource] ?? row.source, originNumber: originNumber(row),
      originId: row.materialRequestId ?? row.purchaseOrderId ?? row.stockExitId ?? row.workOrderId ?? null,
      workOrderOpen: row.source === "WORK_ORDER" && row.workOrderStatus === "OPEN",
      product: { id: row.productId, tag: row.productTag, name: row.productName },
      front: row.frontName, serviceFrontId: row.serviceFrontId,
      equipment: row.equipmentId ? { id: row.equipmentId, prefix: row.equipmentPrefix } : null,
      employee: row.employeeId ? { id: row.employeeId, name: row.employeeName } : null,
      // Aplicação: onde a peça da O.S. foi aplicada; na falta, o destino da saída.
      application: row.application || row.equipmentPrefix || row.employeeName || null,
      withdrawnBy: row.withdrawnBy, unitPrice, total: unitPrice === null ? null : unitPrice * quantity,
      reason: row.reason, reversed: row.reversedAt !== null, createdBy: row.createdByName,
    };
  });
}
export type StockHistoryRow = Awaited<ReturnType<typeof listStockMovements>>[number];
