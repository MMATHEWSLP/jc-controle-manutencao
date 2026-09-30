import assert from "node:assert/strict";
import test from "node:test";
import { previousWeek, weekOf, weeklyReportText, weeklySummaryLine } from "../lib/weekly-report-rules.ts";

test("semana de segunda a domingo e a semana anterior completa", () => {
  assert.deepEqual(weekOf("2026-09-30"), { from: "2026-09-28", to: "2026-10-04" }); // quarta
  assert.deepEqual(weekOf("2026-09-28"), { from: "2026-09-28", to: "2026-10-04" }); // segunda
  assert.deepEqual(weekOf("2026-10-04"), { from: "2026-09-28", to: "2026-10-04" }); // domingo
  assert.deepEqual(previousWeek("2026-10-05"), { from: "2026-09-28", to: "2026-10-04" }); // envio de segunda
  assert.deepEqual(previousWeek("2027-01-01"), { from: "2026-12-21", to: "2026-12-27" });
});

const report = {
  period: { from: "2026-09-21", to: "2026-09-27" }, scope: "Todas as frentes",
  fuel: { exitLiters: 12450.4, entryLiters: 15000, fuelCost: 75000, outliers: [{ prefix: "CM-10", consumption: 2.1, typeAverage: 3, unit: "KM" }], withoutUsage: 0 },
  costs: { total: 90000, parts: 10000, maintenance: 5000 },
  maintenance: { done: 7, overdue: 3, near: 2, overdueList: ["PC-01", "PC-02", "CM-01"] },
  workOrders: { opened: 4, closed: 5, openNow: 6, oldest: [{ number: "OS-000001", prefix: "CM-01", days: 40 }] },
  checklists: { total: 50, blocked: 1, pending: 3, blockedList: ["CM-01"] },
  daily: { records: 120, problems: 2, problemList: [{ prefix: "PC-02", reason: "vazamento" }] },
  tanks: { measurements: 3, outside: 1, lossLiters: 180 },
  fleet: { maintenance: 2, stopped: 1 },
  components: { alerts: 0, list: [] },
};

test("texto do WhatsApp com as seções e sem o que está zerado", () => {
  const text = weeklyReportText(report, "https://exemplo/");
  assert.match(text, /^\*Resumo semanal — 21\/09 a 27\/09\*/);
  assert.match(text, /Saídas para a frota: 12\.450 L/);
  assert.match(text, /Consumo acima da média: CM-10/);
  assert.match(text, /1 medição\(ões\) fora da tolerância \(perda de 180 L\)/);
  assert.match(text, /Trocas vencidas hoje: 3 \(PC-01, PC-02, CM-01\) · urgentes: 2/);
  assert.match(text, /OS-000001 CM-01 \(40 dias\)/);
  assert.doesNotMatch(text, /Pneus\/baterias/);
  assert.match(text, /Detalhes: https:\/\/exemplo\//);
  assert.doesNotMatch(weeklyReportText({ ...report, costs: null }), /Custo total/);
});

test("linha única para o modelo da Meta", () => {
  const line = weeklySummaryLine(report);
  assert.doesNotMatch(line, /\n|\s{2,}/);
  assert.match(line, /Combustível 12\.450 L \(1 acima da média\)/);
  assert.ok(line.length <= 900);
});
