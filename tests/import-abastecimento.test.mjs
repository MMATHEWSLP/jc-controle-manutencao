import assert from "node:assert/strict";
import test from "node:test";
import { buildImportPlan, mapHeaders, matchEquipment, buildEquipmentIndex, parseDateTime, parseNumber, resolveFuelType, rowHash, summarize } from "../scripts/import-abastecimento/plan.mjs";

const fuelTypes = [{ id: 1, code: "DIESEL_S10", name: "Diesel S10" }, { id: 2, code: "GASOLINA_COMUM", name: "Gasolina Comum" }, { id: 3, code: "ARLA_32", name: "ARLA 32" }];
const equipment = [{ id: 10, prefix: "CM-30", plate: "QVN6E34" }, { id: 11, prefix: "PC-01", plate: null }];
const employees = [{ id: 7, name: "JOÃO DA SILVA" }];
const utc = (value) => new Date(`${value}Z`);
const row = (rowNumber, cells) => ({ rowNumber, cells: { totalPrice: null, vehicle: null, responsible: null, ...cells } });
const plan = (rows, existingHashes = new Set()) => buildImportPlan({
  rows, fuelTypes, equipment, employees, existingHashes, frontId: 3, importSource: "historico_planilha_2026-09-29", fileName: "planilha.xlsx",
  destination: { frontId: 3, location: "PORTO" },
});

test("cabeçalho da aba Dados_Limpos com e sem acento", () => {
  const { indexes, missing } = mapHeaders(["Data", "Tipo Combustível", "Tipo Movimentação", "Quantidade (L)", "Preço Total", "Veículo", "Responsável"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(indexes, { date: 0, fuel: 1, movement: 2, quantity: 3, totalPrice: 4, vehicle: 5, responsible: 6 });
  assert.deepEqual(mapHeaders(["Data", "Quantidade (L)"]).missing, ["TIPO COMBUSTIVEL", "TIPO MOVIMENTACAO"]);
});

test("datas: instante (fuso de Brasília), texto dd/mm/aaaa hh:mm e número de série", () => {
  // Como vêm na planilha limpa: meia-noite de Brasília = 03:00Z; algumas linhas 04:00Z.
  assert.deepEqual(parseDateTime(utc("2025-05-27T03:00:00")), { day: "2025-05-27", stamp: "2025-05-27 00:00:00", hasTime: false });
  assert.deepEqual(parseDateTime(utc("2025-05-27T04:00:00")), { day: "2025-05-27", stamp: "2025-05-27 01:00:00", hasTime: false });
  assert.deepEqual(parseDateTime(utc("2026-09-27T21:39:34")), { day: "2026-09-27", stamp: "2026-09-27 18:39:34", hasTime: true });
  assert.deepEqual(parseDateTime("27/09/2026 14:05"), { day: "2026-09-27", stamp: "2026-09-27 14:05:00", hasTime: true });
  assert.equal(parseDateTime(45804).day, "2025-05-27");
  assert.equal(parseDateTime("31/02/2026"), null);
  assert.equal(parseDateTime(""), null);
});

test("números: formato brasileiro, vazio e inválido", () => {
  assert.equal(parseNumber("1.234,5"), 1234.5);
  assert.equal(parseNumber("R$ 31.250,00"), 31250);
  assert.equal(parseNumber(120.5), 120.5);
  assert.equal(parseNumber(""), null);
  assert.ok(Number.isNaN(parseNumber("abc")));
});

test("combustível por nome ou código, ARLA com ou sem espaço", () => {
  assert.equal(resolveFuelType("Diesel S10", fuelTypes).id, 1);
  assert.equal(resolveFuelType("GASOLINA COMUM", fuelTypes).id, 2);
  assert.equal(resolveFuelType("Arla32", fuelTypes).id, 3);
  assert.equal(resolveFuelType("Querosene", fuelTypes), null);
});

test("veículo por prefixo (com variações) ou placa", () => {
  const index = buildEquipmentIndex(equipment);
  assert.equal(matchEquipment("CM-30", index).id, 10);
  assert.equal(matchEquipment("cm 30", index).id, 10);
  assert.equal(matchEquipment("CM-30 - CAMINHÃO", index).id, 10);
  assert.equal(matchEquipment("QVN6E34", index).id, 10);
  assert.equal(matchEquipment("PC-1", index).id, 11);
  assert.equal(matchEquipment("XX-99", index), null);
});

test("linha vira lançamento da frente fixa, origem Frente não confirmada, lote e hash", () => {
  const result = plan([row(2, { date: utc("2025-05-27T11:30:00"), fuel: "Diesel S10", movement: "Entrada", quantity: 5000, totalPrice: 31250, responsible: "João da Silva" })]);
  const [item] = result.items;
  assert.equal(item.status, "IMPORTAR");
  assert.equal(item.record.serviceFrontId, 3);
  assert.equal(item.record.stockLocation, "FRENTE");
  assert.equal(item.record.originConfirmed, false);
  assert.equal(item.record.unitPrice, 6.25);
  assert.equal(item.record.responsibleEmployeeId, 7);
  assert.equal(item.record.importSource, "historico_planilha_2026-09-29");
  assert.equal(item.record.movementDate, "2025-05-27");
  assert.match(item.record.notes, /Data\/hora original: 2025-05-27 08:30:00/);
  assert.equal(item.record.importHash.length, 64);
});

test("veículo 'A IDENTIFICAR' e veículo fora do cadastro ficam pendentes, sem vínculo", () => {
  const result = plan([
    row(2, { date: "28/05/2025 10:00", fuel: "Diesel S10", movement: "Saída", quantity: 80, vehicle: 'A IDENTIFICAR (ex-"teste")' }),
    row(3, { date: "28/05/2025 11:00", fuel: "Diesel S10", movement: "Saída", quantity: 20, vehicle: "XX-99" }),
    row(4, { date: "28/05/2025 12:00", fuel: "Diesel S10", movement: "Saída", quantity: 30, vehicle: "CM-30" }),
    row(5, { date: "28/05/2025 13:00", fuel: "Diesel S10", movement: "Saída", quantity: 30 }),
  ]);
  const [identify, unknown, linked, empty] = result.items;
  assert.deepEqual([identify.record.vehiclePending, identify.record.equipmentId, identify.vehicleReason], [true, null, "A_IDENTIFICAR"]);
  assert.deepEqual([unknown.record.vehiclePending, unknown.record.equipmentId, unknown.vehicleReason], [true, null, "NAO_ENCONTRADO"]);
  assert.deepEqual([linked.record.vehiclePending, linked.record.equipmentId], [false, 10]);
  assert.deepEqual([empty.record.vehiclePending, empty.record.equipmentId, empty.record.responsible], [false, null, null]);
  assert.equal(summarize(result.items.map((item) => item.record)).vehiclePending, 2);
});

test("transferência vai para o destino escolhido; campos vazios são aceitos", () => {
  const [item] = plan([row(2, { date: "03/06/2025", fuel: "Diesel S10", movement: "Transferência", quantity: 300 })]).items;
  assert.deepEqual([item.record.movementType, item.record.destinationFrontId, item.record.destinationLocation, item.record.unitPrice], ["TRANSFERENCIA", 3, "PORTO", null]);
});

test("idempotência: linha repetida na planilha e linha já importada são puladas", () => {
  const cells = { date: "03/06/2025 07:00", fuel: "Diesel S10", movement: "Saída", quantity: 50, vehicle: "CM-30", responsible: "João" };
  const first = plan([row(2, cells), row(3, cells)]);
  assert.deepEqual(first.items.map((item) => item.status), ["IMPORTAR", "DUPLICADO_NA_PLANILHA"]);
  const again = plan([row(2, cells)], new Set([first.items[0].record.importHash]));
  assert.equal(again.items[0].status, "JA_EXISTE");
  // O hash considera data/hora, combustível, movimentação, quantidade, veículo e responsável.
  const hash = rowHash({ stamp: "2025-06-03 07:00:00", fuel: "Diesel S10", movement: "SAIDA", quantity: 50, vehicle: "CM-30", responsible: "João" });
  assert.equal(first.items[0].record.importHash, hash);
  assert.notEqual(hash, rowHash({ stamp: "2025-06-03 07:00:00", fuel: "Diesel S10", movement: "SAIDA", quantity: 50, vehicle: "CM-30", responsible: "Maria" }));
});

test("linhas de ARLA 32 são ignoradas (combustível não usado), sem virar erro", () => {
  const result = plan([
    row(2, { date: "01/06/2025", fuel: "ARLA 32", movement: "Entrada", quantity: 100 }),
    row(3, { date: "01/06/2025", fuel: "Arla32", movement: "Saída", quantity: 10, vehicle: "CM-30" }),
    row(4, { date: "01/06/2025", fuel: "Diesel S10", movement: "Saída", quantity: 10, vehicle: "CM-30" }),
  ]);
  assert.deepEqual(result.items.map((item) => item.status), ["IGNORADO", "IGNORADO", "IMPORTAR"]);
  assert.equal(result.totals.ERRO, undefined);
});

test("linha sem combustível: erro por padrão; com missingFuel entra com o combustível indicado e observação", () => {
  const cells = { date: "17/07/2025", fuel: null, movement: "Saída", quantity: 225, vehicle: "CM-30" };
  assert.equal(plan([row(2, cells)]).items[0].status, "ERRO");
  const [item] = buildImportPlan({ rows: [row(2, cells)], fuelTypes, equipment, employees, existingHashes: new Set(), frontId: 3, importSource: "lote", fileName: "p.xlsx", destination: { frontId: 3, location: "PORTO" }, missingFuel: "Diesel S10" }).items;
  assert.deepEqual([item.status, item.record.fuelTypeId], ["IMPORTAR", 1]);
  assert.match(item.record.notes, /Combustível ausente na planilha — importado como Diesel S10/);
});

test("linhas inválidas vão para ERRO com o motivo", () => {
  const result = plan([row(2, { date: "sem data", fuel: "Querosene", movement: "Empréstimo", quantity: 0 })]);
  assert.equal(result.items[0].status, "ERRO");
  assert.match(result.items[0].error, /data inválida.*combustível não cadastrado.*movimentação inválido.*quantidade inválida/);
});
