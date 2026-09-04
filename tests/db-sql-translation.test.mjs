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

// Este bloco cobre a causa raiz do "Configure o intervalo de undefined antes de
// registrar a troca." no Registrar troca de óleo: "AS equipmentId" (sem aspas)
// no SQLite/D1 volta com essa grafia exata, mas no Postgres qualquer identificador
// sem aspas é dobrado para minúsculas ("equipmentid") — daí `row.equipmentId`
// (e `row.maintenanceName`, usado na própria mensagem de erro) chegavam undefined
// no JS, para todo equipamento, mesmo com o intervalo certinho no banco.

test("'AS aliasCamelCase' ganha aspas para o Postgres preservar a grafia (bug real do intervalo undefined)", () => {
  const query = "SELECT p.id,p.equipment_id AS equipmentId,t.name AS maintenanceName,p.interval_hours AS intervalHours FROM maintenance_plans p";
  assert.equal(
    normalizeSqliteisms(query),
    'SELECT p.id,p.equipment_id AS "equipmentId",t.name AS "maintenanceName",p.interval_hours AS "intervalHours" FROM maintenance_plans p',
  );
});

test("query real de lib/maintenance-data.ts (loadPlansForEquipment) sai com todos os apelidos camelCase entre aspas", () => {
  const query = `SELECT
    p.id,p.equipment_id AS equipmentId,p.maintenance_type_id AS maintenanceTypeId,
    t.name AS maintenanceName,p.interval_hours AS intervalHours,p.interval_km AS intervalKm,
    p.trigger_mode AS triggerMode,p.last_hours AS lastHours,p.last_km AS lastKm,
    p.next_hours AS nextHours,p.next_km AS nextKm,p.active
    FROM maintenance_plans p
    INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
    WHERE p.equipment_id=? AND p.active=1`;
  const normalized = normalizeSqliteisms(query);
  for (const alias of ["equipmentId", "maintenanceTypeId", "maintenanceName", "intervalHours", "intervalKm", "triggerMode", "lastHours", "lastKm", "nextHours", "nextKm"]) {
    assert.match(normalized, new RegExp(`AS "${alias}"`), `apelido ${alias} deveria estar entre aspas`);
  }
});

test("query real de lib/maintenance-data.ts (loadThresholds) também protege os apelidos dos limiares de alerta", () => {
  const query = `SELECT
    alerta_horas_amarelo_fim AS alertaHorasAmareloFim,
    alerta_horas_laranja_fim AS alertaHorasLaranjaFim,
    alerta_km_amarelo_fim AS alertaKmAmareloFim,
    alerta_km_laranja_fim AS alertaKmLaranjaFim,
    urgency_percent AS urgencyPercent
    FROM system_settings WHERE id=1`;
  const normalized = normalizeSqliteisms(query);
  for (const alias of ["alertaHorasAmareloFim", "alertaHorasLaranjaFim", "alertaKmAmareloFim", "alertaKmLaranjaFim", "urgencyPercent"]) {
    assert.match(normalized, new RegExp(`AS "${alias}"`), `apelido ${alias} deveria estar entre aspas`);
  }
});

test("apelidos já em snake_case ou minúsculos continuam sem aspas (não precisam e não devem mudar)", () => {
  const query = "SELECT t.name AS maintenance_name, p.active, e.id FROM maintenance_plans p";
  assert.equal(normalizeSqliteisms(query), query);
});

test("apelido já escrito entre aspas não é alterado (evita aspas duplicadas)", () => {
  const query = 'SELECT p.equipment_id AS "equipmentId" FROM maintenance_plans p';
  assert.equal(normalizeSqliteisms(query), query);
});

test("aspas em apelido camelCase sobrevivem à conversão final de placeholders para $1,$2...", () => {
  const query = "SELECT p.interval_hours AS intervalHours FROM maintenance_plans p WHERE p.id=?";
  const finalSql = toPgQuery(normalizeSqliteisms(query));
  assert.equal(finalSql, 'SELECT p.interval_hours AS "intervalHours" FROM maintenance_plans p WHERE p.id=$1');
});
