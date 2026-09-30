import assert from "node:assert/strict";
import test from "node:test";
import { duplicateKey, estimatedConsumption, parseFullTank, parseImportDate, parseImportNumber, parseImportType, originLocation, patternWarnings, readRawRows, average } from "../lib/fuel-import-rules.ts";

test("data DD/MM/AAAA, ISO e número do Excel; datas impossíveis são inválidas", () => {
  assert.equal(parseImportDate("29/09/2026"), "2026-09-29");
  assert.equal(parseImportDate("1/9/2026"), "2026-09-01");
  assert.equal(parseImportDate("2026-09-29"), "2026-09-29");
  assert.equal(parseImportDate("46294"), "2026-09-29");
  assert.equal(parseImportDate("31/02/2026"), null);
  assert.equal(parseImportDate("ontem"), null);
  assert.equal(parseImportDate(""), null);
});

test("números em formato brasileiro", () => {
  assert.equal(parseImportNumber("297"), 297);
  assert.equal(parseImportNumber("297,5"), 297.5);
  assert.equal(parseImportNumber("1.234,50"), 1234.5);
  assert.equal(parseImportNumber("411.208"), 411208);
  assert.equal(parseImportNumber("347.5"), 347.5);
  assert.equal(parseImportNumber(""), null);
  assert.ok(Number.isNaN(parseImportNumber("abc")));
});

test("tanque cheio, tipo e origem", () => {
  assert.equal(parseFullTank(""), true);
  assert.equal(parseFullTank("sim"), true);
  assert.equal(parseFullTank("NÃO"), false);
  assert.equal(parseFullTank("talvez"), null);
  assert.equal(parseImportType("saida_prestador"), "SAIDA_PRESTADOR");
  assert.equal(parseImportType("SAIDA"), null);
  assert.equal(originLocation("Frente Arapiuns"), "FRENTE");
  assert.equal(originLocation("Porto Arapiuns"), "PORTO");
});

test("consumo estimado, médias, avisos e duplicidade", () => {
  assert.deepEqual(estimatedConsumption("KM", 600, 300, true), { value: 2, unit: "km/L" });
  assert.deepEqual(estimatedConsumption("HOURS", 20, 300, true), { value: 15, unit: "L/h" });
  assert.equal(estimatedConsumption("KM", 600, 300, false), null);
  assert.equal(average([10, 20]), null);
  assert.equal(average([10, 20, 30]), 20);
  const warnings = patternWarnings({ difference: 2000, averageInterval: 500, liters: 600, averageLiters: 300, unitLabel: "km" });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Salto de leitura/);
  assert.deepEqual(patternWarnings({ difference: 600, averageInterval: 500, liters: 320, averageLiters: 300, unitLabel: "km" }), []);
  assert.equal(duplicateKey("E1", "2026-09-29", 297, 1000), duplicateKey("E1", "2026-09-29", 297.0, 1000.0));
  assert.notEqual(duplicateKey("E1", "2026-09-29", 297, null), duplicateKey("E1", "2026-09-29", 297, 1000));
  const rows = readRawRows([{ rowNumber: 5, values: { data: " 29/09/2026 ", litros: 297 } }]);
  assert.equal(rows[0].rowNumber, 5);
  assert.equal(rows[0].values.data, "29/09/2026");
  assert.equal(rows[0].values.litros, "297");
  assert.equal(rows[0].values.motorista, "");
});
