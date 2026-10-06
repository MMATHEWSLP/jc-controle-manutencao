import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { getDb } from "../db";
import { equipment, fuelDailySettings, fuelMovements, fuelTypes, serviceFronts, thirdParties, thirdPartyVehicles } from "../db/schema";
import { computeFuelBalances } from "./fuel-rules";
import { pendingConvoyForDay } from "./convoy";
import { DEFAULT_DAILY_SETTINGS, dailyMessage, dailyTotals, transferPlace, type DailyLocation, type DailyMessageSettings, type DailyMovement, type DailyTransfer } from "./fuel-daily-rules";

// ---------------------------------------------------------------------------
// Resumo do dia (Combustível → Histórico → "Resumo do dia"): UMA consulta para a mensagem do
// WhatsApp, o modal e o PDF — os números nunca divergem. Regras em lib/fuel-daily-rules.ts.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;

export type DailyExit = {
  id: number; equipment: string; plate: string | null; kind: "FROTA" | "TERCEIRO" | "PRESTADOR"; company: string | null;
  liters: number; reading: number | null; readingUnit: "KM" | "HOURS" | null; responsible: string | null; notes: string | null; location: "FRENTE" | "PORTO";
};
// Transferência do dia com o outro lado já por extenso ("Frente Fazendinha") — mensagem, modal e PDF.
export type DailyTransferRow = DailyTransfer & { place: string; responsible: string | null; notes: string | null };
export const DAILY_EXIT_KIND_LABELS: Record<DailyExit["kind"], string> = { FROTA: "Frota", TERCEIRO: "Terceiro", PRESTADOR: "Prestador" };

export async function dailySettings(db: Db, frontId: number): Promise<DailyMessageSettings & { configured: boolean }> {
  let row: typeof fuelDailySettings.$inferSelect | undefined;
  // Antes da migração 0036 a tabela não existe: usa os textos padrão (os números não dependem dela).
  try { [row] = await db.select().from(fuelDailySettings).where(eq(fuelDailySettings.serviceFrontId, frontId)).limit(1); }
  catch (error) { if ((error as { cause?: { code?: string } })?.cause?.code !== "42P01") throw error; }
  return row ? { greeting: row.greeting, title: row.title, balanceLabel: row.balanceLabel, configured: true } : { ...DEFAULT_DAILY_SETTINGS, configured: false };
}

export async function fuelDailySummary(db: Db, input: { date: string; frontId: number; fuelTypeId: number; location: DailyLocation }) {
  const [front, fuel] = await Promise.all([
    db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, input.frontId)).limit(1).then((rows) => rows[0] ?? null),
    db.select({ id: fuelTypes.id, name: fuelTypes.name }).from(fuelTypes).where(eq(fuelTypes.id, input.fuelTypeId)).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!front) throw new Error("Frente não encontrada.");
  if (!fuel) throw new Error("Combustível não encontrado.");
  // Todos os lançamentos do combustível que tocam a frente (origem ou destino) até o fim do dia.
  const movements = (await db.select({
    id: fuelMovements.id, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType, movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity,
    serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, balanceAdjustment: fuelMovements.balanceAdjustment,
  }).from(fuelMovements).where(and(
    isNull(fuelMovements.deletedAt), eq(fuelMovements.fuelTypeId, input.fuelTypeId), lte(fuelMovements.movementDate, input.date),
    or(eq(fuelMovements.serviceFrontId, input.frontId), eq(fuelMovements.destinationFrontId, input.frontId)),
  ))) as DailyMovement[];
  const totals = dailyTotals(movements, input);
  // Conferência com o saldo do formulário (mesma conta de computeFuelBalances, até o fim do dia).
  const ledger = computeFuelBalances(movements, { fronts: [input.frontId], from: input.date, to: input.date }).get(input.fuelTypeId)?.byFront.get(input.frontId);
  const ledgerBalance = ledger ? (input.location === "TODOS" ? ledger.balance : ledger.byLocation[input.location].balance) : 0;

  const exits: DailyExit[] = totals.exitIds.length ? (await db.select({
    id: fuelMovements.id, quantity: fuelMovements.quantity, prefix: equipment.prefix, equipmentPlate: equipment.plate, thirdParty: fuelMovements.thirdParty,
    thirdPartyKind: fuelMovements.thirdPartyKind, partyName: thirdParties.name, vehiclePlate: thirdPartyVehicles.plate, providerCompany: fuelMovements.providerCompany,
    providerEquipment: fuelMovements.providerEquipment, thirdPartyDescription: fuelMovements.thirdPartyDescription, importedVehicle: fuelMovements.importedVehicle,
    meterReading: fuelMovements.meterReading, meterUnit: fuelMovements.meterUnit, responsible: fuelMovements.responsible, notes: fuelMovements.notes, stockLocation: fuelMovements.stockLocation,
  }).from(fuelMovements)
    .leftJoin(equipment, eq(equipment.id, fuelMovements.equipmentId))
    .leftJoin(thirdParties, eq(thirdParties.id, fuelMovements.thirdPartyId))
    .leftJoin(thirdPartyVehicles, eq(thirdPartyVehicles.id, fuelMovements.thirdPartyVehicleId))
    .where(inArray(fuelMovements.id, totals.exitIds))).map((row) => {
    const kind: DailyExit["kind"] = !row.thirdParty ? "FROTA" : row.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "TERCEIRO";
    const plate = kind === "FROTA" ? row.equipmentPlate : row.vehiclePlate ?? row.providerEquipment ?? null;
    return {
      id: row.id, kind, plate: plate || null, liters: row.quantity,
      equipment: kind === "FROTA" ? row.prefix ?? (row.importedVehicle ? `A identificar (${row.importedVehicle})` : "—") : row.vehiclePlate ?? row.providerEquipment ?? row.thirdPartyDescription ?? "—",
      company: kind === "FROTA" ? null : row.partyName ?? row.providerCompany ?? row.thirdPartyDescription ?? null,
      reading: row.meterReading, readingUnit: row.meterUnit, responsible: row.responsible, notes: row.notes, location: row.stockLocation,
    };
  }).sort((a, b) => a.equipment.localeCompare(b.equipment, "pt-BR", { numeric: true, sensitivity: "base" }) || a.id - b.id) : [];

  // Nomes das frentes do outro lado das transferências; responsável e observação de cada uma.
  const otherFrontIds = [...new Set(totals.transfers.map((transfer) => transfer.frontId))];
  const frontNames: Record<number, string> = { [front.id]: front.name };
  if (otherFrontIds.length) for (const row of await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(inArray(serviceFronts.id, otherFrontIds))) frontNames[row.id] = row.name;
  const transferInfo = new Map(totals.transferIds.length ? (await db.select({ id: fuelMovements.id, responsible: fuelMovements.responsible, notes: fuelMovements.notes })
    .from(fuelMovements).where(inArray(fuelMovements.id, totals.transferIds))).map((row) => [row.id, row] as const) : []);
  const transfers: DailyTransferRow[] = totals.transfers.map((transfer) => ({
    ...transfer, place: transferPlace(transfer, frontNames), responsible: transferInfo.get(transfer.id)?.responsible ?? null, notes: transferInfo.get(transfer.id)?.notes ?? null,
  }));

  // Abastecimentos do comboio do dia ainda não aprovados: não entram nas saídas nem no saldo.
  const convoyPending = await pendingConvoyForDay(db, input.frontId, input.date, input.fuelTypeId).catch(() => ({ liters: 0, count: 0 }));
  const settings = await dailySettings(db, input.frontId);
  const exitsLiters = Math.round(exits.reduce((sum, row) => sum + row.liters, 0) * 1000) / 1000;
  return {
    date: input.date, location: input.location, front, fuel, totals, exits, exitsLiters, transfers, settings, convoyPending,
    // Deve ser sempre igual a totals.final (e a totals.consumption no caso das saídas).
    ledgerBalance: Math.round(ledgerBalance * 1000) / 1000,
    message: dailyMessage({ settings, frontName: front.name, fuelName: fuel.name, date: input.date, totals, frontNames }),
  };
}
export type FuelDailySummary = Awaited<ReturnType<typeof fuelDailySummary>>;
