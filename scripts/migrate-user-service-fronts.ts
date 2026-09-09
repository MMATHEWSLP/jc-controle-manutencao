// Copia a frente atual de cada usuário (users.service_front_id) para user_service_fronts, para
// que ninguém perca acesso quando o sistema passar a decidir visibilidade por essa tabela em vez
// da coluna única. A coluna continua existindo depois — vira a "frente principal" (padrão em
// formulários/relatórios), não mais a única frente que a pessoa enxerga.
//
// Idempotente: usa onConflictDoNothing na chave composta (userId, serviceFrontId), então rodar
// de novo não duplica nada.
//
// Uso: npx tsx scripts/migrate-user-service-fronts.ts
import "dotenv/config";
import { isNotNull } from "drizzle-orm";
import { getDb } from "../db";
import { userServiceFronts, users } from "../db/schema";

async function main() {
  const db = await getDb();
  const rows = await db
    .select({ id: users.id, serviceFrontId: users.serviceFrontId })
    .from(users)
    .where(isNotNull(users.serviceFrontId));

  let linked = 0;
  let alreadyLinked = 0;
  for (const row of rows) {
    if (row.serviceFrontId === null) continue;
    const result = await db
      .insert(userServiceFronts)
      .values({ userId: row.id, serviceFrontId: row.serviceFrontId })
      .onConflictDoNothing({ target: [userServiceFronts.userId, userServiceFronts.serviceFrontId] })
      .returning({ userId: userServiceFronts.userId });
    if (result.length > 0) linked++;
    else alreadyLinked++;
  }

  console.log(`[migrate-user-service-fronts] ${rows.length} usuários com frente principal analisados.`);
  console.log(`  vínculos criados agora: ${linked}`);
  console.log(`  já existiam: ${alreadyLinked}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[migrate-user-service-fronts] Falhou:", error);
  process.exit(1);
});
