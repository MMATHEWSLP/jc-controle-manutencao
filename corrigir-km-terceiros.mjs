import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Corrige o KM (meter_reading) das saídas de combustível dos caminhões de um prestador a partir de
// uma lista conferida (ex.: prints do controle do GREGOLETO). Cada correção acha o lançamento pelas
// saídas que vieram como "teste" na importação (ou já estão nos caminhões do prestador) com os mesmos
// litros e o KM que está hoje no sistema (+ data, quando informada). Sem KM no banco, casa por
// data + litros. Também acerta caminhão, motorista e observação do lançamento.
// Parte A (padrão): só mostra a conferência. Com --confirmar grava, mas só se TODAS as correções
// casarem com exatamente 1 lançamento (senão nada muda). Lançamento excluído só conta com
// --restaurar-excluidas (volta a valer); com --manter-excluidas essas correções são puladas e o
// lançamento continua excluído. Numa transação, com registro em audit_logs.
//
// Uso: node corrigir-km-terceiros.mjs --arquivo=lista.json --empresa=GREGOLETO [--confirmar] [--restaurar-excluidas | --manter-excluidas] [--somente=21,40]
// --somente = só estas correções da lista (pelo número "n"), ex.: restaurar depois as que ficaram excluídas.
// lista.json = [{ "n": 1, "plate": "QEH4C88", "driver": "Reginaldo", "date": null | "AAAA-MM-DD", "liters": 359, "current": 216934, "correct": 216934 }]
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const RESTAURAR = process.argv.includes("--restaurar-excluidas");
const MANTER = process.argv.includes("--manter-excluidas");
if (RESTAURAR && MANTER) { console.error("Use só um: --restaurar-excluidas ou --manter-excluidas."); process.exit(1); }
const arg = (name, fallback = "") => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }

const plateKey = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = (value) => Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const linha = () => console.log("-".repeat(110));
const SOMENTE = arg("somente", "").split(/[,;\s]+/).filter(Boolean).map(Number);
if (SOMENTE.some((n) => !Number.isInteger(n) || n <= 0)) { console.error("--somente deve ser uma lista de números da lista (ex.: 21,40)."); process.exit(1); }
const fullList = JSON.parse(readFileSync(arg("arquivo", "scripts/import-abastecimento/data/gregoleto-km-2026-09-29.json"), "utf8"));
const list = SOMENTE.length ? fullList.filter((item) => SOMENTE.includes(Number(item.n))) : fullList;
if (SOMENTE.length && list.length !== SOMENTE.length) { console.error(`Correções não encontradas na lista: ${SOMENTE.filter((n) => !list.some((item) => Number(item.n) === n)).join(", ")}.`); process.exit(1); }

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  const party = (await client.query(`SELECT id,name FROM third_parties WHERE upper(name)=upper($1)`, [arg("empresa", "GREGOLETO")])).rows[0];
  if (!party) throw new Error("Prestador não encontrado.");
  const vehicles = (await client.query(`SELECT id,plate,plate_key FROM third_party_vehicles WHERE third_party_id=$1`, [party.id])).rows;
  const missingPlates = [...new Set(list.map((item) => plateKey(item.plate)))].filter((key) => !vehicles.some((vehicle) => vehicle.plate_key === key));
  if (missingPlates.length) throw new Error(`Caminhões fora do cadastro de ${party.name}: ${missingPlates.join(", ")}.`);
  const rows = (await client.query(`SELECT fm.id,fm.movement_date,fm.quantity,fm.meter_reading,fm.meter_unit,fm.responsible,fm.notes,fm.deleted_at,
      fm.third_party_id,fm.third_party_vehicle_id,fm.provider_company,fm.provider_equipment,fm.imported_vehicle,v.plate
    FROM fuel_movements fm LEFT JOIN third_party_vehicles v ON v.id=fm.third_party_vehicle_id
    WHERE fm.movement_type='SAIDA' AND fm.balance_adjustment=false
      AND (fm.third_party_id=$1 OR upper(coalesce(fm.imported_vehicle,'')) LIKE '%TESTE%' OR upper(coalesce(fm.imported_vehicle,'')) LIKE 'A IDENTIFICAR%')`, [party.id])).rows
    .map((row) => ({ ...row, quantity: Number(row.quantity), meter_reading: row.meter_reading === null ? null : Number(row.meter_reading) }));

  const results = list.map((item) => {
    const vehicle = vehicles.find((candidate) => candidate.plate_key === plateKey(item.plate));
    let matches = rows.filter((row) => Math.abs(row.quantity - item.liters) < 0.001 && (!item.date || row.movement_date === item.date)
      && (row.meter_reading === item.current || (row.meter_reading === null && item.date)));
    // Mesmo dia e litros em dois caminhões (ex.: 397 L do Caio e do André em 18/09): fica o do caminhão da lista.
    const sameVehicle = matches.filter((row) => row.third_party_vehicle_id === vehicle.id);
    if (matches.length > 1 && sameVehicle.length) matches = sameVehicle;
    return { item, matches, vehicle };
  });
  // Sem data e sem KM no banco (a importação não trouxe KM): casa com as saídas do próprio caminhão
  // com os mesmos litros que sobraram, na ordem do KM correto = ordem da data.
  const taken = new Set(results.flatMap(({ matches }) => matches.length === 1 ? [matches[0].id] : []));
  const pending = results.filter(({ item, matches }) => !item.date && matches.length === 0);
  for (const key of new Set(pending.map(({ item, vehicle }) => `${vehicle.id}|${item.liters}`))) {
    const group = pending.filter(({ item, vehicle }) => `${vehicle.id}|${item.liters}` === key).sort((a, b) => a.item.correct - b.item.correct);
    const candidates = rows.filter((row) => !row.deleted_at && !taken.has(row.id) && row.meter_reading === null && `${row.third_party_vehicle_id}|${row.quantity}` === key)
      .sort((a, b) => a.movement_date.localeCompare(b.movement_date) || a.id - b.id);
    if (candidates.length !== group.length) { for (const result of group) result.matches = candidates; continue; }
    group.forEach((result, index) => { result.matches = [candidates[index]]; result.bySequence = true; taken.add(candidates[index].id); });
  }

  linha();
  console.log(CONFIRMAR ? `CORREÇÃO DE KM — ${party.name} — GRAVANDO` : `CORREÇÃO DE KM — ${party.name} — PARTE A: CONFERÊNCIA (nada será gravado)`);
  linha();
  const sorted = [...results].sort((a, b) => Number(a.matches.length === 1 && !a.matches[0].deleted_at) - Number(b.matches.length === 1 && !b.matches[0].deleted_at) || a.item.n - b.item.n);
  console.log(`${"n".padStart(3)} ${"placa".padEnd(8)} ${"motorista".padEnd(10)} ${"data".padEnd(10)} ${"litros".padStart(6)} ${"KM atual".padStart(10)} ${"KM certo".padStart(10)}  achados  lançamento(s)`);
  for (const { item, matches, bySequence } of sorted) {
    const detail = matches.map((row) => `#${row.id} ${row.movement_date} ${row.plate ?? row.imported_vehicle ?? "—"} resp. ${row.responsible ?? "—"}${row.deleted_at ? " [EXCLUÍDO]" : ""}${bySequence ? " (pela ordem do KM)" : ""}`).join(" | ");
    console.log(`${String(item.n).padStart(3)} ${item.plate.padEnd(8)} ${item.driver.padEnd(10)} ${(item.date ?? "—").padEnd(10)} ${num(item.liters).padStart(6)} ${num(item.current).padStart(10)} ${num(item.correct).padStart(10)}  ${String(matches.length).padStart(7)}  ${detail}`);
  }
  linha();
  const problems = results.filter(({ matches }) => matches.length !== 1);
  const deleted = results.filter(({ matches }) => matches.length === 1 && matches[0].deleted_at);
  const ids = results.flatMap(({ matches }) => matches.map((row) => row.id));
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  const moves = results.filter(({ matches, vehicle }) => matches.length === 1 && matches[0].third_party_vehicle_id !== vehicle.id);
  console.log(`Correções: ${list.length} · casaram 1 vez: ${results.length - problems.length} · sem correspondência única: ${problems.length} · em lançamento excluído: ${deleted.length}`);
  if (moves.length) console.log(`Mudam de caminhão: ${moves.map(({ item, matches }) => `#${matches[0].id} ${matches[0].plate ?? "(sem caminhão)"} → ${item.plate}`).join("; ")}`);
  const changedKm = results.filter(({ matches, item }) => matches.length === 1 && matches[0].meter_reading !== item.correct);
  const filled = changedKm.filter(({ matches }) => matches[0].meter_reading === null).length;
  console.log(`KM que muda: ${changedKm.length} (${filled} estavam vazios no sistema)${changedKm.length > filled ? ` · trocados: ${changedKm.filter(({ matches }) => matches[0].meter_reading !== null).map(({ item, matches }) => `#${matches[0].id} ${num(matches[0].meter_reading)} → ${num(item.correct)}`).join("; ")}` : ""}`);
  const listed = new Set(results.flatMap(({ matches }) => matches.map((row) => row.id)));
  const outside = rows.filter((row) => !row.deleted_at && row.third_party_id === party.id && !listed.has(row.id));
  if (outside.length) {
    console.log(`No ${party.name}, mas fora da lista (não mudam): ${outside.length}`);
    for (const row of outside) console.log(`  #${row.id} ${row.movement_date} ${num(row.quantity).padStart(5)} L ${(row.plate ?? "—").padEnd(8)} resp. ${row.responsible ?? "—"} · KM ${row.meter_reading === null ? "—" : num(row.meter_reading)}`);
  }
  linha();

  if (!CONFIRMAR) { console.log("Parte A concluída. Para gravar, rode de novo em modo confirmar."); linha(); }
  else {
    if (problems.length) throw new Error(`Nada foi alterado. Correções sem correspondência única: ${problems.map(({ item }) => item.n).join(", ")}.`);
    if (repeated.length) throw new Error(`Nada foi alterado. Um mesmo lançamento casou com duas correções: ${[...new Set(repeated)].join(", ")}.`);
    if (deleted.length && !RESTAURAR && !MANTER) throw new Error(`Nada foi alterado. Correções em lançamentos excluídos: ${deleted.map(({ item, matches }) => `${item.n} (#${matches[0].id})`).join(", ")}. Use o modo que restaura os excluídos se eles devem voltar a valer.`);
    const toWrite = MANTER ? results.filter(({ matches }) => !matches[0].deleted_at) : results;
    if (MANTER && deleted.length) console.log(`Mantidas excluídas (não mudam): ${deleted.map(({ item, matches }) => `correção ${item.n} → #${matches[0].id}`).join("; ")}`);
    await client.query("BEGIN");
    const now = new Date().toISOString();
    for (const { item, matches, vehicle } of toWrite) {
      const row = matches[0];
      await client.query(`UPDATE fuel_movements SET meter_reading=$1, meter_unit='KM', third_party=true, third_party_kind='PRESTADOR', third_party_id=$2, third_party_vehicle_id=$3,
          provider_company=$4, provider_equipment=$5, third_party_description=NULL, equipment_id=NULL, vehicle_pending=false, reading_exception=false,
          responsible=$6, notes=$7, deleted_at=NULL, updated_at=$8 WHERE id=$9`,
        [item.correct, party.id, vehicle.id, party.name, vehicle.plate, item.driver, `${party.name} ${vehicle.plate}`, now, row.id]);
      await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES ('FUEL_MOVEMENT',$1,'KM CORRIGIDO (conferência com o prestador)',$2,$3,$4)`,
        [String(row.id), JSON.stringify(row), JSON.stringify({ meter_reading: item.correct, plate: vehicle.plate, responsible: item.driver, restored: Boolean(row.deleted_at) }), now]);
    }
    for (const vehicle of vehicles) {
      await client.query(`UPDATE third_party_vehicles SET last_reading=coalesce((SELECT meter_reading FROM fuel_movements WHERE third_party_vehicle_id=$1 AND deleted_at IS NULL AND meter_reading IS NOT NULL
          ORDER BY movement_date DESC,id DESC LIMIT 1),last_reading), updated_at=$2 WHERE id=$1`, [vehicle.id, now]);
    }
    await client.query("COMMIT");
    console.log(`Lançamentos atualizados: ${toWrite.length}${deleted.length ? (MANTER ? ` (mantidos excluídos: ${deleted.length})` : ` (restaurados: ${deleted.length})`) : ""}`);
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
