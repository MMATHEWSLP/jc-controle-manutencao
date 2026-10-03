// Prévia (SOMENTE LEITURA) da importação do Controle Diário de setembro/2026 contra o banco, com a
// MESMA função da tela "Importar planilha" (montarPrevia) e as decisões já combinadas:
// CA-01 (Antonio Francisco, ~280.000 km) → CC-01; CC-02 na escala de km (~167.000) → HL-02;
// HL-0x casados pelo prefixo. Os demais grupos "a decidir" usam a sugestão e aparecem listados.
// Não grava nada (sessão READ ONLY).
// Uso: DATABASE_URL=... npx tsx scripts/previa-controle-diario.ts [arquivo.xlsx]
import "dotenv/config";
import { readFileSync } from "node:fs";
process.env.DATABASE_READ_ONLY = "1";

const ARQUIVO = process.argv[2] ?? "importacoes/Controle_Diario_Setembro_LIMPO.xlsx";
const n = (v: number, casas = 2) => v.toLocaleString("pt-BR", { maximumFractionDigits: casas });

async function main() {
  const { getDb } = await import("../db");
  const { lerPlanilhaDiario, montarPrevia } = await import("../lib/daily-import");
  const arquivo = readFileSync(ARQUIVO);
  const linhas = await lerPlanilhaDiario(arquivo.buffer.slice(arquivo.byteOffset, arquivo.byteOffset + arquivo.byteLength));
  const db = await getDb();

  // 1ª passada sem decisões: quem precisa de decisão.
  const inicial = await montarPrevia(db, linhas, { equipamentos: {}, problemas: [] });
  const porPrefixo = (inicio: string) => inicial.equipamentosCadastro.filter((item) => item.prefix.toUpperCase().startsWith(inicio));
  const ajustes: Record<string, number | null> = {};
  console.log("== Equipamentos a decidir (decisão aplicada)");
  for (const grupo of inicial.grupos.filter((item) => item.situacao === "DECIDIR")) {
    let escolha: number | null = grupo.sugestaoId; let regra = "sugestão";
    if (grupo.codigo === "CA-01") { const cc = porPrefixo("CC-01"); if (cc.length === 1) { escolha = cc[0].id; regra = "combinado: CA-01 é o CC-01"; } }
    if (grupo.codigo === "CC-02" && grupo.escala === "B") { const hl = porPrefixo("HL-02"); if (hl.length === 1) { escolha = hl[0].id; regra = "combinado: CC-02 em km é o HL-02"; } }
    ajustes[grupo.chave] = escolha;
    const alvo = inicial.equipamentosCadastro.find((item) => item.id === escolha);
    console.log(`  ${grupo.chave}: ${grupo.linhas} linha(s) · ${n(grupo.primeira)} → ${n(grupo.ultima)} · ${grupo.operadores.join(", ")} · ${grupo.motivo}\n     → ${alvo ? `${alvo.prefix} (${alvo.model}, atual ${n(alvo.atual)} ${alvo.unidade === "KM" ? "km" : "h"})` : "NÃO IMPORTAR"} [${regra}]`);
  }
  console.log("== Casados pelo prefixo");
  for (const grupo of inicial.grupos.filter((item) => item.situacao === "CASADO_PELO_PREFIXO")) console.log(`  ${grupo.chave} → ${grupo.motivo} (${grupo.linhas} linha(s))`);

  const previa = await montarPrevia(db, linhas, { equipamentos: ajustes, problemas: [] });
  const r = previa.resumo;
  console.log(`\n== Resumo (${previa.label}, ${previa.periodo.de} a ${previa.periodo.ate})`);
  console.log(`  Planilha: ${r.planilha.linhas} linhas · ${n(r.planilha.viagens, 0)} viagens · ${n(r.planilha.volumePorto)} m³ · ${n(r.planilha.diesel, 0)} L de diesel`);
  console.log(`  Importar: ${r.importar} · Conferir: ${r.conferir} · Mesmo dia (avisos): ${r.avisos} · Ignoradas: ${r.ignoradas} · Não importadas: ${r.naoImportadas} · A decidir: ${r.decidir}`);
  console.log(`  Viagens: ${n(r.viagens, 0)} · Volume porto: ${n(r.volumePorto)} m³ · Diesel informado: ${n(r.dieselInformado, 0)} L · Diesel > 600 L não lançado: ${r.dieselNaoLancado}`);
  console.log(`  Sem operador: ${r.semOperador} linha(s) · Operadores vinculados ao cadastro: ${r.operadoresVinculados} · Sem cadastro (ficam com o nome): ${r.operadoresSemCadastro}`);
  console.log(`  Problemas relatados: ${r.problemas} (viram pendência só se marcados) · Leituras que sobem: ${r.leiturasQueSobem}`);
  console.log(`  Por frente: ${r.porFrente.map((item) => `${item.nome} ${item.total}`).join(" · ")}`);

  console.log("\n== Diesel acima de 600 L");
  for (const linha of previa.plano.filter((item) => item.dieselNota)) console.log(`  Linha ${linha.linha} · ${linha.data} · ${linha.prefixo}: planilha ${n(linha.dieselPlanilha, 0)} L → ${linha.diesel === null ? "sem saída no Combustível" : `${n(linha.diesel)} L da saída do dia`}`);
  console.log("\n== Conferir");
  for (const linha of previa.plano.filter((item) => item.conferir)) console.log(`  Linha ${linha.linha} · ${linha.data} · ${linha.prefixo} · ${linha.inicial ?? "—"} → ${linha.final ?? "—"} · ${linha.conferir}`);
  console.log("\n== Operadores sem cadastro de campo (ficam com o nome; editar um a um no Histórico)");
  for (const item of previa.semCadastro) console.log(`  ${item.nome} (${item.lancamentos})${item.parecidos.length ? ` · parecido: ${item.parecidos.map((p) => `${p.nome} [${p.semelhanca}]`).join("; ")}` : ""}`);
  console.log("\n== Leituras atuais que vão subir");
  for (const item of previa.leituras.filter((x) => x.sobe)) console.log(`  ${item.prefixo}: ${n(item.atual)} → ${n(item.importada ?? 0)} ${item.unidade === "KM" ? "km" : "h"} (${item.data})`);
  const bloqueadas = previa.leituras.filter((x) => !x.sobe && x.historicoMaisNovo);
  if (bloqueadas.length) console.log(`  Não sobem por ter leitura mais nova no histórico: ${bloqueadas.map((x) => `${x.prefixo} (${x.historicoMaisNovo})`).join(", ")}`);
  if (previa.ignoradas.length || previa.naoImportadas.length) {
    console.log("\n== Ignoradas / não importadas");
    for (const item of previa.ignoradas) console.log(`  Linha ${item.linha}: ${item.motivo}`);
    for (const item of previa.naoImportadas) console.log(`  Linha ${item.linha} · ${item.codigo}: ${item.motivo}`);
  }
  console.log("\nNada foi gravado.");
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
