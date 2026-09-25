import assert from "node:assert/strict";
import test from "node:test";
import { emptyFueling, parseDecimal, readingUnitFor, resizeCards, validateDailyRecord } from "../lib/daily-record-rules.ts";

const TODAY = "2026-09-25";
const base = (overrides = {}) => ({
  recordDate: TODAY, equipmentId: 7, workedToday: true, noWorkReason: "", serviceFrontId: 2, location: "Fazenda Flexal T-12",
  startReading: "11225", endReading: "11234,5", fuelingCount: "", fuelings: [], inactiveOrProblem: false, problemReason: "",
  hadProduction: false, productionType: null, tripCount: "", trips: [], notes: "", hasProblemPhoto: false, hasProductionPhoto: false, ...overrides,
});

test("cards dinâmicos: cria N, preserva os primeiros ao reduzir e some com 0/vazio", () => {
  const three = resizeCards([], "3", emptyFueling, 20);
  assert.equal(three.length, 3);
  const filled = three.map((item, index) => ({ ...item, liters: String(index + 1) }));
  const two = resizeCards(filled, "2", emptyFueling, 20);
  assert.deepEqual(two.map((item) => item.liters), ["1", "2"], "remove do último para o primeiro, mantendo os dados");
  assert.deepEqual(resizeCards(two, "4", emptyFueling, 20).map((item) => item.liters), ["1", "2", "", ""]);
  assert.equal(resizeCards(two, "", emptyFueling, 20).length, 0);
  assert.equal(resizeCards(two, "0", emptyFueling, 20).length, 0);
  assert.equal(resizeCards([], "99", emptyFueling, 20).length, 20, "respeita o limite");
});

test("registro completo válido é normalizado", () => {
  const { errors, value } = validateDailyRecord(base(), TODAY);
  assert.deepEqual(errors, {});
  assert.equal(value.startReading, 11225);
  assert.equal(value.endReading, 11234.5);
  assert.deepEqual(value.fuelings, []);
});

test("não trabalhou: só exige o motivo e descarta o resto", () => {
  const draft = base({ workedToday: false, location: "", endReading: "", inactiveOrProblem: null, hadProduction: null });
  assert.deepEqual(Object.keys(validateDailyRecord(draft, TODAY).errors), ["noWorkReason"]);
  const { value } = validateDailyRecord({ ...draft, noWorkReason: "Chuva" }, TODAY);
  assert.equal(value.workedToday, false);
  assert.equal(value.endReading, null);
  assert.equal(value.noWorkReason, "Chuva");
});

test("trabalhou: frente, localização, leituras e respostas Sim/Não são obrigatórias", () => {
  const { errors } = validateDailyRecord(base({ serviceFrontId: null, location: " ", endReading: "", inactiveOrProblem: null, hadProduction: null }), TODAY);
  assert.deepEqual(Object.keys(errors).sort(), ["endReading", "hadProduction", "inactiveOrProblem", "location", "serviceFrontId"]);
  assert.ok(validateDailyRecord(base({ endReading: "100" }), TODAY).errors.endReading, "final menor que inicial");
  assert.ok(validateDailyRecord(base({ recordDate: "2026-09-28" }), TODAY).errors.recordDate, "data futura");
});

test("abastecimentos: cada card precisa de litros e local", () => {
  const draft = base({ fuelingCount: "2", fuelings: [{ liters: "150,5", location: "Comboio" }, { liters: "", location: "" }] });
  assert.deepEqual(Object.keys(validateDailyRecord(draft, TODAY).errors).sort(), ["fuelings.1.liters", "fuelings.1.location"]);
  draft.fuelings[1] = { liters: "80", location: "Posto BR" };
  assert.deepEqual(validateDailyRecord(draft, TODAY).value.fuelings, [{ liters: 150.5, location: "Comboio" }, { liters: 80, location: "Posto BR" }]);
});

test("problema: motivo obrigatório, foto opcional", () => {
  assert.ok(validateDailyRecord(base({ inactiveOrProblem: true }), TODAY).errors.problemReason);
  const { value } = validateDailyRecord(base({ inactiveOrProblem: true, problemReason: "Mangueira estourada" }), TODAY);
  assert.equal(value.problemReason, "Mangueira estourada");
});

test("produção BALDEIO: viagens com toras + foto da ficha obrigatória", () => {
  const draft = base({ hadProduction: true, productionType: "BALDEIO", tripCount: "2", trips: [{ logs: "12", meters: "" }, { logs: "", meters: "" }] });
  assert.deepEqual(Object.keys(validateDailyRecord(draft, TODAY).errors).sort(), ["productionPhoto", "trips.1.logs"]);
  draft.trips[1].logs = "9";
  const { value } = validateDailyRecord({ ...draft, hasProductionPhoto: true }, TODAY);
  assert.deepEqual(value.trips, [{ logs: 12, meters: null }, { logs: 9, meters: null }]);
});

test("produção PORTO: cada viagem exige toras e metragem; tipo e viagens obrigatórios", () => {
  assert.deepEqual(Object.keys(validateDailyRecord(base({ hadProduction: true }), TODAY).errors).sort(), ["productionType", "tripCount"]);
  const draft = base({ hadProduction: true, productionType: "PORTO", tripCount: "1", trips: [{ logs: "30", meters: "" }], hasProductionPhoto: true });
  assert.deepEqual(Object.keys(validateDailyRecord(draft, TODAY).errors), ["trips.0.meters"]);
  draft.trips[0].meters = "42,7";
  assert.deepEqual(validateDailyRecord(draft, TODAY).value.trips, [{ logs: 30, meters: 42.7 }]);
});

test("leituras e unidade", () => {
  assert.equal(parseDecimal("1.234,5"), 1234.5);
  assert.equal(parseDecimal("abc"), null);
  assert.equal(readingUnitFor("KM", "PC-10"), "KM");
  assert.equal(readingUnitFor("HOURS_KM", "CM-05"), "KM");
  assert.equal(readingUnitFor("HOURS_KM", "PC-10"), "HOURS");
});
