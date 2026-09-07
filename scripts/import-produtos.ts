// Importa produtos_import.csv (peças, insumos, EPI e mantimentos) para a tabela
// `products`, casando a coluna "aplicacao" com `equipment_models` e marcando
// `needs_review` a partir da aba "Revisar" da planilha tratada.
//
// Upsert por TAG (products.tag é único) — rodar duas vezes não duplica nada,
// só atualiza os campos com o conteúdo mais recente do CSV.
//
// Uso:
//   npx tsx scripts/import-produtos.ts
//   npx tsx scripts/import-produtos.ts --arquivo=caminho/para/outro.csv
import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { equipmentModels, products } from "../db/schema";
import { GARBAGE_TAGS, isGenericApplication, matchEquipmentModel, needsReviewFor, parsePrice, parseProductsCsv } from "../lib/products-import";

const fileArg = process.argv.find((arg) => arg.startsWith("--arquivo="));
const filePath = fileArg
  ? fileArg.slice("--arquivo=".length)
  : new URL("./import-produtos/data/produtos_import.csv", import.meta.url);

async function main() {
  const content = readFileSync(filePath, "utf-8");
  const rows = parseProductsCsv(content);

  const db = await getDb();
  const models = await db.select({ id: equipmentModels.id, name: equipmentModels.name }).from(equipmentModels);
  if (models.length === 0) {
    console.error("Nenhum equipment_model cadastrado. Rode `npx tsx scripts/seed-equipment-models.ts` antes de importar.");
    process.exit(1);
  }

  let skippedGarbage = 0;
  let inserted = 0;
  let updated = 0;
  let linkedToModel = 0;
  let markedNeedsReview = 0;
  const unmatchedApplications = new Map<string, number>();

  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (GARBAGE_TAGS.has(row.tag)) {
        skippedGarbage++;
        continue;
      }
      if (!row.tag) continue;

      const price = parsePrice(row.preco) ?? 0;
      const name = row.nome.toUpperCase();
      const reference = row.referencia ? row.referencia.toUpperCase() : null;

      // fornecedor/marca vêm vazios de propósito nesta base tratada — importados como NULL,
      // conforme a especificação do módulo (preenchimento fica para a tela de cadastro/edição).
      const supplierId: number | null = null;
      const brand: string | null = null;

      let equipmentModelId: number | null = null;
      const generic = isGenericApplication(row.aplicacao);
      if (row.aplicacao && !generic) {
        const match = matchEquipmentModel(row.aplicacao, models);
        if (match) {
          equipmentModelId = match.id;
          linkedToModel++;
        } else {
          unmatchedApplications.set(row.aplicacao, (unmatchedApplications.get(row.aplicacao) ?? 0) + 1);
        }
      }

      const review = needsReviewFor(row.tag, price);
      const needsReview = review.needsReview || generic;
      if (needsReview) markedNeedsReview++;

      const now = new Date().toISOString();
      const existing = await tx.select({ id: products.id }).from(products).where(eq(products.tag, row.tag)).limit(1);
      await tx
        .insert(products)
        .values({ tag: row.tag, name, reference, price, supplierId, brand, equipmentModelId, needsReview, updatedAt: now })
        .onConflictDoUpdate({
          target: products.tag,
          set: { name, reference, price, supplierId, brand, equipmentModelId, needsReview, updatedAt: now },
        });
      if (existing.length > 0) updated++;
      else inserted++;
    }
  });

  console.log("[import-produtos] Concluído.");
  console.log(`  total lido no CSV: ${rows.length}`);
  console.log(`  ignorados (linhas inválidas da planilha de origem): ${skippedGarbage}`);
  console.log(`  inseridos: ${inserted}`);
  console.log(`  atualizados: ${updated}`);
  console.log(`  vinculados a um modelo de equipamento: ${linkedToModel}`);
  console.log(`  marcados para revisão (needs_review): ${markedNeedsReview}`);
  if (unmatchedApplications.size > 0) {
    console.log(`  aplicações que não casaram com nenhum modelo (${unmatchedApplications.size} distintas):`);
    for (const [application, count] of unmatchedApplications) console.log(`    - ${application} (${count}x)`);
  } else {
    console.log("  aplicações que não casaram com nenhum modelo: nenhuma");
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("[import-produtos] Falhou:", error);
  process.exit(1);
});
