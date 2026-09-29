import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Exclusão lógica (deleted_at) de lançamentos de combustível pelo id, conferindo antes a data e os
// litros de cada um. Recalcula a última leitura do veículo de terceiro afetado.
// Simula por padrão; só grava com --confirmar (numa transação, com registro em audit_logs).
//
// Uso: node excluir-lancamentos-combustivel.mjs --ids="6945:2026-09-09:350; 7114:2026-09-16:395" --confirmar
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }

const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const linha = () => console.log("-".repeat(90));
const targets = arg("ids").split(/[;\n,]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
  const [id, date, liters] = part.split(":").map((value) => value.trim());
  if (!/^\d+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(Number(String(liters).replace(",", ".")))) throw new Error(`Item inválido: "${part}" (use ID:AAAA-MM-DD:LITROS).`);
  return { id: Number(id), date, liters: Number(String(liters).replace(",", ".")) };
});

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  if (!targets.length) throw new Error("Informe os lançamentos em --ids (ex.: \"6945:2026-09-09:350\").");
  const rows = (await client.query(`SELECT fm.id,fm.movement_type,fm.movement_date,fm.quantity,fm.responsible,fm.deleted_at,fm.third_party_vehicle_id,
      ft.name AS fuel,sf.name AS front,coalesce(v.plate,fm.provider_equipment,fm.imported_vehicle) AS vehicle
    FROM fuel_movements fm JOIN fuel_types ft ON ft.id=fm.fuel_type_id JOIN service_fronts sf ON sf.id=fm.service_front_id
    LEFT JOIN third_party_vehicles v ON v.id=fm.third_party_vehicle_id WHERE fm.id = ANY($1)`, [targets.map((target) => target.id)])).rows;
  linha();
  console.log(CONFIRMAR ? "EXCLUSÃO DE LANÇAMENTOS DE COMBUSTÍVEL — GRAVANDO" : "SIMULAÇÃO DA EXCLUSÃO DE LANÇAMENTOS DE COMBUSTÍVEL — nada será gravado");
  linha();
  const problems = [];
  for (const target of targets) {
    const row = rows.find((item) => item.id === target.id);
    if (!row) { problems.push(`#${target.id} não existe`); continue; }
    console.log(`  #${row.id} ${row.movement_type} ${row.movement_date} ${litros(row.quantity).padStart(9)} ${row.fuel} · ${row.front} · ${row.vehicle ?? "—"} · resp. ${row.responsible ?? "—"}`);
    if (row.deleted_at) problems.push(`#${row.id} já está excluído`);
    if (row.movement_date !== target.date || Math.abs(Number(row.quantity) - target.liters) > 0.001) problems.push(`#${row.id} não confere (esperado ${target.date} ${litros(target.liters)})`);
  }
  if (problems.length) throw new Error(`Nada foi excluído: ${problems.join("; ")}.`);
  console.log(`Total a excluir: ${rows.length} · ${litros(rows.reduce((sum, row) => sum + Number(row.quantity), 0))}`);
  linha();
  if (!CONFIRMAR) { console.log("Simulação concluída. Para gravar, rode de novo em modo confirmar."); linha(); }
  else {
    await client.query("BEGIN");
    const now = new Date().toISOString();
    const result = await client.query(`UPDATE fuel_movements SET deleted_at=$1, updated_at=$1 WHERE id = ANY($2) AND deleted_at IS NULL`, [now, rows.map((row) => row.id)]);
    // Última leitura do caminhão volta a ser a do abastecimento mais recente que sobrou.
    const vehicleIds = [...new Set(rows.map((row) => row.third_party_vehicle_id).filter(Boolean))];
    for (const vehicleId of vehicleIds) {
      await client.query(`UPDATE third_party_vehicles SET last_reading=(SELECT meter_reading FROM fuel_movements WHERE third_party_vehicle_id=$1 AND deleted_at IS NULL AND meter_reading IS NOT NULL
          ORDER BY movement_date DESC,id DESC LIMIT 1), updated_at=$2 WHERE id=$1`, [vehicleId, now]);
    }
    for (const row of rows) {
      await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,previous_value,occurred_at) VALUES ('FUEL_MOVEMENT',$1,'LANÇAMENTO EXCLUÍDO (conferência com o prestador)',$2,$3)`,
        [String(row.id), JSON.stringify(row), now]);
    }
    await client.query("COMMIT");
    console.log(`Lançamentos excluídos: ${result.rowCount}`);
    linha();
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`ERRO: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
