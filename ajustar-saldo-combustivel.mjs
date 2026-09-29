import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import pg from "pg";
import { normalizeText, parseBalanceTargets, planBalanceAdjustments } from "./scripts/import-abastecimento/plan.mjs";

// ---------------------------------------------------------------------------
// Ajusta o saldo de combustível de uma frente (Frente e Porto) para valores informados, por
// exemplo para igualar ao saldo do sistema anterior depois da carga do histórico. O saldo nunca é
// gravado: o ajuste é um lançamento (Entrada se falta, Saída se sobra) por combustível/estoque,
// marcado com import_source = lote (filtrável em "Importados do histórico" e reversível).
// Simula por padrão; só grava com --confirmar. Rodar de novo com o mesmo alvo não lança nada.
//
// Uso:
//   node ajustar-saldo-combustivel.mjs --alvo="Diesel S10:FRENTE=83174; Diesel S10:PORTO=16379,99"
//   ... --confirmar                 (grava)
//   --frente=Arapiuns  --data=AAAA-MM-DD (padrão: hoje)  --lote=ajuste_saldo_<data>
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const FRENTE = arg("frente", "Arapiuns");
const DATA = arg("data", today);
const LOTE = arg("lote", `ajuste_saldo_${DATA}`);
const ALVO = arg("alvo", "");

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }
const linha = () => console.log("-".repeat(78));
const litros = (value) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;

async function loadFuelRules() {
  const projectRoot = path.dirname(new URL(import.meta.url).pathname);
  const outDir = mkdtempSync(path.join(projectRoot, ".import-abastecimento-tmp-"));
  const outfile = path.join(outDir, `fuel-rules-${randomUUID()}.mjs`);
  await esbuild.build({ entryPoints: [path.join(projectRoot, "lib/fuel-rules.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  const rules = await import(outfile);
  return { ...rules, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

async function currentBalances(client, rules, frontId) {
  const rows = (await client.query(`SELECT service_front_id,stock_location,destination_front_id,destination_location,fuel_type_id,movement_type,movement_date,quantity
    FROM fuel_movements WHERE deleted_at IS NULL AND (service_front_id=$1 OR destination_front_id=$1)`, [frontId])).rows;
  const result = rules.computeFuelBalances(rows.map((row) => ({
    serviceFrontId: Number(row.service_front_id), stockLocation: row.stock_location, destinationFrontId: row.destination_front_id === null ? null : Number(row.destination_front_id),
    destinationLocation: row.destination_location, fuelTypeId: Number(row.fuel_type_id), movementType: row.movement_type, movementDate: row.movement_date, quantity: Number(row.quantity),
  })), { fronts: [frontId], from: "0000-01-01", to: "9999-12-31" });
  return (fuelTypeId, location) => result.get(fuelTypeId)?.byFront.get(frontId)?.byLocation[location].balance ?? 0;
}

function printPlan(plan) {
  console.log(`  ${"Combustível".padEnd(16)} ${"Estoque".padEnd(8)} ${"Saldo atual".padStart(16)} ${"Saldo alvo".padStart(16)} ${"Ajuste".padStart(18)}`);
  for (const item of plan) {
    const action = item.record ? `${item.record.movementType === "ENTRADA" ? "Entrada" : "Saída"} ${litros(item.record.quantity)}` : "já está certo";
    console.log(`  ${item.fuelName.padEnd(16)} ${(item.location === "PORTO" ? "Porto" : "Frente").padEnd(8)} ${litros(item.before).padStart(16)} ${litros(item.target).padStart(16)} ${action.padStart(18)}`);
  }
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const rules = await loadFuelRules();
const client = await pool.connect();
try {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATA)) throw new Error("--data deve ser AAAA-MM-DD.");
  const targets = parseBalanceTargets(ALVO);
  if (!targets.length) throw new Error("Informe os saldos-alvo em --alvo (ex.: \"Diesel S10:FRENTE=83174; Diesel S10:PORTO=16379,99\").");
  const fronts = (await client.query(`SELECT id,name FROM service_fronts`)).rows;
  const front = fronts.find((item) => normalizeText(item.name) === normalizeText(FRENTE));
  if (!front) throw new Error(`Frente "${FRENTE}" não encontrada.`);
  const frontId = Number(front.id);
  const fuelTypes = (await client.query(`SELECT id,code,name FROM fuel_types WHERE active=true`)).rows.map((row) => ({ ...row, id: Number(row.id) }));

  await client.query("BEGIN");
  // Trava os lançamentos da frente enquanto calcula e grava (ninguém muda o saldo no meio).
  await client.query(`SELECT id FROM fuel_movements WHERE service_front_id=$1 OR destination_front_id=$1 FOR UPDATE`, [frontId]);
  const plan = planBalanceAdjustments({ targets, fuelTypes, current: await currentBalances(client, rules, frontId), frontId, date: DATA, importSource: LOTE });
  linha();
  console.log(CONFIRMAR ? `AJUSTE DE SALDO — ${front.name.toUpperCase()} (gravando)` : `SIMULAÇÃO DO AJUSTE DE SALDO — ${front.name.toUpperCase()} (nada será gravado)`);
  console.log(`  Data dos lançamentos de ajuste: ${DATA} · lote: ${LOTE}`);
  linha();
  printPlan(plan);
  const records = plan.filter((item) => item.record).map((item) => item.record);
  if (!CONFIRMAR) { await client.query("ROLLBACK"); linha(); console.log(records.length ? "Simulação concluída. Para gravar, rode de novo em modo confirmar." : "Nada a ajustar."); linha(); }
  else {
    const now = new Date().toISOString();
    let inserted = 0;
    for (const record of records) {
      const result = await client.query(
        `INSERT INTO fuel_movements (service_front_id,fuel_type_id,movement_type,movement_date,quantity,stock_location,third_party,notes,import_source,import_hash,origin_confirmed,vehicle_pending,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,true,false,$10,$10) ON CONFLICT (import_hash) DO NOTHING`,
        [record.serviceFrontId, record.fuelTypeId, record.movementType, record.movementDate, record.quantity, record.stockLocation, record.notes, record.importSource, record.importHash, now]);
      inserted += result.rowCount;
    }
    await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,new_value,occurred_at) VALUES ('FUEL_IMPORT',$1,'AJUSTE DE SALDO DE COMBUSTÍVEL',$2,$3)`,
      [LOTE, JSON.stringify({ frente: front.name, ajustes: plan.map(({ fuelName, location, before, target, diff }) => ({ fuelName, location, before, target, diff })) }), now]);
    await client.query("COMMIT");
    const after = await currentBalances(client, rules, frontId);
    linha();
    console.log(`Lançamentos de ajuste gravados: ${inserted}`);
    console.log("SALDO DEPOIS DO AJUSTE");
    for (const item of plan) console.log(`  ${item.fuelName.padEnd(16)} ${(item.location === "PORTO" ? "Porto" : "Frente").padEnd(8)} ${litros(after(item.fuelTypeId, item.location)).padStart(16)}`);
    linha();
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`ERRO: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  client.release();
  rules.cleanup();
  await pool.end();
}
