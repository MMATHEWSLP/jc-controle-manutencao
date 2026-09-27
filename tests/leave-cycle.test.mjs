import assert from "node:assert/strict";
import test from "node:test";
import { cycleTotals, daysBetween, nextStep, statusForPhase, summarizeCycle, validateCycleDates } from "../lib/leave-cycle.ts";

const targets = { workDaysTarget: 90, offDaysTarget: 10 };
const empty = { workStart: null, frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null };

test("contagem de dias por etapa (a folga só conta a partir da chegada em casa)", () => {
  const cycle = { workStart: "2026-06-01", frontDeparture: "2026-08-30", homeArrival: "2026-09-01", homeDeparture: "2026-09-11", frontArrival: "2026-09-13" };
  const summary = summarizeCycle(cycle, targets, "2026-09-27");
  assert.equal(summary.phase, "FECHADO");
  assert.equal(summary.workedDays, 90);
  assert.equal(summary.travelOutDays, 2);
  assert.equal(summary.offDays, 10);
  assert.equal(summary.travelBackDays, 2);
  assert.equal(summary.travelDays, 4);
  assert.equal(summary.alert, null);
  assert.equal(nextStep(cycle), null);
});

test("etapa em andamento conta até hoje", () => {
  const working = summarizeCycle({ ...empty, workStart: "2026-07-01" }, targets, "2026-09-27");
  assert.equal(working.phase, "TRABALHANDO");
  assert.equal(working.workedDays, 88);
  assert.equal(working.daysToLeave, 2);
  assert.deepEqual(working.alert, { kind: "APPROACHING", level: 3, daysLeft: 2 });
  const home = summarizeCycle({ ...empty, workStart: "2026-06-01", frontDeparture: "2026-09-10", homeArrival: "2026-09-12" }, targets, "2026-09-20");
  assert.equal(home.phase, "FOLGA");
  assert.equal(home.offDays, 8);
  assert.equal(home.nextStep, "homeDeparture");
});

test("alertas: faltando 5/3/1 dias, ciclo excedido e folga estourada", () => {
  const at = (worked) => summarizeCycle({ ...empty, workStart: "2026-06-01" }, targets, new Date(Date.UTC(2026, 5, 1 + worked, 12)).toISOString().slice(0, 10)).alert;
  assert.equal(at(80), null);
  assert.deepEqual(at(85), { kind: "APPROACHING", level: 5, daysLeft: 5 });
  assert.deepEqual(at(89), { kind: "APPROACHING", level: 1, daysLeft: 1 });
  assert.deepEqual(at(93), { kind: "WORK_EXCEEDED", days: 3 });
  const overdue = summarizeCycle({ ...empty, workStart: "2026-06-01", frontDeparture: "2026-08-30", homeArrival: "2026-09-01" }, targets, "2026-09-15");
  assert.deepEqual(overdue.alert, { kind: "OFF_OVERDUE", days: 4 });
  assert.equal(overdue.overdueOffDays, 4);
});

test("ciclo personalizado por funcionário", () => {
  const summary = summarizeCycle({ ...empty, workStart: "2026-09-01" }, { workDaysTarget: 30, offDaysTarget: 5 }, "2026-09-27");
  assert.equal(summary.daysToLeave, 4);
  assert.equal(summary.alert.kind, "APPROACHING");
});

test("validação: ordem das datas e sem datas futuras; ciclo convertido pode ter lacunas", () => {
  assert.equal(validateCycleDates({ ...empty, workStart: "2026-06-01", frontDeparture: "2026-08-30" }, "2026-09-27"), null);
  assert.match(validateCycleDates({ ...empty, workStart: "2026-06-01", frontDeparture: "2026-05-30" }, "2026-09-27"), /não pode ser antes/);
  assert.match(validateCycleDates({ ...empty, workStart: "2026-10-01" }, "2026-09-27"), /futura/);
  assert.equal(validateCycleDates({ ...empty, homeArrival: "2026-09-27" }, "2026-09-27"), null);
});

test("totais do perfil e situação acompanhando a etapa", () => {
  const cycles = [
    { workStart: "2026-01-01", frontDeparture: "2026-03-31", homeArrival: "2026-04-02", homeDeparture: "2026-04-12", frontArrival: "2026-04-14", ...targets },
    { workStart: "2026-04-14", frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null, ...targets },
  ];
  assert.deepEqual(cycleTotals(cycles, "2026-05-01"), { offDays: 10, travelDays: 4, cycles: 2 });
  assert.equal(statusForPhase("ATIVO", "VIAGEM_IDA"), "FOLGA");
  assert.equal(statusForPhase("FOLGA", "FECHADO"), "ATIVO");
  assert.equal(statusForPhase("AFASTADO", "FOLGA"), "AFASTADO");
  assert.equal(daysBetween("2026-02-27", "2026-03-01"), 2);
});

test("ciclo encerrado pela demissão, tempo de casa e permanência nas frentes", async () => {
  const { summarizeStoredCycle, tenure, frontStays, openSpan } = await import("../lib/leave-cycle.ts");
  const ended = summarizeStoredCycle({ ...empty, workStart: "2026-06-01", endedAt: "2026-07-01", ...targets }, "2026-09-27");
  assert.equal(ended.workedDays, 30);
  assert.equal(ended.alert, null);
  assert.equal(tenure("2024-06-15", "2026-09-27").label, "2 anos, 3 meses e 12 dias");
  assert.equal(tenure("2026-09-27", "2026-09-27").label, "0 dias");
  const stays = frontStays([{ id: 2, transferDate: "2026-08-01" }, { id: 1, transferDate: "2026-01-01" }], "2026-09-27");
  assert.deepEqual(stays.map((stay) => [stay.id, stay.days, stay.current]), [[2, 57, true], [1, 212, false]]);
  assert.equal(openSpan("2026-09-01", "2026-09-10", "2026-09-27"), 9);
});
