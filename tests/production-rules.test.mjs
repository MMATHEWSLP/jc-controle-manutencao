// Produção (lib/production-rules.ts): situação das etapas, filtro de frentes, preço efetivo, funções dos
// funcionários e os números dos critérios de aceite do módulo.
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsLaunch, cleanName, compareProjects, effectivePrice, franconPerTree, fuelValue, matchesFunctionGroup, nextStageStatus, parseDecimal,
  parseFrontIds, perDay, processedPercent, rejectPercent, roundTo, scopeFrontIds, skiddingBalance, skiddingWriteOff, statusAfterLaunch, treesToMeasure,
} from "../lib/production-rules.ts";
import { multiFrontSummary, operatorTotals, parseSheetDate, reasonLabel, targetResult, validateFellingDay } from "../lib/production-rules.ts";
import { fuelAverageCostsOn } from "../lib/fuel-rules.ts";

test("etapas: finalizar, reabrir e lançar", () => {
  assert.deepEqual(nextStageStatus("EM_ANDAMENTO", "FINALIZAR"), { status: "FINALIZADO" });
  assert.deepEqual(nextStageStatus("NAO_INICIADO", "FINALIZAR"), { status: "FINALIZADO" });
  assert.ok("error" in nextStageStatus("FINALIZADO", "FINALIZAR"));
  assert.deepEqual(nextStageStatus("FINALIZADO", "REABRIR"), { status: "EM_ANDAMENTO" });
  assert.ok("error" in nextStageStatus("EM_ANDAMENTO", "REABRIR"));
  assert.equal(acceptsLaunch("FINALIZADO"), false);
  assert.equal(acceptsLaunch("NAO_INICIADO"), true);
  assert.equal(statusAfterLaunch("NAO_INICIADO"), "EM_ANDAMENTO");
  assert.equal(statusAfterLaunch("EM_ANDAMENTO"), "EM_ANDAMENTO");
});

test("projetos em andamento primeiro, depois alfabética", () => {
  const list = [
    { name: "UPA 10", statuses: ["FINALIZADO", "FINALIZADO", "FINALIZADO", "FINALIZADO"] },
    { name: "UPA 2", statuses: ["FINALIZADO", "EM_ANDAMENTO", "NAO_INICIADO", "NAO_INICIADO"] },
    { name: "ARAPIUNS 1", statuses: ["NAO_INICIADO", "NAO_INICIADO", "NAO_INICIADO", "NAO_INICIADO"] },
    { name: "UPA 1", statuses: ["EM_ANDAMENTO", "NAO_INICIADO", "NAO_INICIADO", "NAO_INICIADO"] },
  ];
  assert.deepEqual([...list].sort(compareProjects).map((item) => item.name), ["UPA 1", "UPA 2", "ARAPIUNS 1", "UPA 10"]);
});

test("filtro de frentes só restringe o que a pessoa vê", () => {
  assert.deepEqual(parseFrontIds("1, 2,abc,2,-3,0"), [1, 2]);
  assert.deepEqual(parseFrontIds(null), []);
  assert.deepEqual(scopeFrontIds([1, 2, 3], [2, 9]), [2]);
  assert.deepEqual(scopeFrontIds([1, 2, 3], []), [1, 2, 3]);
  assert.deepEqual(scopeFrontIds([1, 2, 3], [9]), [1, 2, 3], "frente que não vê é ignorada");
});

test("nomes, números e preço efetivo", () => {
  assert.equal(cleanName("  fazenda   boa vista  upa 3 "), "FAZENDA BOA VISTA UPA 3");
  assert.equal(parseDecimal("1.234,56"), 1234.56);
  assert.equal(parseDecimal("32,22"), 32.22);
  assert.equal(parseDecimal("6.29"), 6.29);
  assert.equal(parseDecimal("R$ 10"), 10);
  assert.ok(Number.isNaN(parseDecimal("")));
  assert.ok(Number.isNaN(parseDecimal("12a")));
  assert.equal(effectivePrice(30, 32.22), 32.22);
  assert.equal(effectivePrice(30, null), 30);
  assert.equal(effectivePrice(null, undefined), 0);
});

test("funções dos funcionários nos autocompletes", () => {
  for (const title of ["OP. DE MOTOSSERRA - DERRUBA", "OP. DE MOTOSSERRA - BATEDOR", "OP. DE MOTOSSERRA - TRILHA", "OPERADOR DE MOTOSSERRA"]) assert.ok(matchesFunctionGroup(title, "MOTOSSERRA"), title);
  assert.equal(matchesFunctionGroup("AJUDANTE OPERADOR DE MOTOSSERRA", "MOTOSSERRA"), false);
  assert.equal(matchesFunctionGroup("MEC. DE MOTOSSERRA", "MOTOSSERRA"), false);
  assert.ok(matchesFunctionGroup("AJUDANTE OPERADOR DE MOTOSSERRA", "AJUDANTE_MOTOSSERRA"));
  assert.ok(matchesFunctionGroup("OPERADOR DE SKIDDER", "SKIDDER"));
  assert.ok(matchesFunctionGroup("MOTORISTA DE CAMINHAO NIVEL III", "MOTORISTA"));
  assert.equal(matchesFunctionGroup("COZINHEIRO", "MOTORISTA"), false);
});

test("critérios de aceite do módulo", () => {
  assert.equal(roundTo(perDay(534, 4), 2), 133.5, "534 árvores em 4 dias = 133,50/dia");
  assert.equal(skiddingWriteOff(50, 15), 65, "50 árvores + 15 refugos baixam 65 do saldo");
  assert.equal(skiddingBalance(1000, 50, 15), 935);
  assert.equal(skiddingBalance(100, 150, 17), -67, "saldo negativo é permitido (alerta vermelho)");
  assert.equal(roundTo(rejectPercent(3204, 133), 2), 3.99, "3.204 arrastadas e 133 refugos = 3,99%");
  assert.equal(roundTo(processedPercent(4000, 3204, 133), 2), 83.43);
  assert.equal(roundTo(franconPerTree(11655.726, 2993), 4), 3.8943, "11.655,7260 m³ ÷ 2.993 árvores = 3,8943");
  assert.equal(treesToMeasure(3204, 2993), 211);
  assert.equal(fuelValue(8, 6.29), 50.32, "8 L a R$ 6,29 = R$ 50,32");
  assert.equal(fuelValue(10, 6.29), 62.9);
  assert.equal(fuelValue(10, null), null, "estoque sem valor = sem valor");
  assert.equal(perDay(10, 0), null);
  assert.equal(rejectPercent(0, 0), null);
});


test("derruba: grade do dia ignora linhas vazias e valida cada linha", () => {
  const { lines, errors } = validateFellingDay([
    { operatorEmployeeId: 10, helperEmployeeId: 20, trees: "30", ipes: "2", gasolineLiters: "8" },
    {},
    { operatorEmployeeId: "", trees: "", ipes: "", gasolineLiters: "" },
    { operatorEmployeeId: 11, trees: "0" },
    { operatorEmployeeId: 12, trees: "5", ipes: "6" },
    { operatorEmployeeId: 10, trees: "10" },
    { operatorEmployeeId: 13, helperEmployeeId: 13, trees: "4" },
    { operatorEmployeeId: 14, trees: "0", reasonId: 3, justification: "  chuva   forte " },
    { trees: "12" },
    { operatorEmployeeId: 15, trees: "12,5" },
  ]);
  assert.deepEqual(lines.map((line) => line.operatorEmployeeId), [10, 14]);
  assert.deepEqual(lines[0], { operatorEmployeeId: 10, helperEmployeeId: 20, trees: 30, ipes: 2, gasolineLiters: 8, reasonId: null, justification: null });
  assert.equal(lines[1].justification, "chuva forte");
  assert.deepEqual(errors.map((error) => [error.line, error.field]), [
    [4, "reasonId"], [5, "ipes"], [6, "operatorEmployeeId"], [7, "helperEmployeeId"], [9, "operatorEmployeeId"], [10, "trees"],
  ]);
});

test("derruba: meta, motivo e acumulado por operador", () => {
  assert.equal(targetResult(30, 25), "NA_META");
  assert.equal(targetResult(24, 25), "ABAIXO");
  assert.equal(targetResult(24, null), "SEM_META");
  assert.equal(reasonLabel("C.09", "MADEIRA GROSSA"), "(C.09) MADEIRA GROSSA");
  const base = { helperId: null, helperName: null, projectId: 1, frontId: 1, frontName: "MAMURU", ipes: 0, gasolineLiters: 0 };
  const [ana] = operatorTotals([
    { ...base, operatorId: 1, operatorName: "ANA", date: "2026-09-01", trees: 30, ipes: 1 },
    { ...base, operatorId: 1, operatorName: "ANA", date: "2026-09-02", trees: 29, ipes: 3 },
    { ...base, operatorId: 1, operatorName: "ANA", date: "2026-09-02", trees: 30, projectId: 2 },
  ]);
  assert.deepEqual([ana.trees, ana.days, ana.ipes, roundTo(ana.perDay, 2)], [89, 2, 4, 44.5]);
});

test("derruba: multi-frente consolida frentes e conta árvores acima da meta", () => {
  const base = { helperId: null, helperName: null, ipes: 0, gasolineLiters: 0 };
  const records = [
    { ...base, operatorId: 1, operatorName: "ANA", projectId: 1, frontId: 1, frontName: "MAMURU", date: "2026-09-01", trees: 40, helperName: "ANDERSON" },
    { ...base, operatorId: 1, operatorName: "ANA", projectId: 2, frontId: 1, frontName: "MAMURU", date: "2026-09-01", trees: 5, helperName: "ANDERSON" },
    { ...base, operatorId: 1, operatorName: "ANA", projectId: 3, frontId: 2, frontName: "FLEXAL", date: "2026-09-02", trees: 20, helperName: "BRUNO" },
    { ...base, operatorId: 1, operatorName: "ANA", projectId: 3, frontId: 2, frontName: "FLEXAL", date: "2026-09-03", trees: 35, helperName: "ANDERSON" },
    { ...base, operatorId: 2, operatorName: "BETO", projectId: 4, frontId: 3, frontName: "ARAPIUNS", date: "2026-09-01", trees: 50 },
  ];
  const { rows, totals } = multiFrontSummary(records, new Map([[1, 40], [2, 30]]));
  const ana = rows.find((row) => row.operatorName === "ANA");
  assert.deepEqual(ana.fronts, ["FLEXAL", "MAMURU"]);
  assert.deepEqual([ana.days, ana.trees, ana.daysOnTarget, ana.daysBelow, ana.treesOnTargetDays, ana.treesAboveTarget], [3, 100, 2, 1, 80, 10]);
  assert.deepEqual(ana.helpers, [{ name: "ANDERSON", days: 2 }]);
  const beto = rows.find((row) => row.operatorName === "BETO");
  assert.deepEqual([beto.daysOnTarget, beto.daysBelow], [0, 0], "frente sem meta não conta");
  assert.deepEqual([totals.operators, totals.trees, totals.treesOnTargetDays, totals.treesAboveTarget, roundTo(totals.perDay, 2)], [2, 150, 80, 10, 37.5]);
});

test("datas da planilha", () => {
  assert.equal(parseSheetDate("05/09/2026"), "2026-09-05");
  assert.equal(parseSheetDate("5/9/26"), "2026-09-05");
  assert.equal(parseSheetDate("2026-09-05"), "2026-09-05");
  assert.equal(parseSheetDate("46270"), "2026-09-05");
  assert.equal(parseSheetDate("31/02/2026"), null);
  assert.equal(parseSheetDate("ontem"), null);
});

test("gasolina da derruba: custo médio do estoque na data, sem lançar saída", () => {
  const entrada = (id, date, quantity, unitPrice, frontId = 1) => ({ id, serviceFrontId: frontId, stockLocation: "FRENTE", destinationFrontId: null, destinationLocation: null, fuelTypeId: 2, movementType: "ENTRADA", movementDate: date, quantity, unitPrice });
  const movements = [entrada(1, "2026-09-01", 1000, 6.29), entrada(2, "2026-09-10", 1000, 6.49)];
  const ask = (key, date, location = "FRENTE", frontId = 1) => ({ key, frontId, location, fuelTypeId: 2, date });
  const costs = fuelAverageCostsOn(movements, [], [ask("antes", "2026-08-31"), ask("dia1", "2026-09-01"), ask("dia5", "2026-09-05"), ask("dia10", "2026-09-10"), ask("porto", "2026-09-05", "PORTO"), ask("outra", "2026-09-05", "FRENTE", 9)]);
  assert.equal(costs.get("antes"), null);
  assert.equal(costs.get("dia1"), 6.29);
  assert.equal(costs.get("dia5"), 6.29);
  assert.equal(roundTo(costs.get("dia10"), 2), 6.39);
  assert.equal(costs.get("porto"), null);
  assert.equal(costs.get("outra"), null);
  assert.equal(fuelValue(8, costs.get("dia5")), 50.32);
  assert.equal(fuelValue(10, costs.get("dia5")), 62.9);
  // Reavaliação a partir de uma data vale para a pergunta daquele dia.
  const revalued = fuelAverageCostsOn(movements, [{ id: 1, fuelTypeId: 2, serviceFrontId: null, stockLocation: null, effectiveDate: "2026-09-05", unitCost: 7 }], [ask("d4", "2026-09-04"), ask("d5", "2026-09-05")]);
  assert.deepEqual([revalued.get("d4"), revalued.get("d5")], [6.29, 7]);
});
