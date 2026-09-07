// Tenta casar cada um dos equipamentos já cadastrados (campo `equipment.model`,
// texto livre) com um `equipment_models.name` da lista semeada por
// seed-equipment-models.ts, preenchendo `equipment.equipmentModelId`.
//
// Nunca sobrescreve `equipment.brand`/`equipment.model` (texto livre continua
// existindo como está hoje) e só vincula quando todas as palavras do nome do
// modelo aparecem no texto do equipamento — na dúvida, fica NULL para revisão
// manual do ADMIN, exatamente como pedido na especificação do módulo.
//
// Uso: npx tsx scripts/link-equipment-models.ts
import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { equipment, equipmentModels } from "../db/schema";
import { normalizeMatchKey } from "../lib/products-import";

// Abreviações usadas nos nomes semeados (ex.: "MB ATEGO 1725", "CAT D6N") que
// não aparecem literalmente no `brand` cadastrado (ex.: "MERCEDES-BENZ",
// "CATERPILLAR") — sem isso, nenhum caminhão Mercedes-Benz bateria com o "MB"
// do nome do modelo.
const BRAND_ALIASES: Record<string, string[]> = {
  "MERCEDES-BENZ": ["MB"],
  CATERPILLAR: ["CAT"],
  VOLKSWAGEN: ["VW"],
};

function candidateText(brand: string, model: string): string {
  const aliases = BRAND_ALIASES[normalizeMatchKey(brand)] ?? [];
  return normalizeMatchKey([brand, ...aliases, model].join(" "));
}

function modelTokens(name: string): string[] {
  return normalizeMatchKey(name).split(" ").filter(Boolean);
}

async function main() {
  const db = await getDb();
  const models = await db.select({ id: equipmentModels.id, name: equipmentModels.name }).from(equipmentModels);
  const rows = await db
    .select({ id: equipment.id, prefix: equipment.prefix, brand: equipment.brand, model: equipment.model })
    .from(equipment)
    .where(isNull(equipment.equipmentModelId));

  const modelsWithTokens = models.map((model) => ({ ...model, tokens: modelTokens(model.name) }));

  let linked = 0;
  const unmatched: string[] = [];
  const ambiguous: string[] = [];

  for (const row of rows) {
    const text = candidateText(row.brand, row.model);
    // Casamento por tokens: só vincula quando TODAS as palavras do nome do modelo aparecem no
    // texto marca+model(+apelido de marca) do equipamento. Prefere falso negativo (fica NULL) a
    // falso positivo (vincular errado) — a especificação pede exatamente essa cautela.
    const matches = modelsWithTokens.filter((model) => model.tokens.length > 0 && model.tokens.every((token) => text.includes(token)));
    if (matches.length === 1) {
      await db.update(equipment).set({ equipmentModelId: matches[0].id }).where(eq(equipment.id, row.id));
      linked++;
    } else if (matches.length > 1) {
      ambiguous.push(`${row.prefix} · ${row.brand} ${row.model} → ${matches.map((match) => match.name).join(" / ")}`);
    } else {
      unmatched.push(`${row.prefix} · ${row.brand} ${row.model}`);
    }
  }

  console.log(`[link-equipment-models] ${rows.length} equipamentos sem vínculo analisados.`);
  console.log(`  vinculados agora: ${linked}`);
  console.log(`  ambíguos (mais de um modelo bateu, ficou NULL): ${ambiguous.length}`);
  ambiguous.forEach((line) => console.log(`    - ${line}`));
  console.log(`  sem correspondência (ficou NULL): ${unmatched.length}`);
  unmatched.forEach((line) => console.log(`    - ${line}`));
  process.exit(0);
}

main().catch((error) => {
  console.error("[link-equipment-models] Falhou:", error);
  process.exit(1);
});
