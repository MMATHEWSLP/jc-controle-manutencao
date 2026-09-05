// Script de diagnóstico (somente leitura) para investigar por que alguns
// históricos de troca de óleo — com ou sem data — não alimentam o Plano de
// Manutenção mesmo aparecendo corretamente na aba Histórico.
//
// Não altera nenhum dado. Reproduz, em JS puro, a mesma normalização usada
// por lib/maintenance-history.ts (canonicalEquipmentPrefix/canonicalMaintenanceService)
// e a mesma lógica de associação de lib/maintenance-recalculation.ts, para
// mostrar exatamente em qual etapa cada registro problemático é descartado.
//
// Uso: DATABASE_URL=... node diagnosticar-historico-oleo.mjs
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function stripAccents(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function canonicalEquipmentPrefix(value) {
  return stripAccents(value).toUpperCase().trim().replace(/[–—_]+/g, "-").replace(/\s+/g, "").replace(/-+/g, "-");
}

function normalizedText(value) {
  return stripAccents(value).toUpperCase().replace(/[_–—-]+/g, " ").replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalMaintenanceService(value) {
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

function equipmentCategory(prefix) {
  return canonicalEquipmentPrefix(prefix).split("-")[0];
}

function isValidDate(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  const parsed = new Date(raw.length === 10 ? `${raw}T12:00:00Z` : raw);
  return !Number.isNaN(parsed.getTime());
}

function linha() {
  console.log("-".repeat(78));
}

async function main() {
  const [equipmentRows, typeRows, configRows, applicableRows, importedRows] = await Promise.all([
    pool.query(`SELECT id, prefix, type, control_type FROM equipment`),
    pool.query(`SELECT id, name, category, description, active FROM maintenance_types WHERE category = 'OIL'`),
    pool.query(`SELECT id, category, maintenance_type_id, unit, interval_value, active FROM maintenance_interval_configs WHERE active = true`),
    pool.query(`SELECT equipment_id, maintenance_type_id FROM equipment_maintenance_types WHERE applicable = true`),
    pool.query(`SELECT id, equipment_id, maintenance_type_id, prefix, service, reading_raw, reading_value, control_type, performed_at, source, import_type FROM imported_maintenance_history`),
  ]);

  const equipmentByPrefix = new Map(equipmentRows.rows.map((row) => [canonicalEquipmentPrefix(row.prefix), row]));
  const equipmentById = new Map(equipmentRows.rows.map((row) => [row.id, row]));
  const configByType = new Map(configRows.rows.map((row) => [`${row.category}:${row.maintenance_type_id}`, row]));
  const configByService = new Map();
  for (const config of configRows.rows) {
    const type = typeRows.rows.find((t) => t.id === config.maintenance_type_id);
    if (!type) continue;
    configByService.set(`${config.category}:${canonicalMaintenanceService(type.name)}`, config);
    if (type.description) configByService.set(`${config.category}:${canonicalMaintenanceService(type.description)}`, config);
  }
  const applicableKeys = new Set(applicableRows.rows.map((row) => `${row.equipment_id}:${row.maintenance_type_id}`));

  console.log("=== Diagnóstico — Histórico de Troca de Óleo ===");
  linha();
  console.log(`Equipamentos cadastrados: ${equipmentRows.rows.length}`);
  console.log(`Tipos de manutenção OIL ativos: ${typeRows.rows.filter((t) => t.active).length} (total OIL incl. inativos: ${typeRows.rows.length})`);
  console.log(`Configurações de intervalo ativas (maintenance_interval_configs): ${configRows.rows.length}`);
  console.log(`Vínculos equipamento×tipo aplicáveis (equipment_maintenance_types): ${applicableRows.rows.length}`);
  console.log(`Registros em imported_maintenance_history: ${importedRows.rows.length}`);
  linha();

  // 1) Datas ausentes/inválidas
  const withoutValidDate = importedRows.rows.filter((row) => !isValidDate(row.performed_at));
  const withoutValidDateAndReading = withoutValidDate.filter((row) => row.reading_value !== null);
  const withoutValidDateNoReading = withoutValidDate.filter((row) => row.reading_value === null);
  console.log(`[PARTE 1] Registros SEM data válida: ${withoutValidDate.length}`);
  console.log(`  - com leitura (elegíveis para a data genérica 2026-07-05): ${withoutValidDateAndReading.length}`);
  console.log(`  - sem leitura também (ambíguos, não tocar): ${withoutValidDateNoReading.length}`);
  if (withoutValidDateAndReading.length > 0) {
    console.log("  Amostra (até 10):");
    for (const row of withoutValidDateAndReading.slice(0, 10)) {
      console.log(`    #${row.id} prefix=${row.prefix} service="${row.service}" reading=${row.reading_value} source=${row.source} import_type=${row.import_type ?? "—"}`);
    }
  }
  linha();

  // 2) Entre os registros COM data válida e leitura, quantos hoje têm
  //    equipment_id/maintenance_type_id resolvidos, e quantos falham em cada etapa.
  const withDateAndReading = importedRows.rows.filter((row) => isValidDate(row.performed_at) && row.reading_value !== null);
  console.log(`[PARTE 2] Registros COM data válida e leitura: ${withDateAndReading.length}`);
  let resolvedBoth = 0, missingEquipment = 0, missingType = 0, noConfigForType = 0, notApplicable = 0, incompatibleUnit = 0, fullyUsable = 0;
  const samples = { missingEquipment: [], missingType: [], noConfigForType: [], notApplicable: [], incompatibleUnit: [] };
  for (const row of withDateAndReading) {
    const equipment = row.equipment_id ? equipmentById.get(row.equipment_id) : equipmentByPrefix.get(canonicalEquipmentPrefix(row.prefix));
    if (!equipment) { missingEquipment++; if (samples.missingEquipment.length < 8) samples.missingEquipment.push(row); continue; }
    let maintenanceTypeId = row.maintenance_type_id;
    if (!maintenanceTypeId) {
      const cat = equipmentCategory(equipment.prefix);
      const bySvc = configByService.get(`${cat}:${canonicalMaintenanceService(row.service)}`);
      maintenanceTypeId = bySvc?.maintenance_type_id ?? null;
      if (!maintenanceTypeId) { missingType++; if (samples.missingType.length < 8) samples.missingType.push({ ...row, canonicalService: canonicalMaintenanceService(row.service), category: cat }); continue; }
    }
    resolvedBoth++;
    const cat = equipmentCategory(equipment.prefix);
    const config = configByType.get(`${cat}:${maintenanceTypeId}`);
    if (!config) { noConfigForType++; if (samples.noConfigForType.length < 8) samples.noConfigForType.push({ ...row, category: cat, resolvedTypeId: maintenanceTypeId }); continue; }
    if (config.unit !== row.control_type) { incompatibleUnit++; if (samples.incompatibleUnit.length < 8) samples.incompatibleUnit.push({ ...row, configUnit: config.unit }); continue; }
    if (!applicableKeys.has(`${equipment.id}:${maintenanceTypeId}`)) { notApplicable++; if (samples.notApplicable.length < 8) samples.notApplicable.push({ ...row, equipmentId: equipment.id, resolvedTypeId: maintenanceTypeId }); continue; }
    fullyUsable++;
  }
  console.log(`  - equipamento não encontrado (prefixo/ID órfão): ${missingEquipment}`);
  console.log(`  - tipo de manutenção não resolvido (serviço não reconhecido): ${missingType}`);
  console.log(`  - sem interval_config ativa para categoria+tipo: ${noConfigForType}`);
  console.log(`  - unidade incompatível com a config (h vs km): ${incompatibleUnit}`);
  console.log(`  - tipo não está marcado "aplicável" para o equipamento: ${notApplicable}`);
  console.log(`  - TOTALMENTE UTILIZÁVEIS pelo cálculo hoje: ${fullyUsable}`);
  for (const [key, list] of Object.entries(samples)) {
    if (list.length === 0) continue;
    console.log(`  Amostra "${key}" (até 8):`);
    for (const row of list) console.log(`    #${row.id} prefix=${row.prefix} service="${row.service}" performed_at=${row.performed_at} ${JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !["id","prefix","service","performed_at","reading_raw"].includes(k))))}`);
  }
  linha();

  // 3) Categorias de maintenance_types com nomes muito parecidos (possível duplicidade)
  const byNormalizedName = new Map();
  for (const type of typeRows.rows) {
    const key = canonicalMaintenanceService(type.name);
    const list = byNormalizedName.get(key) ?? [];
    list.push(type);
    byNormalizedName.set(key, list);
  }
  const duplicateNameGroups = [...byNormalizedName.entries()].filter(([, list]) => list.length > 1);
  console.log(`[VERIFICAÇÃO] Grupos de maintenance_types OIL com nome normalizado repetido: ${duplicateNameGroups.length}`);
  for (const [key, list] of duplicateNameGroups) console.log(`  "${key}": ${list.map((t) => `#${t.id} "${t.name}" (ativo=${t.active})`).join(", ")}`);
  linha();

  // 4) Prefixos de importação que não batem com nenhum equipamento cadastrado
  const orphanPrefixes = new Map();
  for (const row of importedRows.rows) {
    if (row.equipment_id) continue;
    const key = canonicalEquipmentPrefix(row.prefix);
    if (equipmentByPrefix.has(key)) continue;
    orphanPrefixes.set(key, (orphanPrefixes.get(key) ?? 0) + 1);
  }
  console.log(`[VERIFICAÇÃO] Prefixos importados sem equipamento correspondente: ${orphanPrefixes.size}`);
  for (const [prefix, count] of [...orphanPrefixes.entries()].slice(0, 20)) console.log(`  ${prefix}: ${count} registro(s)`);
  linha();

  // 5) Formatação numérica: reading_raw preenchido mas reading_value nulo
  const numericFormatIssues = importedRows.rows.filter((row) => row.reading_value === null && String(row.reading_raw ?? "").trim() !== "");
  console.log(`[VERIFICAÇÃO] Registros com reading_raw preenchido mas reading_value NULO (possível problema de formatação numérica): ${numericFormatIssues.length}`);
  for (const row of numericFormatIssues.slice(0, 15)) console.log(`  #${row.id} prefix=${row.prefix} reading_raw="${row.reading_raw}"`);
  linha();

  console.log("Diagnóstico concluído. Nenhum dado foi alterado.");
  await pool.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
