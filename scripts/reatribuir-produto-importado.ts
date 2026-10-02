// Corrige o produto de linhas de um lote da importação de movimentações (histórico do almoxarifado
// antigo): as linhas cujo nome na planilha é --nome passam para o produto da --tag informada. O
// produto que o próprio lote tinha cadastrado para esse nome é excluído se não ficar usado em mais
// nada (senão continua cadastrado). Só mexe em linhas de histórico (affects_balance = FALSE).
//
// Uso:
//   npx tsx scripts/reatribuir-produto-importado.ts --lote=1 --nome="CAT ÓLEO SAE 15W40 20L" --tag=69              -> simulação
//   npx tsx scripts/reatribuir-produto-importado.ts --lote=1 --nome="CAT ÓLEO SAE 15W40 20L" --tag=69 --confirmar  -> grava
import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, productStockMovements, products, stockImportBatches, users } from "../db/schema";
import { historyNameKey } from "../lib/stock-history-import-rules";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)?.trim();
const confirm = process.argv.includes("--confirmar");
const batchId = Number(arg("lote"));
const name = arg("nome") ?? "";
const tag = arg("tag") ?? "";

async function main() {
  if (!Number.isInteger(batchId) || batchId <= 0 || !name || !tag) throw new Error("Informe --lote, --nome e --tag.");
  if (!confirm) process.env.DATABASE_READ_ONLY = "1";
  const db = await getDb();
  const batch = (await db.select().from(stockImportBatches).where(eq(stockImportBatches.id, batchId)).limit(1))[0];
  if (!batch) throw new Error(`Lote #${batchId} não encontrado.`);
  if (batch.status !== "ACTIVE") throw new Error(`Lote #${batchId} não está ativo (${batch.status}).`);
  const target = (await db.select({ id: products.id, tag: products.tag, name: products.name, active: products.active }).from(products).where(eq(products.tag, tag)).limit(1))[0];
  if (!target) throw new Error(`Produto com TAG ${tag} não encontrado.`);

  const key = historyNameKey(name);
  const batchRows = await db.select({ id: productStockMovements.id, productId: productStockMovements.productId, nameText: productStockMovements.productNameText, affectsBalance: productStockMovements.affectsBalance, delta: productStockMovements.delta, unitPrice: productStockMovements.unitPrice })
    .from(productStockMovements).where(eq(productStockMovements.importBatchId, batchId));
  const rows = batchRows.filter((row) => historyNameKey(row.nameText) === key);
  if (!rows.length) throw new Error(`Nenhuma linha do lote #${batchId} com o nome "${name}".`);
  if (rows.some((row) => row.affectsBalance)) throw new Error("Há linhas que baixaram estoque: corrija pela tela (desfazer e importar de novo).");
  const toMove = rows.filter((row) => row.productId !== target.id);
  const previousIds = [...new Set(toMove.map((row) => row.productId))];
  const previous = previousIds.length ? await db.select({ id: products.id, tag: products.tag, name: products.name }).from(products).where(inArray(products.id, previousIds)) : [];
  const details = JSON.parse(batch.details ?? "{}") as { createdProductIds?: number[]; options?: { decisions?: Record<string, unknown> }; report?: { unmatchedProducts?: Array<{ name: string; decision: unknown }> } };
  const createdIds = new Set(details.createdProductIds ?? []);

  console.log(`\n=== ${confirm ? "CORREÇÃO (grava)" : "SIMULAÇÃO (nada foi gravado)"} — lote #${batchId} ===`);
  console.log(`Nome na planilha: ${name} · ${rows.length} linha(s) · quantidade ${rows.reduce((total, row) => total - row.delta, 0)} · valor R$ ${rows.reduce((total, row) => total - row.delta * (row.unitPrice ?? 0), 0).toFixed(2)}`);
  console.log(`Destino: [${target.tag}] ${target.name}${target.active ? "" : " (inativo)"}`);
  console.log(`A mover: ${toMove.length} linha(s) de ${previous.map((product) => `[${product.tag}] ${product.name}${createdIds.has(product.id) ? " (criado pelo lote)" : ""}`).join(", ") || "—"}`);
  if (!toMove.length) { console.log("Nada a fazer: as linhas já estão no produto de destino."); process.exit(0); }
  if (!confirm) { console.log("Rode com --confirmar para gravar."); process.exit(0); }

  const admin = (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"))).orderBy(users.id).limit(1))[0];
  const result = await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    await tx.update(productStockMovements).set({ productId: target.id, updatedAt: now }).where(inArray(productStockMovements.id, toMove.map((row) => row.id)));
    const deleted: string[] = [], kept: string[] = [];
    for (const product of previous) {
      if (!createdIds.has(product.id)) { kept.push(`[${product.tag}] ${product.name} (não foi criado pelo lote)`); continue; }
      const still = await tx.select({ id: productStockMovements.id }).from(productStockMovements).where(eq(productStockMovements.productId, product.id)).limit(1);
      if (still.length) { kept.push(`[${product.tag}] ${product.name} (ainda tem movimentações)`); continue; }
      try {
        await tx.transaction(async (savepoint) => { await savepoint.delete(products).where(eq(products.id, product.id)); });
        deleted.push(`[${product.tag}] ${product.name}`);
        createdIds.delete(product.id);
      } catch {
        kept.push(`[${product.tag}] ${product.name} (usado em outro cadastro)`);
      }
    }
    // O lote passa a registrar o vínculo (o "Desfazer importação" não tenta apagar o produto de destino).
    details.createdProductIds = [...createdIds];
    if (details.options?.decisions) details.options.decisions[key] = { action: "LINK", productId: target.id };
    for (const item of details.report?.unmatchedProducts ?? []) if (historyNameKey(item.name) === key) item.decision = { action: "LINK", productId: target.id };
    await tx.update(stockImportBatches).set({ details: JSON.stringify(details), updatedAt: now }).where(eq(stockImportBatches.id, batchId));
    await tx.insert(auditLogs).values({
      userId: admin?.id ?? batch.userId, entityType: "STOCK_IMPORT_BATCH", entityId: String(batchId), action: "PRODUTO DA IMPORTAÇÃO REATRIBUÍDO",
      previousValue: JSON.stringify({ name, products: previous }), newValue: JSON.stringify({ productId: target.id, tag: target.tag, movements: toMove.length, deleted, kept }),
    });
    return { deleted, kept };
  });
  console.log(`\n✔ ${toMove.length} linha(s) passaram para [${target.tag}] ${target.name}.`);
  if (result.deleted.length) console.log(`  Produto(s) excluído(s): ${result.deleted.join(", ")}`);
  if (result.kept.length) console.log(`  Mantido(s): ${result.kept.join(", ")}`);
  process.exit(0);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
