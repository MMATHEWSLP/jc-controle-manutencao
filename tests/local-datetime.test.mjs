import assert from "node:assert/strict";
import test from "node:test";
import { toLocalWallTime } from "../lib/local-datetime.ts";

test("leitura com fuso vira hora local de Fortaleza sem fuso", () => {
  assert.equal(toLocalWallTime("2026-08-29T13:39:00.000Z"), "2026-08-29T10:39");
  assert.equal(toLocalWallTime("2026-08-29T13:39:00-03:00"), "2026-08-29T13:39");
});

test("hora local e data simples ficam como estão", () => {
  assert.equal(toLocalWallTime("2026-09-04T10:46"), "2026-09-04T10:46");
  assert.equal(toLocalWallTime("2026-09-04 10:46:12"), "2026-09-04T10:46");
  assert.equal(toLocalWallTime("2026-09-04"), "2026-09-04");
});

test("ordem por texto fica cronológica depois de padronizar", () => {
  const values = ["2026-08-29T14:01", "2026-08-29T13:39:00.000Z"].map(toLocalWallTime).sort();
  assert.deepEqual(values, ["2026-08-29T10:39", "2026-08-29T14:01"]);
});
