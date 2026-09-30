import assert from "node:assert/strict";
import test from "node:test";
import { isOwnCompany, normalizeFicha, titleCaseName } from "../lib/assistant-rules.ts";

const line = (values) => ({ data: "", tipo: "", frente: "", origem: "", combustivel: "", equipamento: "", empresa: "", litros: "", leitura: "", tanque_cheio: "", motorista: "", observacao: "", duvidas: [], ...values });

test("nome do motorista com iniciais maiúsculas", () => {
  assert.equal(titleCaseName("JOSÉ SOUSA"), "José Sousa");
  assert.equal(titleCaseName("  maria  DA silva "), "Maria da Silva");
});

test("empresa JC ou vazia é frota própria", () => {
  assert.equal(isOwnCompany(""), true);
  assert.equal(isOwnCompany("jc"), true);
  assert.equal(isOwnCompany("J.C."), true);
  assert.equal(isOwnCompany("Gregoleto"), false);
});

test("cabeçalho vale para todas as linhas; leitura 0000 vira vazia; observação padrão", () => {
  const result = normalizeFicha({
    data: "29/09/2026 07:30", frente: "Arapiuns", combustivel: "Diesel S10", origem: "Frente Arapiuns", avisos: [],
    linhas: [
      line({ data: "28/09/2026", equipamento: "CM-35", empresa: "JC", litros: "297,5", leitura: "0000", motorista: "JOSÉ SOUSA" }),
      line({ equipamento: "QVN6E34", empresa: "Gregoleto", litros: "150", leitura: "41 1208", motorista: "ana", duvidas: [{ coluna: "leitura", motivo: "primeiro dígito ilegível" }] }),
      line({}),
    ],
  });
  assert.equal(result.rows.length, 2, "linha em branco é ignorada");
  const [first, second] = result.rows;
  assert.equal(first.values.data, "29/09/2026");
  assert.equal(first.values.tipo, "SAIDA_FROTA");
  assert.equal(first.values.empresa, "");
  assert.equal(first.values.leitura, "");
  assert.equal(first.values.frente, "Arapiuns");
  assert.equal(first.values.combustivel, "Diesel S10");
  assert.equal(first.values.tanque_cheio, "SIM");
  assert.equal(first.values.motorista, "José Sousa");
  assert.equal(first.values.observacao, "Ficha de abastecimento 29/09/2026");
  assert.deepEqual(first.doubts, {});
  assert.equal(second.values.tipo, "SAIDA_TERCEIRO");
  assert.equal(second.values.leitura, "411208");
  assert.deepEqual(second.doubts.leitura, ["primeiro dígito ilegível"]);
  assert.ok(second.doubts.tipo, "terceiro deduzido fica marcado para conferir");
});

test("data do cabeçalho ilegível vira aviso", () => {
  const result = normalizeFicha({ data: "??", frente: "Arapiuns", combustivel: "Diesel", origem: "", avisos: ["foto 2 cortada"], linhas: [line({ equipamento: "CM-01", litros: "50", motorista: "Ze" })] });
  assert.match(result.warnings[0], /Data do cabeçalho ilegível/);
  assert.equal(result.warnings[1], "foto 2 cortada");
  assert.equal(result.rows[0].values.origem, "Frente Arapiuns");
});
