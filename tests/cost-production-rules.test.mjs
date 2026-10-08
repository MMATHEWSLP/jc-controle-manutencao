// Relatórios casados (lib/cost-production-rules.ts): rateio do custo do equipamento entre operadores e
// locais, agrupamentos que somam sempre o mesmo total, indicadores e período anterior.
import assert from "node:assert/strict";
import test from "node:test";
import { allocateCosts, attachPrevious, buildCostReport, NO_DAILY, NO_EQUIPMENT, previousPeriod, sortRows, variation } from "../lib/cost-production-rules.ts";

const cost = (category, amount, extra = {}) => ({ category, amount, date: "2026-09-10", frontName: "Frente A", equipmentId: 1, equipmentLabel: "TR-01", unit: "HOURS", ...extra });
const ficha = (extra = {}) => ({ date: "2026-09-10", frontName: "Frente A", equipmentId: 1, equipmentLabel: "TR-01", operator: "Ana", location: "Talhão 1", unit: "HOURS", worked: 10, trips: 5, volume: 0, logs: 0, ...extra });

const costs = [
  cost("diesel", 600, { liters: 100 }),
  cost("pecas", 300),
  cost("diesel", 1200, { liters: 200, equipmentId: 2, equipmentLabel: "CM-33", unit: "KM" }),
  cost("manutencao", 150, { equipmentId: 3, equipmentLabel: "SK-02", frontName: "Frente B" }),
  cost("gasolina", 65, { liters: 10, equipmentId: null, equipmentLabel: null, unit: null }),
  cost("outros", 35, { equipmentId: null, equipmentLabel: null, unit: null, date: "2026-10-02" }),
];
const fichas = [
  ficha(), ficha({ operator: "Bruno", location: "Talhão 2", worked: 30, trips: 15 }),
  ficha({ equipmentId: 2, equipmentLabel: "CM-33", operator: "Carla", location: "Porto", unit: "KM", worked: 400, trips: 4, volume: 120, logs: 80 }),
];

test("rateio: proporção das horas; sem ficha vai para Sem Controle Diário; sem equipamento fica à parte", () => {
  const parts = allocateCosts(costs, fichas);
  const diesel = parts.filter((part) => part.category === "diesel" && part.equipmentId === 1);
  assert.deepEqual(diesel.map((part) => [part.operator, part.amount, part.liters]), [["Ana", 150, 25], ["Bruno", 450, 75]]);
  assert.equal(parts.find((part) => part.equipmentId === 3).operator, NO_DAILY);
  assert.equal(parts.find((part) => part.category === "gasolina").operator, NO_EQUIPMENT);
  assert.equal(Math.round(parts.reduce((sum, part) => sum + part.amount, 0)), 2350, "o rateio não perde nem cria valor");
});

test("rateio sem horas/km: pelo número de fichas", () => {
  const parts = allocateCosts([cost("pecas", 90)], [ficha({ worked: 0 }), ficha({ worked: 0 }), ficha({ operator: "Bruno", worked: 0 })]);
  assert.deepEqual(parts.map((part) => [part.operator, part.amount]), [["Ana", 60], ["Bruno", 30]]);
});

test("todo agrupamento soma o mesmo total geral", () => {
  const geral = buildCostReport({ costs, records: fichas, grouping: "geral" });
  assert.equal(geral.total.total, 2350);
  assert.deepEqual(geral.total.costs, { diesel: 1800, gasolina: 65, pecas: 300, manutencao: 150, pneus: 0, outros: 35 });
  for (const grouping of ["equipamento", "frente", "operador", "local", "mes"]) {
    const report = buildCostReport({ costs, records: fichas, grouping });
    assert.equal(Math.round(report.rows.reduce((sum, row) => sum + row.total, 0) * 100) / 100, 2350, grouping);
    assert.equal(report.total.total, 2350, grouping);
  }
  const porFrente = buildCostReport({ costs, records: fichas, grouping: "frente" });
  assert.deepEqual(porFrente.rows.map((row) => [row.key, row.total]).sort(), [["Frente A", 2200], ["Frente B", 150]]);
  const porMes = buildCostReport({ costs, records: fichas, grouping: "mes" });
  assert.deepEqual(porMes.monthly.map((month) => [month.month, month.total]), [["2026-09", 2315], ["2026-10", 35]]);
});

test("indicadores: R$/h só com os equipamentos de horímetro, R$/km só com os de KM", () => {
  const { rows, total } = buildCostReport({ costs, records: fichas, grouping: "equipamento" });
  const trator = rows.find((row) => row.key === "TR-01");
  assert.equal(trator.hours, 40);
  assert.equal(trator.perHour, 900 / 40);
  assert.equal(trator.litersPerHour, 100 / 40);
  assert.equal(trator.perTrip, 900 / 20);
  const caminhao = rows.find((row) => row.key === "CM-33");
  assert.equal(caminhao.perKm, 1200 / 400);
  assert.equal(caminhao.kmPerLiter, 2);
  assert.equal(caminhao.perM3, 10);
  assert.equal(caminhao.litersPerM3, 200 / 120);
  assert.equal(total.perHour, (600 + 300 + 150) / 40, "R$/h do total inclui o SK-02 (horímetro), mesmo sem ficha");
  assert.equal(total.perKm, 3);
  assert.equal(rows.find((row) => row.key === NO_EQUIPMENT).perHour, null);
});

test("filtros de operador/local e de categoria de gasto", () => {
  const bruno = buildCostReport({ costs, records: fichas, grouping: "equipamento", operator: "brun" });
  assert.equal(bruno.total.total, 450 + 225);
  assert.equal(bruno.total.hours, 30);
  const soDiesel = buildCostReport({ costs, records: fichas, grouping: "geral", categories: ["diesel"] });
  assert.equal(soDiesel.total.total, 1800);
  assert.equal(soDiesel.total.costs.pecas, 0);
});

test("ranking: maior primeiro, sem indicador no fim e os 'Sem ...' por último", () => {
  const { rows } = buildCostReport({ costs, records: fichas, grouping: "equipamento" });
  assert.deepEqual(sortRows(rows, "total", "equipamento").map((row) => row.key), ["CM-33", "TR-01", "SK-02", NO_EQUIPMENT]);
  assert.deepEqual(sortRows(rows, "perHour", "equipamento").map((row) => row.key).slice(0, 2), ["TR-01", "CM-33"]);
  assert.deepEqual(sortRows(rows, "key", "equipamento").map((row) => row.key), ["CM-33", "SK-02", "TR-01", NO_EQUIPMENT]);
});

test("período anterior: mês fechado ou corrente → mês anterior inteiro; senão o mesmo número de dias", () => {
  assert.deepEqual(previousPeriod("2026-10-01", "2026-10-08", "2026-10-08"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(previousPeriod("2026-03-01", "2026-03-31", "2026-10-08"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(previousPeriod("2026-09-10", "2026-09-19", "2026-10-08"), { from: "2026-08-31", to: "2026-09-09" });
  assert.deepEqual(previousPeriod("2026-01-01", "2026-01-31", "2026-10-08"), { from: "2025-12-01", to: "2025-12-31" });
});

test("comparação: anterior por linha e variação", () => {
  const atual = buildCostReport({ costs, records: fichas, grouping: "frente" });
  const anterior = buildCostReport({ costs: [cost("diesel", 1100, { liters: 100 })], records: [], grouping: "frente" });
  attachPrevious(atual, anterior);
  assert.equal(atual.rows.find((row) => row.key === "Frente A").previous.total, 1100);
  assert.equal(atual.rows.find((row) => row.key === "Frente B").previous, null);
  assert.equal(atual.total.previous.total, 1100);
  assert.equal(variation(2200, 1100), 1);
  assert.equal(variation(10, 0), null);
});
