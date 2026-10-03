// Regras puras da importação do Controle Diário: cabeçalho, leitura das linhas, "Conferir",
// separação de escalas (um código para dois equipamentos), casamento pelo prefixo e sugestões.
import assert from "node:assert/strict";
import test from "node:test";
import {
  casarPorPrefixo, conferirLeituras, DIESEL_LIMITE_LITROS, gruposDeEscala, lerData, lerLinhaDiario, lerNumero, mapearCabecalhoDiario, mesDoLote, sugerirEquipamento, totaisDiario,
} from "../lib/daily-import-rules.ts";

const CABECALHO = ["Data", "Equipamento", "Frente", "Operador", "Sem operador", "Local", "Local original", "Leitura inicial", "Leitura final", "KM/Horas trabalhadas", "Local Produção",
  "Viagens Porto", "Volume Porto (m³)", "Toras Porto", "Viagens Baldeio", "Total de viagens", "Diesel (L)", "Problema relatado", "Observações"];

test("cabeçalho: todas as colunas; obrigatórias faltando", () => {
  const { indices, faltando } = mapearCabecalhoDiario(CABECALHO);
  assert.deepEqual(faltando, []);
  assert.equal(indices.local, 5);
  assert.equal(indices.localOriginal, 6);
  assert.equal(indices.localProducao, 10);
  assert.equal(indices.trabalhado, 9);
  assert.equal(indices.diesel, 16);
  assert.deepEqual(mapearCabecalhoDiario(["Data", "Equipamento"]).faltando, ["Frente", "Leitura inicial", "Leitura final"]);
});

test("números e datas", () => {
  assert.equal(lerNumero("1.234,5"), 1234.5);
  assert.equal(lerNumero("1234.5"), 1234.5);
  assert.equal(lerNumero(""), null);
  assert.equal(lerNumero("abc"), null);
  assert.equal(lerData("01/09/2026"), "2026-09-01");
  assert.equal(lerData("2026-09-30"), "2026-09-30");
  assert.equal(lerData(new Date("2026-09-15T00:00:00Z")), "2026-09-15");
  assert.equal(lerData(46266), "2026-09-01");
  assert.equal(lerData("ontem"), null);
});

test("linha: sem operador, produção do porto e total de viagens", () => {
  const { indices } = mapearCabecalhoDiario(CABECALHO);
  const linha = lerLinhaDiario(["01/09/2026", "cm 22", "Arapiuns", "joão  silva", "NÃO", "concessão", "Concessao 2", "1.000", "1.050", 50, "Porto", 3, "45,5", 60, 0, "", 120, "pneu furado", ""], indices, 2);
  assert.equal(linha.equipamento, "CM22");
  assert.equal(linha.operador, "JOÃO SILVA");
  assert.equal(linha.semOperador, false);
  assert.equal(linha.local, "CONCESSÃO");
  assert.equal(linha.localProducao, "PORTO");
  assert.equal(linha.totalViagens, 3);
  assert.equal(linha.volumePorto, 45.5);
  assert.equal(linha.problema, "pneu furado");
  const sem = lerLinhaDiario(["01/09/2026", "CM-22", "Arapiuns", "", "SIM", "", "", 0, 0, 0, "", 0, 0, 0, 2, 2, 0, "", ""], indices, 3);
  assert.equal(sem.semOperador, true);
  assert.equal(sem.operador, null);
  assert.equal(sem.localProducao, null);
  const totais = totaisDiario([linha, sem]);
  assert.equal(totais.viagens, 5);
  assert.equal(totais.diesel, 120);
});

const l = (linha, data, inicial, final) => ({ linha, data, leituraInicial: inicial, leituraFinal: final, operador: "X" });

test("conferir: final menor, inicial abaixo da final anterior, sem leitura; iguais em dias seguidos são normais", () => {
  const { conferir, avisos } = conferirLeituras([
    l(1, "2026-09-01", 100, 110), l(2, "2026-09-02", 110, 110), l(3, "2026-09-03", 110, 110), // parado: normal
    l(4, "2026-09-04", 105, 120), // inicial < 110
    l(5, "2026-09-05", 130, 125), // final < inicial
    l(6, "2026-09-06", null, 140),
    l(7, "2026-09-07", 140, 150), l(8, "2026-09-07", 140, 150), // mesmo dia, idênticos (com trabalho)
    l(9, "2026-09-08", 0, 0), l(10, "2026-09-08", 0, 0), // zerados no mesmo dia: não avisa
  ]);
  assert.deepEqual([...conferir.keys()].sort((a, b) => a - b), [4, 5, 6, 9, 10]);
  assert.deepEqual(conferir.get(4), ["INICIAL_MENOR_QUE_FINAL_ANTERIOR"]);
  assert.deepEqual(conferir.get(5), ["FINAL_MENOR_QUE_INICIAL"]);
  assert.deepEqual(conferir.get(6), ["SEM_LEITURA"]);
  assert.ok(!conferir.has(2) && !conferir.has(3));
  assert.deepEqual(avisos.get(7), ["LEITURAS_IGUAIS_NO_DIA"]);
  assert.ok(!avisos.has(9));
});

test("escalas: CC-02 com ~167.000 km e ~500 h vira dois grupos; uma escala só não separa", () => {
  const linhas = [
    { ...l(1, "2026-09-01", 167000, 167200), operador: "SERGIO" }, { ...l(2, "2026-09-02", 167200, 167450), operador: "VALDINEY" },
    { ...l(3, "2026-09-01", 500, 508), operador: "FRANCIAN" }, { ...l(4, "2026-09-02", 508, 515), operador: "FRANCIAN" },
  ];
  const grupos = gruposDeEscala(linhas);
  assert.ok(grupos);
  assert.deepEqual(grupos.baixo.linhas, [3, 4]);
  assert.deepEqual(grupos.alto.linhas, [1, 2]);
  assert.deepEqual(grupos.alto.operadores, ["SERGIO", "VALDINEY"]);
  assert.equal(grupos.alto.primeira, 167000);
  assert.equal(grupos.alto.ultima, 167450);
  assert.equal(gruposDeEscala([l(1, "2026-09-01", 100, 110), l(2, "2026-09-02", 110, 130)]), null);
});

test("prefixo: HL-02 casa com HL-02-QVN6E34; ambíguo ou ausente não casa", () => {
  const cadastro = [{ id: 1, prefix: "HL-02-QVN6E34" }, { id: 2, prefix: "HL-01-ABC1D23" }, { id: 3, prefix: "HL-012" }, { id: 4, prefix: "CC-05-X" }, { id: 5, prefix: "CC-05-Y" }];
  assert.equal(casarPorPrefixo("HL-02", cadastro)?.id, 1);
  assert.equal(casarPorPrefixo("hl-01", cadastro)?.id, 2);
  assert.equal(casarPorPrefixo("CC-05", cadastro), null);
  assert.equal(casarPorPrefixo("HL-09", cadastro), null);
});

test("sugestão: faixa da planilha que contém o grupo (CA-01 → CC-01; CC-02 km → HL-02), senão o cadastro", () => {
  const faixas = [{ equipmentId: 16, min: 2000, max: 9000 }, { equipmentId: 11, min: 279000, max: 284000 }, { equipmentId: 42, min: 166000, max: 168500 }];
  assert.equal(sugerirEquipamento({ primeira: 280000, ultima: 283000 }, faixas, []), 11);
  assert.equal(sugerirEquipamento({ primeira: 167000, ultima: 167450 }, faixas, []), 42);
  assert.equal(sugerirEquipamento({ primeira: 90000, ultima: 90500 }, faixas, [{ id: 7, atual: 89900 }, { id: 8, atual: 95000 }]), 7);
  assert.equal(sugerirEquipamento({ primeira: 90000, ultima: 90500 }, faixas, [{ id: 8, atual: 95000 }]), null);
});

test("lote e limite de diesel", () => {
  assert.equal(mesDoLote(["2026-09-01", "2026-09-30", "2026-10-01"]), "IMPORTACAO_SETEMBRO_2026");
  assert.equal(DIESEL_LIMITE_LITROS, 600);
});
