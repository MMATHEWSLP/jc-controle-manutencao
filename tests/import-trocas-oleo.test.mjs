import assert from "node:assert/strict";
import test from "node:test";
import { buildImportPlan, canonicalService, parseBrDate, parseReading, readSourceFile } from "../scripts/import-trocas-oleo/plan.mjs";

const DATA_FILE = new URL("../scripts/import-trocas-oleo/data/flexal-2026-09-25.tsv", import.meta.url);
const OPTIONS = { source: "PLANILHA_FLEXAL_TESTE", sourceLabel: "teste" };

const oilTypes = [
  { id: 1, name: "Troca de óleo do motor", description: "MOTOR" },
  { id: 2, name: "Caixa de marcha", description: null },
  { id: 3, name: "Diferencial dianteiro", description: null },
  { id: 4, name: "Diferencial traseiro", description: null },
  { id: 5, name: "Transmissão", description: null },
];
const baseExisting = () => ({
  equipment: [
    { id: 10, prefix: "CA-05", control_type: "HOURS_KM", oil_change_enabled: true, current_hours: 100, current_km: 0 },
    { id: 20, prefix: "CM-01", control_type: "KM", oil_change_enabled: true, current_hours: 0, current_km: 999999 },
  ],
  oilTypes,
  applicable: [{ equipment_id: 10, maintenance_type_id: 1 }, { equipment_id: 10, maintenance_type_id: 2 }, { equipment_id: 20, maintenance_type_id: 1 }],
  imported: [],
  maintenances: [],
});
const row = (overrides) => ({ rowNumber: 2, prefix: "CA-05", front: "Flexal", dateRaw: "27/04/2026", date: "2026-04-27", service: "MOTOR", canonicalService: "MOTOR",
  workOrder: "", readingRaw: "11548", reading: 11548, status: "REALIZADA", notes: "", ...overrides });

test("lê as 123 trocas da planilha do Flexal com data e medidor válidos", () => {
  const rows = readSourceFile(DATA_FILE);
  assert.equal(rows.length, 123);
  assert.ok(rows.every((item) => item.date && item.reading !== null && item.front === "Flexal" && item.status === "REALIZADA"));
  assert.deepEqual(new Set(rows.map((item) => item.canonicalService)),
    new Set(["MOTOR", "CAIXA DE MARCHA", "DIFERENCIAL DIANTEIRO", "DIFERENCIAL TRASEIRO", "CAIXA DE REDUCAO", "TRANSMISSAO", "COMANDO FINAL"]));
});

test("datas e medidores em formato brasileiro", () => {
  assert.equal(parseBrDate("04/02/2025"), "2025-02-04");
  assert.equal(parseBrDate("31/02/2026"), null);
  assert.equal(parseReading("215.225"), 215225);
  assert.equal(parseReading("1027"), 1027);
  assert.equal(parseReading(""), null);
  assert.equal(canonicalService("CAIXA DE REDUÇÃO"), "CAIXA DE REDUCAO");
});

test("importa linha nova ligada ao equipamento e ao tipo aplicável, na unidade certa", () => {
  const plan = buildImportPlan([row({}), row({ prefix: "CM-01", reading: 276702, readingRaw: "276702" })], baseExisting(), OPTIONS);
  assert.equal(plan.totals.IMPORTAR, 2);
  const [ca, cm] = plan.decisions;
  assert.equal(ca.insert.equipmentId, 10);
  assert.equal(ca.insert.maintenanceTypeId, 1);
  assert.equal(ca.insert.controlType, "HOURS");
  assert.equal(cm.insert.controlType, "KM");
  assert.match(ca.insert.notes, /Filial: Flexal/);
  assert.deepEqual(plan.meters.map((item) => [item.equipment.prefix, item.reading]), [["CA-05", 11548]], "só avança leitura menor que a planilha");
});

test("não duplica: já importado, já lançado no sistema, ou repetido na planilha", () => {
  const existing = baseExisting();
  existing.imported.push({ equipment_id: null, prefix: "ca05", service: "Troca de óleo do motor", performed_at: "2026-04-27", reading_value: 11548, import_key: null });
  existing.maintenances.push({ equipment_id: 10, maintenance_type_id: 2, performed_at: "2026-04-27T15:00:00.000Z", hours: 11548, km: null });
  const plan = buildImportPlan([
    row({}),
    row({ service: "CAIXA DE MARCHA", canonicalService: "CAIXA DE MARCHA" }),
    row({ service: "DIFERENCIAL DIANTEIRO", canonicalService: "DIFERENCIAL DIANTEIRO" }),
    row({ service: "DIFERENCIAL DIANTEIRO", canonicalService: "DIFERENCIAL DIANTEIRO" }),
  ], existing, OPTIONS);
  assert.deepEqual(plan.decisions.map((item) => item.action), ["JA_EXISTE", "JA_EXISTE", "IMPORTAR", "DUPLICADO_NA_PLANILHA"]);
  assert.match(plan.decisions[2].warnings.join(), /não está marcado como aplicável/);
});

test("rodar de novo após importar não grava nada (import_key)", () => {
  const first = buildImportPlan([row({})], baseExisting(), OPTIONS);
  const existing = baseExisting();
  existing.imported.push({ equipment_id: 10, prefix: "CA-05", service: "MOTOR", performed_at: "2026-04-27", reading_value: 11548, import_key: first.decisions[0].insert.importKey });
  assert.equal(buildImportPlan([row({})], existing, OPTIONS).totals.JA_EXISTE, 1);
});

test("equipamento não cadastrado e medidor placeholder são sinalizados", () => {
  const plan = buildImportPlan([row({ prefix: "XX-99" }), row({ reading: 1, readingRaw: "1" })], baseExisting(), OPTIONS);
  assert.equal(plan.decisions[0].action, "EQUIPAMENTO_NAO_ENCONTRADO");
  assert.match(plan.decisions[1].warnings.join(), /placeholder/);
});
