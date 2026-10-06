import assert from "node:assert/strict";
import test from "node:test";
import { aiReadingDiverges, convoyWarnings, estimatedConsumption, fortalezaWallTime, matchesSearch, parseConvoyNumber, readConvoyPayload, validateConvoyPayload } from "../lib/convoy-rules.ts";

const base = { liters: 300, reading: 8120, unit: "HOURS", lastReading: 8100, lastReadingDate: "2026-10-05", recordDate: "2026-10-06", litersStats: { count: 10, average: 280, max: 350 }, avgPerDay: 10 };
const codes = (input) => convoyWarnings({ ...base, ...input }).map((warning) => warning.code);

test("avisos da hora: leitura menor, salto alto e litragem alta (sem bloquear)", () => {
  assert.deepEqual(codes({}), []);
  assert.deepEqual(codes({ reading: 8090 }), ["LEITURA_MENOR"]);
  // 1 dia: no máximo 24 h no horímetro (25 h já é salto).
  assert.deepEqual(codes({ reading: 8125 }), ["SALTO_ALTO"]);
  assert.deepEqual(codes({ reading: 8122 }), []);
  // 3 dias com média de 10 h/dia: acima de 3× o esperado (90 h) é salto, mesmo abaixo de 72 h/dia.
  assert.deepEqual(codes({ lastReadingDate: "2026-10-03", reading: 8150 }), []);
  assert.deepEqual(codes({ lastReadingDate: "2026-10-03", reading: 8195 }), ["SALTO_ALTO"]);
  // KM: 1.000 km por dia.
  assert.deepEqual(codes({ unit: "KM", reading: 141500, lastReading: 140000, avgPerDay: null }), ["SALTO_ALTO"]);
  assert.deepEqual(codes({ unit: "KM", reading: 140900, lastReading: 140000, avgPerDay: null }), []);
  // Litragem: acima de 20% do maior abastecimento ou 1,8× a média; acima de 1.200 L sempre.
  assert.deepEqual(codes({ liters: 430 }), ["LITRAGEM_ALTA"]);
  assert.deepEqual(codes({ liters: 1300, litersStats: null }), ["LITRAGEM_ALTA"]);
  assert.deepEqual(codes({ liters: 900, litersStats: { count: 2, average: 100, max: 100 } }), [], "menos de 3 abastecimentos no histórico: sem comparação");
  // Sem leitura (sem foto): só confere a litragem.
  assert.deepEqual(codes({ reading: null }), []);
});

test("consumo estimado e números digitados no formato brasileiro", () => {
  assert.deepEqual(estimatedConsumption("HOURS", 300, 20), { value: 15, unit: "L/h" });
  assert.deepEqual(estimatedConsumption("KM", 200, 500), { value: 2.5, unit: "km/L" });
  assert.equal(estimatedConsumption("KM", 200, -5), null);
  assert.equal(parseConvoyNumber("1.234,5"), 1234.5);
  assert.equal(parseConvoyNumber("411.208"), 411208);
  assert.equal(parseConvoyNumber("347.5"), 347.5);
  assert.equal(parseConvoyNumber(""), null);
  assert.ok(Number.isNaN(parseConvoyNumber("abc")));
});

test("busca local sem acento e sem sinais", () => {
  assert.ok(matchesSearch("pc20", "PC-20", "PC20"));
  assert.ok(matchesSearch("joao silva", "JOÃO DA SILVA"));
  assert.ok(!matchesSearch("cm35", "PC-20"));
  assert.ok(matchesSearch("qvn6", "HL-02", "QVN6E34"));
});

const uuid = "8a6e0f5e-1f2b-4c3d-9e8f-0a1b2c3d4e5f";
const payload = (input = {}) => readConvoyPayload({ clientUuid: uuid, equipmentId: 7, operatorName: "JOSÉ", liters: "300", reading: "8.120", recordedAt: "2026-10-06T14:00:00.000Z", recordDate: "2026-10-06", ...input });
const options = { hasMeterPhoto: true, hasPumpPhoto: false, pumpPhotoRequired: false, today: "2026-10-06" };

test("preenchimento: foto obrigatória, sem foto com motivo, dia anterior com justificativa", () => {
  assert.equal(validateConvoyPayload(payload(), options), null);
  assert.equal(payload().reading, 8120);
  assert.match(validateConvoyPayload(payload(), { ...options, hasMeterPhoto: false }), /foto do KM/);
  assert.match(validateConvoyPayload(payload({ reading: "" }), options), /leitura/);
  // Sem foto: motivo obrigatório; leitura opcional; "Outro" pede o texto.
  assert.match(validateConvoyPayload(payload({ noPhoto: true, reading: "" }), { ...options, hasMeterPhoto: false }), /motivo/);
  assert.equal(validateConvoyPayload(payload({ noPhoto: true, noPhotoReason: "EQUIPAMENTO_FECHADO", reading: "" }), { ...options, hasMeterPhoto: false }), null);
  assert.match(validateConvoyPayload(payload({ noPhoto: true, noPhotoReason: "OUTRO" }), { ...options, hasMeterPhoto: false }), /motivo/);
  // Data: hoje ou ontem com justificativa; nunca futura nem anteontem.
  assert.match(validateConvoyPayload(payload({ recordDate: "2026-10-05" }), options), /justificativa/);
  assert.equal(validateConvoyPayload(payload({ recordDate: "2026-10-05", dateJustification: "sem sinal" }), options), null);
  assert.match(validateConvoyPayload(payload({ recordDate: "2026-10-04", dateJustification: "x" }), options), /hoje ou o dia anterior/);
  assert.match(validateConvoyPayload(payload({ recordDate: "2026-10-07" }), options), /futura/);
  // Registro guardado offline e enviado dias depois: vale o dia em que foi registrado (recordedAt).
  assert.equal(validateConvoyPayload(payload(), { ...options, today: undefined }), null);
  assert.match(validateConvoyPayload(payload(), { ...options, pumpPhotoRequired: true }), /bomba/);
  assert.match(validateConvoyPayload(payload({ clientUuid: "x" }), options), /identificação/);
  assert.match(validateConvoyPayload(payload({ liters: "0" }), options), /litros/);
});

test("conferência da foto: diverge acima de 0,5% (mínimo 2 unidades) e hora de Fortaleza", () => {
  assert.equal(aiReadingDiverges(8120, 8121), false);
  assert.equal(aiReadingDiverges(8120, 8180), true);
  assert.equal(aiReadingDiverges(140900, 141500), false);
  assert.equal(aiReadingDiverges(140900, 148000), true);
  assert.equal(fortalezaWallTime("2026-10-06T14:05:00.000Z"), "2026-10-06T11:05");
  assert.equal(fortalezaWallTime("2026-10-06T01:30:00.000Z"), "2026-10-05T22:30");
});
