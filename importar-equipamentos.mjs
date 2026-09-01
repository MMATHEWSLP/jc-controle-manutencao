import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import pg from "pg";
import { prefixCategory, rawKey } from "./scripts/import-equipamentos/normalize.mjs";
import { findInternalDuplicates, findSubstringSerialConflicts, parseFleetSource } from "./scripts/import-equipamentos/parse.mjs";
import { buildImportPlan } from "./scripts/import-equipamentos/plan.mjs";

// ---------------------------------------------------------------------------
// Importação idempotente e sem duplicação da frota (equipamentos), a partir
// da planilha em scripts/import-equipamentos/data/. Segue o mesmo padrão dos
// outros scripts da raiz do projeto (diagnostico-db.mjs, importar-base.mjs):
// conecta direto no Postgres via DATABASE_URL, roda em modo simulação por
// padrão, e só grava de verdade com --confirmar.
//
// Uso:
//   node importar-equipamentos.mjs                -> dry-run (nada é gravado)
//   node importar-equipamentos.mjs --confirmar     -> aplica a importação real
//   node importar-equipamentos.mjs --recalcular    -> só recalcula os planos
//                                                      de manutenção de toda a
//                                                      frota (retomar depois de
//                                                      um cadastro que já
//                                                      terminou, mas cujo
//                                                      cálculo de plano falhou)
//   node importar-equipamentos.mjs --arquivo=caminho/para/arquivo.tsv
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const RECALCULAR = process.argv.includes("--recalcular");
const arquivoArg = process.argv.find((arg) => arg.startsWith("--arquivo="));
const ARQUIVO = arquivoArg
  ? arquivoArg.slice("--arquivo=".length)
  : new URL("./scripts/import-equipamentos/data/frota-fonte-2026-09.tsv", import.meta.url);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no ambiente.");
  process.exit(1);
}

function linha() {
  console.log("-".repeat(78));
}

async function loadExisting(pool) {
  const { rows: equipmentRows } = await pool.query(
    `SELECT id, code, prefix, type, chassis, serial_number, plate, oil_change_enabled, identification_type FROM equipment`,
  );

  const equipmentByPrefixKey = new Map();
  const allChassisSerialKeys = new Map();
  const allPlateKeys = new Map();
  const categoryStats = new Map();

  const ensureCategory = (category) => {
    if (!categoryStats.has(category)) {
      categoryStats.set(category, {
        typeCounts: new Map(),
        oilEnabledCounts: { true: 0, false: 0 },
        identificationTypeCounts: { CHASSIS: 0, SERIAL_NUMBER: 0 },
        hasTemplate: false,
        templateMaintenanceTypeNames: [],
      });
    }
    return categoryStats.get(category);
  };

  for (const row of equipmentRows) {
    const prefixKeyValue = rawKey(row.prefix);
    if (prefixKeyValue) equipmentByPrefixKey.set(prefixKeyValue, { id: row.id, prefix: row.prefix });

    const chassisKey = rawKey(row.chassis);
    if (chassisKey) allChassisSerialKeys.set(chassisKey, { id: row.id, prefix: row.prefix, field: "chassis" });
    const serialKeyValue = rawKey(row.serial_number);
    if (serialKeyValue) allChassisSerialKeys.set(serialKeyValue, { id: row.id, prefix: row.prefix, field: "serial_number" });

    const plateKeyValue = rawKey(row.plate);
    if (plateKeyValue) allPlateKeys.set(plateKeyValue, { id: row.id, prefix: row.prefix });

    const category = prefixCategory(row.prefix);
    if (category) {
      const stats = ensureCategory(category);
      stats.typeCounts.set(row.type, (stats.typeCounts.get(row.type) ?? 0) + 1);
      stats.oilEnabledCounts[row.oil_change_enabled ? "true" : "false"] += 1;
      if (row.identification_type === "CHASSIS" || row.identification_type === "SERIAL_NUMBER") {
        stats.identificationTypeCounts[row.identification_type] += 1;
      }
    }
  }

  const { rows: templateRows } = await pool.query(
    `SELECT c.category, t.name FROM maintenance_interval_configs c
     INNER JOIN maintenance_types t ON t.id = c.maintenance_type_id
     WHERE c.active = TRUE AND t.active = TRUE
     ORDER BY c.category, t.name`,
  );
  for (const row of templateRows) {
    const stats = ensureCategory(row.category);
    stats.hasTemplate = true;
    stats.templateMaintenanceTypeNames.push(row.name);
  }

  return { equipmentByPrefixKey, allChassisSerialKeys, allPlateKeys, categoryStats };
}

// Empacota o motor de recálculo (TypeScript) num único arquivo .mjs
// temporário e o importa — mesma técnica usada nos scripts de teste do
// projeto (esbuild --bundle --platform=node --format=esm), evitando
// duplicar a lógica de cálculo de plano de manutenção aqui no importador.
async function loadRecalculationEngine() {
  const entry = new URL("./scripts/import-equipamentos/recalc-entry.ts", import.meta.url).pathname;
  const projectRoot = path.dirname(new URL(import.meta.url).pathname);
  // O bundle precisa ficar DENTRO do projeto (não em /tmp): com
  // packages:"external", o Node resolve "pg" etc. subindo diretórios em
  // busca de node_modules a partir de onde o arquivo importado está — fora
  // do projeto essa busca falha com "Cannot find package 'pg'".
  const outDir = mkdtempSync(path.join(projectRoot, ".import-equipamentos-tmp-"));
  const outfile = path.join(outDir, `recalc-entry-${randomUUID()}.mjs`);
  // packages:"external" faz o esbuild só resolver os arquivos locais do
  // projeto (db/, lib/) e deixar os pacotes do node_modules (pg, drizzle-orm,
  // dotenv...) para o Node resolver em tempo de execução — sem isso, o `pg`
  // quebra com "Dynamic require of events is not supported" quando embutido
  // num bundle ESM.
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile });
  const engine = await import(outfile);
  return { ...engine, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

function printSection(title) {
  linha();
  console.log(title);
  linha();
}

function printPlanSummary(totals, rowCount) {
  printSection(CONFIRMAR ? "IMPORTAÇÃO REAL — RESUMO" : "SIMULAÇÃO (dry-run) — nada será gravado");
  console.log(`  Linhas lidas do arquivo:        ${rowCount}`);
  console.log(`  Total válido/analisado:         ${totals.total}`);
  console.log(`  Já existente (ignorado):        ${totals.JA_EXISTENTE}`);
  console.log(`  Novo equipamento:                ${totals.NOVO}`);
  console.log(`  Conflito (não importado):       ${totals.CONFLITO}`);
  console.log(`  Plano copiado de template:       ${totals.planTemplate}`);
  console.log(`  Plano pendente de configuração:  ${totals.planPendente}`);
}

function printDecisions(decisions) {
  const novos = decisions.filter((decision) => decision.action === "NOVO");
  const existentes = decisions.filter((decision) => decision.action === "JA_EXISTENTE");
  const conflitos = decisions.filter((decision) => decision.action === "CONFLITO");

  if (novos.length) {
    printSection(`EQUIPAMENTOS NOVOS (${novos.length})`);
    for (const decision of novos) {
      console.log(`  ${decision.row.prefixRaw.padEnd(16)} ${decision.row.description}`);
      console.log(`      tipo: ${decision.insert.type} (${decision.insert.typeSource})`);
      console.log(`      faz troca de óleo: ${decision.insert.oilChangeEnabled ? "SIM" : "NÃO"} (${decision.insert.oilSource})`);
      console.log(`      identificação: ${decision.insert.identificationType} (${decision.insert.identificationSource})`);
      console.log(`      plano: ${decision.insert.planStatus}${decision.insert.planMaintenanceTypeNames?.length ? " -> " + decision.insert.planMaintenanceTypeNames.join(", ") : ""}`);
      if (decision.row.alerts.length) console.log(`      alertas: ${decision.row.alerts.join(" | ")}`);
    }
  }

  if (conflitos.length) {
    printSection(`CONFLITOS — NÃO IMPORTADOS AUTOMATICAMENTE (${conflitos.length})`);
    for (const decision of conflitos) {
      console.log(`  ${decision.row.prefixRaw.padEnd(16)} ${decision.row.description} — ${decision.reason}`);
    }
  }

  printSection(`JÁ EXISTENTES — IGNORADOS (${existentes.length})`);
  console.log("  " + existentes.map((decision) => decision.row.prefixRaw).join(", "));

  // Alertas de qualidade de dado da planilha valem para QUALQUER linha —
  // inclusive equipamento já cadastrado, que não aparece na seção "NOVOS".
  const comAlerta = decisions.filter((decision) => decision.row.alerts.length > 0);
  if (comAlerta.length) {
    printSection(`ALERTAS DE QUALIDADE DE DADO NA PLANILHA (${comAlerta.length}) — conferir manualmente`);
    for (const decision of comAlerta) {
      console.log(`  ${decision.row.prefixRaw.padEnd(16)} [${decision.action}] ${decision.row.description}`);
      for (const alert of decision.row.alerts) console.log(`      - ${alert}`);
    }
  }
}

async function recalcularTodaFrota() {
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    linha();
    console.log("Recalculando planos de manutenção de toda a frota (equipamento com plano já em dia não é alterado)...");
    const { getD1, recalculateMaintenanceCycles, cleanup } = await loadRecalculationEngine();
    try {
      const d1 = await getD1();
      const result = await recalculateMaintenanceCycles(d1, { force: true, notify: false });
      linha();
      console.log(`Concluído: ${result.equipment} equipamento(s) com troca de óleo habilitada, ${result.plans} plano(s) ativo(s) calculado(s).`);
      linha();
    } finally {
      cleanup();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  if (RECALCULAR) return recalcularTodaFrota();

  const { rows } = parseFleetSource(ARQUIVO);
  const internalDuplicates = findInternalDuplicates(rows);
  const substringConflicts = findSubstringSerialConflicts(rows);

  const crossRowConflictKeys = new Set();
  for (const [, list] of [...internalDuplicates.prefix, ...internalDuplicates.serial, ...internalDuplicates.plate]) {
    for (const row of list) {
      crossRowConflictKeys.add(row.prefixKey);
      if (row.serialKey) crossRowConflictKeys.add(row.serialKey);
      if (row.plateKey) crossRowConflictKeys.add(row.plateKey);
    }
  }
  for (const [a, b] of substringConflicts) {
    crossRowConflictKeys.add(a.prefixKey);
    crossRowConflictKeys.add(b.prefixKey);
  }

  if (internalDuplicates.prefix.length || internalDuplicates.serial.length || internalDuplicates.plate.length || substringConflicts.length) {
    printSection("DUPLICIDADES/CONFLITOS DENTRO DO PRÓPRIO ARQUIVO DE ORIGEM");
    for (const [key, list] of internalDuplicates.prefix) console.log(`  Prefixo duplicado no arquivo (${key}): ${list.map((r) => r.prefixRaw).join(", ")}`);
    for (const [key, list] of internalDuplicates.serial) console.log(`  Chassi/série duplicado no arquivo (${key}): ${list.map((r) => r.prefixRaw).join(", ")}`);
    for (const [key, list] of internalDuplicates.plate) console.log(`  Placa duplicada no arquivo (${key}): ${list.map((r) => r.prefixRaw).join(", ")}`);
    for (const [a, b] of substringConflicts) console.log(`  Possível mesmo número de série: ${a.prefixRaw} (${a.serialRaw}) e ${b.prefixRaw} (${b.serialRaw}) — bloqueados até conferência`);
  }

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    const existing = await loadExisting(pool);
    const { decisions, totals } = buildImportPlan(rows, existing, crossRowConflictKeys);

    printPlanSummary(totals, rows.length);
    printDecisions(decisions);

    if (!CONFIRMAR) {
      linha();
      console.log("Nada foi gravado. Revise o relatório acima e, se estiver correto, rode:");
      console.log("   node importar-equipamentos.mjs --confirmar");
      linha();
      return;
    }

    const novos = decisions.filter((decision) => decision.action === "NOVO");
    if (!novos.length) {
      linha();
      console.log("Nenhum equipamento novo para importar. Nada foi alterado.");
      linha();
      return;
    }

    linha();
    console.log(`Gravando ${novos.length} equipamento(s) novo(s) em uma única transação...`);
    const client = await pool.connect();
    const insertedIds = [];
    try {
      await client.query("BEGIN");
      for (const decision of novos) {
        const { row, insert } = decision;
        const code = `IMPORT-${row.prefixCanonical}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chassis = insert.identificationType === "CHASSIS" ? (row.serialRaw ?? null) : null;
        const serialNumber = insert.identificationType === "SERIAL_NUMBER" ? (row.serialRaw ?? null) : null;
        const notesParts = [row.plateObservation ? `Observação da placa original: ${row.plateObservation}` : null, insert.notes].filter(Boolean);
        const { rows: insertedRows } = await client.query(
          `INSERT INTO equipment (code, prefix, type, brand, model, year, serial_number, chassis, identification_type, plate, service_front_id, current_hours, current_km, control_type, status, notes, oil_change_enabled, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,0,0,'HOURS','ACTIVE',$11,$12, to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           RETURNING id`,
          [code, row.prefixCanonical, insert.type, "Não informado", row.description, row.year, serialNumber, chassis, insert.identificationType, row.plate, notesParts.join(" | ") || null, insert.oilChangeEnabled],
        );
        const equipmentId = insertedRows[0].id;
        insertedIds.push({ id: equipmentId, prefix: row.prefixCanonical, oilChangeEnabled: insert.oilChangeEnabled, planStatus: insert.planStatus });

        await client.query(
          `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, previous_value, new_value, occurred_at)
           VALUES (NULL, 'EQUIPMENT', $1, 'IMPORTACAO_EM_LOTE', NULL, $2, to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
          [String(equipmentId), JSON.stringify({ prefix: row.prefixCanonical, arquivo: String(ARQUIVO), linha: row.rowNumber })],
        );

        if (insert.oilChangeEnabled && insert.planStatus === "TEMPLATE_CATEGORIA" && insert.planMaintenanceTypeNames.length) {
          const { rows: typeRows } = await client.query(
            `SELECT id, name FROM maintenance_types WHERE active = TRUE AND name = ANY($1::text[])`,
            [insert.planMaintenanceTypeNames],
          );
          for (const typeRow of typeRows) {
            await client.query(
              `INSERT INTO equipment_maintenance_types (equipment_id, maintenance_type_id, applicable, created_at, updated_at)
               VALUES ($1,$2,TRUE, to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               ON CONFLICT (equipment_id, maintenance_type_id) DO UPDATE SET applicable = TRUE, updated_at = EXCLUDED.updated_at`,
              [equipmentId, typeRow.id],
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    console.log(`${insertedIds.length} equipamento(s) gravado(s) com sucesso.`);

    // Fora da transação (a própria função já gerencia sua consistência via
    // d1.batch): dispara o motor de recálculo já existente no sistema para
    // cada equipamento novo com troca de óleo habilitada — ele cria os
    // maintenance_plans a partir do template da categoria, sem inventar
    // horímetro/km/data (não há histórico real para esses equipamentos).
    const toRecalculate = insertedIds.filter((item) => item.oilChangeEnabled);
    if (toRecalculate.length) {
      linha();
      console.log(`Calculando planos de manutenção para ${toRecalculate.length} equipamento(s)...`);
      let cleanup;
      try {
        const engine = await loadRecalculationEngine();
        cleanup = engine.cleanup;
        const d1 = await engine.getD1();
        for (const item of toRecalculate) {
          await engine.recalculateMaintenanceCycles(d1, { equipmentId: item.id, force: true, notify: false });
          console.log(`  ${item.prefix}: plano calculado.`);
        }
      } catch (error) {
        // Os equipamentos JÁ FORAM GRAVADOS (commit concluído acima); um erro
        // aqui não desfaz o cadastro, só significa que o plano de manutenção
        // precisa ser recalculado numa nova execução (idempotente e segura
        // de rodar de novo — equipamento já cadastrado não é duplicado).
        linha();
        console.error("AVISO: os equipamentos foram gravados, mas o cálculo do plano de manutenção falhou:");
        console.error(`  ${error.message}`);
        console.error("Rode: node importar-equipamentos.mjs --recalcular  (só calcula os planos pendentes, não recadastra nada).");
        linha();
        console.log("IMPORTAÇÃO CONCLUÍDA COM PENDÊNCIA (cadastro ok, plano pendente).");
        console.log(`  Equipamentos novos gravados: ${insertedIds.map((item) => item.prefix).join(", ")}`);
        linha();
        return;
      } finally {
        cleanup?.();
      }
    }

    linha();
    console.log("IMPORTAÇÃO CONCLUÍDA.");
    console.log(`  Equipamentos novos gravados: ${insertedIds.map((item) => item.prefix).join(", ")}`);
    linha();
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  linha();
  console.error("ERRO:", error.message);
  if (error.detail) console.error("detalhe:", error.detail);
  if (error.table) console.error("tabela:", error.table);
  if (error.column) console.error("coluna:", error.column);
  console.error("\nA transação de gravação foi desfeita (ROLLBACK). Nada parcial ficou salvo.");
  process.exitCode = 1;
});
