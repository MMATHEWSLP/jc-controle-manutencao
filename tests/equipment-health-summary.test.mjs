import assert from "node:assert/strict";
import test from "node:test";
import { calculatePlanState, planBalanceText, planDetailStatus, planSortRank, summarizeEquipmentHealth } from "../lib/maintenance-engine.ts";

const thresholds = { alertaHorasAmareloFim: 100, alertaHorasLaranjaFim: 50, alertaKmAmareloFim: 2000, alertaKmLaranjaFim: 1000, urgencyPercent: 20 };

function kmPlan({ id, lastKm, intervalKm, currentKm }) {
  return calculatePlanState({ id, triggerMode: "KM", intervalHours: null, intervalKm, lastHours: null, lastKm, nextHours: null, nextKm: lastKm !== null && intervalKm !== null ? lastKm + intervalKm : null }, 0, currentKm, thresholds);
}

test("saldo positivo, zero e negativo produzem exatamente o texto exigido", () => {
  const overdue = kmPlan({ id: 1, lastKm: 184244, intervalKm: 5000, currentKm: 190189 });
  assert.equal(planBalanceText(overdue), "Vencida há 945 km");
  const exact = kmPlan({ id: 2, lastKm: 184244, intervalKm: 5000, currentKm: 189244 });
  assert.equal(planBalanceText(exact), "Troca no limite atual");
  const remaining = kmPlan({ id: 3, lastKm: 184244, intervalKm: 5000, currentKm: 187000 });
  assert.equal(planBalanceText(remaining), "Faltam 2.244 km");
});

test("sem histórico suficiente mostra o texto exigido, nunca um saldo inventado", () => {
  const noHistory = calculatePlanState({ id: 4, triggerMode: "KM", intervalHours: null, intervalKm: 5000, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  assert.equal(planBalanceText(noHistory), "Histórico sem leitura suficiente para calcular");
  const noPlan = calculatePlanState({ id: 5, triggerMode: "KM", intervalHours: null, intervalKm: null, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  assert.equal(planBalanceText(noPlan), "—");
});

test("planDetailStatus traduz o PlanState para o vocabulário exigido na ficha", () => {
  const overdue = kmPlan({ id: 1, lastKm: 184244, intervalKm: 5000, currentKm: 190189 });
  assert.deepEqual(planDetailStatus(overdue), { label: "Vencida", tone: "red" });
  const atLimit = kmPlan({ id: 2, lastKm: 184244, intervalKm: 5000, currentKm: 189244 });
  assert.deepEqual(planDetailStatus(atLimit), { label: "No limite", tone: "yellow" });
  const ok = kmPlan({ id: 3, lastKm: 0, intervalKm: 5000, currentKm: 100 });
  assert.deepEqual(planDetailStatus(ok), { label: "Em dia", tone: "green" });
  const noHistory = calculatePlanState({ id: 4, triggerMode: "KM", intervalHours: null, intervalKm: 5000, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  assert.deepEqual(planDetailStatus(noHistory), { label: "Sem histórico", tone: "gray" });
  const noPlan = calculatePlanState({ id: 5, triggerMode: "KM", intervalHours: null, intervalKm: null, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  assert.deepEqual(planDetailStatus(noPlan), { label: "Dados insuficientes", tone: "gray" });
});

test("planSortRank ordena vencidas antes de próximas, em dia e sem dados", () => {
  const overdue = kmPlan({ id: 1, lastKm: 184244, intervalKm: 5000, currentKm: 190189 });
  const warning = kmPlan({ id: 2, lastKm: 0, intervalKm: 5000, currentKm: 3500 });
  const ok = kmPlan({ id: 3, lastKm: 0, intervalKm: 5000, currentKm: 100 });
  const noHistory = calculatePlanState({ id: 4, triggerMode: "KM", intervalHours: null, intervalKm: 5000, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  const ranks = [ok, noHistory, overdue, warning].map((state) => planSortRank(state));
  const sorted = [...ranks].sort((a, b) => a - b);
  assert.deepEqual(ranks.map((_, i) => i).sort((a, b) => ranks[a] - ranks[b]), [2, 3, 0, 1], "vencido, depois próximo, depois em dia, depois sem histórico");
  assert.deepEqual(sorted, [...ranks].sort((a, b) => a - b));
});

test("equipamento vencido nunca mostra saúde preventiva Normal nem zero itens de atenção", () => {
  const overdue = kmPlan({ id: 1, lastKm: 184244, intervalKm: 5000, currentKm: 190189 });
  const ok = kmPlan({ id: 2, lastKm: 0, intervalKm: 5000, currentKm: 100 });
  const summary = summarizeEquipmentHealth([{ name: "Óleo do motor", state: overdue }, { name: "Óleo do diferencial", state: ok }]);
  assert.equal(summary.situation, "Vencido");
  assert.notEqual(summary.situation, "Em dia");
  assert.equal(summary.counts.overdue, 1);
  assert.ok(summary.counts.overdue > 0);
});

test("card mostra as trocas vencidas ordenadas da mais crítica para a menos crítica", () => {
  const nearCritical = kmPlan({ id: 1, lastKm: 0, intervalKm: 1000, currentKm: 5000 }); // muito vencido -> NEAR
  const justOverdue = kmPlan({ id: 2, lastKm: 0, intervalKm: 5000, currentKm: 5100 }); // pouco vencido -> OVERDUE
  const summary = summarizeEquipmentHealth([{ name: "Item pouco vencido", state: justOverdue }, { name: "Item muito vencido", state: nearCritical }]);
  assert.equal(summary.overduePlans.length, 2);
  assert.equal(summary.overduePlans[0].name, "Item muito vencido", "o mais crítico (NEAR) vem primeiro, independente da ordem de entrada");
});

test("equipamento com plano configurado mas sem histórico é 'Dados pendentes', diferente de 'Sem plano'", () => {
  const noHistory = calculatePlanState({ id: 1, triggerMode: "KM", intervalHours: null, intervalKm: 5000, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  const pending = summarizeEquipmentHealth([{ name: "Óleo do motor", state: noHistory }]);
  assert.equal(pending.situation, "Dados pendentes");
  assert.equal(pending.health, null);

  const noPlanAtAll = calculatePlanState({ id: 2, triggerMode: "KM", intervalHours: null, intervalKm: null, lastHours: null, lastKm: null, nextHours: null, nextKm: null }, 0, 100, thresholds);
  const empty = summarizeEquipmentHealth([{ name: "Óleo do motor", state: noPlanAtAll }]);
  assert.equal(empty.situation, "Sem plano");
});

test("equipamento sem nenhum plano cadastrado também é 'Sem plano'", () => {
  const summary = summarizeEquipmentHealth([]);
  assert.equal(summary.situation, "Sem plano");
  assert.equal(summary.health, null);
  assert.deepEqual(summary.overduePlans, []);
});
