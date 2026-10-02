// Prévia (somente leitura) da criação em massa dos acessos dos operadores: quantos por frente e por
// função e quem fica de fora por falta de dados. Não grava nada (sessão READ ONLY) e não gera PIN.
// Uso: DATABASE_URL=... npx tsx scripts/previa-operadores.ts
import "dotenv/config";
process.env.DATABASE_READ_ONLY = "1";

async function main() {
  const { getDb } = await import("../db");
  const { previaCriacaoEmMassa } = await import("../lib/operadores");
  const { ALL_PERMISSIONS } = await import("../lib/auth");
  const db = await getDb();
  const admin = { id: 0, name: "Prévia", username: "", email: "", profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: true, lastAccessAt: null, createdAt: "",
    permissions: ALL_PERMISSIONS, serviceFrontId: null, serviceFrontName: null, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  const previa = await previaCriacaoEmMassa(db, admin as Parameters<typeof previaCriacaoEmMassa>[1]);
  console.log("=== PRÉVIA DA CRIAÇÃO EM MASSA (nada foi gravado) ===");
  console.log(`Funções que operam: ${previa.funcoesQueOperam.join(" | ")}`);
  console.log(`Total: ${previa.total} (criar ${previa.criar}, reativar ${previa.reativar}, vincular ${previa.vincular})`);
  console.log("\nPor frente:"); for (const row of previa.porFrente) console.log(`  ${row.nome}: ${row.total}`);
  console.log("\nPor função:"); for (const row of previa.porFuncao) console.log(`  ${row.nome}: ${row.total}`);
  console.log(`\nFora por falta de dados (${previa.foraPorDados.length}):`); for (const row of previa.foraPorDados) console.log(`  ${row.nome} — ${row.funcao} — ${row.motivo}`);
  console.log("\nLista:"); for (const row of previa.linhas) console.log(`  [${row.acao}] ${row.nome} — ${row.funcao} — ${row.frente} — ${row.situacao}${row.matricula ? ` — mat. ${row.matricula}` : ""}`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
