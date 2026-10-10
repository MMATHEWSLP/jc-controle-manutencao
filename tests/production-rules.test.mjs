// Produção (lib/production-rules.ts): situação das etapas, filtro de frentes, preço efetivo, funções dos
// funcionários e os números dos critérios de aceite do módulo.
import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsLaunch, cleanName, compareProjects, effectivePrice, franconPerTree, fuelValue, matchesFunctionGroup, nextStageStatus, parseDecimal,
  parseFrontIds, perDay, processedPercent, rejectPercent, roundTo, scopeFrontIds, skiddingBalance, skiddingWriteOff, statusAfterLaunch, treesToMeasure,
} from "../lib/production-rules.ts";

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
