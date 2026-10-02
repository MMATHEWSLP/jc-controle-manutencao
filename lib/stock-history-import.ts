import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { auditLogs, departments, employees, equipment, productFrontStock, productStockMovements, products, serviceFronts, stockImportBatches, users } from "../db/schema";
import type { SessionUser } from "./auth";
import { productAudit, activateInFront } from "./products-data";
import { nextSequentialTag } from "./product-rules";
import {
  analyzeHistory, chunk, DEFAULT_CUTOFF_DATE, DEFAULT_FRONT_NAME, equipmentKey, HISTORY_ORIGIN, historyNameKey, historyReason, parseHistoryDate,
  type HistoryContext, type HistoryOptions, type HistoryRawRow, type HistoryResolvedRow, type ProductDecision,
} from "./stock-history-import-rules";

// ---------------------------------------------------------------------------------------------
// Produtos → Importar movimentações (histórico do almoxarifado antigo). Só ADMIN.
//  - analyze: prévia sem gravar (lib/stock-history-import-rules.ts).
//  - confirm: analisa DE NOVO no servidor com as decisões da tela, cria o lote, cadastra os produtos
//    novos e grava as linhas em blocos de 500, cada bloco na sua transação (não estoura o tempo da
//    requisição na Hostinger). Se um bloco falhar, o que já foi gravado é desfeito e o lote fica FAILED.
//  - revert: "Desfazer importação" — apaga as linhas do lote, devolve ao saldo as que baixaram estoque
//    e remove os produtos criados pelo lote que não foram usados em outro lugar.
// As linhas gravadas aqui NÃO passam por lib/stock.ts de propósito: por padrão são só histórico
// (affects_balance = FALSE). As que baixam saldo (saídas posteriores ao corte, se o ADMIN marcou)
// usam a mesma atualização de product_front_stock do serviço de estoque.
// ---------------------------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export class HistoryImportError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export const canImportHistory = (user: SessionUser) => user.profile === "ADMIN";

export async function historyFronts(db: Db) {
  const fronts = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(serviceFronts.name);
  const preferred = fronts.find((front) => historyNameKey(front.name).includes(historyNameKey(DEFAULT_FRONT_NAME)));
  return { fronts, defaultFrontId: preferred?.id ?? fronts[0]?.id ?? null };
}

function dateRange(rows: HistoryRawRow[]) {
  let from: string | null = null, to: string | null = null;
  for (const row of rows) {
    const day = parseHistoryDate(row.values[0] ?? null);
    if (!day) continue;
    if (!from || day < from) from = day;
    if (!to || day > to) to = day;
  }
  return { from, to };
}

const day = sql<string>`coalesce(${productStockMovements.movementDate}, substr(${productStockMovements.createdAt}, 1, 10))`;

export async function loadHistoryContext(db: Db, rows: HistoryRawRow[], frontId: number): Promise<HistoryContext> {
  const { from, to } = dateRange(rows);
  const [productRows, equipmentRows, employeeRows, departmentRows, frontRows, systemRows, historyRows, balanceRows] = await Promise.all([
    db.select({ id: products.id, tag: products.tag, name: products.name, price: products.price, active: products.active }).from(products),
    db.select({ id: equipment.id, code: equipment.code, prefix: equipment.prefix, plate: equipment.plate, chassis: equipment.chassis, serialNumber: equipment.serialNumber }).from(equipment),
    db.select({ id: employees.id, name: employees.name }).from(employees),
    db.select({ id: departments.id, name: departments.name }).from(departments),
    db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts),
    from && to ? db.select({
      id: productStockMovements.id, day, productId: productStockMovements.productId, delta: productStockMovements.delta,
      equipmentId: productStockMovements.equipmentId, employeeId: productStockMovements.employeeId, source: productStockMovements.source,
    }).from(productStockMovements).where(and(lt(productStockMovements.delta, 0), isNull(productStockMovements.reversedAt), ne(productStockMovements.source, "HISTORY_IMPORT"), gte(day, from), lte(day, to))) : Promise.resolve([]),
    db.select({
      day, productNameText: productStockMovements.productNameText, delta: productStockMovements.delta, kind: productStockMovements.historyKind,
      employeeText: productStockMovements.employeeText, equipmentText: productStockMovements.equipmentText,
    }).from(productStockMovements).innerJoin(stockImportBatches, eq(stockImportBatches.id, productStockMovements.importBatchId))
      .where(and(eq(productStockMovements.origin, HISTORY_ORIGIN), inArray(stockImportBatches.status, ["ACTIVE", "PROCESSING"]))),
    db.select({ productId: productFrontStock.productId, quantity: productFrontStock.quantity }).from(productFrontStock).where(eq(productFrontStock.serviceFrontId, frontId)),
  ]);
  return {
    products: productRows.map((row) => ({ ...row, price: Number(row.price) })),
    equipment: equipmentRows, employees: employeeRows, departments: departmentRows, fronts: frontRows,
    systemExits: systemRows.map((row) => ({ id: row.id, day: row.day, productId: row.productId, quantity: -Number(row.delta), equipmentId: row.equipmentId, employeeId: row.employeeId, source: row.source })),
    importedHistory: historyRows.map((row) => ({
      day: row.day, productNameKey: historyNameKey(row.productNameText), quantity: -Number(row.delta), kind: row.kind ?? "SAIDA",
      employeeKey: historyNameKey(row.employeeText), equipmentKey: equipmentKey(row.equipmentText),
    })),
    balances: new Map(balanceRows.map((row) => [row.productId, Number(row.quantity)])),
  };
}

export type HistoryRequestOptions = { frontId: number | null; cutoffDate: string | null; applyBalance: boolean; decisions: Record<string, ProductDecision>; today: string };

async function resolveOptions(db: Db, input: HistoryRequestOptions): Promise<HistoryOptions> {
  const { fronts, defaultFrontId } = await historyFronts(db);
  const frontId = input.frontId ?? defaultFrontId;
  if (!frontId || !fronts.some((front) => front.id === frontId)) throw new HistoryImportError("Escolha uma frente ativa para o lançamento.");
  return { frontId, cutoffDate: input.cutoffDate ?? DEFAULT_CUTOFF_DATE, applyBalance: input.applyBalance, decisions: input.decisions, today: input.today };
}

export async function analyzeHistoryImport(db: Db, rows: HistoryRawRow[], input: HistoryRequestOptions) {
  const options = await resolveOptions(db, input);
  const context = await loadHistoryContext(db, rows, options.frontId);
  return { options, analysis: analyzeHistory(rows, context, options) };
}

function movementValues(row: HistoryResolvedRow, frontId: number, batchId: number, userId: number) {
  return {
    productId: row.productId!, serviceFrontId: frontId, delta: -row.quantity!, reason: historyReason(row.kind!), source: "HISTORY_IMPORT" as const,
    movementDate: row.date, unitPrice: row.unitPrice, equipmentId: row.equipmentId, employeeId: row.employeeId, departmentId: row.departmentId,
    createdBy: userId, affectsBalance: row.affectsBalance, origin: HISTORY_ORIGIN, importBatchId: batchId, historyKind: row.kind, importRowNumber: row.rowNumber,
    productNameText: row.productName, equipmentText: row.equipment || null, chassisText: row.chassis || null, ownerText: row.owner || null,
    equipmentDescriptionText: row.equipmentDescription || null, destinationText: row.destination || null, employeeText: row.employee || null, departmentText: row.department || null,
  };
}

// Baixa (delta < 0) ou devolução (delta > 0) agregada por produto numa frente.
async function applyBalances(tx: Tx, frontId: number, deltas: Map<number, number>, userId: number, action: string, batchId: number) {
  for (const [productId, delta] of deltas) {
    if (!delta) continue;
    await activateInFront(tx, productId, frontId, userId);
    await tx.update(productFrontStock).set({ quantity: sql`${productFrontStock.quantity} + ${delta}`, updatedAt: new Date().toISOString() })
      .where(and(eq(productFrontStock.productId, productId), eq(productFrontStock.serviceFrontId, frontId)));
    await productAudit(tx, userId, productId, action, undefined, { serviceFrontId: frontId, quantity: Math.abs(delta), importBatchId: batchId });
  }
}

export async function confirmHistoryImport(db: Db, user: SessionUser, fileName: string, rows: HistoryRawRow[], input: HistoryRequestOptions) {
  const recent = await db.select({ id: stockImportBatches.id }).from(stockImportBatches)
    .where(and(eq(stockImportBatches.status, "PROCESSING"), gte(stockImportBatches.createdAt, new Date(Date.now() - 15 * 60_000).toISOString()))).limit(1);
  if (recent.length) throw new HistoryImportError(`A importação #${recent[0].id} ainda está sendo gravada. Aguarde alguns minutos.`, 409);

  const { options, analysis } = await analyzeHistoryImport(db, rows, input);
  if (analysis.summary.productsPending > 0) {
    throw new HistoryImportError(`Falta decidir ${analysis.summary.productsPending} produto(s) não encontrado(s): vincule a um produto existente, cadastre como novo ou marque para não importar.`, 409);
  }
  const toImport = analysis.rows.filter((row) => row.status === "IMPORTAR");
  if (!toImport.length) throw new HistoryImportError("Nenhuma linha para importar (todas com erro, duplicadas ou ignoradas).", 409);

  // 1) Lote + produtos novos (uma transação).
  const now = new Date().toISOString();
  const createKeys = [...new Set(toImport.filter((row) => row.createProduct).map((row) => row.productKey))];
  const { batchId, created } = await db.transaction(async (tx) => {
    const [batch] = await tx.insert(stockImportBatches).values({ userId: user.id, fileName, serviceFrontId: options.frontId, status: "PROCESSING" }).returning({ id: stockImportBatches.id });
    const created = new Map<string, number>();
    if (createKeys.length) {
      const tags = (await tx.select({ tag: products.tag }).from(products)).map((row) => row.tag);
      for (const key of createKeys) {
        const info = analysis.unmatchedProducts.find((item) => item.key === key)!;
        const tag = nextSequentialTag(tags);
        tags.push(tag);
        const name = info.name.trim().replace(/\s+/g, " ").toUpperCase();
        const [product] = await tx.insert(products).values({ tag, name, price: Math.round(info.unitPrice * 100) / 100, needsReview: true, updatedAt: now }).returning({ id: products.id });
        await activateInFront(tx, product.id, options.frontId, user.id);
        await productAudit(tx, user.id, product.id, "PRODUTO CADASTRADO NA IMPORTAÇÃO DE MOVIMENTAÇÕES", undefined, { tag, name, price: info.unitPrice, importBatchId: batch.id });
        created.set(key, product.id);
      }
    }
    return { batchId: batch.id, created };
  });
  for (const row of toImport) if (row.createProduct) row.productId = created.get(row.productKey) ?? null;

  // 2) Linhas em blocos de 500, cada bloco numa transação.
  try {
    for (const block of chunk(toImport)) {
      await db.transaction(async (tx) => {
        await tx.insert(productStockMovements).values(block.map((row) => movementValues(row, options.frontId, batchId, user.id)));
        const deltas = new Map<number, number>();
        for (const row of block) if (row.affectsBalance) deltas.set(row.productId!, (deltas.get(row.productId!) ?? 0) - row.quantity!);
        await applyBalances(tx, options.frontId, deltas, user.id, "SAÍDA DO ESTOQUE (IMPORTAÇÃO DE MOVIMENTAÇÕES)", batchId);
      });
    }
  } catch (error) {
    await undoBatch(db, user.id, batchId, [...created.values()], "FAILED").catch((cleanup) => console.error("[history-import.cleanup]", cleanup));
    throw error;
  }

  // 3) Fecha o lote.
  const exits = toImport.filter((row) => row.kind === "SAIDA").length;
  const totalValue = Math.round(toImport.reduce((sum, row) => sum + row.total, 0) * 100) / 100;
  const balanceRows = toImport.filter((row) => row.affectsBalance).length;
  const details = {
    options: { frontId: options.frontId, cutoffDate: options.cutoffDate, applyBalance: options.applyBalance, decisions: options.decisions },
    createdProductIds: [...created.values()],
    report: {
      totalRows: analysis.summary.totalRows, duplicates: analysis.summary.duplicates, errors: analysis.summary.errors, skipped: analysis.summary.skippedRows,
      unmatchedEquipment: analysis.unmatchedEquipment, unmatchedEmployees: analysis.unmatchedEmployees, unmatchedDepartments: analysis.unmatchedDepartments,
      unmatchedProducts: analysis.unmatchedProducts.map((item) => ({ name: item.name, rows: item.rows, decision: item.decision })),
    },
  };
  await db.transaction(async (tx) => {
    await tx.update(stockImportBatches).set({
      status: "ACTIVE", rowCount: toImport.length, exitCount: exits, adjustmentCount: toImport.length - exits, balanceRowCount: balanceRows, totalValue,
      details: JSON.stringify(details), updatedAt: new Date().toISOString(),
    }).where(eq(stockImportBatches.id, batchId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "STOCK_IMPORT_BATCH", entityId: String(batchId), action: "MOVIMENTAÇÕES IMPORTADAS", newValue: JSON.stringify({ fileName, rows: toImport.length, totalValue, balanceRows, createdProducts: created.size }) });
  });
  return {
    batchId, imported: toImport.length, exits, adjustments: toImport.length - exits, totalValue, balanceRows, createdProducts: created.size,
    duplicates: analysis.summary.duplicates, errors: analysis.summary.errors, skipped: analysis.summary.skippedRows,
  };
}

// Remove as linhas do lote, devolve o saldo das que baixaram estoque e apaga os produtos criados pelo
// lote que não ficaram vinculados a mais nada.
async function undoBatch(db: Db, userId: number, batchId: number, createdProductIds: number[], status: "REVERTED" | "FAILED") {
  return db.transaction(async (tx) => {
    const affected = await tx.select({ productId: productStockMovements.productId, serviceFrontId: productStockMovements.serviceFrontId, delta: sql<number>`sum(${productStockMovements.delta})` })
      .from(productStockMovements).where(and(eq(productStockMovements.importBatchId, batchId), eq(productStockMovements.affectsBalance, true)))
      .groupBy(productStockMovements.productId, productStockMovements.serviceFrontId);
    const byFront = new Map<number, Map<number, number>>();
    for (const row of affected) byFront.set(row.serviceFrontId, (byFront.get(row.serviceFrontId) ?? new Map()).set(row.productId, -Number(row.delta)));
    for (const [frontId, deltas] of byFront) await applyBalances(tx, frontId, deltas, userId, "ESTOQUE DEVOLVIDO (IMPORTAÇÃO DESFEITA)", batchId);
    const removed = await tx.delete(productStockMovements).where(eq(productStockMovements.importBatchId, batchId)).returning({ id: productStockMovements.id });
    let deletedProducts = 0;
    for (const productId of createdProductIds) {
      try {
        await tx.transaction(async (savepoint) => { await savepoint.delete(products).where(eq(products.id, productId)); });
        deletedProducts++;
      } catch {
        // Produto já usado em outro lançamento/pedido: continua cadastrado.
      }
    }
    const now = new Date().toISOString();
    await tx.update(stockImportBatches).set({ status, revertedAt: now, revertedBy: userId, updatedAt: now }).where(eq(stockImportBatches.id, batchId));
    await tx.insert(auditLogs).values({ userId, entityType: "STOCK_IMPORT_BATCH", entityId: String(batchId), action: status === "FAILED" ? "IMPORTAÇÃO DE MOVIMENTAÇÕES FALHOU (LINHAS REMOVIDAS)" : "IMPORTAÇÃO DE MOVIMENTAÇÕES DESFEITA", newValue: JSON.stringify({ movements: removed.length, restoredProducts: affected.length, deletedProducts }) });
    return { movements: removed.length, restoredProducts: affected.length, deletedProducts, keptProducts: createdProductIds.length - deletedProducts };
  });
}

export async function revertHistoryImport(db: Db, user: SessionUser, batchId: number) {
  if (!canImportHistory(user)) throw new HistoryImportError("Somente administrador desfaz importações.", 403);
  const batch = (await db.select().from(stockImportBatches).where(eq(stockImportBatches.id, batchId)).limit(1))[0];
  if (!batch) throw new HistoryImportError("Importação não encontrada.", 404);
  if (batch.status !== "ACTIVE") throw new HistoryImportError("Esta importação não está ativa.", 409);
  let createdProductIds: number[] = [];
  try { createdProductIds = (JSON.parse(batch.details ?? "{}") as { createdProductIds?: number[] }).createdProductIds ?? []; } catch { createdProductIds = []; }
  return undoBatch(db, user.id, batchId, createdProductIds, "REVERTED");
}

export async function listHistoryImportBatches(db: Db) {
  const rows = await db.select({
    id: stockImportBatches.id, fileName: stockImportBatches.fileName, rowCount: stockImportBatches.rowCount, exitCount: stockImportBatches.exitCount,
    adjustmentCount: stockImportBatches.adjustmentCount, balanceRowCount: stockImportBatches.balanceRowCount, totalValue: stockImportBatches.totalValue,
    status: stockImportBatches.status, createdAt: stockImportBatches.createdAt, revertedAt: stockImportBatches.revertedAt, userName: users.name, front: serviceFronts.name,
  }).from(stockImportBatches).leftJoin(users, eq(users.id, stockImportBatches.userId)).leftJoin(serviceFronts, eq(serviceFronts.id, stockImportBatches.serviceFrontId))
    .orderBy(desc(stockImportBatches.id)).limit(50);
  return rows.map((row) => ({ ...row, totalValue: Number(row.totalValue) }));
}
