import assert from "node:assert/strict";
import test from "node:test";
import { averageConsumption, computeConsumption, isOutlier, parseThirdParty, parseVehicle, plateKey } from "../lib/third-party-rules.ts";

const f = (id, date, liters, reading, extra = {}) => ({ id, date, liters, reading, fullTank: true, ...extra });

test("consumo em km/L entre tanques cheios; o primeiro abastecimento é só base", () => {
  const result = computeConsumption("KM", [f(1, "2026-09-01", 100, 10000), f(2, "2026-09-05", 200, 10500), f(3, "2026-09-10", 250, 11000)]);
  assert.equal(result.get(1), null);
  assert.deepEqual(result.get(2), { distance: 500, liters: 200, value: 2.5 });
  assert.deepEqual(result.get(3), { distance: 500, liters: 250, value: 2 });
  assert.deepEqual(averageConsumption("KM", [...result.values()]), { distance: 1000, liters: 450, value: 1000 / 450 });
});

test("horímetro em L/h e tanque parcial acumulando litros para o próximo tanque cheio", () => {
  const result = computeConsumption("HORIMETRO", [
    f(1, "2026-09-01", 300, 1000), f(2, "2026-09-02", 100, 1004, { fullTank: false }), f(3, "2026-09-03", 200, 1010),
  ]);
  assert.equal(result.get(2), null);
  // 100 + 200 litros em 10 horas desde o último tanque cheio = 30 L/h.
  assert.deepEqual(result.get(3), { distance: 10, liters: 300, value: 30 });
});

test("ordem por data e leitura aceita como exceção vira nova base", () => {
  const result = computeConsumption("KM", [f(3, "2026-09-10", 100, 500, { readingException: true }), f(1, "2026-09-01", 100, 20000), f(2, "2026-09-05", 100, 20300), f(4, "2026-09-12", 50, 700)]);
  assert.equal(result.get(2).value, 3);
  assert.equal(result.get(3), null);
  assert.deepEqual(result.get(4), { distance: 200, liters: 50, value: 4 });
});

test("fora da média = desvio acima de 25%", () => {
  assert.equal(isOutlier(2, 2.5), false);
  assert.equal(isOutlier(1.8, 2.5), true);
  assert.equal(isOutlier(3.2, 2.5), true);
  assert.equal(isOutlier(3, null), false);
});

test("cadastro: documento com 11 ou 14 dígitos, placa normalizada e números opcionais", () => {
  assert.equal(parseThirdParty({ name: "transportes x", kind: "PRESTADOR", document: "12.345.678/0001-90" }).value.document, "12345678000190");
  assert.match(parseThirdParty({ name: "X", kind: "PRESTADOR" }).error, /nome/);
  assert.match(parseThirdParty({ name: "Fulano", kind: "PESSOA_FISICA", document: "123" }).error, /CPF/);
  assert.equal(plateKey("abc-1d23"), "ABC1D23");
  const vehicle = parseVehicle({ plate: "abc-1d23", vehicleType: "CAMINHAO", meterType: "KM", tankCapacityLiters: "400", expectedConsumption: "2,5", lastReading: "" });
  assert.deepEqual([vehicle.value.plate, vehicle.value.plateKey, vehicle.value.tankCapacityLiters, vehicle.value.expectedConsumption, vehicle.value.lastReading], ["ABC-1D23", "ABC1D23", 400, 2.5, null]);
  assert.match(parseVehicle({ plate: "X1", vehicleType: "CAMINHAO", meterType: "KM", tankCapacityLiters: "0" }).error, /capacidade/);
});
