import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CATALOGO, catalogoDoUsuario, podeConsultar, viewDoCatalogo } from "../lib/assistente/catalogo.ts";
import { ConsultaError, dataIso, formatarValor, montarConsulta } from "../lib/assistente/consulta.ts";
import { buscarNoManual } from "../lib/assistente/ajuda.ts";
import { MANUAL_ASSISTENTE } from "../lib/assistente/manual-texto.ts";

const admin = { id: 1, profile: "ADMIN", permissions: ["fuel.view", "products.view", "tasks.view", "equipment.view", "maintenance.view"] };
const gestor = { id: 7, profile: "GESTOR", permissions: ["fuel.view", "products.view", "tasks.view"] };
const TODAS = { ids: "ALL", nomes: ["todas as frentes"] };
const ARAPIUNS = { ids: [3], nomes: ["Arapiuns"] };
const HOJE = "2026-10-02";

test("catálogo: colunas padrão, de período e de frente existem; sem colunas sensíveis", () => {
  for (const item of CATALOGO) {
    const nomes = new Set(item.colunas.map((col) => col.nome));
    assert.equal(nomes.size, item.colunas.length, `${item.view}: coluna repetida`);
    for (const col of item.padrao) assert.ok(nomes.has(col), `${item.view}: padrão ${col}`);
    if (item.colunaData) assert.equal(item.colunas.find((col) => col.nome === item.colunaData)?.tipo, "data", `${item.view}: colunaData`);
    if (item.escopo === "frente") for (const col of item.colunasFrente ?? ["frente_id"]) assert.ok(nomes.has(col), `${item.view}: frente ${col}`);
    for (const col of nomes) assert.doesNotMatch(col, /senha|password|hash|token|salt|secret|qr|cpf|salario|salary|access_code|whatsapp/i, `${item.view}.${col}`);
  }
});

test("catálogo × migration: toda view do catálogo é criada na migration e vice-versa", () => {
  const sqlText = ["drizzle/0038_assistente_views.sql", "drizzle/0039_assistente_ajustes.sql", "drizzle/0041_assistente_pendentes_views.sql", "drizzle/0044_assistente_terceiros_views.sql"].map((file) => readFileSync(file, "utf8")).join("\n");
  const views = [...new Set([...sqlText.matchAll(/CREATE OR REPLACE VIEW assistente\.(v_[a-z_]+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(CATALOGO.map((item) => item.view).sort(), views);
});

test("permissões: usuários só para ADMIN; módulo exige a permissão; perfis de gestão", () => {
  assert.equal(podeConsultar(viewDoCatalogo("v_usuarios"), gestor), false);
  assert.equal(podeConsultar(viewDoCatalogo("v_usuarios"), admin), true);
  assert.equal(podeConsultar(viewDoCatalogo("v_funcionarios"), gestor), false);
  assert.equal(podeConsultar(viewDoCatalogo("v_custos_consumo"), gestor), true);
  assert.equal(podeConsultar(viewDoCatalogo("v_custos_consumo"), { ...gestor, profile: "OFICINA" }), false);
  assert.ok(catalogoDoUsuario(gestor).every((item) => item.view !== "v_usuarios"));
});

test("frente: filtro sempre aplicado para quem não vê todas; transferência olha origem e destino", () => {
  const simples = montarConsulta({ view: "v_combustivel_saldos" }, gestor, ARAPIUNS, HOJE);
  assert.match(simples.sql, /"frente_id" = ANY\(\$1::int\[\]\)/);
  assert.deepEqual(simples.params[0], [3]);
  const mov = montarConsulta({ view: "v_combustivel_movimentacoes" }, gestor, ARAPIUNS, HOJE);
  assert.match(mov.sql, /\("frente_id" = ANY\(\$1::int\[\]\) OR "frente_destino_id" = ANY\(\$1::int\[\]\)\)/);
  const todas = montarConsulta({ view: "v_combustivel_saldos" }, admin, TODAS, HOJE);
  assert.doesNotMatch(todas.sql, /ANY/);
  const global = montarConsulta({ view: "v_terceiros" }, { ...gestor, permissions: ["fuel.view"] }, ARAPIUNS, HOJE);
  assert.doesNotMatch(global.sql, /frente_id/);
});

test("tarefas: quem não é ADMIN só vê as próprias", () => {
  const minhas = montarConsulta({ view: "v_tarefas", periodo: "todo" }, gestor, ARAPIUNS, HOJE);
  assert.match(minhas.sql, /\("responsavel_id" = \$1::int OR "criado_por_id" = \$1::int\)/);
  assert.equal(minhas.params[0], 7);
  assert.doesNotMatch(montarConsulta({ view: "v_tarefas", periodo: "todo" }, admin, TODAS, HOJE).sql, /responsavel_id" =/);
});

test("período: padrão mês atual em eventos; explícito em DD/MM/AAAA; 'todo' sem limite; retrato sem período", () => {
  const padrao = montarConsulta({ view: "v_combustivel_movimentacoes" }, admin, TODAS, HOJE);
  assert.deepEqual(padrao.periodo, { de: "2026-10-01", ate: "2026-10-02", padrao: true });
  assert.match(padrao.sql, /"data" BETWEEN \$1::date AND \$2::date/);
  const setembro = montarConsulta({ view: "v_combustivel_movimentacoes", periodo: { de: "01/09/2026", ate: "30/09/2026" } }, admin, TODAS, HOJE);
  assert.deepEqual(setembro.params.slice(0, 2), ["2026-09-01", "2026-09-30"]);
  assert.equal(montarConsulta({ view: "v_combustivel_movimentacoes", periodo: "todo" }, admin, TODAS, HOJE).periodo, null);
  assert.equal(montarConsulta({ view: "v_produtos" }, admin, TODAS, HOJE).periodo, null);
  assert.throws(() => montarConsulta({ view: "v_combustivel_movimentacoes", periodo: { de: "31/02/2026" } }, admin, TODAS, HOJE), ConsultaError);
});

test("filtros: texto sem acento/maiúsculas, parametrizado; operadores validados por tipo", () => {
  const q = montarConsulta({ view: "v_produtos_movimentacoes", periodo: "todo", filtros: [
    { campo: "tipo", operador: "=", valor: "Saída" }, { campo: "departamento", operador: "contem", valor: "alimenta%" },
    { campo: "quantidade", operador: ">=", valor: "1.000,5" }, { campo: "importado_sistema_antigo", operador: "=", valor: "sim" },
    { campo: "tipo", operador: "em", valor: ["Saída", "Correção de estoque"] },
  ] }, admin, TODAS, HOJE);
  assert.match(q.sql, /assistente\.chave\("tipo"\) = assistente\.chave\(\$1::text\)/);
  assert.match(q.sql, /assistente\.chave\("departamento"\) LIKE assistente\.chave\(\$2::text\)/);
  assert.equal(q.params[1], "%alimenta\\%%");
  assert.equal(q.params[2], 1000.5);
  assert.equal(q.params[3], true);
  assert.match(q.sql, /IN \(assistente\.chave\(\$5::text\), assistente\.chave\(\$6::text\)\)/);
  assert.throws(() => montarConsulta({ view: "v_produtos", filtros: [{ campo: "saldo", operador: "contem", valor: "1" }] }, admin, TODAS, HOJE), /só vale para texto/);
  assert.throws(() => montarConsulta({ view: "v_produtos", filtros: [{ campo: "senha", operador: "=", valor: "x" }] }, admin, TODAS, HOJE), /não existe/);
  assert.throws(() => montarConsulta({ view: "v_produtos", filtros: [{ campo: "nome", operador: "; DROP TABLE", valor: "x" }] }, admin, TODAS, HOJE), /Operador/);
  assert.throws(() => montarConsulta({ view: "public.users" }, admin, TODAS, HOJE), /não existe/);
});

test("agrupamento e agregações calculados no banco; ordem só por colunas do resultado; limite", () => {
  const q = montarConsulta({ view: "v_produtos_movimentacoes", periodo: "todo", agrupar_por: ["tag", "mes(data)"],
    agregacoes: [{ funcao: "soma", campo: "valor_total", nome: "valor" }, { funcao: "contagem" }], ordenar_por: [{ campo: "valor", direcao: "desc" }], limite: 10 }, admin, TODAS, HOJE);
  assert.match(q.sql, /SELECT "tag" AS "tag", date_trunc\('month', "data"\)::date AS "mes_data", sum\("valor_total"\) AS "valor", count\(\*\) AS "contagem"/);
  assert.match(q.sql, /GROUP BY 1, 2 ORDER BY "valor" DESC NULLS LAST LIMIT 11$/);
  assert.deepEqual(q.colunas.map((col) => col.tipo), ["texto", "mes", "numero", "numero"]);
  assert.throws(() => montarConsulta({ view: "v_produtos", agregacoes: [{ funcao: "soma", campo: "nome" }] }, admin, TODAS, HOJE), /numérica/);
  assert.throws(() => montarConsulta({ view: "v_produtos", ordenar_por: [{ campo: "preco; drop", direcao: "asc" }] }, admin, TODAS, HOJE), /Ordenação/);
  assert.equal(montarConsulta({ view: "v_produtos", limite: 999999 }, admin, TODAS, HOJE).limite, 1000);
  assert.throws(() => montarConsulta({ view: "v_usuarios" }, gestor, ARAPIUNS, HOJE), /não tem acesso/);
});

test("formatação brasileira para o modelo", () => {
  assert.equal(formatarValor(1234.5, "numero"), "1.234,5");
  assert.equal(formatarValor("2026-09-30", "data"), "30/09/2026");
  assert.equal(formatarValor("2026-09-01", "mes"), "09/2026");
  assert.equal(formatarValor(true, "sim_nao"), "sim");
  assert.equal(dataIso("1/9/2026"), "2026-09-01");
});

test("manual: embutido igual ao docs/manual-assistente.md e busca acha a transferência de diesel", () => {
  assert.equal(MANUAL_ASSISTENTE, readFileSync("docs/manual-assistente.md", "utf8"), "rode node scripts/gerar-manual-assistente.mjs");
  const [primeira] = buscarNoManual("como faço para registrar uma transferência de diesel entre frentes?");
  assert.equal(primeira.titulo, "Combustível");
  assert.match(primeira.texto, /Filial Destino/);
  assert.equal(buscarNoManual("como abro uma ordem de serviço")[0].titulo, "Ordem de Serviço");
});
