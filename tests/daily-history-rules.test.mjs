import assert from "node:assert/strict";
import test from "node:test";
import { compareHistoryRows, historyFiltersToParams, historyStatusTags, likePattern, parseHistoryFilters, parseHistoryPage, workedAmount } from "../lib/daily-history-rules.ts";
import { requiresManualOperator, validateDailyRecord } from "../lib/daily-record-rules.ts";

test("filtros: ida e volta pela URL, datas invertidas e colaboradores sem duplicar", () => {
  const params = new URLSearchParams("q=+cm-19+&de=2026-09-20&ate=2026-09-01&frente=3&colaborador=João&colaborador=João&colaborador=Ana&pagina=2");
  const filters = parseHistoryFilters(params);
  assert.deepEqual(filters, { q: "cm-19", from: "2026-09-01", to: "2026-09-20", frontId: 3, operators: ["João", "Ana"] });
  assert.equal(parseHistoryPage(params), 2);
  assert.deepEqual(parseHistoryFilters(historyFiltersToParams(filters, 2)), filters);
  assert.equal(historyFiltersToParams(filters, 1).has("pagina"), false);
  assert.deepEqual(parseHistoryFilters(new URLSearchParams("de=ontem&frente=abc")), { q: "", from: "", to: "", frontId: null, operators: [] });
});

test("busca livre escapa curingas do ILIKE", () => {
  assert.equal(likePattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
});

test("trabalhado = final - inicial; nulo quando não trabalhou ou falta leitura", () => {
  assert.equal(workedAmount({ workedToday: true, startReading: 11225, endReading: 11234.5 }), 9.5);
  assert.equal(workedAmount({ workedToday: false, startReading: 1, endReading: 2 }), null);
  assert.equal(workedAmount({ workedToday: true, startReading: null, endReading: 2 }), null);
});

test("status: não trabalhou / trabalhou + problema + produção", () => {
  assert.deepEqual(historyStatusTags({ workedToday: false, inactiveOrProblem: false, hadProduction: false, productionType: null }).map((t) => t.key), ["off"]);
  assert.deepEqual(historyStatusTags({ workedToday: true, inactiveOrProblem: true, hadProduction: true, productionType: "PORTO" }).map((t) => t.label), ["Trabalhou", "Inativo/problema", "Produção (Porto)"]);
});

test("ordenação: data mais recente primeiro; no dia, equipamento (natural) e operador", () => {
  const rows = [
    { id: 1, recordDate: "2026-09-24", prefix: "CM-10", operator: "Ana" },
    { id: 2, recordDate: "2026-09-25", prefix: "CM-10", operator: "Bruno" },
    { id: 3, recordDate: "2026-09-25", prefix: "CM-2", operator: "Zé" },
    { id: 4, recordDate: "2026-09-25", prefix: "CM-10", operator: "ana" },
  ].sort(compareHistoryRows);
  assert.deepEqual(rows.map((r) => r.id), [3, 4, 2, 1]);
});

test("lançamento manual: só login de campo dispensa o nome do operador", () => {
  assert.equal(requiresManualOperator("CAMPO"), false);
  for (const profile of ["ADMIN", "GESTOR", "OPERADOR", "OFICINA"]) assert.equal(requiresManualOperator(profile), true);
  const draft = { recordDate: "2026-09-25", equipmentId: 7, workedToday: false, noWorkReason: "Chuva", serviceFrontId: null, location: "", startReading: "", endReading: "",
    fuelingCount: "", fuelings: [], inactiveOrProblem: null, problemReason: "", hadProduction: null, productionType: null, tripCount: "", trips: [], notes: "", hasProblemPhoto: false, hasProductionPhoto: false };
  assert.equal(validateDailyRecord(draft, "2026-09-25").value.operatorName, null);
  assert.ok(validateDailyRecord(draft, "2026-09-25", { manualOperator: true }).errors.operatorName);
  const ok = validateDailyRecord({ ...draft, operatorName: "  José   da Silva " }, "2026-09-25", { manualOperator: true });
  assert.equal(ok.value.operatorName, "José da Silva");
  assert.equal(validateDailyRecord({ ...draft, operatorName: "Fulano" }, "2026-09-25").value.operatorName, null, "login de campo ignora nome enviado");
});
