import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Muda a DATA de lançamentos de ajuste de saldo de combustível (balance_adjustment), sem mexer em
// quantidade, frente ou estoque. Serve para o ajuste valer a partir do dia certo no "Resumo do dia"
// (ex.: ajuste feito em 29/09 para o saldo de 28/09 → data 27/09). O saldo de hoje não muda.
// Só aceita lançamentos que são ajuste de saldo e não estão excluídos.
// Simula por padrão (transação desfeita no fim); grava só com --confirmar, com registro em audit_logs.
//
// Uso: node redatar-ajuste-saldo.mjs --ids=7401,7402 --data=2026-09-27 [--conferir=2026-09-28] [--confirmar]
// ---------------------------------------------------------------------------
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3).trim() ?? "";
const CONFIRMAR = process.argv.includes("--confirmar");
const toIso = (value) => { const br = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return br ? `${br[3]}-${br[2]}-${br[1]}` : value; };
const IDS = arg("ids").split(/[,;\s]+/).map(Number).filter((id) => Number.isInteger(id) && id > 0);
const DATA = toIso(arg("data"));
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }
if (!IDS.length) { console.error("Informe os lançamentos em --ids (ex.: --ids=7401,7402)."); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATA)) { console.error("Informe a nova data em --data (AAAA-MM-DD ou DD/MM/AAAA)."); process.exit(1); }
const CONFERIR = toIso(arg("conferir")) || new Date(Date.parse(`${DATA}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const br = (iso) => String(iso).split("-").reverse().join("/");
const linha = () => console.log("-".repeat(100));

// Saldo por estoque (Frente/Porto) de uma frente e combustível: antes do dia de conferência, no fim
// dele e hoje. Mesma regra de lib/fuel-rules.ts (entrada +, saída −, transferência − origem / + destino).
async function saldos(client, frontId, fuelTypeId) {
  const { rows } = await client.query(`WITH legs AS (
      SELECT movement_date AS d, service_front_id AS f, stock_location AS l, CASE WHEN movement_type='ENTRADA' THEN quantity ELSE -quantity END AS q
        FROM fuel_movements WHERE deleted_at IS NULL AND fuel_type_id=$2
      UNION ALL
      SELECT movement_date, coalesce(destination_front_id, service_front_id), coalesce(destination_location,'FRENTE'), quantity
        FROM fuel_movements WHERE deleted_at IS NULL AND fuel_type_id=$2 AND movement_type='TRANSFERENCIA')
    SELECT l, coalesce(sum(q) FILTER (WHERE d < $3),0) AS anterior, coalesce(sum(q) FILTER (WHERE d <= $3),0) AS fim, coalesce(sum(q),0) AS hoje
      FROM legs WHERE f=$1 GROUP BY l ORDER BY l`, [frontId, fuelTypeId, CONFERIR]);
  return rows;
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const rows = (await client.query(`SELECT fm.id,fm.movement_date,fm.movement_type,fm.quantity,fm.stock_location,fm.balance_adjustment,fm.deleted_at,fm.notes,
      fm.service_front_id,fm.fuel_type_id,sf.name AS front,ft.name AS fuel
    FROM fuel_movements fm JOIN service_fronts sf ON sf.id=fm.service_front_id JOIN fuel_types ft ON ft.id=fm.fuel_type_id
    WHERE fm.id = ANY($1::int[]) ORDER BY fm.id FOR UPDATE OF fm`, [IDS])).rows;
  const missing = IDS.filter((id) => !rows.some((row) => Number(row.id) === id));
  if (missing.length) throw new Error(`Lançamento(s) não encontrado(s): ${missing.join(", ")}.`);
  const invalid = rows.filter((row) => !row.balance_adjustment || row.deleted_at);
  if (invalid.length) throw new Error(`Só ajustes de saldo ativos podem ter a data mudada. Recusados: ${invalid.map((row) => `#${row.id}${row.deleted_at ? " (excluído)" : " (não é ajuste)"}`).join(", ")}.`);

  linha();
  console.log(CONFIRMAR ? `MUDANÇA DE DATA DE AJUSTES DE SALDO (gravando) → ${br(DATA)}` : `SIMULAÇÃO — MUDANÇA DE DATA DE AJUSTES DE SALDO → ${br(DATA)} (nada será gravado)`);
  for (const row of rows) console.log(`  #${row.id} ${row.front} · ${row.fuel} · ${row.stock_location} · ${row.movement_type} ${litros(row.quantity)} · data ${br(row.movement_date)} → ${br(DATA)} · ${String(row.notes ?? "").slice(0, 70)}`);
  const groups = [...new Map(rows.map((row) => [`${row.service_front_id}|${row.fuel_type_id}`, row])).values()];
  const before = new Map();
  for (const group of groups) before.set(`${group.service_front_id}|${group.fuel_type_id}`, await saldos(client, group.service_front_id, group.fuel_type_id));

  const now = new Date().toISOString();
  await client.query(`UPDATE fuel_movements SET movement_date=$2, updated_at=$3 WHERE id = ANY($1::int[]) AND balance_adjustment AND deleted_at IS NULL`, [IDS, DATA, now]);
  for (const row of rows) {
    await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES ('FUEL_MOVEMENT',$1,'DATA DO AJUSTE DE SALDO ALTERADA',$2,$3,$4)`,
      [String(row.id), JSON.stringify({ movementDate: row.movement_date }), JSON.stringify({ movementDate: DATA, motivo: "ajuste vale para o saldo do dia seguinte (Resumo do dia)" }), now]);
  }
  linha();
  console.log(`Saldos por estoque (conferência do dia ${br(CONFERIR)}): antes → depois da mudança`);
  for (const group of groups) {
    const key = `${group.service_front_id}|${group.fuel_type_id}`;
    const after = await saldos(client, group.service_front_id, group.fuel_type_id);
    for (const item of after) {
      const old = before.get(key).find((row) => row.l === item.l) ?? { anterior: 0, fim: 0, hoje: 0 };
      console.log(`  ${group.front} · ${group.fuel} · ${item.l === "PORTO" ? "Porto " : "Frente"} | saldo anterior ${br(CONFERIR)}: ${litros(old.anterior)} → ${litros(item.anterior)} | fim de ${br(CONFERIR)}: ${litros(old.fim)} → ${litros(item.fim)} | hoje: ${litros(old.hoje)} → ${litros(item.hoje)}`);
    }
  }
  linha();
  if (CONFIRMAR) { await client.query("COMMIT"); console.log(`Gravado: ${rows.length} ajuste(s) com data ${br(DATA)} (registrado em audit_logs).`); }
  else { await client.query("ROLLBACK"); console.log("Simulação concluída: nada foi gravado. Para gravar, rode de novo em modo confirmar."); }
  linha();
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`ERRO: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
