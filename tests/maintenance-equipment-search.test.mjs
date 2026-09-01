import assert from "node:assert/strict";
import test from "node:test";
import {
  maintenanceEquipmentSearchKey,
  searchMaintenanceEquipment,
} from "../app/page.tsx";

const equipment = [
  { id: 2, prefix: "CM-230", code: "00230", brand: "Mercedes-Benz", model: "Axor 3344 6X4", plate: "QAB-2A30", type: "Caminhão", reading: "80.120 km" },
  { id: 3, prefix: "PC-20", code: "PC020", brand: "Caterpillar", model: "320 GC", plate: null, type: "Escavadeira", reading: "7.300 h" },
  { id: 1, prefix: "CM-23", code: "00023", brand: "Mercedes-Benz", model: "Axor 3344 6X4", plate: "QAB-1A23", type: "Caminhão", reading: "74.684 km" },
];

test("normaliza prefixo com maiúsculas, espaços e hífen", () => {
  assert.equal(maintenanceEquipmentSearchKey("  cm-23 "), "CM23");
  assert.equal(maintenanceEquipmentSearchKey("CM23"), "CM23");
});

test("prioriza o prefixo exato", () => {
  assert.equal(searchMaintenanceEquipment(equipment, "CM-23")[0]?.id, 1);
  assert.equal(searchMaintenanceEquipment(equipment, "cm23")[0]?.id, 1);
});

test("pesquisa por modelo, código, marca e placa", () => {
  assert.deepEqual(searchMaintenanceEquipment(equipment, "320").map((item) => item.id), [3]);
  assert.equal(searchMaintenanceEquipment(equipment, "00023")[0]?.id, 1);
  assert.equal(searchMaintenanceEquipment(equipment, "mercedes")[0]?.brand, "Mercedes-Benz");
  assert.equal(searchMaintenanceEquipment(equipment, "QAB1A23")[0]?.id, 1);
});

test("não abre uma lista completa com pesquisa vazia", () => {
  assert.deepEqual(searchMaintenanceEquipment(equipment, "   "), []);
});
