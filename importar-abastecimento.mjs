import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import esbuild from "esbuild";
import pg from "pg";
import { buildImportPlan, mapHeaders, normalizeText, SHEET_NAME, summarize } from "./scripts/import-abastecimento/plan.mjs";

// ---------------------------------------------------------------------------
// Importa o histórico de abastecimento (planilha já limpa, aba "Dados_Limpos") para o módulo
// Combustível como carga RETROATIVA — não como lançamentos manuais. Mesmo padrão dos outros
// importadores: conecta direto no Postgres via DATABASE_URL, simula por padrão e só grava com
// --confirmar. As demais abas da planilha (auditoria do que foi descartado) não são lidas.
//
// Cada linha vira um lançamento em fuel_movements com:
//   - frente fixa (--frente, padrão Arapiuns) e estoque de origem = Frente;
//   - origin_confirmed = false (corrigir para Porto depois, no Histórico, filtro "Origem a confirmar");
//   - vehicle_pending = true para "A IDENTIFICAR" e veículos que não existem no cadastro;
//   - import_source = lote (--lote) e import_hash = hash da linha (rodar de novo não duplica).
// O saldo do módulo nunca é gravado: é sempre recalculado a partir dos lançamentos, então os saldos
// do relatório final já são os que a tela vai mostrar.
//
// Uso:
//   node importar-abastecimento.mjs                        -> simulação (nada é gravado)
//   node importar-abastecimento.mjs --confirmar            -> grava de verdade
//   node importar-abastecimento.mjs --reverter             -> simula a remoção do lote
//   node importar-abastecimento.mjs --reverter --confirmar -> remove o lote inteiro (rollback)
// Opções:
//   --arquivo=caminho.xlsx  --frente=Arapiuns  --lote=historico_planilha_2026-09-29
//   --destino-transferencia=PORTO   (Frente → Porto da mesma frente; ou o nome de outra frente)
//   --ignorar-erros         (grava as linhas válidas mesmo havendo linhas com erro)
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const REVERTER = process.argv.includes("--reverter");
const IGNORAR_ERROS = process.argv.includes("--ignorar-erros");
const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const DEFAULT_FILE = "scripts/import-abastecimento/data/Historico_de_Abastecimento_LIMPO_2026-09-29.xlsx";
const ARQUIVO = arg("arquivo", DEFAULT_FILE);
const FRENTE = arg("frente", "Arapiuns");
const LOTE = arg("lote", "historico_planilha_2026-09-29");
const DESTINO = arg("destino-transferencia", "PORTO");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no ambiente.");
  process.exit(1);
}
const linha = () => console.log("-".repeat(78));
const litros = (value) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
const MOVIMENTO = { ENTRADA: "Entrada", SAIDA: "Saída", TRANSFERENCIA: "Transferência" };

// Texto de uma célula do ExcelJS (rich text, fórmula, hyperlink...).
function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  if ("result" in value) return cellValue(value.result);
  if ("text" in value) return cellValue(value.text);
  return String(value);
}

async function readSheet(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets.find((item) => normalizeText(item.name) === normalizeText(SHEET_NAME));
  if (!sheet) throw new Error(`A aba "${SHEET_NAME}" não foi encontrada. Abas do arquivo: ${workbook.worksheets.map((item) => item.name).join(", ")}`);
  const header = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => { header[column - 1] = cellValue(cell.value); });
  const { indexes, missing } = mapHeaders(header);
  if (missing.length) throw new Error(`Colunas obrigatórias ausentes na aba ${SHEET_NAME}: ${missing.join(", ")}. Cabeçalho lido: ${header.join(" | ")}`);
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = {};
    for (const [key, index] of Object.entries(indexes)) values[key] = cellValue(row.getCell(index + 1).value);
    if (Object.values(values).every((value) => value === null || String(value).trim() === "")) return;
    rows.push({ rowNumber, cells: values });
  });
  return { rows, sheets: workbook.worksheets.map((item) => item.name) };
}

// Mesma técnica dos outros importadores: empacota as regras de saldo (TypeScript) num .mjs temporário.
async function loadFuelRules() {
  const projectRoot = path.dirname(new URL(import.meta.url).pathname);
  const outDir = mkdtempSync(path.join(projectRoot, ".import-abastecimento-tmp-"));
  const outfile = path.join(outDir, `fuel-rules-${randomUUID()}.mjs`);
  await esbuild.build({ entryPoints: [path.join(projectRoot, "lib/fuel-rules.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  const rules = await import(outfile);
  return { ...rules, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

async function findFront(pool, name) {
  const fronts = (await pool.query(`SELECT id,name,active FROM service_fronts`)).rows;
  const front = fronts.find((item) => normalizeText(item.name) === normalizeText(name));
  if (!front) throw new Error(`Frente "${name}" não encontrada. Frentes cadastradas: ${fronts.map((item) => item.name).join(", ")}`);
  return { id: Number(front.id), name: front.name, fronts };
}

async function ensureMigration(pool) {
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='fuel_movements' AND column_name IN ('import_source','import_hash','origin_confirmed','vehicle_pending','imported_vehicle')`)).rows;
  if (columns.length < 5) throw new Error("A migração 0023 (colunas de importação em fuel_movements) ainda não foi aplicada. Rode o workflow \"Migrar banco de dados (Drizzle)\" antes.");
}

// Saldos da frente (Frente e Porto separados) por combustível, a partir de todos os lançamentos.
async function balances(pool, rules, frontId, fuelTypes, extra = []) {
  const rows = (await pool.query(`SELECT service_front_id,stock_location,destination_front_id,destination_location,fuel_type_id,movement_type,movement_date,quantity
    FROM fuel_movements WHERE deleted_at IS NULL AND (service_front_id=$1 OR destination_front_id=$1)`, [frontId])).rows;
  const movements = [...rows.map((row) => ({
    serviceFrontId: Number(row.service_front_id), stockLocation: row.stock_location, destinationFrontId: row.destination_front_id === null ? null : Number(row.destination_front_id),
    destinationLocation: row.destination_location, fuelTypeId: Number(row.fuel_type_id), movementType: row.movement_type, movementDate: row.movement_date, quantity: Number(row.quantity),
  })), ...extra];
  const result = rules.computeFuelBalances(movements, { fronts: [frontId], from: "0000-01-01", to: "9999-12-31" });
  return fuelTypes.map((type) => {
    const front = result.get(type.id)?.byFront.get(frontId);
    return { name: type.name, frente: front?.byLocation.FRENTE.balance ?? 0, porto: front?.byLocation.PORTO.balance ?? 0, total: front?.balance ?? 0 };
  });
}

function printBalances(title, list) {
  console.log(title);
  console.log(`  ${"Combustível".padEnd(18)} ${"Frente".padStart(16)} ${"Porto".padStart(16)} ${"Total".padStart(16)}`);
  for (const item of list) console.log(`  ${item.name.padEnd(18)} ${litros(item.frente).padStart(16)} ${litros(item.porto).padStart(16)} ${litros(item.total).padStart(16)}`);
}

function printSummary(records) {
  const summary = summarize(records);
  console.log("  Por combustível:");
  for (const [name, value] of summary.byFuel) console.log(`    ${name.padEnd(18)} ${String(value.rows).padStart(6)} linhas  ${litros(value.liters).padStart(16)}`);
  console.log("  Por tipo de movimentação:");
  for (const [type, value] of summary.byMovement) console.log(`    ${MOVIMENTO[type].padEnd(18)} ${String(value.rows).padStart(6)} linhas  ${litros(value.liters).padStart(16)}`);
  console.log(`  Veículo pendente (vehicle_pending = true):     ${summary.vehiclePending}`);
  console.log(`  Origem a confirmar (origin_confirmed = false): ${summary.originUnconfirmed}`);
  console.log(`  Saídas vinculadas a veículo do cadastro:       ${summary.linkedVehicles}`);
  console.log(`  Responsável casado com Funcionário:            ${summary.withEmployee}`);
}

async function importar(pool) {
  if (!existsSync(ARQUIVO)) throw new Error(`Arquivo não encontrado: ${ARQUIVO}. Coloque a planilha em ${DEFAULT_FILE} (ou use --arquivo=).`);
  const front = await findFront(pool, FRENTE);
  let destination;
  if (normalizeText(DESTINO) === "PORTO") destination = { frontId: front.id, location: "PORTO", label: `Frente → Porto (${front.name})` };
  else {
    const target = front.fronts.find((item) => normalizeText(item.name) === normalizeText(DESTINO));
    if (!target) throw new Error(`--destino-transferencia: frente "${DESTINO}" não encontrada (use PORTO ou o nome de uma frente).`);
    destination = { frontId: Number(target.id), location: "FRENTE", label: `Frente ${front.name} → Frente ${target.name}` };
  }
  const { rows, sheets } = await readSheet(ARQUIVO);
  const [fuelTypes, equipment, employees, hashes] = await Promise.all([
    pool.query(`SELECT id,code,name FROM fuel_types WHERE active=true ORDER BY sort_order,name`),
    pool.query(`SELECT id,prefix,plate FROM equipment`),
    pool.query(`SELECT id,name FROM employees`),
    pool.query(`SELECT import_hash FROM fuel_movements WHERE import_hash IS NOT NULL`),
  ]);
  const types = fuelTypes.rows.map((row) => ({ ...row, id: Number(row.id) }));
  const plan = buildImportPlan({
    rows, fuelTypes: types, equipment: equipment.rows.map((row) => ({ ...row, id: Number(row.id) })),
    employees: employees.rows.map((row) => ({ ...row, id: Number(row.id) })), existingHashes: new Set(hashes.rows.map((row) => row.import_hash)),
    frontId: front.id, importSource: LOTE, fileName: path.basename(ARQUIVO), destination,
  });
  const records = plan.items.filter((item) => item.status === "IMPORTAR").map((item) => item.record);
  const errors = plan.items.filter((item) => item.status === "ERRO");

  linha();
  console.log(CONFIRMAR ? "IMPORTAÇÃO REAL — HISTÓRICO DE ABASTECIMENTO" : "SIMULAÇÃO (dry-run) — nada será gravado");
  linha();
  console.log(`  Arquivo: ${ARQUIVO}`);
  console.log(`  Aba lida: ${SHEET_NAME} (ignoradas: ${sheets.filter((name) => name !== SHEET_NAME).join(", ") || "nenhuma"})`);
  console.log(`  Frente fixa: ${front.name} (id ${front.id}) · origem padrão: Frente · lote: ${LOTE}`);
  console.log(`  Transferências: ${destination.label}`);
  console.log(`  Linhas lidas:                   ${rows.length}`);
  console.log(`  A importar:                     ${plan.totals.IMPORTAR ?? 0}`);
  console.log(`  Já importadas antes (hash):     ${plan.totals.JA_EXISTE ?? 0}`);
  console.log(`  Repetidas na própria planilha:  ${plan.totals.DUPLICADO_NA_PLANILHA ?? 0}`);
  console.log(`  Com erro (não importadas):      ${plan.totals.ERRO ?? 0}`);
  if (records.length) { linha(); console.log(`RESUMO DO QUE ${CONFIRMAR ? "SERÁ GRAVADO" : "SERIA GRAVADO"}`); printSummary(records); }
  const notFound = new Map();
  for (const item of plan.items) if (item.vehicleReason === "NAO_ENCONTRADO") notFound.set(item.record.importedVehicle, (notFound.get(item.record.importedVehicle) ?? 0) + 1);
  if (notFound.size) {
    linha();
    console.log(`VEÍCULOS DA PLANILHA NÃO ENCONTRADOS NO CADASTRO (${notFound.size}) — importados com veículo pendente`);
    for (const [text, count] of [...notFound].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}×  ${text}`);
  }
  const repeated = plan.items.filter((item) => item.status === "DUPLICADO_NA_PLANILHA");
  if (repeated.length) {
    linha();
    console.log(`LINHAS IGUAIS A OUTRA DA PLANILHA (${repeated.length}) — mesma data/hora, combustível, movimentação, quantidade, veículo e responsável; não serão importadas`);
    console.log(`  linhas: ${repeated.map((item) => item.rowNumber).join(", ")}`);
  }
  if (errors.length) {
    linha();
    console.log(`LINHAS COM ERRO (${errors.length})`);
    for (const item of errors.slice(0, 200)) console.log(`  linha ${String(item.rowNumber).padStart(5)} — ${item.error}`);
    if (errors.length > 200) console.log(`  ... e mais ${errors.length - 200}`);
  }

  const rules = await loadFuelRules();
  try {
    linha();
    const before = await balances(pool, rules, front.id, types);
    printBalances(`SALDO ATUAL EM ${front.name.toUpperCase()} (antes da importação)`, before);
    if (!CONFIRMAR) {
      linha();
      printBalances(`SALDO EM ${front.name.toUpperCase()} DEPOIS DA IMPORTAÇÃO (previsão)`, await balances(pool, rules, front.id, types, records));
      linha();
      console.log(errors.length && !IGNORAR_ERROS
        ? "Há linhas com erro: corrija a planilha (ou rode com --ignorar-erros) antes de confirmar."
        : "Simulação concluída. Para gravar, rode de novo em modo confirmar.");
      return;
    }
    if (errors.length && !IGNORAR_ERROS) throw new Error(`${errors.length} linha(s) com erro — nada foi gravado. Corrija a planilha ou use --ignorar-erros.`);
    const client = await pool.connect();
    let inserted = 0;
    try {
      await client.query("BEGIN");
      const now = new Date().toISOString();
      for (const record of records) {
        const result = await client.query(
          `INSERT INTO fuel_movements (service_front_id,fuel_type_id,movement_type,movement_date,quantity,stock_location,third_party,unit_price,equipment_id,
            destination_front_id,destination_location,responsible,responsible_employee_id,notes,import_source,import_hash,origin_confirmed,vehicle_pending,imported_vehicle,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16,$17,$18,$18)
           ON CONFLICT (import_hash) DO NOTHING`,
          [record.serviceFrontId, record.fuelTypeId, record.movementType, record.movementDate, record.quantity, record.stockLocation, record.unitPrice, record.equipmentId,
            record.destinationFrontId, record.destinationLocation, record.responsible, record.responsibleEmployeeId, record.notes, record.importSource, record.importHash,
            record.vehiclePending, record.importedVehicle, now],
        );
        inserted += result.rowCount;
      }
      await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,new_value,occurred_at) VALUES ('FUEL_IMPORT',$1,'HISTÓRICO DE ABASTECIMENTO IMPORTADO',$2,$3)`,
        [LOTE, JSON.stringify({ arquivo: path.basename(ARQUIVO), frente: front.name, inseridos: inserted, destinoTransferencia: destination.label }), now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const saved = (await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE vehicle_pending)::int AS pending, COUNT(*) FILTER (WHERE NOT origin_confirmed)::int AS unconfirmed
      FROM fuel_movements WHERE import_source=$1 AND deleted_at IS NULL`, [LOTE])).rows[0];
    linha();
    console.log("RELATÓRIO FINAL");
    console.log(`  Linhas importadas agora:                      ${inserted}`);
    console.log(`  Total do lote ${LOTE} no banco: ${saved.total}`);
    console.log(`  Do lote, com veículo pendente:                ${saved.pending}`);
    console.log(`  Do lote, com origem a confirmar:              ${saved.unconfirmed}`);
    printSummary(records);
    linha();
    printBalances(`NOVO SALDO EM ${front.name.toUpperCase()} (recalculado com o histórico completo)`, await balances(pool, rules, front.id, types));
    linha();
  } finally {
    rules.cleanup();
  }
}

async function reverter(pool) {
  const stats = (await pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(quantity),0)::float AS liters FROM fuel_movements WHERE import_source=$1`, [LOTE])).rows[0];
  linha();
  console.log(CONFIRMAR ? `REVERSÃO DO LOTE ${LOTE}` : `SIMULAÇÃO DA REVERSÃO DO LOTE ${LOTE} — nada será apagado`);
  linha();
  console.log(`  Lançamentos do lote: ${stats.total} (${litros(stats.liters)})`);
  if (!CONFIRMAR || stats.total === 0) { linha(); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await client.query(`DELETE FROM fuel_movements WHERE import_source=$1`, [LOTE]);
    await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,new_value,occurred_at) VALUES ('FUEL_IMPORT',$1,'IMPORTAÇÃO DE ABASTECIMENTO REVERTIDA',$2,$3)`,
      [LOTE, JSON.stringify({ removidos: removed.rowCount }), new Date().toISOString()]);
    await client.query("COMMIT");
    console.log(`  Removidos: ${removed.rowCount}. O saldo volta automaticamente ao que era sem o lote.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  linha();
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
try {
  await ensureMigration(pool);
  if (REVERTER) await reverter(pool); else await importar(pool);
} catch (error) {
  console.error(`ERRO: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
