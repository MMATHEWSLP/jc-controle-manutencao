import assert from "node:assert/strict";
import test from "node:test";
import { formatBrDate } from "../lib/date-format.ts";

test("data sem hora não volta um dia (bug da última troca)", () => {
  assert.equal(formatBrDate("2026-07-05", false), "05/07/2026");
  assert.equal(formatBrDate("2026-07-05"), "05/07/2026");
});

test("hora local sem fuso aparece como foi digitada", () => {
  assert.equal(formatBrDate("2026-09-04T10:46"), "04/09/2026, 10:46");
  assert.equal(formatBrDate("2026-09-04T10:46", false), "04/09/2026");
});

test("valor com fuso vira horário de Fortaleza", () => {
  assert.equal(formatBrDate("2026-08-29T13:39:00.000Z"), "29/08/2026, 10:39");
  assert.equal(formatBrDate(null), "—");
  assert.equal(formatBrDate("", true, "Sem data"), "Sem data");
});
