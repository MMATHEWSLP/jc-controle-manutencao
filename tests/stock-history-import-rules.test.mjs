import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeHistory, chunk, historyNameKey, historyRowsFromMatrix, parseDecisions, parseHistoryDate, parseHistoryKind, parseHistoryNumber, readHistoryRawRows,
} from "../lib/stock-history-import-rules.ts";

const HEADER = ["Data", "Tipo", "Produto", "Quantidade", "Valor Unitário", "Valor Total", "Equipamento", "Chassi/Série", "Proprietário", "Descrição equipamento", "Local/Destino", "Colaborador", "Departamento"];
const row = (rowNumber, values) => ({ rowNumber, values: [...values, ...Array(13).fill(null)].slice(0, 13) });
const options = (extra = {}) => ({ frontId: 1, cutoffDate: "2026-09-07", applyBalance: false, decisions: {}, today: "2026-10-02", ...extra });
const context = (extra = {}) => ({
  products: [
    { id: 1, tag: "69", name: "CAT ÓLEO SAE 15W40 20L", price: 17.5, active: true },
    { id: 2, tag: "70", name: "Filtro  de ar", price: 10, active: true },
    { id: 3, tag: "71", name: "CAT ANEL 140GC", price: 1, active: true },
    { id: 4, tag: "72", name: "CAT ANEL 140GC", price: 1, active: true },
    { id: 5, tag: "73", name: "LUVA VAQUETA", price: 1, active: false },
    { id: 6, tag: "74", name: "LUVA VAQUETA", price: 1, active: true },
  ],
  equipment: [{ id: 10, code: "CM-22", prefix: "CM-22", plate: "RXH4G16", chassis: "9BWZZZ377VT004251", serialNumber: null }],
  employees: [{ id: 20, name: "Roberto Braga da Silva" }],
  departments: [{ id: 30, name: "Manutenção e Gestão da Frota" }],
  fronts: [{ id: 1, name: "Arapiuns" }],
  systemExits: [], importedHistory: [], balances: new Map([[1, 100]]),
  ...extra,
});

test("números, datas e tipo da planilha", () => {
  assert.equal(parseHistoryNumber(17.5), 17.5);
  assert.equal(parseHistoryNumber("1.234,56"), 1234.56);
  assert.equal(parseHistoryNumber("R$ 87,50"), 87.5);
  assert.equal(parseHistoryNumber("1.000"), 1000);
  assert.equal(parseHistoryNumber("abc"), null);
  assert.equal(parseHistoryDate("2026-01-08T00:00:00.000Z"), "2026-01-08");
  assert.equal(parseHistoryDate("08/01/2026"), "2026-01-08");
  assert.equal(parseHistoryDate(46030), "2026-01-08");
  assert.equal(parseHistoryDate("31/02/2026"), null);
  assert.equal(parseHistoryKind("SAÍDA"), "SAIDA");
  assert.equal(parseHistoryKind("ajuste"), "AJUSTE");
  assert.equal(parseHistoryKind("Correção de Estoque"), "AJUSTE");
  assert.equal(parseHistoryKind("ENTRADA"), null);
});

test("nome comparado sem acento, sem maiúsculas e com espaços normalizados", () => {
  assert.equal(historyNameKey("  cat óleo  sae 15w40 20l "), "CAT OLEO SAE 15W40 20L");
});

test("cabeçalho do modelo e linhas da matriz (aba Importar)", () => {
  const rows = historyRowsFromMatrix([["Resumo"], HEADER, [46030, "SAIDA", "X", 1, 2, 2], [], [null, null]]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowNumber, 3);
  assert.throws(() => historyRowsFromMatrix([["Data", "Produto"]]), /Cabeçalho/);
  assert.throws(() => historyRowsFromMatrix([HEADER.filter((name) => name !== "Colaborador")]), /Colaborador/);
  assert.equal(readHistoryRawRows([{ rowNumber: 5, values: ["2026-01-08", "SAIDA"] }])[0].values.length, 13);
});

test("casamento de produto, equipamento (código, placa ou chassi), colaborador e departamento", () => {
  const result = analyzeHistory([
    row(2, ["2026-01-08", "SAIDA", "Cat Oleo SAE 15W40  20L", 5, 17.5, 87.5, "cm 22", "", "DWE", "", "", "ROBERTO BRAGA DA SILVA", "Manutencao e Gestao da Frota"]),
    row(3, ["2026-01-08", "SAIDA", "FILTRO DE AR", 1, 10, 10, "RXH4G16", "", "", "", "", "GREGOLETO", ""]),
    row(4, ["2026-01-08", "SAIDA", "FILTRO DE AR", 1, 10, 10, "PRANCHA", "9BWZZZ377VT004251", "", "", "", "", ""]),
    row(5, ["2026-01-08", "SAIDA", "LUVA VAQUETA", 1, 1, 1, "EST-05", "", "", "", "", "", "Setor X"]),
  ], context(), options());
  assert.deepEqual(result.rows.map((item) => item.productId), [1, 2, 2, 6]); // nome repetido: fica o ativo
  assert.deepEqual(result.rows.map((item) => item.equipmentId), [10, 10, 10, null]);
  assert.equal(result.rows[0].employeeId, 20);
  assert.equal(result.rows[0].departmentId, 30);
  assert.equal(result.rows[1].employeeId, null);
  assert.deepEqual(result.unmatchedEquipment, [{ text: "EST-05", rows: 1 }]);
  assert.deepEqual(result.unmatchedEmployees, [{ text: "GREGOLETO", rows: 1 }]);
  assert.deepEqual(result.unmatchedDepartments, [{ text: "Setor X", rows: 1 }]);
  assert.equal(result.summary.toImport, 4);
});

test("AJUSTE = Correção de Estoque: não procura departamento e é somado à parte", () => {
  const result = analyzeHistory([
    row(2, ["2026-01-09", "AJUSTE", "FILTRO DE AR", 5, 5.9, 29.5, "", "", "", "", "", "", "Correção de Estoque"]),
    row(3, ["2026-01-09", "SAIDA", "FILTRO DE AR", 1, 10, 10]),
  ], context(), options());
  assert.equal(result.unmatchedDepartments.length, 0);
  assert.equal(result.summary.adjustments, 1);
  assert.equal(result.summary.adjustmentsValue, 29.5);
  assert.equal(result.summary.exitsValue, 10);
  assert.equal(result.summary.totalValue, 39.5);
});

test("produto não encontrado: sugestões, pendência e decisões (vincular, cadastrar, não importar)", () => {
  const rows = [
    row(2, ["2026-01-08", "SAIDA", "CAT OLEO SAE 15W40 20 L", 2, 18, 36]),
    row(3, ["2026-02-08", "SAIDA", "PARAFUSO XYZ", 2, 3, 6]),
    row(4, ["2026-02-09", "SAIDA", "PRODUTO QUALQUER", 1, 3, 3]),
    row(5, ["2026-02-09", "SAIDA", "CAT ANEL 140GC", 1, 3, 3]),
  ];
  const pending = analyzeHistory(rows, context(), options());
  assert.equal(pending.summary.productsUnmatched, 4);
  assert.equal(pending.summary.productsPending, 4);
  assert.equal(pending.summary.pendingProductRows, 4);
  const oleo = pending.unmatchedProducts.find((item) => item.name.startsWith("CAT OLEO"));
  assert.equal(oleo.suggestions.length, 3);
  assert.equal(oleo.suggestions[0].id, 1);
  const anel = pending.unmatchedProducts.find((item) => item.name === "CAT ANEL 140GC");
  assert.equal(anel.ambiguous, true);
  assert.deepEqual(anel.suggestions.map((item) => item.id).sort(), [3, 4]);

  const decisions = parseDecisions({ "CAT OLEO SAE 15W40 20 L": { action: "LINK", productId: 1 }, "PARAFUSO XYZ": { action: "CREATE" }, "produto qualquer": { action: "SKIP" }, "CAT ANEL 140GC": { action: "LINK", productId: 4 }, lixo: { action: "X" } });
  const decided = analyzeHistory(rows, context(), options({ decisions }));
  assert.equal(decided.summary.productsPending, 0);
  assert.deepEqual(decided.rows.map((item) => item.status), ["IMPORTAR", "IMPORTAR", "IGNORADO", "IMPORTAR"]);
  assert.equal(decided.rows[0].productId, 1);
  assert.equal(decided.rows[1].createProduct, true);
  assert.equal(decided.rows[3].productId, 4);
  assert.equal(decided.unmatchedProducts.find((item) => item.name === "PARAFUSO XYZ").unitPrice, 3);
});

test("duplicidade: saída já lançada no sistema (data + produto + qtd + colaborador/equipamento), uma para uma", () => {
  const rows = [
    row(2, ["2026-09-20", "SAIDA", "FILTRO DE AR", 2, 10, 20, "", "", "", "", "", "ROBERTO BRAGA DA SILVA", ""]),
    row(3, ["2026-09-20", "SAIDA", "FILTRO DE AR", 2, 10, 20, "", "", "", "", "", "ROBERTO BRAGA DA SILVA", ""]),
    row(4, ["2026-09-20", "SAIDA", "FILTRO DE AR", 2, 10, 20, "CM-22", "", "", "", "", "", ""]),
    row(5, ["2026-09-20", "SAIDA", "FILTRO DE AR", 3, 10, 30, "CM-22", "", "", "", "", "", ""]),
  ];
  const systemExits = [
    { id: 900, day: "2026-09-20", productId: 2, quantity: 2, equipmentId: null, employeeId: 20, source: "STOCK_EXIT" },
    { id: 901, day: "2026-09-20", productId: 2, quantity: 2, equipmentId: 10, employeeId: null, source: "WORK_ORDER" },
  ];
  const result = analyzeHistory(rows, context({ systemExits }), options());
  assert.deepEqual(result.rows.map((item) => item.status), ["DUPLICADO", "IMPORTAR", "DUPLICADO", "IMPORTAR"]);
  assert.match(result.duplicates[0].reason, /Movimentação #900/);
  assert.match(result.duplicates[1].reason, /O\.S\. #901/);
});

test("duplicidade: a mesma planilha não entra duas vezes (lote anterior ativo)", () => {
  const rows = [row(2, ["2026-03-01", "SAIDA", "FILTRO DE AR", 1, 10, 10, "CM-22", "", "", "", "", "GREGOLETO", ""]), row(3, ["2026-03-01", "SAIDA", "FILTRO DE AR", 1, 10, 10, "CM-22", "", "", "", "", "GREGOLETO", ""])];
  const importedHistory = [{ day: "2026-03-01", productNameKey: "FILTRO DE AR", quantity: 1, kind: "SAIDA", employeeKey: "GREGOLETO", equipmentKey: "CM22" }];
  const result = analyzeHistory(rows, context({ importedHistory }), options());
  assert.deepEqual(result.rows.map((item) => item.status), ["DUPLICADO", "IMPORTAR"]);
  // Produto sem cadastro com todas as linhas já importadas: aparece na lista, mas não trava a confirmação.
  const again = analyzeHistory([row(2, ["2026-03-01", "SAIDA", "PECA SEM CADASTRO", 1, 10, 10])], context({ importedHistory: [{ day: "2026-03-01", productNameKey: "PECA SEM CADASTRO", quantity: 1, kind: "SAIDA", employeeKey: "", equipmentKey: "" }] }), options());
  assert.equal(again.summary.productsUnmatched, 1);
  assert.equal(again.summary.productsPending, 0);
  assert.equal(again.summary.duplicates, 1);
});

test("NÃO duplicar baixa: por padrão nada mexe no saldo; só saídas após o corte, e só se marcado", () => {
  const rows = [
    row(2, ["2026-09-07", "SAIDA", "CAT ÓLEO SAE 15W40 20L", 5, 17.5, 87.5]),
    row(3, ["2026-09-08", "SAIDA", "CAT ÓLEO SAE 15W40 20L", 4, 17.5, 70]),
    row(4, ["2026-09-09", "AJUSTE", "CAT ÓLEO SAE 15W40 20L", 1, 17.5, 17.5]),
  ];
  const standard = analyzeHistory(rows, context(), options());
  assert.equal(standard.rows.filter((item) => item.affectsBalance).length, 0);
  assert.equal(standard.afterCutoff.rows, 1);
  assert.deepEqual(standard.afterCutoff.products.map((item) => [item.productId, item.quantity, item.balance, item.after]), [[1, 4, 100, 96]]);
  const applied = analyzeHistory(rows, context(), options({ applyBalance: true }));
  assert.deepEqual(applied.rows.map((item) => item.affectsBalance), [false, true, false]);
  assert.equal(applied.summary.balanceRows, 1);
});

test("erros por linha não importam", () => {
  const result = analyzeHistory([
    row(2, ["", "SAIDA", "FILTRO DE AR", 1, 1, 1]),
    row(3, ["2026-11-01", "SAIDA", "FILTRO DE AR", 1, 1, 1]),
    row(4, ["2026-01-01", "ENTRADA", "FILTRO DE AR", 1, 1, 1]),
    row(5, ["2026-01-01", "SAIDA", "", 1, 1, 1]),
    row(6, ["2026-01-01", "SAIDA", "FILTRO DE AR", 0, 1, 0]),
    row(7, ["2026-01-01", "SAIDA", "FILTRO DE AR", 2, null, 9]),
    row(8, ["2026-01-01", "SAIDA", "FILTRO DE AR", 2, 1, 5]),
  ], context(), options());
  assert.deepEqual(result.errors.map((item) => item.rowNumber), [2, 3, 4, 5, 6]);
  assert.equal(result.rows[5].unitPrice, 4.5);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.summary.toImport, 2);
});

test("blocos de 500 linhas", () => {
  assert.deepEqual(chunk(Array.from({ length: 1201 }, (_, index) => index)).map((block) => block.length), [500, 500, 201]);
});
