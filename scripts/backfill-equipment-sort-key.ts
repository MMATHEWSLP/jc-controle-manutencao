// Calcula equipment.sort_key para todo equipamento já cadastrado, a partir do prefixo atual.
// Necessário só uma vez, na migração — daqui pra frente, app/api/equipment/route.ts recalcula o
// sort_key sozinho a cada cadastro/edição de equipamento.
//
// Idempotente: recalcular não tem efeito colateral, pode rodar quantas vezes precisar.
//
// Uso: npx tsx scripts/backfill-equipment-sort-key.ts
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { equipment } from "../db/schema";
import { naturalSortKey } from "../lib/equipment-sort";

async function main() {
  const db = await getDb();
  const rows = await db.select({ id: equipment.id, prefix: equipment.prefix }).from(equipment);

  let updated = 0;
  for (const row of rows) {
    await db.update(equipment).set({ sortKey: naturalSortKey(row.prefix) }).where(eq(equipment.id, row.id));
    updated++;
  }

  console.log(`[backfill-equipment-sort-key] ${updated} equipamento(s) atualizados com a nova chave de ordenação.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[backfill-equipment-sort-key] Falhou:", error);
  process.exit(1);
});
