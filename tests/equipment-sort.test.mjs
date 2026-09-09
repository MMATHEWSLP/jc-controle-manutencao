import assert from "node:assert/strict";
import test from "node:test";
import { naturalSortKey } from "../lib/equipment-sort.ts";

test("naturalSortKey preenche dígitos com zero à esquerda para ordem natural", () => {
  const values = ["EQ-10", "EQ-2", "EQ-1"].map(naturalSortKey).sort();
  assert.deepEqual(values, ["EQ-0000000001", "EQ-0000000002", "EQ-0000000010"]);
});

test("naturalSortKey ignora acento e caixa", () => {
  assert.equal(naturalSortKey("ábaco"), "ABACO");
  assert.equal(naturalSortKey("Ábaco"), "ABACO");
  assert.equal(naturalSortKey("ABACAXI"), "ABACAXI");
});

test("naturalSortKey preserva prefixos reais da frota sem alterar a ordem alfabética entre categorias", () => {
  const sorted = ["PC-30", "CA-01", "JL-24", "CA-10", "CA-2"].map(naturalSortKey).sort();
  assert.deepEqual(sorted, ["CA-0000000001", "CA-0000000002", "CA-0000000010", "JL-0000000024", "PC-0000000030"]);
});

test("naturalSortKey remove espaços nas pontas", () => {
  assert.equal(naturalSortKey("  CA-01  "), "CA-0000000001");
});
