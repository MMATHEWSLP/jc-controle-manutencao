import assert from "node:assert/strict";
import test from "node:test";
import { computeFuelBalances, computeFuelCosts, fuelMovementLabel, validateFuelMovement } from "../lib/fuel-rules.ts";

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
  meterReading: 1200, destinationFrontId: null, destinationLocation: null, thirdParty: false, thirdPartyKind: null, thirdPartyDescription: null,
  providerCompany: null, providerEquipment: null, unitPrice: null, responsible: "João",
};
const today = "2026-09-27";

test("bloqueia lançamento para equipamento de outra frente", () => {
  const error = validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 2, frontName: "Mamuru" }, today);
  assert.match(error, /CM-30 está em Mamuru/);
  assert.equal(validateFuelMovement(base, { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" }, today), null);
});

test("saída exige equipamento; saída para terceiros exige descrição e responsável", () => {
  assert.match(validateFuelMovement({ ...base, equipmentId: null }, null, today), /veículo\/máquina/);
  const third = { ...base, equipmentId: null, meterReading: null, thirdParty: true, thirdPartyKind: "GERAL" };
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
  assert.match(validateFuelMovement({ ...transfer, destinationLocation: "PORTO", responsible: "" }, null, today), /responsável/);
  assert.equal(validateFuelMovement({ ...transfer, destinationFrontId: 2, destinationLocation: "FRENTE" }, null, today), null);
});

test("quantidade positiva e data não futura", () => {
  const equipment = { id: 9, prefix: "CM-30", serviceFrontId: 1, frontName: "Arapiuns" };
  assert.match(validateFuelMovement({ ...base, quantity: 0 }, equipment, today), /quantidade/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-10-01" }, equipment, today), /futura/);
  assert.match(validateFuelMovement({ ...base, movementDate: "2026-13-45" }, equipment, today), /data válida/);
});

test("entrada exige valor por litro e responsável, e não aceita equipamento", () => {
  const entry = { ...base, movementType: "ENTRADA", equipmentId: null, meterReading: null, unitPrice: 6.1 };
  assert.equal(validateFuelMovement(entry, null, today), null);
  assert.match(validateFuelMovement({ ...entry, unitPrice: null }, null, today), /valor por litro/);
  assert.match(validateFuelMovement({ ...entry, responsible: " " }, null, today), /recebeu o combustível/);
  assert.match(validateFuelMovement({ ...entry, equipmentId: 9 }, { id: 9, prefix: "X", serviceFrontId: 1, frontName: "A" }, today), /não é vinculada/);
});

test("prestador de serviço exige empresa e descrição do equipamento", () => {
  const provider = { ...base, equipmentId: null, meterReading: null, thirdParty: true, thirdPartyKind: "PRESTADOR", providerCompany: "Transportes Silva", providerEquipment: "Caminhão placa ABC1D23" };
  assert.equal(validateFuelMovement(provider, null, today), null);
  assert.match(validateFuelMovement({ ...provider, providerCompany: "" }, null, today), /empresa/);
  assert.match(validateFuelMovement({ ...provider, providerEquipment: "" }, null, today), /equipamento do prestador/);
  assert.equal(fuelMovementLabel(provider), "Saída — Prestador de Serviço");
});

test("custo das saídas pelo custo médio ponderado do estoque de origem", () => {
  const ledger = [
    { id: 1, serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-09-01", quantity: 1000, unitPrice: 6 },
    { id: 2, serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-02", quantity: 100 },
    { id: 3, serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "ENTRADA", movementDate: "2026-09-03", quantity: 900, unitPrice: 7 },
    { id: 4, serviceFrontId: 1, stockLocation: "FRENTE", destinationFrontId: 1, destinationLocation: "PORTO", fuelTypeId: DIESEL, movementType: "TRANSFERENCIA", movementDate: "2026-09-04", quantity: 200 },
    { id: 5, serviceFrontId: 1, stockLocation: "PORTO", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-05", quantity: 50 },
    { id: 6, serviceFrontId: 2, stockLocation: "FRENTE", destinationFrontId: null, fuelTypeId: DIESEL, movementType: "SAIDA", movementDate: "2026-09-05", quantity: 10 },
  ];
  const costs = computeFuelCosts(ledger);
  assert.deepEqual(costs.get(1), { unitCost: 6, cost: 6000 });
  assert.deepEqual(costs.get(2), { unitCost: 6, cost: 600 });
  // Média após a 2ª entrada: (900 × 6 + 900 × 7) / 1800 = 6,5
  assert.equal(costs.get(4).unitCost, 6.5);
  assert.equal(costs.get(5).unitCost, 6.5); // o Porto herdou o custo médio da Frente
  assert.equal(costs.get(5).cost, 325);
  assert.deepEqual(costs.get(6), { unitCost: null, cost: null }); // estoque sem valor informado
});

test("lançamento importado do histórico: correção sem os campos obrigatórios dos lançamentos novos", () => {
  const historical = { historical: true };
  // Saída sem veículo e sem responsável (veículo a identificar).
  const pending = { ...base, equipmentId: null, meterReading: null, responsible: null };
  assert.match(validateFuelMovement(pending, null, today), /responsável/);
  assert.equal(validateFuelMovement(pending, null, today, historical), null);
  // Entrada sem valor por litro.
  const entry = { ...base, movementType: "ENTRADA", equipmentId: null, meterReading: null, responsible: null };
  assert.match(validateFuelMovement({ ...entry, responsible: "João" }, null, today), /valor por litro/);
  assert.equal(validateFuelMovement(entry, null, today, historical), null);
  // Equipamento que hoje está em outra frente (transferido/vendido depois do abastecimento).
  const other = { id: 9, prefix: "CM-30", serviceFrontId: 2, frontName: "Mamuru" };
  assert.match(validateFuelMovement(base, other, today), /Mamuru/);
  assert.equal(validateFuelMovement(base, other, today, historical), null);
  // Regras de estrutura continuam valendo.
  assert.match(validateFuelMovement({ ...pending, quantity: 0 }, null, today, historical), /quantidade/);
  assert.match(validateFuelMovement({ ...pending, movementType: "TRANSFERENCIA", destinationLocation: "FRENTE" }, null, today, historical), /diferente da origem/);
});
