import assert from "node:assert/strict";
import test from "node:test";
import { computeFuelBalances } from "../lib/fuel-rules.ts";
import { dailyMessage, dailyTotals, fillTemplate, litersMessage } from "../lib/fuel-daily-rules.ts";

let id = 0;
const mov = (movementDate, movementType, quantity, extra = {}) => ({ id: ++id, fuelTypeId: 1, movementType, movementDate, quantity, serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: null, destinationLocation: null, balanceAdjustment: false, ...extra });

test("litros no formato da mensagem", () => {
  assert.equal(litersMessage(83174), "83.174L");
  assert.equal(litersMessage(1234.5), "1.234,5L");
  assert.equal(litersMessage(87033.0004), "87.033L");
  assert.equal(litersMessage(0), "0L");
});

test("saldo anterior, consumo e saldo final (sem entradas nem transferências)", () => {
  const list = [mov("2026-09-27", "ENTRADA", 90892), mov("2026-09-28", "SAIDA", 3000), mov("2026-09-28", "SAIDA", 859), mov("2026-09-27", "SAIDA", 3859), mov("2026-09-29", "SAIDA", 500)];
  const t = dailyTotals(list, { date: "2026-09-28", frontId: 1, location: "FRENTE" });
  assert.equal(t.previous, 87033); assert.equal(t.consumption, 3859); assert.equal(t.final, 83174);
  assert.equal(t.exitIds.length, 2);
  const msg = dailyMessage({ settings: { greeting: "Bom dia a todos!", title: "Controle de Diesel Arapiuns/Fazendinha 2026", balanceLabel: "Saldo Arapiuns" }, frontName: "Arapiuns", fuelName: "Diesel S10", date: "2026-09-28", totals: t, frontNames: { 1: "Arapiuns" } });
  assert.equal(msg, "Bom dia a todos!\nControle de Diesel Arapiuns/Fazendinha 2026\n\nData: 28/09/2026\n\nSaldo anterior: 87.033L\n\nConsumo: 3.859L\n\nSaldo Arapiuns: 83.174L");
});

test("entradas e transferências do dia aparecem e entram no saldo; transferência interna some", () => {
  const list = [
    mov("2026-09-01", "ENTRADA", 10000),
    mov("2026-09-10", "ENTRADA", 5000),
    mov("2026-09-10", "TRANSFERENCIA", 2000, { destinationFrontId: 1, destinationLocation: "PORTO" }),        // Frente → Porto da mesma frente
    mov("2026-09-10", "TRANSFERENCIA", 700, { serviceFrontId: 2, destinationFrontId: 1, destinationLocation: "FRENTE" }), // outra frente → aqui
    mov("2026-09-10", "SAIDA", 1234.5),
    mov("2026-09-10", "SAIDA", 300, { stockLocation: "PORTO" }),
  ];
  const frente = dailyTotals(list, { date: "2026-09-10", frontId: 1, location: "FRENTE" });
  assert.deepEqual([frente.previous, frente.entries, frente.transfersIn, frente.transfersOut, frente.consumption, frente.final], [10000, 5000, 700, 2000, 1234.5, 12465.5]);
  const todos = dailyTotals(list, { date: "2026-09-10", frontId: 1, location: "TODOS" });
  assert.deepEqual([todos.transfersIn, todos.transfersOut, todos.consumption, todos.final], [700, 0, 1534.5, 14165.5]);
  // Mesmo saldo da conta do formulário (computeFuelBalances).
  const ledger = computeFuelBalances(list, { fronts: [1], from: "2026-09-10", to: "2026-09-10" }).get(1).byFront.get(1);
  assert.equal(frente.final, ledger.byLocation.FRENTE.balance);
  assert.equal(todos.final, ledger.balance);
  const msg = dailyMessage({ settings: { greeting: "Bom dia a todos!", title: "Controle de {combustivel} {frente} {ano}", balanceLabel: "Saldo {frente}" }, frontName: "Arapiuns", fuelName: "Diesel S10", date: "2026-09-10", totals: frente, frontNames: { 1: "Arapiuns", 2: "Fazendinha" } });
  assert.match(msg, /Saldo anterior: 10\.000L\n\nEntrada: 5\.000L\n\nTransferência recebida: 700L de Frente Fazendinha\n\nTransferência enviada: 2\.000L para Porto Arapiuns\n\nConsumo: 1\.234,5L\n\nSaldo Arapiuns: 12\.465,5L$/);
  assert.match(msg, /^Bom dia a todos!\nControle de Diesel Arapiuns 2026/);
});

test("transferências enviadas para destinos diferentes aparecem separadas na mensagem", () => {
  const list = [
    mov("2026-10-01", "ENTRADA", 35122),
    mov("2026-10-05", "TRANSFERENCIA", 3000, { destinationFrontId: 2, destinationLocation: "FRENTE" }),
    mov("2026-10-05", "TRANSFERENCIA", 2000, { destinationFrontId: 3, destinationLocation: "PORTO" }),
    mov("2026-10-05", "SAIDA", 6575),
  ];
  const t = dailyTotals(list, { date: "2026-10-05", frontId: 1, location: "FRENTE" });
  assert.deepEqual(t.transfers.map((item) => [item.direction, item.liters, item.frontId, item.location]), [["ENVIADA", 3000, 2, "FRENTE"], ["ENVIADA", 2000, 3, "PORTO"]]);
  const frontNames = { 1: "Arapiuns", 2: "Fazendinha", 3: "Santarém" };
  const msg = dailyMessage({ settings: { greeting: "", title: "Controle", balanceLabel: "Saldo {frente}" }, frontName: "Arapiuns", fuelName: "Diesel S10", date: "2026-10-05", totals: t, frontNames });
  assert.match(msg, /Transferência enviada: 5\.000L \(3\.000L para Frente Fazendinha; 2\.000L para Porto Santarém\)\n\nConsumo: 6\.575L\n\nSaldo Arapiuns: 23\.547L$/);
  const one = dailyTotals(list.slice(0, 2), { date: "2026-10-05", frontId: 1, location: "FRENTE" });
  assert.match(dailyMessage({ settings: { greeting: "", title: "C", balanceLabel: "Saldo" }, frontName: "Arapiuns", fuelName: "Diesel", date: "2026-10-05", totals: one, frontNames }), /Transferência enviada: 3\.000L para Frente Fazendinha\n/);
});

test("ajuste de saldo do dia conta no saldo e aparece como ajuste, não como entrada", () => {
  const list = [mov("2026-09-01", "ENTRADA", 100), mov("2026-09-02", "ENTRADA", 25, { balanceAdjustment: true }), mov("2026-09-02", "SAIDA", 10)];
  const t = dailyTotals(list, { date: "2026-09-02", frontId: 1, location: "FRENTE" });
  assert.deepEqual([t.entries, t.adjustments, t.final], [0, 25, 115]);
});

test("modelo com marcadores", () => {
  assert.equal(fillTemplate("Saldo {FRENTE}", { frente: "Arapiuns", combustivel: "Diesel", ano: "2026" }), "Saldo Arapiuns");
});
