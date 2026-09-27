import assert from "node:assert/strict";
import test from "node:test";
import { computeFuelBalances, validateFuelMovement } from "../lib/fuel-rules.ts";

const DIESEL = 1;
const GASOLINA = 2;
const movements = [
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-08-20", quantity: 1000 },
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-09-02", quantity: 500 },
  { serviceFrontId: 1, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-03", quantity: 120 },
  { serviceFrontId: 1, destinationFrontId: 2, fuelTypeId: DIESEL, movementType: "TRANSFERENCIA", movementDate: "2026-09-04", quantity: 300 },
  { serviceFrontId: 2, destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-05", quantity: 50 },
  { serviceFrontId: 2, destinationFrontId: null, fuelTypeId: GASOLINA, movementType: "ENTRADA", movementDate: "2026-09-05", quantity: 80 },
];
const september = { from: "2026-09-01", to: "2026-09-30" };

test("saldo por frente: entrada soma, saída subtrai, transferência sai da origem e entra no destino", () => {
  const balances = computeFuelBalances(movements, { fronts: [1], ...september });
  const diesel = balances.get(DIESEL);
  assert.equal(diesel.balance, 1000 + 500 - 120 - 300);
  assert.equal(diesel.entries, 500); // a entrada de agosto está fora do período
  assert.equal(diesel.exits, 120 + 300);

  const destination = computeFuelBalances(movements, { fronts: [2], ...september }).get(DIESEL);
  assert.equal(destination.balance, 300 - 50);
  assert.equal(destination.entries, 300);
  assert.equal(destination.exits, 50);
});

test("consolidado: transferência interna não altera saldo nem conta como entrada/saída", () => {
  const diesel = computeFuelBalances(movements, { fronts: [1, 2], ...september }).get(DIESEL);
  assert.equal(diesel.balance, 1000 + 500 - 120 - 50);
  assert.equal(diesel.entries, 500);
  assert.equal(diesel.exits, 120 + 50);
  assert.equal(diesel.byFront.get(2).entries, 300); // o detalhe por frente continua mostrando
});

test("saldos separados por tipo de combustível", () => {
  const balances = computeFuelBalances(movements, { fronts: [1, 2], ...september });
  assert.equal(balances.get(GASOLINA).balance, 80);
  assert.equal(computeFuelBalances(movements, { fronts: [1], ...september }).get(GASOLINA), undefined);
});

const base = { serviceFrontId: 1, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-10", quantity: 60, equipmentId: 9, meterReading: 1200, destinationFrontId: null };
const today = "2026-09-27";

test("bloqueia lançamento para equipamento de outra frente", () => {
  const error = validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 2, frontName: "Mamuru" }, today);
  assert.match(error, /CM-30 está em Mamuru/);
  assert.equal(validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" }, today), null);
});

test("regras por tipo: saída exige equipamento, transferência exige destino diferente", () => {
  assert.match(validateFuelMovement({ ...base, equipmentId: null }, null, today), /veículo\/máquina/);
  assert.match(validateFuelMovement({ ...base, movementType: "TRANSFERENCIA", equipmentId: null }, null, today), /filial destino/);
  assert.match(validateFuelMovement({ ...base, movementType: "TRANSFERENCIA", equipmentId: null, destinationFrontId: 1 }, null, today), /diferente/);
  assert.equal(validateFuelMovement({ ...base, movementType: "ENTRADA", equipmentId: null, meterReading: null }, null, today), null);
});

test("quantidade positiva e data não futura", () => {
  const equipment = { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" };
  assert.match(validateFuelMovement({ ...base, quantity: 0 }, equipment, today), /quantidade/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-10-01" }, equipment, today), /futura/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-13-45" }, equipment, today), /data válida/);
});
