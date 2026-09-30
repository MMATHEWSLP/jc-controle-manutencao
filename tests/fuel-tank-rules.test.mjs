import assert from "node:assert/strict";
import test from "node:test";
import { litersFromRuler, parseCalibration, reconcile } from "../lib/fuel-tank-rules.ts";

test("tabela de arqueação: aceita ; tab e espaço, ordena e valida", () => {
  assert.deepEqual(parseCalibration("100;5.000\n0;0\n50;2.400,5").points, [[0, 0], [50, 2400.5], [100, 5000]]);
  assert.deepEqual(parseCalibration("0\t0\n200\t10000").points, [[0, 0], [200, 10000]]);
  assert.match(parseCalibration("0;0\n0;10").error, /repetido/);
  assert.match(parseCalibration("0;0\n10;500\n20;400").error, /aumentar/);
  assert.match(parseCalibration("abc").error, /inválida/);
  assert.match(parseCalibration("0;0").error, /pelo menos 2/);
});

test("régua: interpola entre os pontos e recusa fora da tabela", () => {
  const points = [[0, 0], [50, 2400], [100, 5000]];
  assert.equal(litersFromRuler(points, 25), 1200);
  assert.equal(litersFromRuler(points, 75), 3700);
  assert.equal(litersFromRuler(points, 100), 5000);
  assert.equal(litersFromRuler(points, 101), null);
});

test("conciliação: perda, sobra e dentro da tolerância", () => {
  assert.deepEqual(reconcile(82900, 83919, 1), { difference: -1019, percent: -1.21, status: "PERDA" });
  assert.deepEqual(reconcile(84000, 83919, 1), { difference: 81, percent: 0.1, status: "OK" });
  assert.equal(reconcile(1100, 1000, 5).status, "SOBRA");
  assert.equal(reconcile(10, 0).status, "SOBRA");
  assert.equal(reconcile(0, 0).status, "OK");
});
