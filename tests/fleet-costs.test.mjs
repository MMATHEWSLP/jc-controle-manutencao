import assert from "node:assert/strict";
import test from "node:test";
import { consumptionDeviation, consumptionOf } from "../lib/fleet-costs.ts";

test("consumo: L/h para horímetro e km/L para KM", () => {
  assert.equal(consumptionOf("HOURS", 200, 10), 20);
  assert.equal(consumptionOf("KM", 100, 350), 3.5);
  assert.equal(consumptionOf("HOURS", 200, 0), null);
  assert.equal(consumptionOf("KM", 0, 350), null);
});

test("fora da média: mais L/h ou menos km/L é ACIMA (gasta mais); dentro de 25% não marca", () => {
  assert.equal(consumptionDeviation("HOURS", 26, 20).outlier, "ACIMA");
  assert.equal(consumptionDeviation("HOURS", 14, 20).outlier, "ABAIXO");
  assert.equal(consumptionDeviation("HOURS", 24, 20).outlier, null);
  assert.equal(consumptionDeviation("KM", 2.5, 3.5).outlier, "ACIMA");
  assert.equal(consumptionDeviation("KM", 4.6, 3.5).outlier, "ABAIXO");
  assert.equal(consumptionDeviation("KM", null, 3.5).outlier, null);
});
