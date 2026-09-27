import assert from "node:assert/strict";
import test from "node:test";
import { computeFuelBalances, fuelMovementLabel, validateFuelMovement } from "../lib/fuel-rules.ts";

const DIESEL = 1;
const GASOLINA = 2;
const movements = [
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-08-20", quantity: 1000 },
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-09-02", quantity: 500 },
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-03", quantity: 120 },
  { serviceFrontId: 1, destinationFrontId: 2, destinationLocation: "FRENTE", fuelTypeId: DIESEL, movementType: "TRANSFERENCIA", movementDate: "2026-09-04", quantity: 300 },
  { serviceFrontId: 2, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-05", quantity: 50 },
  { serviceFrontId: 2, destinationFrontId: null, fuelTypeId: GASOLINA, movementType: "ENTRADA", movementDate: "2026-09-05", quantity: 80 },
];
const september = { from: "2026-09-01", to: "2026-09-30" };

test("saldo por frente: entrada soma, saída subtrai, transferência sai da origem e entra no destino", () => {
  const diesel = computeFuelBalances(movements, { fronts: [1], ...september }).get(DIESEL);
  assert.equal(diesel.balance, 1000 + 500 - 120 - 300);
  assert.equal(diesel.entries, 500);
  assert.equal(diesel.exits, 120 + 300);
  const destination = computeFuelBalances(movements, { fronts: [2], ...september }).get(DIESEL);
  assert.equal(destination.balance, 300 - 50);
  assert.equal(destination.entries, 300);
});

test("consolidado: transferência entre frentes em exibição não conta como entrada/saída", () => {
  const diesel = computeFuelBalances(movements, { fronts: [1, 2], ...september }).get(DIESEL);
  assert.equal(diesel.balance, 1000 + 500 - 120 - 50);
  assert.equal(diesel.entries, 500);
  assert.equal(diesel.exits, 120 + 50);
  assert.equal(diesel.byFront.get(2).entries, 300);
});

test("saldos separados por tipo de combustível", () => {
  const balances = computeFuelBalances(movements, { fronts: [1, 2], ...september });
  assert.equal(balances.get(GASOLINA).balance, 80);
  assert.equal(computeFuelBalances(movements, { fronts: [1], ...september }).get(GASOLINA), undefined);
});

test("Frente e Porto da mesma frente têm saldos independentes; transferência Frente → Porto", () => {
  const ledger = [
    { serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-09-01", quantity: 1000 },
    { serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: 1, destinationLocation: "PORTO", fuelTypeId: DIESEL, movementType: "TRANSFERENCIA", movementDate: "2026-09-02", quantity: 400 },
    { serviceFrontId: 1, stockLocation: "PORTO", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-03", quantity: 150 },
    { serviceFrontId: 1, stockLocation: "PORTO", destinationFrontId: 1, destinationLocation: "FRENTE", fuelTypeId: DIESEL, movementType: "TRANSFERENCIA", movementDate: "2026-09-04", quantity: 50 },
  ];
  const diesel = computeFuelBalances(ledger, { fronts: [1], ...september }).get(DIESEL);
  assert.equal(diesel.byLocation.FRENTE.balance, 1000 - 400 + 50);
  assert.equal(diesel.byLocation.PORTO.balance, 400 - 150 - 50);
  assert.equal(diesel.balance, 1000 - 150);
  // Transferência interna da frente não é entrada/saída da frente, mas é de cada estoque.
  assert.equal(diesel.entries, 1000);
  assert.equal(diesel.exits, 150);
  assert.equal(diesel.byLocation.PORTO.entries, 400);
  assert.equal(diesel.byLocation.PORTO.exits, 150 + 50);
  assert.equal(diesel.byFront.get(1).byLocation.PORTO.balance, 200);
});

const base = {
  serviceFrontId: 1, stockLocation: "FRENTE", fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-10", quantity: 60, equipmentId: 9,
  meterReading: 1200, destinationFrontId: null, destinationLocation: null, thirdParty: false, thirdPartyDescription: null, responsible: "João",
};
const today = "2026-09-27";

test("bloqueia lançamento para equipamento de outra frente", () => {
  const error = validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 2, frontName: "Mamuru" }, today);
  assert.match(error, /CM-30 está em Mamuru/);
  assert.equal(validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" }, today), null);
});

test("saída exige equipamento; saída para terceiros exige descrição e responsável", () => {
  assert.match(validateFuelMovement({ ...base, equipmentId: null }, null, today), /veículo\/máquina/);
  const third = { ...base, equipmentId: null, meterReading: null, thirdParty: true };
  assert.match(validateFuelMovement({ ...third, thirdPartyDescription: " " }, null, today), /Destino\/Descrição/);
  assert.match(validateFuelMovement({ ...third, thirdPartyDescription: "Comunidade X", responsible: "" }, null, today), /responsável/);
  assert.equal(validateFuelMovement({ ...third, thirdPartyDescription: "Comunidade X" }, null, today), null);
  assert.equal(fuelMovementLabel({ movementType: "SAIDA", thirdParty: true }), "Saída para terceiros");
});

test("transferência: destino obrigatório e diferente da origem (Frente ↔ Porto ou outra filial)", () => {
  const transfer = { ...base, movementType: "TRANSFERENCIA", equipmentId: null, meterReading: null };
  assert.match(validateFuelMovement(transfer, null, today), /estoque de destino/);
  assert.match(validateFuelMovement({ ...transfer, destinationLocation: "FRENTE" }, null, today), /diferente da origem/);
  assert.equal(validateFuelMovement({ ...transfer, destinationLocation: "PORTO" }, null, today), null);
  assert.equal(validateFuelMovement({ ...transfer, destinationFrontId: 2, destinationLocation: "FRENTE" }, null, today), null);
});

test("quantidade positiva e data não futura", () => {
  const equipment = { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" };
  assert.match(validateFuelMovement({ ...base, quantity: 0 }, equipment, today), /quantidade/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-10-01" }, equipment, today), /futura/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-13-45" }, equipment, today), /data válida/);
});
