import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Relatório (só leitura) das saídas de combustível de um terceiro: caminhões cadastrados, saídas
// vinculadas a cada um (com total) e as saídas "teste"/"A IDENTIFICAR" que ainda estão pendentes,
// para conferir o total com o controle do prestador.
//
// Uso: node relatorio-terceiro.mjs --empresa=GREGOLETO
// ---------------------------------------------------------------------------

const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }

const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const linha = () => console.log("-".repeat(90));

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  const parties = (await client.query(`SELECT id,name,kind FROM third_parties WHERE upper(name) LIKE '%' || upper($1) || '%'`, [arg("empresa")])).rows;
  if (!parties.length) throw new Error(`Nenhum terceiro com "${arg("empresa")}" no nome.`);
  for (const party of parties) {
    linha();
    console.log(`TERCEIRO #${party.id} ${party.name} (${party.kind})`);
    const vehicles = (await client.query(`SELECT id,plate,plate_key,description,vehicle_type,active FROM third_party_vehicles WHERE third_party_id=$1 ORDER BY id`, [party.id])).rows;
    console.log(`Veículos: ${vehicles.map((vehicle) => `#${vehicle.id} ${vehicle.plate}${vehicle.description ? ` (${vehicle.description})` : ""}${vehicle.active ? "" : " INATIVO"}`).join(" | ") || "nenhum"}`);
    const rows = (await client.query(`SELECT fm.id,fm.movement_date,fm.quantity,fm.responsible,fm.third_party_vehicle_id,ft.name AS fuel,sf.name AS front
      FROM fuel_movements fm JOIN fuel_types ft ON ft.id=fm.fuel_type_id JOIN service_fronts sf ON sf.id=fm.service_front_id
      WHERE fm.deleted_at IS NULL AND fm.balance_adjustment=false AND fm.movement_type='SAIDA' AND fm.third_party_id=$1
      ORDER BY fm.third_party_vehicle_id,fm.movement_date,fm.id`, [party.id])).rows;
    linha();
    for (const vehicle of [...vehicles, { id: null, plate: "(sem veículo)" }]) {
      const list = rows.filter((row) => row.third_party_vehicle_id === vehicle.id);
      if (!list.length) continue;
      console.log(`${vehicle.plate}: ${list.length} saídas · ${litros(list.reduce((sum, row) => sum + Number(row.quantity), 0))}`);
      for (const row of list) console.log(`  #${String(row.id).padEnd(6)} ${row.movement_date}  ${litros(row.quantity).padStart(9)}  ${(row.responsible ?? "—").padEnd(20)} ${row.fuel} · ${row.front}`);
    }
    linha();
    console.log(`TOTAL ${party.name}: ${rows.length} saídas · ${litros(rows.reduce((sum, row) => sum + Number(row.quantity), 0))}`);
  }
  const pending = (await client.query(`SELECT fm.id,fm.movement_date,fm.quantity,fm.responsible,fm.imported_vehicle,sf.name AS front
    FROM fuel_movements fm JOIN service_fronts sf ON sf.id=fm.service_front_id
    WHERE fm.deleted_at IS NULL AND fm.movement_type='SAIDA' AND fm.vehicle_pending=true
      AND (upper(coalesce(fm.imported_vehicle,'')) LIKE '%TESTE%' OR upper(coalesce(fm.imported_vehicle,'')) LIKE 'A IDENTIFICAR%')
    ORDER BY fm.movement_date,fm.id`)).rows;
  linha();
  console.log(`SAÍDAS "TESTE" AINDA PENDENTES: ${pending.length} · ${litros(pending.reduce((sum, row) => sum + Number(row.quantity), 0))}`);
  for (const row of pending) console.log(`  #${String(row.id).padEnd(6)} ${row.movement_date}  ${litros(row.quantity).padStart(9)}  ${(row.responsible ?? "—").padEnd(20)} ${row.imported_vehicle} · ${row.front}`);
  linha();
} catch (error) {
  console.error(`ERRO: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
