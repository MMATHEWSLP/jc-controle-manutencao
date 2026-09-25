import { readFileSync } from "node:fs";
import { prefixKey } from "../import-equipamentos/normalize.mjs";

// ---------------------------------------------------------------------------
// Lógica pura (sem banco) da importação de trocas de óleo a partir da
// planilha "Manutenção Consolidado" (aba Histórico_Detalhado). Fica separada
// do script da raiz para poder ser testada sem Postgres.
// ---------------------------------------------------------------------------

function stripAccents(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Mesma normalização de lib/maintenance-history.ts (canonicalMaintenanceService)
// — o motor de recálculo usa exatamente esta chave para ligar o histórico ao plano.
function normalizedText(value) {
  return stripAccents(value).toUpperCase().replace(/[_–—-]+/g, " ").replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function canonicalService(value) {
  const normalized = normalizedText(value)
    .replace(/^TROCA DE OLEO (DO|DA|DOS|DAS|DE) /, "")
    .replace(/^TROCA DO OLEO (DO|DA|DOS|DAS|DE) /, "")
    .replace(/^TROCA (DO|DA|DOS|DAS|DE) /, "")
    .replace(/^OLEO (DO|DA|DOS|DAS|DE) /, "")
    .trim();
  if (normalized.includes("DIFERENCIAL") && normalized.includes("DIANTEIR")) return "DIFERENCIAL DIANTEIRO";
  if (normalized.includes("DIFERENCIAL") && normalized.includes("TRASEIR")) return "DIFERENCIAL TRASEIRO";
  if (normalized.includes("COMANDO") && normalized.includes("FINAL")) return "COMANDO FINAL";
  if ((normalized.includes("CAIXA") && normalized.includes("REDU")) || normalized === "REDUTOR") return "CAIXA DE REDUCAO";
  if ((normalized.includes("CAIXA") && normalized.includes("MARCH")) || normalized.includes("CAMBIO")) return "CAIXA DE MARCHA";
  if (normalized.includes("TRANSMISSAO")) return "TRANSMISSAO";
  if (normalized.includes("HIDRAUL")) return "HIDRAULICO";
  if (normalized.includes("MOTOR")) return "MOTOR";
  return normalized;
}

// "27/04/2026" -> "2026-04-27" (rejeita datas inexistentes como 31/02).
export function parseBrDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, d, m, y] = match;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseReading(value) {
  const raw = String(value ?? "").trim().replace(/\s+/g, "");
  if (!raw) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw) ? raw.replaceAll(".", "").replace(",", ".") : raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseSourceRows(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines.shift()?.split("\t").map((cell) => normalizedText(cell)) ?? [];
  const col = (name) => header.indexOf(name);
  const idx = { prefix: col("VEICULO"), front: col("FILIAL"), date: col("DATA MANUTENCAO"), service: col("TIPO DE MANUTENCAO"), workOrder: col("O S"), reading: col("MEDIDOR"), status: col("STATUS"), notes: col("OBSERVACOES") };
  for (const [key, value] of Object.entries(idx)) if (value < 0) throw new Error(`Coluna obrigatória ausente na planilha: ${key}`);
  return lines.map((line, index) => {
    const cells = line.split("\t");
    const cell = (key) => String(cells[idx[key]] ?? "").trim();
    return {
      rowNumber: index + 2,
      prefix: cell("prefix"),
      front: cell("front"),
      dateRaw: cell("date"),
      date: parseBrDate(cell("date")),
      service: cell("service"),
      canonicalService: canonicalService(cell("service")),
      workOrder: cell("workOrder"),
      readingRaw: cell("reading"),
      reading: parseReading(cell("reading")),
      status: normalizedText(cell("status")),
      notes: cell("notes"),
    };
  });
}

export function readSourceFile(file) {
  return parseSourceRows(readFileSync(file, "utf8"));
}

// Unidade do histórico: segue o control_type do equipamento; nos mistos
// (HOURS_KM) caminhões "CM-" são por KM e o resto por horímetro — mesma regra
// de reconcileEquipmentMeasurement em lib/maintenance-history.ts.
export function unitFor(equipment) {
  if (equipment.control_type === "KM") return "KM";
  if (equipment.control_type === "HOURS") return "HOURS";
  return prefixKey(equipment.prefix).startsWith("CM") ? "KM" : "HOURS";
}

export function importKeyFor(source, equipmentPrefix, row) {
  return `${source}:${prefixKey(equipmentPrefix)}:${row.canonicalService}:${row.date}:${row.reading}`;
}

function buildNotes(row, sourceLabel) {
  const parts = [`Importado da planilha ${sourceLabel}`];
  if (row.front) parts.push(`Filial: ${row.front}`);
  if (row.workOrder) parts.push(`O.S.: ${row.workOrder}`);
  if (row.notes) parts.push(`Obs.: ${row.notes}`);
  return parts.join(" · ");
}

/**
 * Decide, linha a linha, o que fazer. Nada aqui grava no banco.
 *
 * existing.equipment: [{id,prefix,control_type,oil_change_enabled,current_hours,current_km}]
 * existing.oilTypes: [{id,name,description}]  (maintenance_types ativos com category='OIL')
 * existing.applicable: [{equipment_id,maintenance_type_id}]
 * existing.imported: [{equipment_id,prefix,service,performed_at,reading_value,import_key}]
 * existing.maintenances: [{equipment_id,maintenance_type_id,performed_at,hours,km}]
 */
export function buildImportPlan(rows, existing, { source, sourceLabel }) {
  const equipmentByKey = new Map(existing.equipment.map((item) => [prefixKey(item.prefix), item]));
  const typeIdsByService = new Map();
  for (const type of existing.oilTypes) {
    for (const text of [type.name, type.description]) {
      if (!text) continue;
      const key = canonicalService(text);
      const set = typeIdsByService.get(key) ?? new Set();
      set.add(Number(type.id));
      typeIdsByService.set(key, set);
    }
  }
  const applicable = new Set(existing.applicable.map((row) => `${row.equipment_id}:${row.maintenance_type_id}`));
  const importKeys = new Set(existing.imported.map((row) => row.import_key).filter(Boolean));
  const dayOf = (value) => (value ? String(value).slice(0, 10) : null);
  const importedFingerprints = new Set(existing.imported.map((row) => {
    const equipment = row.equipment_id ? existing.equipment.find((item) => item.id === row.equipment_id) : equipmentByKey.get(prefixKey(row.prefix));
    return `${equipment ? equipment.id : prefixKey(row.prefix)}:${canonicalService(row.service)}:${dayOf(row.performed_at)}`;
  }));
  const typeById = new Map(existing.oilTypes.map((type) => [Number(type.id), type]));
  const maintenanceFingerprints = new Set(existing.maintenances.map((row) => {
    const type = typeById.get(Number(row.maintenance_type_id));
    return `${row.equipment_id}:${type ? canonicalService(type.name) : `T${row.maintenance_type_id}`}:${dayOf(row.performed_at)}`;
  }));

  const seenInFile = new Set();
  const decisions = [];
  for (const row of rows) {
    const decision = { row, action: "IMPORTAR", reason: null, warnings: [] };
    decisions.push(decision);
    const equipment = equipmentByKey.get(prefixKey(row.prefix));
    if (row.status && row.status !== "REALIZADA") { decision.action = "IGNORADO"; decision.reason = `status "${row.status}" (só entram trocas REALIZADAS)`; continue; }
    if (!equipment) { decision.action = "EQUIPAMENTO_NAO_ENCONTRADO"; decision.reason = `prefixo ${row.prefix} não está cadastrado`; continue; }
    if (!row.date) { decision.action = "ERRO"; decision.reason = `data inválida "${row.dateRaw}"`; continue; }
    if (row.reading === null) { decision.action = "ERRO"; decision.reason = `medidor inválido "${row.readingRaw}"`; continue; }
    if (!row.canonicalService) { decision.action = "ERRO"; decision.reason = "tipo de manutenção vazio"; continue; }
    decision.equipment = equipment;
    decision.unit = unitFor(equipment);

    const fingerprint = `${equipment.id}:${row.canonicalService}:${row.date}`;
    if (seenInFile.has(fingerprint)) { decision.action = "DUPLICADO_NA_PLANILHA"; decision.reason = "mesmo equipamento, serviço e data já aparecem numa linha anterior"; continue; }
    seenInFile.add(fingerprint);
    const importKey = importKeyFor(source, equipment.prefix, row);
    if (importKeys.has(importKey) || importedFingerprints.has(fingerprint)) { decision.action = "JA_EXISTE"; decision.reason = "já está no Histórico (importação anterior)"; continue; }
    if (maintenanceFingerprints.has(fingerprint)) { decision.action = "JA_EXISTE"; decision.reason = "já foi lançada no sistema como troca de óleo nesta data"; continue; }

    const candidates = [...(typeIdsByService.get(row.canonicalService) ?? [])];
    const applicableCandidates = candidates.filter((id) => applicable.has(`${equipment.id}:${id}`));
    const typeId = applicableCandidates.length === 1 ? applicableCandidates[0] : candidates.length === 1 ? candidates[0] : null;
    if (typeId === null) decision.warnings.push(`serviço "${row.service}" não corresponde a um único tipo de óleo cadastrado — entra no Histórico, mas não atualiza plano`);
    else if (!applicable.has(`${equipment.id}:${typeId}`)) decision.warnings.push(`"${row.service}" não está marcado como aplicável ao ${equipment.prefix} — entra no Histórico, mas não atualiza plano`);
    if (!equipment.oil_change_enabled) decision.warnings.push(`${equipment.prefix} está com troca de óleo desabilitada no cadastro`);
    if (row.reading <= 1) decision.warnings.push(`medidor ${row.readingRaw} parece placeholder — conferir`);

    decision.insert = {
      equipmentId: equipment.id,
      maintenanceTypeId: typeId,
      prefix: equipment.prefix,
      service: row.service,
      readingRaw: row.readingRaw,
      readingValue: row.reading,
      controlType: decision.unit,
      performedAt: row.date,
      source,
      importType: "TROCA_DE_OLEO",
      importKey,
      notes: buildNotes(row, sourceLabel),
    };
  }

  // Leitura mais recente de cada equipamento (para avançar horímetro/odômetro
  // atual quando a planilha trouxer um valor maior que o cadastrado).
  const meterUpdates = new Map();
  for (const decision of decisions) {
    if (decision.action !== "IMPORTAR") continue;
    const { equipment, unit, row } = decision;
    const current = unit === "KM" ? Number(equipment.current_km) : Number(equipment.current_hours);
    const previous = meterUpdates.get(equipment.id);
    const newer = !previous || row.date > previous.date || (row.date === previous.date && row.reading > previous.reading);
    if (newer) meterUpdates.set(equipment.id, { equipment, unit, date: row.date, reading: row.reading, current });
  }
  const meters = [...meterUpdates.values()].filter((item) => item.reading > item.current);

  const totals = {};
  for (const decision of decisions) totals[decision.action] = (totals[decision.action] ?? 0) + 1;
  return { decisions, meters, totals };
}
