import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Vincula saídas de combustível com veículo pendente ("A IDENTIFICAR (ex-teste)" / "teste1") a
// caminhões de Prestador de Serviço do cadastro de Terceiros, pelo nome do responsável (motorista).
// Ex.: todas as saídas "teste" do REGINALDO passam a ser do caminhão QEH4C88.
// Simula por padrão; só grava com --confirmar (numa transação, com registro em audit_logs).
//
// Uso:
//   node vincular-saidas-terceiros.mjs --vinculos="QEH4C88=REGINALDO; NTA0B14=ANDRE"
//   --empresa="NOME DO PRESTADOR"   (cria o prestador e os caminhões que ainda não estão no cadastro)
//   --confirmar                     (grava)
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }

const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const plateKey = (value) => normalize(value).replace(/[^A-Z0-9]/g, "");
const litros = (value) => `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const linha = () => console.log("-".repeat(78));

const links = arg("vinculos").split(/[;\n,]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
  const [plate, name] = part.split("=").map((value) => value?.trim());
  if (!plate || !name) throw new Error(`Vínculo inválido: "${part}" (use PLACA=NOME).`);
  return { plate: plate.toUpperCase(), key: plateKey(plate), name: normalize(name) };
});
const EMPRESA = normalize(arg("empresa"));
// O responsável casa pelo nome inteiro ou pelo primeiro nome ("Reginaldo Silva" → REGINALDO).
const matchName = (responsible) => {
  const value = normalize(responsible);
  return links.find((link) => value === link.name || value.split(" ")[0] === link.name) ?? null;
};

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  if (!links.length) throw new Error("Informe os vínculos em --vinculos (ex.: \"QEH4C88=REGINALDO; NTA0B14=ANDRE\").");
  const vehicles = (await client.query(`SELECT v.id,v.plate,v.plate_key,v.active,p.id AS party_id,p.name AS party_name,p.kind,p.active AS party_active
    FROM third_party_vehicles v JOIN third_parties p ON p.id=v.third_party_id WHERE v.plate_key = ANY($1)`, [links.map((link) => link.key)])).rows;
  const rows = (await client.query(`SELECT fm.id,fm.movement_date,fm.quantity,fm.responsible,fm.imported_vehicle,sf.name AS front
    FROM fuel_movements fm JOIN service_fronts sf ON sf.id=fm.service_front_id
    WHERE fm.deleted_at IS NULL AND fm.movement_type='SAIDA' AND fm.vehicle_pending=true
      AND (upper(coalesce(fm.imported_vehicle,'')) LIKE '%TESTE%' OR upper(coalesce(fm.imported_vehicle,'')) LIKE 'A IDENTIFICAR%')
    ORDER BY fm.movement_date,fm.id`)).rows;

  linha();
  console.log(CONFIRMAR ? "VÍNCULO DAS SAÍDAS \"TESTE\" AOS CAMINHÕES — GRAVANDO" : "SIMULAÇÃO DO VÍNCULO DAS SAÍDAS \"TESTE\" AOS CAMINHÕES — nada será gravado");
  linha();
  console.log("Caminhões no cadastro de Terceiros:");
  for (const link of links) {
    const found = vehicles.filter((vehicle) => vehicle.plate_key === link.key);
    console.log(`  ${link.plate.padEnd(9)} ${link.name.padEnd(12)} ${found.length === 0 ? "NÃO CADASTRADO" : found.map((vehicle) => `${vehicle.party_name} (${vehicle.kind}${vehicle.active && vehicle.party_active ? "" : ", INATIVO"})`).join(" | ")}`);
  }
  // Agrupado por nome: dois motoristas podem usar o mesmo caminhão.
  const matched = new Map(links.map((link) => [link.name, []]));
  const unmatched = new Map();
  for (const row of rows) {
    const link = matchName(row.responsible);
    if (link) matched.get(link.name).push(row);
    else { const key = row.responsible ? normalize(row.responsible) : "(sem responsável)"; unmatched.set(key, [...(unmatched.get(key) ?? []), row]); }
  }
  linha();
  console.log(`Saídas "teste" pendentes encontradas: ${rows.length}`);
  for (const link of links) {
    const list = matched.get(link.name);
    const fronts = [...new Set(list.map((row) => row.front))].join(", ");
    console.log(`  ${link.name.padEnd(12)} → ${link.plate.padEnd(9)} ${String(list.length).padStart(4)} saídas  ${litros(list.reduce((sum, row) => sum + Number(row.quantity), 0)).padStart(14)}${list.length ? `  (${list[0].movement_date} a ${list[list.length - 1].movement_date}; ${fronts})` : ""}`);
  }
  if (unmatched.size) {
    console.log(`Continuam pendentes (responsável fora da lista): ${[...unmatched.values()].reduce((sum, list) => sum + list.length, 0)}`);
    for (const [name, list] of [...unmatched].sort((a, b) => b[1].length - a[1].length)) console.log(`    ${String(list.length).padStart(4)}×  ${name}`);
  }

  // Caminhão sem cadastro: cria no prestador informado em --empresa.
  const missing = links.filter((link, index) => !vehicles.some((vehicle) => vehicle.plate_key === link.key) && links.findIndex((other) => other.key === link.key) === index);
  const ambiguous = links.filter((link) => vehicles.filter((vehicle) => vehicle.plate_key === link.key).length > 1);
  if (ambiguous.length) throw new Error(`Placa cadastrada em mais de um terceiro: ${ambiguous.map((link) => link.plate).join(", ")}. Resolva no cadastro antes.`);
  if (missing.length) console.log(EMPRESA ? `Serão cadastrados no prestador ${EMPRESA}: ${missing.map((link) => link.plate).join(", ")}` : `Sem cadastro e sem --empresa: ${missing.map((link) => link.plate).join(", ")} (informe a empresa para criar).`);
  linha();
  if (!CONFIRMAR) { console.log("Simulação concluída. Para gravar, rode de novo em modo confirmar."); linha(); }
  else {
    if (missing.length && !EMPRESA) throw new Error("Há caminhões sem cadastro: informe --empresa (nome do prestador) para criá-los.");
    await client.query("BEGIN");
    const now = new Date().toISOString();
    let party = null;
    if (missing.length) {
      party = (await client.query(`SELECT id,name FROM third_parties WHERE upper(name)=$1 LIMIT 1`, [EMPRESA])).rows[0]
        ?? (await client.query(`INSERT INTO third_parties (name,kind,active,notes,created_at,updated_at) VALUES ($1,'PRESTADOR',true,'Cadastrado no vínculo das saídas "teste"',$2,$2) RETURNING id,name`, [EMPRESA, now])).rows[0];
      for (const link of missing) {
        const created = (await client.query(`INSERT INTO third_party_vehicles (third_party_id,plate,plate_key,vehicle_type,meter_type,active,created_at,updated_at)
          VALUES ($1,$2,$3,'CAMINHAO','KM',true,$4,$4) RETURNING id`, [party.id, link.plate, link.key, now])).rows[0];
        vehicles.push({ id: created.id, plate: link.plate, plate_key: link.key, active: true, party_id: party.id, party_name: party.name, kind: "PRESTADOR", party_active: true });
      }
    }
    let updated = 0;
    for (const link of links) {
      const vehicle = vehicles.find((item) => item.plate_key === link.key);
      const ids = matched.get(link.name).map((row) => row.id);
      if (!ids.length) continue;
      const result = await client.query(`UPDATE fuel_movements SET third_party=true, third_party_kind='PRESTADOR', third_party_id=$1, third_party_vehicle_id=$2,
          provider_company=$3, provider_equipment=$4, third_party_description=NULL, equipment_id=NULL, vehicle_pending=false,
          notes=trim(coalesce(notes,'') || ' ' || $5), updated_at=$6
        WHERE id = ANY($7) AND vehicle_pending=true`,
        [vehicle.party_id, vehicle.id, vehicle.party_name, vehicle.plate, `Vinculado ao caminhão ${vehicle.plate} (${vehicle.party_name}) pelo responsável ${link.name}.`, now, ids]);
      updated += result.rowCount;
    }
    await client.query(`INSERT INTO audit_logs (entity_type,entity_id,action,new_value,occurred_at) VALUES ('FUEL_MOVEMENT','vinculo-teste','SAÍDAS "TESTE" VINCULADAS A CAMINHÕES DE PRESTADOR',$1,$2)`,
      [JSON.stringify({ links: links.map(({ plate, name }) => ({ plate, name, saidas: matched.get(normalize(name)).map((row) => row.id) })) }), now]);
    await client.query("COMMIT");
    console.log(`Saídas vinculadas: ${updated}`);
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
