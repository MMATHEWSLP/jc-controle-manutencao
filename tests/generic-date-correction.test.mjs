import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  GENERIC_DATE,
  GENERIC_DATE_SOURCE,
  genericDateAuditPayload,
  isAmbiguousImportedHistory,
  isEligibleForGenericDate,
  isValidDateText,
} from "../scripts/generic-date-correction/logic.mjs";

test("a data genérica autorizada é 2026-07-05 (dia 5, mês 7 — nunca 7 de maio)", () => {
  assert.equal(GENERIC_DATE, "2026-07-05");
});

test("isValidDateText reconhece datas válidas e rejeita nulo, vazio e texto inválido", () => {
  assert.equal(isValidDateText("2025-08-15"), true);
  assert.equal(isValidDateText("2025-08-15T10:00:00.000Z"), true);
  assert.equal(isValidDateText(null), false);
  assert.equal(isValidDateText(undefined), false);
  assert.equal(isValidDateText(""), false);
  assert.equal(isValidDateText("   "), false);
  assert.equal(isValidDateText("DANIFICADO"), false);
  assert.equal(isValidDateText("SEM HORIMETRO"), false);
});

test("histórico importado sem data e com leitura registrada é elegível para a data genérica", () => {
  assert.equal(isEligibleForGenericDate({ performedAt: null, readingValue: 1453 }), true);
  assert.equal(isEligibleForGenericDate({ performedAt: "", readingValue: 817025 }), true);
  assert.equal(isEligibleForGenericDate({ performedAt: "DANIFICADO", readingValue: null }), false, "sem leitura não é elegível — é ambíguo");
});

test("migration não altera um histórico que já possui data válida", () => {
  assert.equal(isEligibleForGenericDate({ performedAt: "2025-08-15", readingValue: 95123 }), false);
  assert.equal(isEligibleForGenericDate({ performedAt: "2025-08-15", readingValue: null }), false);
});

test("registro sem data e sem leitura é ambíguo e nunca é corrigido automaticamente", () => {
  assert.equal(isAmbiguousImportedHistory({ performedAt: null, readingValue: null }), true);
  assert.equal(isAmbiguousImportedHistory({ performedAt: "DANIFICADO", readingValue: null }), true);
  assert.equal(isAmbiguousImportedHistory({ performedAt: null, readingValue: 100 }), false);
  assert.equal(isAmbiguousImportedHistory({ performedAt: "2025-08-15", readingValue: null }), false, "data válida sem leitura não é o caso tratado aqui (não é 'sem data')");
});

test("o registro de auditoria preserva a data original (mesmo nula) e nunca apaga metadados", () => {
  const audit = genericDateAuditPayload({ performedAt: null, isGenericDate: false, dateSource: "ORIGINAL" });
  assert.deepEqual(audit.previousValue, { performedAt: null, isGenericDate: false, dateSource: "ORIGINAL" });
  assert.deepEqual(audit.newValue, { performedAt: GENERIC_DATE, isGenericDate: true, dateSource: GENERIC_DATE_SOURCE });
});

// --- Integração (SQLite em memória): a correção real aplicada linha a linha ---

function testDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE imported_maintenance_history (
      id INTEGER PRIMARY KEY,
      prefix TEXT NOT NULL,
      service TEXT NOT NULL,
      reading_raw TEXT NOT NULL DEFAULT '',
      reading_value REAL,
      control_type TEXT NOT NULL,
      performed_at TEXT,
      is_generic_date INTEGER NOT NULL DEFAULT 0,
      date_source TEXT NOT NULL DEFAULT 'ORIGINAL',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      previous_value TEXT,
      new_value TEXT,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return database;
}

function insertImported(database, { prefix, service, reading, unit, date }) {
  return Number(database.prepare(`INSERT INTO imported_maintenance_history (prefix,service,reading_raw,reading_value,control_type,performed_at)
    VALUES (?,?,?,?,?,?)`).run(prefix, service, reading === null ? "" : String(reading), reading, unit, date).lastInsertRowid);
}

// Reproduz, statement a statement, a mesma lógica do script de produção
// (corrigir-historico-data-generica.mjs), usando as mesmas funções puras.
function applyGenericDateCorrection(database) {
  const rows = database.prepare(`SELECT * FROM imported_maintenance_history WHERE is_generic_date = 0`).all();
  let corrected = 0;
  for (const row of rows) {
    const pure = { performedAt: row.performed_at, readingValue: row.reading_value, isGenericDate: Boolean(row.is_generic_date), dateSource: row.date_source };
    if (!isEligibleForGenericDate(pure)) continue;
    const audit = genericDateAuditPayload(pure);
    database.prepare(`UPDATE imported_maintenance_history SET performed_at=?,is_generic_date=1,date_source=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND is_generic_date=0`)
      .run(GENERIC_DATE, GENERIC_DATE_SOURCE, row.id);
    database.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value) VALUES (NULL,'IMPORTED_MAINTENANCE_HISTORY',?,?,?,?)`)
      .run(String(row.id), "DATA GENÉRICA APLICADA", JSON.stringify(audit.previousValue), JSON.stringify(audit.newValue));
    corrected++;
  }
  return corrected;
}

test("aplica a data genérica apenas nos históricos importados sem data, preservando os demais dados", () => {
  const database = testDatabase();
  const semDataId = insertImported(database, { prefix: "CC-04", service: "Troca de óleo do motor", reading: 1453, unit: "HOURS", date: null });
  const comDataId = insertImported(database, { prefix: "CM-27", service: "Troca de óleo do motor", reading: 124673, unit: "KM", date: "2026-06-20" });
  const ambiguoId = insertImported(database, { prefix: "CM-04", service: "Troca de óleo da caixa de marcha", reading: null, unit: "KM", date: null });

  const corrected = applyGenericDateCorrection(database);
  assert.equal(corrected, 1, "só o registro sem data e com leitura deve ser corrigido");

  const semData = database.prepare("SELECT performed_at,is_generic_date,date_source,prefix,service,reading_value,control_type FROM imported_maintenance_history WHERE id=?").get(semDataId);
  assert.deepEqual({ ...semData }, { performed_at: GENERIC_DATE, is_generic_date: 1, date_source: GENERIC_DATE_SOURCE, prefix: "CC-04", service: "Troca de óleo do motor", reading_value: 1453, control_type: "HOURS" },
    "recebe a data genérica e a marcação, sem alterar equipamento, serviço, leitura ou unidade");

  const comData = database.prepare("SELECT performed_at,is_generic_date,date_source FROM imported_maintenance_history WHERE id=?").get(comDataId);
  assert.deepEqual({ ...comData }, { performed_at: "2026-06-20", is_generic_date: 0, date_source: "ORIGINAL" }, "histórico com data válida não é tocado");

  const ambiguo = database.prepare("SELECT performed_at,is_generic_date,reading_value FROM imported_maintenance_history WHERE id=?").get(ambiguoId);
  assert.deepEqual({ ...ambiguo }, { performed_at: null, is_generic_date: 0, reading_value: null }, "registro ambíguo (sem data e sem leitura) fica intacto para revisão manual");

  const auditRows = database.prepare("SELECT entity_id,action FROM audit_logs").all();
  assert.deepEqual(auditRows.map((row) => [row.entity_id, row.action]), [[String(semDataId), "DATA GENÉRICA APLICADA"]], "só o registro corrigido recebe entrada de auditoria");
});

test("rodar a correção duas vezes é idempotente — não duplica nem altera de novo os registros já corrigidos", () => {
  const database = testDatabase();
  const id = insertImported(database, { prefix: "CM-34", service: "Troca de óleo do motor", reading: 114215, unit: "KM", date: null });

  const firstRun = applyGenericDateCorrection(database);
  assert.equal(firstRun, 1);
  const afterFirst = { ...database.prepare("SELECT performed_at,is_generic_date,date_source,updated_at FROM imported_maintenance_history WHERE id=?").get(id) };

  const secondRun = applyGenericDateCorrection(database);
  assert.equal(secondRun, 0, "a segunda execução não encontra mais candidatos");
  const afterSecond = { ...database.prepare("SELECT performed_at,is_generic_date,date_source,updated_at FROM imported_maintenance_history WHERE id=?").get(id) };
  assert.deepEqual(afterSecond, afterFirst, "o registro permanece exatamente como ficou após a primeira correção");

  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM audit_logs").get().total, 1, "não gera um segundo evento de auditoria para o mesmo registro");
});
