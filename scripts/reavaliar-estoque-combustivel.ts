// Reavaliação do estoque de combustível: a partir de --data (padrão: hoje, Fortaleza) o custo médio
// dos estoques do combustível passa a ser --valor. Grava UMA linha em fuel_stock_valuations — não
// altera nenhum lançamento: saídas anteriores à data continuam com o custo de antes, e as entradas
// futuras (com R$/L) entram na média a partir desse valor (lib/fuel-rules.ts:computeFuelCosts).
// Prévia por padrão (sessão somente leitura); grava só com --confirmar. Repetir não duplica.
// Uso: npx tsx scripts/reavaliar-estoque-combustivel.ts --valor=6,38 [--combustivel=diesel] [--data=AAAA-MM-DD] [--confirmar]
import "dotenv/config";

const CONFIRMAR = process.argv.includes("--confirmar");
if (!CONFIRMAR) process.env.DATABASE_READ_ONLY = "1";
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const VALOR = Number(arg("valor").replace(/\./g, "").replace(",", "."));
const COMBUSTIVEL = arg("combustivel") || "diesel";
const litros = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const reais = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 });

async function main() {
  if (!(VALOR > 0 && VALOR < 100)) throw new Error(`--valor inválido ("${arg("valor")}"). Ex.: --valor=6,38`);
  const { and, eq, ilike, isNull } = await import("drizzle-orm");
  const { getDb } = await import("../db");
  const { fuelMovements, fuelStockValuations, fuelTypes, serviceFronts } = await import("../db/schema");
  const { computeFuelCosts } = await import("../lib/fuel-rules");
  const { fuelLocalDay } = await import("../lib/fuel");
  const { loadFuelValuations } = await import("../lib/fuel-valuations");
  const DATA = arg("data") || fuelLocalDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATA)) throw new Error("--data deve ser AAAA-MM-DD.");
  const db = await getDb();

  const fuels = await db.select({ id: fuelTypes.id, name: fuelTypes.name }).from(fuelTypes).where(ilike(fuelTypes.name, `%${COMBUSTIVEL}%`));
  if (!fuels.length) throw new Error(`Nenhum combustível com "${COMBUSTIVEL}" no nome.`);
  const fronts = new Map((await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts)).map((row) => [row.id, row.name]));
  const movements = await db.select({
    id: fuelMovements.id, serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType,
    movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity, unitPrice: fuelMovements.unitPrice,
  }).from(fuelMovements).where(isNull(fuelMovements.deletedAt));
  const valuations = await loadFuelValuations(db);
  console.log(`Reavaliação: ${reais(VALOR)}/L a partir de ${DATA.split("-").reverse().join("/")} · ${fuels.map((fuel) => fuel.name).join(", ")}`);

  for (const fuel of fuels) {
    console.log(`\n== ${fuel.name}`);
    // Saldo atual de cada estoque (frente + local), como no formulário.
    const saldo = new Map<string, number>();
    const add = (frontId: number, location: string, delta: number) => saldo.set(`${frontId}:${location}`, (saldo.get(`${frontId}:${location}`) ?? 0) + delta);
    for (const m of movements.filter((item) => item.fuelTypeId === fuel.id)) {
      if (m.movementType === "ENTRADA") add(m.serviceFrontId, m.stockLocation, m.quantity);
      else if (m.movementType === "SAIDA") add(m.serviceFrontId, m.stockLocation, -m.quantity);
      else { add(m.serviceFrontId, m.stockLocation, -m.quantity); add(m.destinationFrontId ?? m.serviceFrontId, m.destinationLocation ?? "FRENTE", m.quantity); }
    }
    let total = 0;
    for (const [key, liters] of [...saldo].filter(([, value]) => Math.abs(value) > 0.005).sort()) {
      const [frontId, location] = key.split(":");
      total += liters;
      console.log(`  - ${fronts.get(Number(frontId)) ?? frontId} · ${location === "PORTO" ? "Porto" : "Frente"}: ${litros(liters)} → ${reais(liters * VALOR)}`);
    }
    console.log(`  Estoque total: ${litros(total)} → ${reais(total * VALOR)} a ${reais(VALOR)}/L`);

    // Efeito: só as saídas/transferências com data a partir da reavaliação mudam de custo.
    const fuelMovs = movements.filter((item) => item.fuelTypeId === fuel.id);
    const fuelVals = valuations.filter((item) => item.fuelTypeId === fuel.id);
    const antes = computeFuelCosts(fuelMovs, fuelVals);
    const depois = computeFuelCosts(fuelMovs, [...fuelVals, { id: Number.MAX_SAFE_INTEGER, fuelTypeId: fuel.id, serviceFrontId: null, stockLocation: null, effectiveDate: DATA, unitCost: VALOR }]);
    const mudam = fuelMovs.filter((item) => item.movementType !== "ENTRADA" && antes.get(item.id)?.cost !== depois.get(item.id)?.cost);
    const passado = mudam.filter((item) => item.movementDate < DATA);
    console.log(`  Lançamentos com data a partir de ${DATA} que passam a ${reais(VALOR)}/L: ${mudam.length}${mudam.length ? ` (${litros(mudam.reduce((sum, item) => sum + item.quantity, 0))})` : ""}`);
    console.log(`  Lançamentos antes de ${DATA} alterados: ${passado.length} (tem de ser 0)`);
    if (passado.length) throw new Error("A reavaliação mexeria no passado: nada foi gravado.");

    const existing = await db.select({ id: fuelStockValuations.id }).from(fuelStockValuations)
      .where(and(eq(fuelStockValuations.fuelTypeId, fuel.id), eq(fuelStockValuations.effectiveDate, DATA), eq(fuelStockValuations.unitCost, VALOR), isNull(fuelStockValuations.serviceFrontId), isNull(fuelStockValuations.stockLocation)))
      .catch(() => [] as Array<{ id: number }>);
    if (existing.length) { console.log(`  Já existe esta reavaliação (#${existing[0].id}). Nada a fazer.`); continue; }
    if (!CONFIRMAR) { console.log("  PRÉVIA: nada foi gravado. Rode com --confirmar para gravar."); continue; }
    const [row] = await db.insert(fuelStockValuations).values({
      fuelTypeId: fuel.id, serviceFrontId: null, stockLocation: null, effectiveDate: DATA, unitCost: VALOR,
      notes: `Estoque reavaliado a ${reais(VALOR)}/L (script reavaliar-estoque-combustivel)`,
    }).returning({ id: fuelStockValuations.id });
    console.log(`  GRAVADO: reavaliação #${row.id}. Para desfazer: DELETE FROM fuel_stock_valuations WHERE id = ${row.id};`);
  }
  process.exit(0);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
