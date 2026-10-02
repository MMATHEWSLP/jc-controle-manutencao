// Teste do Assistente JC contra o banco (somente leitura): as 10 perguntas de referência, como ADMIN e
// como um usuário de uma frente só, mais a conferência de que esse usuário NÃO vê outras frentes.
//  1) Consultas determinísticas: as mesmas ferramentas que o assistente usa, com os parâmetros certos.
//  2) Isolamento: consultar_dados em todas as views de frente, sem filtro — toda linha tem de ser da
//     frente do usuário; pedir outra frente tem de dar erro.
//  3) Se ANTHROPIC_API_KEY existir: a resposta completa do assistente (sem gravar em assistant_logs).
// Uso: npx tsx scripts/testar-assistente.ts [--frente=Arapiuns] [--sem-ia]
import "dotenv/config";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { serviceFronts, userServiceFronts, users } from "../db/schema";
import { runAssistantChat } from "../lib/assistant";
import { runAssistantTool, type AssistantToolContext } from "../lib/assistant-tools";
import { ALL_PERMISSIONS, effectivePermissions, type SessionUser } from "../lib/auth";
import { CATALOGO, podeConsultar } from "../lib/assistente/catalogo";
import { colunasDasViews, fecharPoolAssistente } from "../lib/assistente/db";
import { fuelLocalDay } from "../lib/fuel";

process.env.DATABASE_READ_ONLY = "1";
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const today = fuelLocalDay();
const year = today.slice(0, 4);
const lastMonth = (() => { const [y, m] = today.split("-").map(Number); const date = new Date(Date.UTC(y, m - 2, 1)); return { de: date.toISOString().slice(0, 10), ate: new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10) }; })();
const br = (iso: string) => iso.split("-").reverse().join("/");
const SETEMBRO = { de: `01/09/${year}`, ate: `30/09/${year}` };

type Call = { tool: string; input: Record<string, unknown> };
const PERGUNTAS: Array<{ pergunta: string; chamadas: Call[] }> = [
  { pergunta: "Qual o saldo de diesel de cada frente hoje?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_combustivel_saldos", filtros: [{ campo: "combustivel", operador: "contem", valor: "diesel" }], agrupar_por: ["frente"], agregacoes: [{ funcao: "soma", campo: "saldo_litros", nome: "saldo_litros" }], ordenar_por: [{ campo: "frente", direcao: "asc" }] } },
  ] },
  { pergunta: "Quanto de diesel saiu em Arapiuns em setembro, por equipamento?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_combustivel_movimentacoes", frentes: ["Arapiuns"], periodo: SETEMBRO, filtros: [{ campo: "tipo", operador: "=", valor: "Saída" }, { campo: "combustivel", operador: "contem", valor: "diesel" }],
      agrupar_por: ["tipo_saida", "equipamento", "placa"], agregacoes: [{ funcao: "soma", campo: "litros", nome: "litros" }, { funcao: "contagem", nome: "abastecimentos" }], ordenar_por: [{ campo: "litros", direcao: "desc" }], limite: 300 } },
  ] },
  { pergunta: "Qual a média de consumo dos caminhões da GREGOLETO?", chamadas: [
    { tool: "consumo_veiculo", input: { empresa: "GREGOLETO", data_inicio: `01/01/${year}`, data_fim: br(today) } },
    { tool: "consultar_dados", input: { view: "v_veiculos_terceiros", filtros: [{ campo: "empresa", operador: "contem", valor: "gregoleto" }],
      colunas: ["empresa", "placa", "tipo_veiculo", "frente", "abastecimentos", "litros_abastecidos", "rodado_com_consumo", "litros_com_consumo", "consumo_medio", "unidade_consumo"] } },
  ] },
  { pergunta: "Quais os 10 produtos que mais saíram em setembro, em quantidade e em valor?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_produtos_movimentacoes", periodo: SETEMBRO, filtros: [{ campo: "tipo", operador: "=", valor: "Saída" }], agrupar_por: ["tag", "produto"],
      agregacoes: [{ funcao: "soma", campo: "quantidade", nome: "quantidade" }, { funcao: "soma", campo: "valor_total", nome: "valor" }], ordenar_por: [{ campo: "quantidade", direcao: "desc" }], limite: 10 } },
    { tool: "consultar_dados", input: { view: "v_produtos_movimentacoes", periodo: SETEMBRO, filtros: [{ campo: "tipo", operador: "=", valor: "Saída" }], agrupar_por: ["tag", "produto"],
      agregacoes: [{ funcao: "soma", campo: "valor_total", nome: "valor" }, { funcao: "soma", campo: "quantidade", nome: "quantidade" }], ordenar_por: [{ campo: "valor", direcao: "desc" }], limite: 10 } },
  ] },
  { pergunta: "O que foi gasto com o CM-22 este ano (produtos, combustível e manutenções)?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_custos_consumo", periodo: { de: `01/01/${year}`, ate: br(today) }, filtros: [{ campo: "equipamento", operador: "=", valor: "CM-22" }],
      agrupar_por: ["equipamento"], agregacoes: [{ funcao: "soma", campo: "litros_combustivel", nome: "litros" }, { funcao: "soma", campo: "valor_pecas", nome: "pecas" }, { funcao: "soma", campo: "valor_manutencoes", nome: "manutencoes" }] } },
    { tool: "consumo_veiculo", input: { equipamento: "CM-22", data_inicio: `01/01/${year}`, data_fim: br(today) } },
  ] },
  { pergunta: "Quais equipamentos estão com troca de óleo vencida?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_trocas_oleo", filtros: [{ campo: "situacao", operador: "em", valor: ["Vencida", "Vencida (urgente)"] }], ordenar_por: [{ campo: "vencida_ha", direcao: "desc" }] } },
  ] },
  { pergunta: "Quais produtos estão com estoque zerado ou baixo?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_produtos", filtros: [{ campo: "situacao_estoque", operador: "em", valor: ["Zerado", "Negativo", "Baixo"] }], agrupar_por: ["frente", "situacao_estoque"], agregacoes: [{ funcao: "contagem", nome: "produtos" }] } },
    { tool: "consultar_dados", input: { view: "v_produtos", filtros: [{ campo: "situacao_estoque", operador: "em", valor: ["Negativo", "Baixo"] }], ordenar_por: [{ campo: "cobertura_meses", direcao: "asc" }], limite: 30 } },
  ] },
  { pergunta: "Quanto o departamento Setor de Alimentação e Refeições consumiu por mês?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_produtos_movimentacoes", periodo: "todo", filtros: [{ campo: "tipo", operador: "=", valor: "Saída" }, { campo: "departamento", operador: "contem", valor: "alimenta" }],
      agrupar_por: ["departamento", "mes(data)"], agregacoes: [{ funcao: "soma", campo: "quantidade", nome: "quantidade" }, { funcao: "soma", campo: "valor_total", nome: "valor" }], ordenar_por: [{ campo: "mes_data", direcao: "asc" }] } },
  ] },
  { pergunta: "Quais tarefas estão pendentes e com quem?", chamadas: [
    { tool: "consultar_dados", input: { view: "v_tarefas", periodo: "todo", filtros: [{ campo: "aberta", operador: "=", valor: "sim" }], ordenar_por: [{ campo: "prazo", direcao: "asc" }] } },
  ] },
  { pergunta: "Como faço para registrar uma transferência de diesel entre frentes?", chamadas: [
    { tool: "ajuda_sistema", input: { pergunta: "registrar transferência de diesel entre frentes" } },
  ] },
];

async function sessionUser(id: number, override?: Partial<SessionUser>): Promise<SessionUser> {
  const db = await getDb();
  const row = (await db.select({
    id: users.id, name: users.name, username: users.username, email: users.email, profile: users.role, taskRoleId: users.taskRoleId, status: users.status, theme: users.theme,
    isPrimaryAdmin: users.isPrimaryAdmin, lastAccessAt: users.lastAccessAt, createdAt: users.createdAt, serviceFrontId: users.serviceFrontId, serviceFrontName: serviceFronts.name,
    allServiceFronts: users.allServiceFronts, canExport: users.canExport, jobTitle: users.jobTitle,
  }).from(users).leftJoin(serviceFronts, eq(serviceFronts.id, users.serviceFrontId)).where(eq(users.id, id)).limit(1))[0];
  const fronts = row.allServiceFronts || row.profile === "ADMIN" ? [] : (await db.select({ id: userServiceFronts.serviceFrontId }).from(userServiceFronts).where(eq(userServiceFronts.userId, id))).map((item) => item.id);
  return { ...row, username: row.username ?? "", permissions: await effectivePermissions(row.id, row.profile), serviceFrontIds: fronts, ...override };
}

function printTool(name: string, content: string) {
  try {
    const data = JSON.parse(content) as Record<string, unknown>;
    const linhas = Array.isArray(data.linhas) ? data.linhas as Array<Record<string, unknown>> : null;
    const head = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "linhas" && key !== "colunas"));
    console.log(`   [${name}] ${JSON.stringify(head).slice(0, 700)}`);
    if (linhas) for (const linha of linhas.slice(0, 15)) console.log(`     · ${Object.values(linha).map((value) => value ?? "—").join(" | ")}`);
    if (linhas && linhas.length > 15) console.log(`     · ... (+${linhas.length - 15} linhas)`);
  } catch { console.log(`   [${name}] ${content.slice(0, 1500)}`); }
}

async function main() {
  const db = await getDb();
  let failures = 0;

  // 0) Catálogo × banco.
  const dbColumns = await colunasDasViews();
  for (const item of CATALOGO) {
    const actual = dbColumns.filter((column) => column.table_name === item.view).map((column) => column.column_name);
    const missing = item.colunas.filter((col) => !actual.includes(col.nome)).map((col) => col.nome);
    const extra = actual.filter((name) => !item.colunas.some((col) => col.nome === name));
    if (!actual.length || missing.length || extra.length) { failures++; console.log(`✗ CATÁLOGO ${item.view}: faltando no banco [${missing}] · fora do catálogo [${extra}]${actual.length ? "" : " · VIEW NÃO EXISTE"}`); }
  }
  console.log(`Catálogo × banco: ${CATALOGO.length} views conferidas${failures ? " — COM DIFERENÇAS" : ", tudo igual"}.`);

  // Usuários do teste.
  const admin = (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.status, "ACTIVE"))).orderBy(sql`${users.isPrimaryAdmin} DESC`, asc(users.id)).limit(1))[0];
  const frontName = arg("frente") ?? "Arapiuns";
  const front = (await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts)).find((item) => item.name.toUpperCase().includes(frontName.toUpperCase()));
  if (!admin || !front) throw new Error("Precisa de um ADMIN ativo e da frente informada.");
  const adminUser = await sessionUser(admin.id);
  // Usuário de uma frente só: GESTOR simulado com TODAS as permissões de consulta, vinculado só à frente
  // escolhida (o pior caso: se ele não vê outra frente, ninguém com menos permissão vê).
  const singleUser: SessionUser = { ...adminUser, name: `${adminUser.name} (simulado: GESTOR só ${front.name})`, profile: "GESTOR", allServiceFronts: false, serviceFrontId: front.id, serviceFrontName: front.name,
    serviceFrontIds: [front.id], permissions: ALL_PERMISSIONS.filter((permission) => !permission.startsWith("users.")) };
  const contexts: Array<[string, AssistantToolContext]> = [
    ["ADMIN (todas as frentes)", { db, user: adminUser, displayed: "ALL" }],
    [`USUÁRIO DE UMA FRENTE (${front.name})`, { db, user: singleUser, displayed: "ALL" }],
  ];

  // 1) Consultas determinísticas.
  for (const { pergunta, chamadas } of PERGUNTAS) {
    console.log(`\n================ ${pergunta}`);
    for (const [label, ctx] of contexts) {
      console.log(` -- ${label}`);
      for (const chamada of chamadas) {
        const result = await runAssistantTool(ctx, chamada.tool, chamada.input);
        if (!result.ok) console.log(`   [${chamada.tool}] ERRO/AVISO: ${result.content}`);
        else printTool(chamada.tool, result.content);
      }
    }
  }

  // 2) Isolamento de frente.
  console.log("\n================ Isolamento: o usuário de uma frente só vê dados de outras frentes?");
  const singleCtx = contexts[1][1];
  for (const item of CATALOGO.filter((view) => view.escopo === "frente" && podeConsultar(view, singleUser))) {
    const cols = [...new Set([...(item.colunasFrente ?? ["frente_id"])])];
    const result = await runAssistantTool(singleCtx, "consultar_dados", { view: item.view, colunas: cols, periodo: item.colunaData ? "todo" : undefined, limite: 1000 });
    if (!result.ok) { failures++; console.log(`✗ ${item.view}: ${result.content}`); continue; }
    const data = JSON.parse(result.content) as { linhas: Array<Record<string, string | null>> };
    const other = data.linhas.filter((linha) => !cols.some((col) => linha[col] !== null && Number(String(linha[col]).replace(/\./g, "")) === front.id));
    if (other.length) { failures++; console.log(`✗ ${item.view}: ${other.length} linha(s) de outra frente!`); }
    else console.log(`✓ ${item.view}: ${data.linhas.length} linha(s), todas de ${front.name}`);
  }
  const otherFront = (await db.select({ name: serviceFronts.name }).from(serviceFronts)).find((item) => item.name !== front.name);
  if (otherFront) {
    const asked = await runAssistantTool(singleCtx, "consultar_dados", { view: "v_combustivel_saldos", frentes: [otherFront.name] });
    if (asked.ok) { failures++; console.log(`✗ Pedir a frente ${otherFront.name} deveria dar erro e devolveu dados.`); }
    else console.log(`✓ Pedir a frente ${otherFront.name}: recusado ("${asked.content}")`);
  }
  const usersView = await runAssistantTool(singleCtx, "consultar_dados", { view: "v_usuarios" });
  console.log(usersView.ok ? (failures++, "✗ v_usuarios liberada para não ADMIN!") : `✓ v_usuarios para não ADMIN: recusado ("${usersView.content}")`);

  // 3) Respostas completas do assistente.
  if (process.env.ANTHROPIC_API_KEY && !process.argv.includes("--sem-ia")) {
    for (const { pergunta } of PERGUNTAS) {
      for (const [label, ctx] of contexts) {
        console.log(`\n################ ${pergunta}\n -- ${label}`);
        try {
          const result = await runAssistantChat({ ...ctx, tabelas: [] }, pergunta, [], { semRegistro: true });
          console.log(result.answer);
          console.log(`   ferramentas: ${result.toolCalls.map((call) => `${call.name}${call.ok ? "" : "(erro)"} ${JSON.stringify(call.input)}`).join(" ‖ ").slice(0, 1500)}`);
          console.log(`   tabelas na tela: ${result.tabelas.map((tabela) => `${tabela.titulo} (${tabela.linhas.length} linhas)`).join("; ") || "nenhuma"}`);
        } catch (error) { failures++; console.log(`✗ ERRO: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  } else console.log("\n(ANTHROPIC_API_KEY ausente: respostas do assistente não geradas — só as consultas acima.)");

  console.log(`\n${failures ? `✗ ${failures} falha(s)` : "✓ Tudo certo"} · referência: hoje ${br(today)}, mês anterior ${br(lastMonth.de)} a ${br(lastMonth.ate)}.`);
  await fecharPoolAssistente();
  process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
