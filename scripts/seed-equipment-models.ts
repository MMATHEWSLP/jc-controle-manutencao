// Semeia a lista de modelos de equipamento usada pelo campo "Aplicação" do módulo Produtos.
// Idempotente: roda `onConflictDoNothing` pelo nome único, então rodar de novo não duplica nada
// nem sobrescreve edições manuais feitas depois pelo ADMIN (categoria/fabricante/ativo).
//
// Uso: npx tsx scripts/seed-equipment-models.ts
import "dotenv/config";
import { getDb } from "../db";
import { equipmentModels } from "../db/schema";

const MODELS: Array<{ name: string; manufacturer: string | null; category: string }> = [
  { name: "MB AXOR 3344", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB AXOR 2544", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB AXOR 2831", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB ATEGO 1725", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB ATEGO 1726", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB ATEGO 1720", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB ATEGO 1315", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB 1720", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB 1723", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB 1620", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "MB 1418", manufacturer: "MERCEDES-BENZ", category: "CAMINHÃO" },
  { name: "CAT D6N", manufacturer: "CATERPILLAR", category: "TRATOR DE ESTEIRA" },
  { name: "CAT D6G", manufacturer: "CATERPILLAR", category: "TRATOR DE ESTEIRA" },
  { name: "CAT D6", manufacturer: "CATERPILLAR", category: "TRATOR DE ESTEIRA" },
  { name: "CAT D5", manufacturer: "CATERPILLAR", category: "TRATOR DE ESTEIRA" },
  { name: "CAT D5N", manufacturer: "CATERPILLAR", category: "TRATOR DE ESTEIRA" },
  { name: "CAT 938K", manufacturer: "CATERPILLAR", category: "PÁ CARREGADEIRA" },
  { name: "CAT 930T", manufacturer: "CATERPILLAR", category: "PÁ CARREGADEIRA" },
  { name: "CAT 140GC", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 140H", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 140G", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 120H", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 120G", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 120K", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 135H", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 12H", manufacturer: "CATERPILLAR", category: "MOTONIVELADORA" },
  { name: "CAT 545C", manufacturer: "CATERPILLAR", category: "SKIDDER" },
  { name: "CAT 540C", manufacturer: "CATERPILLAR", category: "SKIDDER" },
  { name: "CAT 525C", manufacturer: "CATERPILLAR", category: "SKIDDER" },
  { name: "CAT 525D", manufacturer: "CATERPILLAR", category: "SKIDDER" },
  { name: "TIGERCAT 630H", manufacturer: "TIGERCAT", category: "SKIDDER" },
  { name: "VOLVO L90F", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L90H", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L90", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L60F", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L60", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L110H", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "VOLVO L110F", manufacturer: "VOLVO", category: "PÁ CARREGADEIRA" },
  { name: "FORD F-4000", manufacturer: "FORD", category: "CAMINHÃO" },
  { name: "VW 13.190", manufacturer: "VOLKSWAGEN", category: "CAMINHÃO" },
  { name: "TOYOTA HILUX", manufacturer: "TOYOTA", category: "CAMIONETE" },
  { name: "MITSUBISHI L200", manufacturer: "MITSUBISHI", category: "CAMIONETE" },
  { name: "STIHL MS 661", manufacturer: "STIHL", category: "MOTOSSERRA" },
  { name: "STIHL MS 660", manufacturer: "STIHL", category: "MOTOSSERRA" },
  { name: "STIHL MS 651", manufacturer: "STIHL", category: "MOTOSSERRA" },
  { name: "STIHL MS 462", manufacturer: "STIHL", category: "MOTOSSERRA" },
  { name: "STIHL MS 361", manufacturer: "STIHL", category: "MOTOSSERRA" },
  { name: "CARRETA / SEMIRREBOQUE", manufacturer: null, category: "IMPLEMENTO" },
  { name: "MOTOR ESTACIONARIO MWM", manufacturer: "MWM", category: "ESTACIONÁRIO" },
  { name: "COMPRESSOR DE AR", manufacturer: null, category: "ESTACIONÁRIO" },
];

async function main() {
  const db = await getDb();
  let inserted = 0;
  let skipped = 0;
  for (const model of MODELS) {
    const result = await db
      .insert(equipmentModels)
      .values({ name: model.name, manufacturer: model.manufacturer, category: model.category })
      .onConflictDoNothing({ target: equipmentModels.name })
      .returning({ id: equipmentModels.id });
    if (result.length > 0) inserted++;
    else skipped++;
  }
  console.log(`[seed-equipment-models] ${MODELS.length} modelos processados — ${inserted} inseridos, ${skipped} já existiam.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[seed-equipment-models] Falhou:", error);
  process.exit(1);
});
