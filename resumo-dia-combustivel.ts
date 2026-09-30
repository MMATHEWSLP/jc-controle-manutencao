// ---------------------------------------------------------------------------
// Conferência SOMENTE LEITURA do "Resumo do dia" do Combustível, com a MESMA função da tela
// (lib/fuel-daily.ts). Toda conexão abre em modo somente leitura (DATABASE_READ_ONLY, db/index.ts):
// o Postgres recusa qualquer gravação.
//
// Uso: npx tsx resumo-dia-combustivel.ts --data=2026-09-28 --frente=Arapiuns [--combustivel="Diesel S10"]
//      [--esperado=87033;3859;83174]   (saldo anterior; consumo; saldo final, para comparar)
// ---------------------------------------------------------------------------
process.env.DATABASE_READ_ONLY = "1";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3).trim() ?? "";
const toIso = (value: string) => { const br = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return br ? `${br[3]}-${br[2]}-${br[1]}` : value; };

async function main() {
  const { getD1, getDb } = await import("./db");
  const { fuelDailySummary } = await import("./lib/fuel-daily");
  const { litersMessage, DAILY_LOCATION_LABELS } = await import("./lib/fuel-daily-rules");
  const date = toIso(arg("data") || "2026-09-28");
  const frontName = arg("frente") || "Arapiuns";
  const fuelName = arg("combustivel") || "Diesel S10";
  const expected = (arg("esperado") || (date === "2026-09-28" ? "87033;3859;83174" : "")).split(";").filter(Boolean).map((value) => Number(value.replace(/\./g, "").replace(",", ".")));
  const d1 = await getD1();
  const readOnly = await d1.prepare("SHOW default_transaction_read_only").first<{ default_transaction_read_only: string }>();
  console.log(`Conexão somente leitura: ${readOnly?.default_transaction_read_only}`);
  if (readOnly?.default_transaction_read_only !== "on") throw new Error("A conexão não está em modo somente leitura; abortando.");
  const front = await d1.prepare("SELECT id,name FROM service_fronts WHERE name ILIKE ? ORDER BY length(name) LIMIT 1").bind(`%${frontName}%`).first<{ id: number; name: string }>();
  const fuel = await d1.prepare("SELECT id,name FROM fuel_types WHERE name ILIKE ? ORDER BY length(name) LIMIT 1").bind(`%${fuelName}%`).first<{ id: number; name: string }>();
  if (!front || !fuel) throw new Error(`Frente "${frontName}" ou combustível "${fuelName}" não encontrado.`);
  console.log(`Frente #${front.id} ${front.name} · ${fuel.name} · dia ${date}`);
  const db = await getDb();
  const line = () => console.log("-".repeat(100));
  for (const location of ["FRENTE", "PORTO", "TODOS"] as const) {
    const summary = await fuelDailySummary(db, { date, frontId: Number(front.id), fuelTypeId: Number(fuel.id), location });
    const t = summary.totals;
    line();
    console.log(`ESTOQUE ${DAILY_LOCATION_LABELS[location].toUpperCase()}`);
    console.log(`  saldo anterior ${litersMessage(t.previous)} | entradas ${litersMessage(t.entries)} | transf. recebidas ${litersMessage(t.transfersIn)} | transf. enviadas ${litersMessage(t.transfersOut)} | ajustes ${litersMessage(t.adjustments)} | consumo ${litersMessage(t.consumption)} (${summary.exits.length} saídas) | saldo final ${litersMessage(t.final)}`);
    console.log(`  saldo pela conta do formulário (computeFuelBalances até o dia): ${litersMessage(summary.ledgerBalance)} ${summary.ledgerBalance === t.final ? "= confere" : "≠ DIVERGE"}`);
    if (expected.length === 3) {
      const diff = [t.previous - expected[0], t.consumption - expected[1], t.final - expected[2]].map((value) => Math.round(value * 1000) / 1000);
      console.log(`  esperado: anterior ${litersMessage(expected[0])} · consumo ${litersMessage(expected[1])} · saldo ${litersMessage(expected[2])} → diferença: anterior ${litersMessage(diff[0])} · consumo ${litersMessage(diff[1])} · saldo ${litersMessage(diff[2])}${diff.every((value) => value === 0) ? "  ✔ BATE" : ""}`);
    }
    if (location === "FRENTE") { console.log("  MENSAGEM:"); for (const text of summary.message.split("\n")) console.log(`    ${text}`); }
  }
  line();
  const rows = async (title: string, query: string, binds: unknown[]) => {
    const list = (await d1.prepare(query).bind(...binds).all<Record<string, unknown>>()).results;
    console.log(`${title}: ${list.length}`);
    for (const row of list) console.log(`  #${String(row.id).padEnd(6)} ${row.movement_date} ${String(row.movement_type).padEnd(13)} ${String(row.stock_location).padEnd(6)}→${String(row.dest ?? "").padEnd(18)} ${String(Number(row.quantity).toLocaleString("pt-BR")).padStart(9)} L  ${String(row.who ?? "").padEnd(22)} ${row.adj ? "AJUSTE " : ""}criado ${String(row.created_at).slice(0, 16)}${row.deleted_at ? ` EXCLUÍDO ${String(row.deleted_at).slice(0, 16)}` : ""}  ${String(row.notes ?? "").slice(0, 50)}`);
  };
  const base = `SELECT fm.id,fm.movement_date,fm.movement_type,fm.stock_location,fm.quantity,fm.balance_adjustment AS adj,fm.created_at,fm.deleted_at,fm.notes,
      CASE WHEN fm.movement_type='TRANSFERENCIA' THEN coalesce(df.name,'')||' '||coalesce(fm.destination_location,'') END AS dest,
      coalesce(e.prefix, tv.plate, fm.provider_equipment, fm.third_party_description, fm.imported_vehicle, fm.origin) AS who
    FROM fuel_movements fm LEFT JOIN service_fronts df ON df.id=fm.destination_front_id LEFT JOIN equipment e ON e.id=fm.equipment_id
    LEFT JOIN third_party_vehicles tv ON tv.id=fm.third_party_vehicle_id
    WHERE fm.fuel_type_id=? AND (fm.service_front_id=? OR fm.destination_front_id=?)`;
  const ids = [fuel.id, front.id, front.id];
  await rows(`Lançamentos do dia ${date} (não excluídos)`, `${base} AND fm.deleted_at IS NULL AND fm.movement_date=? ORDER BY fm.movement_type, who, fm.id`, [...ids, date]);
  line();
  await rows(`Lançamentos com data ATÉ ${date} criados DEPOIS do dia (mudam o saldo anterior/consumo)`, `${base} AND fm.deleted_at IS NULL AND fm.movement_date<=? AND fm.created_at>=? ORDER BY fm.created_at`, [...ids, date, `${new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)}T03:00:00.000Z`]);
  line();
  await rows(`Ajustes de saldo e lançamentos excluídos entre ${date} e hoje (data do lançamento)`, `${base} AND (fm.balance_adjustment OR fm.deleted_at IS NOT NULL) AND fm.movement_date>=? ORDER BY fm.movement_date, fm.id`, [...ids, date]);
  line();
  console.log("Nenhum dado foi alterado (conexão somente leitura).");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
