// Menu RELATÓRIOS (lib/reports-catalog.ts): quem vê cada relatório, busca sem acento e a regra do
// projeto de que permissão nova nasce desligada para os perfis de funcionário.
import assert from "node:assert/strict";
import test from "node:test";
import { canSeeReport, groupReports, REPORT_CATEGORIES, reportById, reportGrants, REPORTS, searchReports, visibleReports } from "../lib/reports-catalog.ts";
import { ALL_PERMISSIONS, PROFILE_DEFAULTS } from "../lib/auth.ts";

const user = (profile, permissions = []) => ({ profile, permissions });
const ids = (list) => list.map((report) => report.id).sort();

test("cada relatório tem id único, categoria válida e permissões que existem", () => {
  assert.equal(new Set(REPORTS.map((report) => report.id)).size, REPORTS.length);
  for (const report of REPORTS) {
    assert.ok(REPORT_CATEGORIES.some((category) => category.key === report.category), report.id);
    for (const permission of reportGrants(report.id)) assert.ok(ALL_PERMISSIONS.includes(permission), `${report.id}: ${permission}`);
  }
  for (const category of REPORT_CATEGORIES) assert.ok(ALL_PERMISSIONS.includes(category.permission), category.permission);
});

test("ADMIN vê tudo; GESTOR vê tudo pelas permissões padrão", () => {
  assert.equal(visibleReports(user("ADMIN")).length, REPORTS.length);
  assert.equal(visibleReports(user("GESTOR", PROFILE_DEFAULTS.GESTOR)).length, REPORTS.length);
});

test("perfis de funcionário nascem sem relatórios (regra do projeto)", () => {
  for (const profile of ["OFICINA", "OPERADOR", "ALMOXARIFADO", "CAMPO"]) {
    assert.ok(!PROFILE_DEFAULTS[profile].some((permission) => permission.startsWith("reports.")), profile);
  }
  assert.deepEqual(visibleReports(user("OPERADOR")), []);
  assert.deepEqual(visibleReports(user("CAMPO", ["reports.combustivel"])), [], "funcionário de campo nunca vê relatórios");
  assert.deepEqual(visibleReports(null), []);
});

test("usuário com uma categoria liberada vê só os relatórios dela", () => {
  const visible = visibleReports(user("OPERADOR", ["reports.pecas"]));
  assert.deepEqual(ids(visible), ["ajustes-estoque", "estoque-saidas", "produtos-estoque"]);
  assert.ok(!canSeeReport(user("OPERADOR", ["reports.pecas"]), "custos-consumo"));
});

test("quem já abria o relatório no lugar antigo continua abrindo", () => {
  const diario = user("OPERADOR", ["daily.view_all"]);
  assert.deepEqual(ids(visibleReports(diario)), ["diario-combustivel", "producao"]);
  const combustivel = user("OPERADOR", ["fuel.view"]);
  for (const id of ["combustivel-movimentacao", "combustivel-dia", "consumo-terceiros", "terceiros-empresa", "comboio"]) assert.ok(canSeeReport(combustivel, id), id);
  // Relatórios novos (sem lugar antigo) só com a permissão da categoria.
  for (const [permissao, id] of [["fuel.view", "consumo-equipamento"], ["fuel.view", "combustivel-destino"], ["products.view", "ajustes-estoque"], ["work_orders.view", "ordens-servico"], ["equipment.view", "pneus-baterias"]]) {
    assert.ok(!canSeeReport(user("OPERADOR", [permissao]), id), `${id} não vem com ${permissao}`);
  }
  assert.ok(canSeeReport(user("OPERADOR", ["reports.manutencao"]), "ordens-servico"));
  assert.ok(!canSeeReport(user("OPERADOR", ["equipment.view"]), "casado-equipamento"), "casados só com reports.custos");
  assert.ok(!canSeeReport(combustivel, "custos-consumo"), "custos continua só com reports.custos");
  assert.ok(canSeeReport(user("OFICINA", PROFILE_DEFAULTS.OFICINA), "trocas-oleo"));
  assert.ok(canSeeReport(user("OFICINA", PROFILE_DEFAULTS.OFICINA), "frota-diario"));
  assert.ok(!canSeeReport(user("OFICINA", PROFILE_DEFAULTS.OFICINA), "resumo-semanal"));
});

test("as rotas autorizam pela permissão da categoria e pelas do lugar antigo", () => {
  assert.deepEqual(reportGrants("producao"), ["reports.producao", "daily.view_all", "daily.manage"]);
  assert.deepEqual(reportGrants("custos-consumo"), ["reports.custos"]);
  assert.deepEqual(reportGrants("nao-existe"), []);
});

test("busca sem acento, por várias palavras, inclusive pela categoria e pelos sinônimos", () => {
  assert.deepEqual(ids(searchReports(REPORTS, "CONFERÊNCIA diario")), ["diario-combustivel"]);
  assert.deepEqual(ids(searchReports(REPORTS, "oleo vencidas")), ["trocas-vencidas"]);
  assert.ok(searchReports(REPORTS, "doações").some((report) => report.id === "consumo-terceiros"));
  assert.ok(searchReports(REPORTS, "peças").some((report) => report.id === "estoque-saidas"));
  assert.equal(searchReports(REPORTS, "   ").length, REPORTS.length);
  assert.deepEqual(searchReports(REPORTS, "xyzxyz"), []);
});

test("cartões agrupados na ordem das categorias, sem categoria vazia", () => {
  const groups = groupReports(visibleReports(user("OPERADOR", ["reports.manutencao", "reports.producao"])));
  assert.deepEqual(groups.map((group) => group.category.key), ["producao", "manutencao"]);
  assert.equal(reportById("resumo-semanal")?.category, "resumos");
});
