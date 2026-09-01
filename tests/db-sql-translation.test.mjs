import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSqliteisms, toPgQuery } from "../db/index.ts";

// Este teste cobre a causa raiz do bug de transferência de equipamento sem
// frente: "coluna IS ?" é válido no SQLite/D1 (a base original do projeto),
// mas o Postgres só aceita "IS" com NULL/TRUE/FALSE/UNKNOWN literais — usar
// um parâmetro ali é erro de sintaxe, e a query INTEIRA falha, não importa
// se o parâmetro é NULL ou um número.

test("'coluna IS ?' vira NULL-safe em Postgres (bug real da transferência sem frente)", () => {
  const query = "UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS ?";
  assert.equal(
    normalizeSqliteisms(query),
    "UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS NOT DISTINCT FROM ?",
  );
});

test("a mesma correção também vale para a duplicidade de histórico importado (performed_at IS ?)", () => {
  const query = "SELECT id FROM imported_maintenance_history WHERE id<>? AND prefix=? AND service=? AND reading_raw=? AND performed_at IS ?";
  assert.match(normalizeSqliteisms(query), /performed_at IS NOT DISTINCT FROM \?/);
});

test("'IS NULL', 'IS NOT NULL', 'IS TRUE' continuam intactos (são válidos em Postgres)", () => {
  for (const clause of ["status IS NULL", "status IS NOT NULL", "active IS TRUE", "active IS FALSE"]) {
    assert.equal(normalizeSqliteisms(`SELECT 1 WHERE ${clause}`), `SELECT 1 WHERE ${clause}`);
  }
});

test("query final (com placeholders convertidos p/ $1,$2...) fica sintaticamente válida para o Postgres", () => {
  const query = "UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS ?";
  const finalSql = toPgQuery(normalizeSqliteisms(query));
  assert.equal(finalSql, "UPDATE equipment SET service_front_id=$1,updated_at=$2 WHERE id=$3 AND service_front_id IS NOT DISTINCT FROM $4");
});

test("primeira definição de frente: parâmetro NULL não quebra mais a query (comparação correta com IS NOT DISTINCT FROM)", () => {
  // service_front_id atual é NULL (equipamento recém-importado, sem frente).
  // "IS NOT DISTINCT FROM $4" com $4=NULL é equivalente a "IS NULL" — casa
  // corretamente a linha e permite a primeira atribuição de frente.
  const query = "UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS ?";
  const finalSql = toPgQuery(normalizeSqliteisms(query));
  assert.ok(finalSql.includes("IS NOT DISTINCT FROM $4"), "deve usar comparação NULL-safe, não IS $4 (inválido em Postgres)");
});
