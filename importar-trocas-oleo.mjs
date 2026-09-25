import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import pg from "pg";
import { buildImportPlan, readSourceFile } from "./scripts/import-trocas-oleo/plan.mjs";

// ---------------------------------------------------------------------------
// Importa trocas de óleo já realizadas (planilha "Manutenção Consolidado",
// aba Histórico_Detalhado) para o Histórico do sistema, sem duplicar.
// Mesmo padrão de importar-equipamentos.mjs: conecta direto no Postgres via
// DATABASE_URL, roda em simulação por padrão e só grava com --confirmar.
//
// Cada linha vira um registro em imported_maintenance_history (o mesmo lugar
// das importações históricas anteriores); depois o motor de recálculo do
// sistema atualiza "última troca" / "próxima troca" dos planos de óleo.
//
// Uso:
//   node importar-trocas-oleo.mjs                 -> dry-run (nada é gravado)
//   node importar-trocas-oleo.mjs --confirmar     -> grava de verdade
//   node importar-trocas-oleo.mjs --arquivo=caminho.tsv --origem=PLANILHA_X --rotulo="X"
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const ARQUIVO = arg("arquivo") ?? new URL("./scripts/import-trocas-oleo/data/flexal-2026-09-25.tsv", import.meta.url);
const SOURCE = arg("origem") ?? "PLANILHA_FLEXAL_2026_09_25";
const SOURCE_LABEL = arg("rotulo") ?? "Manutenção Consolidado Flexal (25/09/2026)";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no ambiente.");
  process.exit(1);
}

function linha() {
  console.log("-".repeat(78));
}

async function loadExisting(pool) {
  const [equipment, oilTypes, applicable, imported, maintenances] = await Promise.all([
    pool.query(`SELECT id,prefix,control_type,oil_change_enabled,current_hours,current_km FROM equipment`),
    pool.query(`SELECT id,name,description FROM maintenance_types WHERE category='OIL' AND active=true`),
    pool.query(`SELECT equipment_id,maintenance_type_id FROM equipment_maintenance_types WHERE applicable=true`),
    pool.query(`SELECT equipment_id,prefix,service,performed_at,reading_value,import_key FROM imported_maintenance_history`),
    pool.query(`SELECT equipment_id,maintenance_type_id,performed_at,hours,km FROM maintenances`),
  ]);
  return {
    equipment: equipment.rows.map((row) => ({ ...row, id: Number(row.id), current_hours: Number(row.current_hours), current_km: Number(row.current_km) })),
    oilTypes: oilTypes.rows,
    applicable: applicable.rows.map((row) => ({ equipment_id: Number(row.equipment_id), maintenance_type_id: Number(row.maintenance_type_id) })),
    imported: imported.rows.map((row) => ({ ...row, equipment_id: row.equipment_id === null ? null : Number(row.equipment_id) })),
    maintenances: maintenances.rows.map((row) => ({ ...row, equipment_id: Number(row.equipment_id) })),
  };
}

// Mesma técnica de importar-equipamentos.mjs: empacota o motor de recálculo
// (TypeScript) num .mjs temporário dentro do projeto e o importa.
async function loadRecalculationEngine() {
  const entry = new URL("./scripts/import-equipamentos/recalc-entry.ts", import.meta.url).pathname;
  const projectRoot = path.dirname(new URL(import.meta.url).pathname);
  const outDir = mkdtempSync(path.join(projectRoot, ".import-trocas-oleo-tmp-"));
  const outfile = path.join(outDir, `recalc-entry-${randomUUID()}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile });
  const engine = await import(outfile);
  return { ...engine, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

function printReport(plan, rowCount) {
  const { decisions, meters, totals } = plan;
  linha();
  console.log(CONFIRMAR ? "IMPORTAÇÃO REAL — RESUMO" : "SIMULAÇÃO (dry-run) — nada será gravado");
  linha();
  console.log(`  Arquivo: ${ARQUIVO instanceof URL ? path.relative(process.cwd(), ARQUIVO.pathname) : ARQUIVO}`);
  console.log(`  Origem gravada: ${SOURCE}`);
  console.log(`  Linhas lidas:                     ${rowCount}`);
  console.log(`  Novas trocas a importar:          ${totals.IMPORTAR ?? 0}`);
  console.log(`  Já existentes (ignoradas):        ${totals.JA_EXISTE ?? 0}`);
  console.log(`  Duplicadas na própria planilha:   ${totals.DUPLICADO_NA_PLANILHA ?? 0}`);
  console.log(`  Equipamento não cadastrado:       ${totals.EQUIPAMENTO_NAO_ENCONTRADO ?? 0}`);
  console.log(`  Ignoradas (status):               ${totals.IGNORADO ?? 0}`);
  console.log(`  Com erro de dado:                 ${totals.ERRO ?? 0}`);
  console.log(`  Horímetros/odômetros a avançar:   ${meters.length}`);

  const byAction = (action) => decisions.filter((decision) => decision.action === action);
  const importar = byAction("IMPORTAR");
  if (importar.length) {
    linha();
    console.log(`TROCAS A IMPORTAR (${importar.length})`);
    for (const { row, unit } of importar) {
      console.log(`  linha ${String(row.rowNumber).padStart(3)}  ${row.prefix.padEnd(8)} ${row.date}  ${row.service.padEnd(24)} ${String(row.reading).padStart(8)} ${unit === "KM" ? "km" : "h"}`);
    }
  }
  for (const action of ["JA_EXISTE", "DUPLICADO_NA_PLANILHA", "EQUIPAMENTO_NAO_ENCONTRADO", "IGNORADO", "ERRO"]) {
    const list = byAction(action);
    if (!list.length) continue;
    linha();
    console.log(`${action} (${list.length})`);
    for (const { row, reason } of list) console.log(`  linha ${String(row.rowNumber).padStart(3)}  ${row.prefix.padEnd(8)} ${row.dateRaw}  ${row.service} — ${reason}`);
  }
  const warned = decisions.filter((decision) => decision.warnings.length);
  if (warned.length) {
    linha();
    console.log(`ALERTAS — conferir manualmente (${warned.length})`);
    for (const { row, warnings } of warned) for (const warning of warnings) console.log(`  linha ${String(row.rowNumber).padStart(3)}  ${row.prefix.padEnd(8)} ${warning}`);
  }
  if (meters.length) {
    linha();
    console.log(`LEITURA ATUAL A AVANÇAR (${meters.length}) — só quando a planilha traz valor maior que o cadastro`);
    for (const item of meters) console.log(`  ${item.equipment.prefix.padEnd(8)} ${item.current} -> ${item.reading} ${item.unit === "KM" ? "km" : "h"} (${item.date})`);
  }
  linha();
}

async function gravar(client, plan) {
  const now = new Date().toISOString();
  const importar = plan.decisions.filter((decision) => decision.action === "IMPORTAR");
  let inserted = 0;
  await client.query("BEGIN");
  try {
    for (const { insert } of importar) {
      const result = await client.query(
        `INSERT INTO imported_maintenance_history
          (equipment_id,maintenance_type_id,prefix,service,reading_raw,reading_value,control_type,performed_at,is_generic_date,date_source,source,import_type,import_key,notes,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,'ORIGINAL',$9,$10,$11,$12,$13,$13)
         ON CONFLICT DO NOTHING`,
        [insert.equipmentId, insert.maintenanceTypeId, insert.prefix, insert.service, insert.readingRaw, insert.readingValue, insert.controlType,
          insert.performedAt, insert.source, insert.importType, insert.importKey, insert.notes, now],
      );
      inserted += result.rowCount;
    }
    for (const item of plan.meters) {
      const column = item.unit === "KM" ? "current_km" : "current_hours";
      await client.query(`UPDATE equipment SET ${column}=$1,updated_at=$2 WHERE id=$3 AND ${column}<$1`, [item.reading, now, item.equipment.id]);
      await client.query(
        `INSERT INTO meter_readings (equipment_id,reading_date,hours,km,operator,notes,source,authorized_regression,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'EXCEL_IMPORT',false,$7,$7)`,
        [item.equipment.id, item.date, item.unit === "HOURS" ? item.reading : null, item.unit === "KM" ? item.reading : null,
          "Importação de trocas de óleo", `Leitura da troca de óleo importada — ${SOURCE_LABEL}`, now],
      );
    }
    await client.query(
      `INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (NULL,'IMPORTED_MAINTENANCE_HISTORY',$1,'IMPORTAÇÃO DE TROCAS DE ÓLEO',NULL,$2,$3)`,
      [SOURCE, JSON.stringify({ arquivo: String(ARQUIVO), inseridos: inserted, leiturasAvancadas: plan.meters.length }), now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return inserted;
}

async function main() {
  const rows = readSourceFile(ARQUIVO);
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    const client = await pool.connect();
    let plan;
    try {
      plan = buildImportPlan(rows, await loadExisting(pool), { source: SOURCE, sourceLabel: SOURCE_LABEL });
      printReport(plan, rows.length);
      if (!CONFIRMAR) {
        console.log("Nada foi alterado. Para gravar de verdade: node importar-trocas-oleo.mjs --confirmar");
        return;
      }
      const inserted = await gravar(client, plan);
      console.log(`Gravado: ${inserted} troca(s) no Histórico, ${plan.meters.length} leitura(s) atual(is) avançada(s).`);
    } finally {
      client.release();
    }

    if (!plan.decisions.some((decision) => decision.action === "IMPORTAR")) return;
    linha();
    console.log("Recalculando planos de óleo da frota (notificações de WhatsApp desligadas)...");
    const { getD1, recalculateMaintenanceCycles, cleanup } = await loadRecalculationEngine();
    try {
      const result = await recalculateMaintenanceCycles(await getD1(), { force: true, notify: false });
      console.log(`${result.plans} plano(s) calculado(s), ${result.withHistory ?? 0} com histórico.`);
    } finally {
      cleanup();
    }
    console.log("Planos recalculados.");
    linha();
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
