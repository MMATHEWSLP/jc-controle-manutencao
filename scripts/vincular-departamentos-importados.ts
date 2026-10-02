// Cadastra os departamentos que vieram como texto na importação de movimentações (histórico do
// almoxarifado antigo) e vincula as saídas do lote a eles (department_id). Usa o mesmo cadastro da
// tela de Departamentos (lib/departments.ts: nome em maiúsculas, chave sem acento/pontuação — um
// departamento já cadastrado com a mesma chave é reaproveitado e reativado, nunca duplicado).
// AJUSTE (Correção de Estoque) não é departamento e fica de fora. O saldo não é tocado.
//
// Uso:
//   npx tsx scripts/vincular-departamentos-importados.ts --lote=1              -> simulação
//   npx tsx scripts/vincular-departamentos-importados.ts --lote=1 --confirmar  -> grava
import "dotenv/config";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, departments, productStockMovements, stockImportBatches, users } from "../db/schema";
import { catalogKey, departmentName } from "../lib/catalog-rules";
import { createDepartment } from "../lib/departments";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)?.trim();
const confirm = process.argv.includes("--confirmar");
const batchId = Number(arg("lote"));

async function main() {
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("Informe --lote.");
  if (!confirm) process.env.DATABASE_READ_ONLY = "1";
  const db = await getDb();
  const batch = (await db.select({ id: stockImportBatches.id, status: stockImportBatches.status, userId: stockImportBatches.userId }).from(stockImportBatches).where(eq(stockImportBatches.id, batchId)).limit(1))[0];
  if (!batch) throw new Error(`Lote #${batchId} não encontrado.`);
  if (batch.status !== "ACTIVE") throw new Error(`Lote #${batchId} não está ativo (${batch.status}).`);

  const rows = await db.select({ id: productStockMovements.id, text: productStockMovements.departmentText }).from(productStockMovements)
    .where(and(eq(productStockMovements.importBatchId, batchId), eq(productStockMovements.historyKind, "SAIDA"), isNull(productStockMovements.departmentId)));
  const groups = new Map<string, { name: string; ids: number[] }>();
  for (const row of rows) {
    const key = catalogKey(row.text ?? "");
    if (!key) continue;
    const group = groups.get(key) ?? { name: departmentName(row.text!), ids: [] };
    group.ids.push(row.id);
    groups.set(key, group);
  }
  const existing = await db.select({ id: departments.id, name: departments.name, key: departments.key, active: departments.active }).from(departments).orderBy(asc(departments.name));
  const byKey = new Map(existing.map((item) => [item.key, item]));

  console.log(`\n=== ${confirm ? "CADASTRO E VÍNCULO (grava)" : "SIMULAÇÃO (nada foi gravado)"} — lote #${batchId} ===`);
  console.log(`Departamentos já cadastrados (${existing.length}): ${existing.map((item) => `${item.name}${item.active ? "" : " (inativo)"}`).join(", ") || "nenhum"}`);
  console.log(`Saídas sem departamento vinculado e com texto: ${[...groups.values()].reduce((total, group) => total + group.ids.length, 0)}`);
  for (const [key, group] of [...groups].sort((a, b) => b[1].ids.length - a[1].ids.length)) {
    const same = byKey.get(key);
    console.log(`  ${group.name.padEnd(48)} ${String(group.ids.length).padStart(5)} linha(s) · ${same ? `já existe (#${same.id} ${same.name}${same.active ? "" : ", será reativado"})` : "SERÁ CADASTRADO"}`);
  }
  if (!groups.size) { console.log("Nada a fazer."); process.exit(0); }
  if (!confirm) { console.log("\nRode com --confirmar para gravar."); process.exit(0); }

  const admin = (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"))).orderBy(asc(users.id)).limit(1))[0];
  const userId = admin?.id ?? batch.userId;
  const summary = await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const result: Array<{ id: number; name: string; created: boolean; rows: number }> = [];
    for (const group of groups.values()) {
      const { department, created } = await createDepartment(tx, group.name, userId);
      for (let index = 0; index < group.ids.length; index += 1000) {
        await tx.update(productStockMovements).set({ departmentId: department.id, updatedAt: now }).where(inArray(productStockMovements.id, group.ids.slice(index, index + 1000)));
      }
      result.push({ id: department.id, name: department.name, created, rows: group.ids.length });
    }
    await tx.insert(auditLogs).values({ userId, entityType: "STOCK_IMPORT_BATCH", entityId: String(batchId), action: "DEPARTAMENTOS DA IMPORTAÇÃO VINCULADOS", newValue: JSON.stringify(result) });
    return result;
  });
  console.log(`\n✔ ${summary.filter((item) => item.created).length} departamento(s) cadastrado(s), ${summary.reduce((total, item) => total + item.rows, 0)} saída(s) vinculada(s):`);
  for (const item of summary) console.log(`  #${item.id} ${item.name} · ${item.rows} linha(s)${item.created ? " · novo" : " · já existia"}`);
  process.exit(0);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
