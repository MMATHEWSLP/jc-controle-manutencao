import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Confere uma lista de saídas de combustível (ex.: PDF do sistema anterior com as saídas "teste1"
// dos caminhões do prestador) contra o banco: cada linha (data + litros + motorista) é casada com
// uma saída de Diesel da frente. Mostra, por caminhão, o que já está vinculado, o que está no
// sistema mas pendente/sem caminhão e o que está FALTANDO.
// Só lê o banco; com --confirmar, vincula as pendentes ao caminhão do motorista (mesmo padrão de
// vincular-saidas-terceiros.mjs). Linhas que faltam não são lançadas aqui (ver relatório).
//
// Uso:
//   node conferir-saidas-terceiros.mjs --arquivo=lista.json --vinculos="QEH4C88=REGINALDO; QEH4C88=(SEM NOME)"
//   --frente=Arapiuns --confirmar
// lista.json = [{ "date": "AAAA-MM-DD", "liters": 357, "name": "ANDRE" }, ...]
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name, fallback = "") => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }

const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const plateKey = (value) => normalize(value).replace(/[^A-Z0-9]/g, "");
const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const linha = () => console.log("-".repeat(90));
const firstName = (value) => normalize(value).split(" ")[0] || "(SEM NOME)";

const links = new Map(arg("vinculos").split(/[;\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
  const [plate, name] = part.split("=").map((value) => value?.trim());
  return [normalize(name), plateKey(plate)];
}));
const list = JSON.parse(readFileSync(arg("arquivo"), "utf8")).map((row, index) => ({ ...row, index, name: normalize(row.name) || "(SEM NOME)" }));

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  const front = (await client.query(`SELECT id,name FROM service_fronts WHERE upper(name)=upper($1)`, [arg("frente", "Arapiuns")])).rows[0];
  if (!front) throw new Error("Frente não encontrada.");
  const dates = list.map((row) => row.date).sort();
  const db = (await client.query(`SELECT fm.id,fm.movement_date,fm.quantity,fm.responsible,fm.vehicle_pending,fm.imported_vehicle,fm.third_party_vehicle_id,fm.equipment_id,
      v.plate,v.plate_key,p.name AS party,e.prefix
    FROM fuel_movements fm JOIN fuel_types ft ON ft.id=fm.fuel_type_id
    LEFT JOIN third_party_vehicles v ON v.id=fm.third_party_vehicle_id LEFT JOIN third_parties p ON p.id=v.third_party_id LEFT JOIN equipment e ON e.id=fm.equipment_id
    WHERE fm.deleted_at IS NULL AND fm.balance_adjustment=false AND fm.movement_type='SAIDA' AND fm.service_front_id=$1 AND upper(ft.name) LIKE 'DIESEL%'
      AND fm.movement_date BETWEEN $2 AND $3`, [front.id, dates[0], dates[dates.length - 1]])).rows.map((row) => ({ ...row, quantity: Number(row.quantity) }));
  const vehicles = (await client.query(`SELECT v.id,v.plate,v.plate_key,p.id AS party_id,p.name AS party FROM third_party_vehicles v JOIN third_parties p ON p.id=v.third_party_id WHERE v.plate_key = ANY($1)`,
    [[...new Set(links.values())]])).rows;

  // Casamento 1:1 por data + litros, preferindo o mesmo motorista e as saídas "teste"/do caminhão.
  const used = new Set();
  const score = (pdf, row) => (firstName(row.responsible) === firstName(pdf.name) ? 2 : 0) + (row.plate_key === links.get(pdf.name) ? 2 : 0) + (/TESTE|IDENTIFICAR/i.test(row.imported_vehicle ?? "") ? 1 : 0);
  const results = list.map((pdf) => {
    const candidates = db.filter((row) => !used.has(row.id) && row.movement_date === pdf.date && Math.abs(row.quantity - pdf.liters) < 0.01).sort((a, b) => score(pdf, b) - score(pdf, a));
    const match = candidates[0] ?? null;
    if (match) used.add(match.id);
    const target = links.get(pdf.name) ?? null;
    const status = !match ? "FALTANDO" : match.plate_key ? (match.plate_key === target ? "OK" : "OUTRO_CAMINHAO") : match.equipment_id ? "EQUIPAMENTO_PROPRIO" : "SEM_CAMINHAO";
    return { pdf, match, target, status };
  });

  linha();
  console.log(CONFIRMAR ? "CONFERÊNCIA DAS SAÍDAS — GRAVANDO VÍNCULOS" : "CONFERÊNCIA DAS SAÍDAS (só leitura)");
  console.log(`Lista: ${list.length} saídas · ${litros(list.reduce((sum, row) => sum + row.liters, 0))} · frente ${front.name}`);
  linha();
  const byPlate = new Map();
  for (const result of results) {
    const key = result.target ?? "(sem caminhão)";
    const group = byPlate.get(key) ?? { rows: 0, liters: 0, ok: 0, okLiters: 0 };
    group.rows += 1; group.liters += result.pdf.liters;
    if (result.status === "OK") { group.ok += 1; group.okLiters += result.pdf.liters; }
    byPlate.set(key, group);
  }
  console.log(`${"Caminhão".padEnd(16)} ${"No PDF".padStart(16)} ${"Vinculadas no sistema".padStart(26)} ${"Diferença".padStart(14)}`);
  for (const [plate, group] of byPlate) console.log(`${plate.padEnd(16)} ${`${group.rows} · ${litros(group.liters)}`.padStart(16)} ${`${group.ok} · ${litros(group.okLiters)}`.padStart(26)} ${litros(group.liters - group.okLiters).padStart(14)}`);
  linha();
  for (const status of ["FALTANDO", "SEM_CAMINHAO", "OUTRO_CAMINHAO", "EQUIPAMENTO_PROPRIO"]) {
    const rows = results.filter((result) => result.status === status);
    if (!rows.length) continue;
    const label = { FALTANDO: "NÃO ENCONTRADAS NO SISTEMA (data + litros)", SEM_CAMINHAO: "NO SISTEMA, MAS SEM CAMINHÃO (pendentes)", OUTRO_CAMINHAO: "NO SISTEMA, EM OUTRO CAMINHÃO", EQUIPAMENTO_PROPRIO: "NO SISTEMA, LANÇADAS EM EQUIPAMENTO PRÓPRIO" }[status];
    console.log(`${label}: ${rows.length} · ${litros(rows.reduce((sum, row) => sum + row.pdf.liters, 0))}`);
    for (const { pdf, match, target } of rows) console.log(`  ${pdf.date}  ${litros(pdf.liters).padStart(9)}  ${pdf.name.padEnd(12)} → ${target ?? "?"}${match ? `   [#${match.id} resp. ${match.responsible ?? "—"} · ${match.plate ?? match.prefix ?? match.imported_vehicle ?? "sem veículo"}]` : ""}`);
    linha();
  }
  const extra = db.filter((row) => !used.has(row.id) && vehicles.some((vehicle) => vehicle.plate_key === row.plate_key));
  if (extra.length) {
    console.log(`NO SISTEMA NESSES CAMINHÕES, MAS FORA DA LISTA: ${extra.length} · ${litros(extra.reduce((sum, row) => sum + row.quantity, 0))}`);
    for (const row of extra) console.log(`  ${row.movement_date}  ${litros(row.quantity).padStart(9)}  ${row.plate}  resp. ${row.responsible ?? "—"}  [#${row.id}]`);
    linha();
  }

  if (CONFIRMAR) {
    const toLink = results.filter((result) => result.status === "SEM_CAMINHAO" && result.target);
    await client.query("BEGIN");
    const now = new Date().toISOString();
    let updated = 0;
    for (const { pdf, match, target } of toLink) {
      const vehicle = vehicles.find((item) => item.plate_key === target);
      if (!vehicle) continue;
      const result = await client.query(`UPDATE fuel_movements SET third_party=true, third_party_kind='PRESTADOR', third_party_id=$1, third_party_vehicle_id=$2,
          provider_company=$3, provider_equipment=$4, third_party_description=NULL, equipment_id=NULL, vehicle_pending=false,
          responsible=coalesce(nullif(trim(responsible),''),$5), notes=trim(coalesce(notes,'') || ' ' || $6), updated_at=$7
        WHERE id=$8 AND third_party_vehicle_id IS NULL`,
        [vehicle.party_id, vehicle.id, vehicle.party, vehicle.plate, pdf.name === "(SEM NOME)" ? null : pdf.name,
          `Vinculado ao caminhão ${vehicle.plate} (${vehicle.party}) na conferência com o PDF do sistema anterior (motorista ${pdf.name}).`, now, match.id]);
      updated += result.rowCount;
    }
    await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,new_value,occurred_at) VALUES ('FUEL_MOVEMENT','conferencia-pdf','SAÍDAS VINCULADAS NA CONFERÊNCIA COM PDF',$1,$2)`,
      [JSON.stringify(toLink.map(({ pdf, match, target }) => ({ id: match.id, plate: target, name: pdf.name }))), now]);
    await client.query("COMMIT");
    console.log(`Saídas vinculadas agora: ${updated}`);
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
