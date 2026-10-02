// Depois da importação de funcionários (e sempre que precisar): passa por todos os funcionários e
// acerta o acesso de operador — garante as funções no cadastro de Funções, desativa o acesso de quem
// foi demitido ou mudou para função que não opera equipamento e atualiza nome/função/frente.
// NÃO cria acesso novo (os PINs precisam ser entregues): quem ficar pendente aparece em
// Usuários > Operadores > "Criar acessos pendentes", que gera o PDF dos PINs.
// Uso: DATABASE_URL=... npx tsx scripts/sincronizar-operadores.ts [--confirmar]
import "dotenv/config";
import { asc } from "drizzle-orm";
import { getDb } from "../db";
import { employees } from "../db/schema";
import { garantirFuncao, sincronizarAcessoOperador } from "../lib/operadores";

async function main() {
  const confirmar = process.argv.includes("--confirmar");
  if (!confirmar) process.env.DATABASE_READ_ONLY = "1";
  const db = await getDb();
  const lista = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle }).from(employees).orderBy(asc(employees.id));
  const contagem: Record<string, number> = {};
  if (!confirmar) { console.log(`Simulação: ${lista.length} funcionário(s). Rode com --confirmar para aplicar.`); process.exit(0); }
  for (const item of lista) {
    await garantirFuncao(db, item.jobTitle);
    const resultado = await sincronizarAcessoOperador(db, item.id, null, { criar: false, motivo: "sincronização após importação" });
    contagem[resultado.acao] = (contagem[resultado.acao] ?? 0) + 1;
    if (resultado.acao === "DESATIVADO") console.log(`Desativado: ${item.name}`);
  }
  console.log("Resultado:", contagem, "— PENDENTE = criar em Usuários > Operadores (gera o PDF dos PINs).");
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
