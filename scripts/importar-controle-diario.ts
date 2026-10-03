// Importação REAL do Controle Diário de setembro/2026 (a mesma da tela "Importar planilha"):
// decisões combinadas (scripts/controle-diario-decisoes.ts), problemas relatados viram Pendência,
// registrado por "mathews", lote IMPORTACAO_SETEMBRO_2026, blocos de 500 e finalização (leituras,
// troca de óleo e alertas). Sem --confirmar só mostra o que faria. Desfazer: tela Importar planilha.
// Uso: DATABASE_URL=... npx tsx scripts/importar-controle-diario.ts [--confirmar] [arquivo.xlsx]
import "dotenv/config";
import { readFileSync } from "node:fs";

const CONFIRMAR = process.argv.includes("--confirmar");
const ARQUIVO = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "importacoes/Controle_Diario_Setembro_LIMPO.xlsx";

async function main() {
  const { getDb } = await import("../db");
  const { and, eq, sql } = await import("drizzle-orm");
  const { dailyImportBatches, users } = await import("../db/schema");
  const { ALL_PERMISSIONS } = await import("../lib/auth");
  const { lerPlanilhaDiario, montarPrevia, iniciarImportacao, importarBloco, finalizarImportacao } = await import("../lib/daily-import");
  const { decisoesCombinadas } = await import("./controle-diario-decisoes");
  const db = await getDb();

  const arquivo = readFileSync(ARQUIVO);
  const buffer = arquivo.buffer.slice(arquivo.byteOffset, arquivo.byteOffset + arquivo.byteLength);
  const linhas = await lerPlanilhaDiario(buffer);
  const inicial = await montarPrevia(db, linhas, { equipamentos: {}, problemas: [] });
  const { equipamentos, linhas: decisoes } = decisoesCombinadas(inicial);
  const problemas = linhas.filter((linha) => linha.problema).map((linha) => linha.linha);
  const ajustes = { equipamentos, problemas };
  const previa = await montarPrevia(db, linhas, ajustes);
  console.log("== Decisões\n" + decisoes.join("\n"));
  const r = previa.resumo;
  console.log(`== ${previa.label}: importar ${r.importar} · conferir ${r.conferir} · ignoradas ${r.ignoradas} · não importadas ${r.naoImportadas} · a decidir ${r.decidir} · pendências ${r.pendencias} · leituras que sobem ${r.leiturasQueSobem}`);

  const ja = await db.select({ id: dailyImportBatches.id, status: dailyImportBatches.status }).from(dailyImportBatches)
    .where(and(eq(dailyImportBatches.label, previa.label), sql`${dailyImportBatches.status} <> 'DESFEITO'`));
  if (ja.length) { console.log(`Já existe lote ${previa.label} (${ja.map((x) => `#${x.id} ${x.status}`).join(", ")}). Nada feito: desfaça na tela antes de importar de novo.`); process.exit(0); }
  if (r.decidir) throw new Error(`Ainda há ${r.decidir} grupo(s) a decidir.`);
  if (!CONFIRMAR) { console.log("Dry-run: nada gravado. Rode com --confirmar para importar."); process.exit(0); }

  const admin = (await db.select().from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"), sql`lower(coalesce(${users.username}, '')) = 'mathews' OR lower(${users.email}) LIKE 'mathews%'`)).limit(1))[0]
    ?? (await db.select().from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"))).orderBy(users.id).limit(1))[0];
  if (!admin) throw new Error("Nenhum ADMIN ativo.");
  const sessao = { id: admin.id, name: admin.name, username: admin.username ?? "", email: admin.email, profile: "ADMIN" as const, taskRoleId: null, status: "ACTIVE" as const, theme: "LIGHT" as const,
    isPrimaryAdmin: true, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: admin.serviceFrontId, serviceFrontName: null, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  console.log(`Importando como ${admin.name} (${admin.username ?? admin.email})...`);
  const lote = await iniciarImportacao(sessao, buffer, ARQUIVO.split("/").at(-1)!, ajustes);
  let total = 0;
  for (let bloco = 0; bloco < lote.blocos; bloco++) { const { inseridos } = await importarBloco(sessao, lote.loteId, bloco); total += inseridos; console.log(`  bloco ${bloco + 1}/${lote.blocos}: ${inseridos} registro(s)`); }
  const fim = await finalizarImportacao(sessao, lote.loteId);
  console.log(`== Concluído: lote #${lote.loteId} ${lote.label} · ${total} registro(s) · ${fim.conferir} para conferir · leitura atualizada em ${fim.leiturasAtualizadas.length} equipamento(s)`);
  for (const item of fim.leiturasAtualizadas) console.log(`  ${item.prefixo}: ${item.antes} → ${item.depois} ${item.unidade === "KM" ? "km" : "h"}`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
