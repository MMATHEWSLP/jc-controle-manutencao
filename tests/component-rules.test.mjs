import assert from "node:assert/strict";
import test from "node:test";
import { ComponentRuleError, componentAlert, costPerUnit, lifeUsedPercent, mainUsage, monthsBetween, replay, totalUsage, validateEvent } from "../lib/component-rules.ts";

const ev = (eventType, eventDate, extra = {}) => ({ eventType, eventDate, equipmentId: null, position: null, reading: null, unit: null, cost: null, ...extra });

test("uso soma cada período montado, inclusive rodízio, e o período em aberto até a leitura atual", () => {
  const events = [
    ev("MOUNT", "2026-01-10", { equipmentId: 1, position: "DE", reading: 10000, unit: "KM" }),
    ev("ROTATE", "2026-03-01", { equipmentId: 1, position: "TEE", reading: 25000, unit: "KM" }),
    ev("UNMOUNT", "2026-05-01", { reading: 40000, unit: "KM" }),
    ev("RECAP", "2026-05-10", { cost: 600 }),
    ev("MOUNT", "2026-05-20", { equipmentId: 2, position: "DD", reading: 5000, unit: "KM" }),
  ];
  const state = replay(events);
  assert.equal(state.status, "MOUNTED");
  assert.equal(state.equipmentId, 2);
  assert.equal(state.recapCount, 1);
  assert.equal(state.usage.KM, 30000);
  assert.deepEqual(totalUsage(state, 12000), { KM: 37000, HOURS: 0 });
  assert.equal(state.eventsCost, 600);
  assert.equal(replay([ev("INSPECTION", "2026-01-01", { treadDepth: 2 }), ev("RECAP", "2026-01-02")]).lastTreadDepth, null);
  assert.equal(costPerUnit(2000 + 600, 37000), 0.0703);
});

test("desfazer = repassar sem o último evento", () => {
  const events = [ev("MOUNT", "2026-01-10", { equipmentId: 1, position: "DE", reading: 100, unit: "HOURS" }), ev("UNMOUNT", "2026-02-10", { reading: 900, unit: "HOURS" })];
  assert.equal(replay(events).status, "STOCK");
  assert.equal(replay(events).usage.HOURS, 800);
  const undone = replay(events.slice(0, -1));
  assert.equal(undone.status, "MOUNTED");
  assert.equal(undone.usage.HOURS, 0);
  assert.deepEqual(mainUsage(totalUsage(undone, 1300)), { unit: "HOURS", value: 1200 });
});

test("validação: montar só do estoque, leitura obrigatória e nunca menor que a da montagem", () => {
  const mounted = replay([ev("MOUNT", "2026-01-10", { equipmentId: 1, position: "DE", reading: 1000, unit: "KM" })]);
  const today = "2026-06-01";
  assert.throws(() => validateEvent("TIRE", mounted, ev("MOUNT", "2026-02-01", { equipmentId: 1, position: "DD", reading: 1200 }), today), /estoque/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("UNMOUNT", "2026-02-01"), today), (error) => error instanceof ComponentRuleError && error.field === "reading");
  assert.throws(() => validateEvent("TIRE", mounted, ev("UNMOUNT", "2026-02-01", { reading: 900 }), today), /menor que a da montagem/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("ROTATE", "2026-02-01", { position: "de", reading: 1100 }), today), /igual à atual/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("RECAP", "2026-02-01"), today), /Desmonte/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("UNMOUNT", "2026-01-01", { reading: 1100 }), today), /anterior ao último/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("UNMOUNT", "2026-07-01", { reading: 1100 }), today), /futura/);
  assert.throws(() => validateEvent("BATTERY", mounted, ev("ROTATE", "2026-02-01", { position: "X", reading: 1 }), today), /não aceita/);
  assert.throws(() => validateEvent("TIRE", mounted, ev("INSPECTION", "2026-02-01"), today), /sulco/);
  validateEvent("TIRE", mounted, ev("INSPECTION", "2026-02-01", { treadDepth: 8 }), today);
  validateEvent("TIRE", mounted, ev("UNMOUNT", "2026-02-01", { reading: 1000 }), today);
  const discarded = replay([ev("DISCARD", "2026-01-10")]);
  assert.throws(() => validateEvent("TIRE", discarded, ev("REPAIR", "2026-02-01"), today), /descartado/);
});

test("vida usada, idade em meses e alertas", () => {
  assert.equal(monthsBetween("2024-03-15", "2026-03-14"), 23);
  assert.equal(monthsBetween("2024-03-15", "2026-03-15"), 24);
  assert.equal(lifeUsedPercent("TIRE", 80000, 72000, null), 90);
  assert.equal(lifeUsedPercent("BATTERY", 24, 0, 12), 50);
  assert.equal(lifeUsedPercent("TIRE", null, 72000, null), null);
  assert.equal(componentAlert({ kind: "TIRE", status: "MOUNTED", lifePercent: 90, lastTreadDepth: 6, warrantyMonths: null, ageMonths: null })?.level, "orange");
  assert.match(componentAlert({ kind: "TIRE", status: "MOUNTED", lifePercent: 20, lastTreadDepth: 2.5, warrantyMonths: null, ageMonths: null })?.text ?? "", /Sulco baixo/);
  assert.equal(componentAlert({ kind: "BATTERY", status: "MOUNTED", lifePercent: 50, lastTreadDepth: null, warrantyMonths: 12, ageMonths: 13 })?.text, "Fora da garantia");
  assert.equal(componentAlert({ kind: "TIRE", status: "DISCARDED", lifePercent: 150, lastTreadDepth: 1, warrantyMonths: null, ageMonths: null }), null);
});
