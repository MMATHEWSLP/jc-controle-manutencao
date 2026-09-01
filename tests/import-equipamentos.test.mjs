import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPrefix,
  classifyPlateField,
  emptyToNull,
  prefixCategory,
  prefixKey,
  serialKey,
} from "../scripts/import-equipamentos/normalize.mjs";
import { findInternalDuplicates, findSubstringSerialConflicts, parseFleetSource } from "../scripts/import-equipamentos/parse.mjs";
import { buildImportPlan, classifyRow, inferEquipmentDefaults, resolvePlanTemplate } from "../scripts/import-equipamentos/plan.mjs";

const DATA_FILE = new URL("../scripts/import-equipamentos/data/frota-fonte-2026-09.tsv", import.meta.url);

test("prefixKey trata CA-01, ca-01 e CA01 como o mesmo prefixo", () => {
  assert.equal(prefixKey("CA-01"), prefixKey("ca-01"));
  assert.equal(prefixKey("CA-01"), prefixKey("CA01"));
  assert.equal(prefixKey("CA-01"), prefixKey(" CA - 01 "));
});

test("placas com e sem hífen comparam como a mesma placa", () => {
  assert.deepEqual(classifyPlateField("QDK-4992"), { plate: "QDK-4992", observation: null });
  assert.deepEqual(classifyPlateField("QDK4992").plate.replace("-", ""), classifyPlateField("QDK-4992").plate.replace("-", ""));
});

test("valores de ausência viram NULL sem inventar dado", () => {
  for (const value of ["", "#N/D", "SEM INFORMAÇÃO", "SEM INFORMAÇAO", "Ñ TEM PLAQUETA", "NÃO TEM PLAQUETA"]) {
    assert.equal(emptyToNull(value), null, `esperava NULL para "${value}"`);
  }
  assert.equal(emptyToNull("LJR00617"), "LJR00617");
});

test("categoria do equipamento vem das letras antes do hífen do prefixo", () => {
  assert.equal(prefixCategory("PC-20"), "PC");
  assert.equal(prefixCategory("HL-06-RXD6G68"), "HL");
  assert.equal(prefixCategory("KEF7F35"), null); // placa sem hífen: sem categoria
});

test("observação em texto livre na coluna CHASSI/SÉRIE não vira identificador (JL-18)", () => {
  assert.equal(serialKey("3 EIXOS"), null);
});

test("arquivo de origem: mesmo executado em cima dele mesmo não deve achar duplicidade interna (arquivo já é consistente)", () => {
  const { rows } = parseFleetSource(DATA_FILE);
  const dup = findInternalDuplicates(rows);
  assert.deepEqual(dup.prefix, []);
  assert.deepEqual(dup.serial, []);
  assert.deepEqual(dup.plate, []);
});

test("TE-09 e TE-10 são sinalizados como possível conflito de série (mesmo número final)", () => {
  const { rows } = parseFleetSource(DATA_FILE);
  const conflicts = findSubstringSerialConflicts(rows);
  const prefixes = conflicts.map(([a, b]) => [a.prefixRaw, b.prefixRaw].sort());
  assert.deepEqual(prefixes, [["TE-09", "TE-10"]]);
});

test("CA-06 (4X5) e CP-01 (dados incompletos) ficam com alerta, sem correção silenciosa", () => {
  const { rows } = parseFleetSource(DATA_FILE);
  const ca06 = rows.find((row) => row.prefixRaw === "CA-06");
  const cp01 = rows.find((row) => row.prefixRaw === "CP-01");
  assert.ok(ca06.alerts.some((alert) => alert.includes("4X5")));
  assert.ok(cp01.alerts.some((alert) => alert.includes("incompletos")));
});

test("a mesma execução rodada duas vezes contra o mesmo banco não duplica: prefixo já existente vira JA_EXISTENTE", () => {
  const existing = {
    equipmentByPrefixKey: new Map([["CA01", { id: 501, prefix: "CA-01" }]]),
    allChassisSerialKeys: new Map(),
    allPlateKeys: new Map(),
    categoryStats: new Map(),
  };
  const row = { prefixKey: "CA01", prefixRaw: "CA-01", serialKey: null, plateKey: null };
  const decision = classifyRow(row, existing);
  assert.equal(decision.action, "JA_EXISTENTE");
  assert.equal(decision.existingEquipmentId, 501);
});

test("conflito de chassi/série com outro equipamento não é inserido automaticamente", () => {
  const existing = {
    equipmentByPrefixKey: new Map(),
    allChassisSerialKeys: new Map([["LJR00617", { prefix: "TE-09", field: "serial_number" }]]),
    allPlateKeys: new Map(),
    categoryStats: new Map(),
  };
  const row = { prefixKey: "TE10", prefixRaw: "TE-10", serialKey: "LJR00617", serialRaw: "LJR00617", plateKey: null };
  const decision = classifyRow(row, existing);
  assert.equal(decision.action, "CONFLITO");
});

test("equipamento existente não é sobrescrito: plano não gera update, só marca JA_EXISTENTE", () => {
  const existing = {
    equipmentByPrefixKey: new Map([["PC20", { id: 900, prefix: "PC-20" }]]),
    allChassisSerialKeys: new Map(),
    allPlateKeys: new Map(),
    categoryStats: new Map(),
  };
  const rows = [{ prefixKey: "PC20", prefixRaw: "PC-20", category: "PC", description: "PA CARREGADEIRA CATERPILLAR 938K", alerts: [], serialKey: null, plateKey: null, plate: null }];
  const { decisions, totals } = buildImportPlan(rows, existing);
  assert.equal(decisions[0].action, "JA_EXISTENTE");
  assert.ok(!("insert" in decisions[0]));
  assert.equal(totals.NOVO, 0);
});

test("carreta/reboque sem motor não recebe plano de troca de óleo (fica NAO_APLICAVEL)", () => {
  const existing = { equipmentByPrefixKey: new Map(), allChassisSerialKeys: new Map(), allPlateKeys: new Map(), categoryStats: new Map() };
  const row = { prefixKey: "JL99", prefixRaw: "JL-99", category: "JL", description: "CARRETA / REBOQUE / FACCHINI", alerts: [], serialKey: "ABC123456", serialRaw: "ABC123456", plateKey: null, plate: null };
  const { decisions } = buildImportPlan([row], existing);
  assert.equal(decisions[0].insert.oilChangeEnabled, false);
  assert.equal(decisions[0].insert.planStatus, "NAO_APLICAVEL");
});

test("equipamento novo sem template de categoria fica PENDENTE_CONFIGURACAO, sem inventar intervalo", () => {
  const existing = { equipmentByPrefixKey: new Map(), allChassisSerialKeys: new Map(), allPlateKeys: new Map(), categoryStats: new Map() };
  const row = { prefixKey: "ZZ01", prefixRaw: "ZZ-01", category: "ZZ", description: "EQUIPAMENTO NUNCA VISTO ANTES", alerts: [], serialKey: "XYZ987654", serialRaw: "XYZ987654", plateKey: null, plate: null };
  const decision = resolvePlanTemplate(row, existing.categoryStats);
  assert.equal(decision.status, "PENDENTE_CONFIGURACAO");
});

test("equipamento novo com template de categoria reaproveita o template (não inventa intervalo novo)", () => {
  const categoryStats = new Map([
    ["PC", { typeCounts: new Map([["Pá Carregadeira", 30]]), oilEnabledCounts: { true: 30, false: 0 }, identificationTypeCounts: { SERIAL_NUMBER: 30, CHASSIS: 0 }, hasTemplate: true, templateMaintenanceTypeNames: ["Óleo do motor", "Óleo hidráulico"] }],
  ]);
  const row = { prefixKey: "PC99", prefixRaw: "PC-99", category: "PC", description: "PA CARREGADEIRA CATERPILLAR 938K", alerts: [], serialKey: "NEWSERIAL123", serialRaw: "NEWSERIAL123", plateKey: null, plate: null };
  const defaults = inferEquipmentDefaults(row, categoryStats);
  assert.equal(defaults.type, "Pá Carregadeira");
  assert.equal(defaults.oilChangeEnabled, true);
  assert.equal(defaults.identificationType, "SERIAL_NUMBER");
  const plan = resolvePlanTemplate(row, categoryStats);
  assert.equal(plan.status, "TEMPLATE_CATEGORIA");
  assert.deepEqual(plan.maintenanceTypeNames, ["Óleo do motor", "Óleo hidráulico"]);
});

test("prefixo válido conforme padrão LETRAS-NUMERO reconhece corretamente o canônico", () => {
  assert.equal(canonicalPrefix("hl-01-ord0j56"), "HL-01-ORD0J56");
});
