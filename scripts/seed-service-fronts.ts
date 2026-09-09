// Garante que as frentes de serviço existam, sem duplicar. Substitui o antigo bootstrap
// hardcoded em lib/front-scope.ts (que rodava a cada carga de tela e só conhecia
// Mamuru/Flexal/Arapiuns) — a partir de agora, frente nova se cadastra pela tela de
// gerenciamento (ADMIN) ou rodando este script de novo com a lista abaixo ajustada.
//
// Idempotente: roda `onConflictDoNothing` pelo nome único, então rodar de novo não duplica nada.
//
// Uso: npx tsx scripts/seed-service-fronts.ts
import "dotenv/config";
import { getDb } from "../db";
import { serviceFronts } from "../db/schema";

const FRONTS = ["Mamuru", "Flexal", "Arapiuns", "MRN", "Belém"];

async function main() {
  const db = await getDb();
  let inserted = 0;
  let skipped = 0;
  for (const name of FRONTS) {
    const result = await db.insert(serviceFronts).values({ name }).onConflictDoNothing({ target: serviceFronts.name }).returning({ id: serviceFronts.id });
    if (result.length > 0) inserted++;
    else skipped++;
  }
  console.log(`[seed-service-fronts] ${FRONTS.length} frentes processadas — ${inserted} inseridas, ${skipped} já existiam.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[seed-service-fronts] Falhou:", error);
  process.exit(1);
});
