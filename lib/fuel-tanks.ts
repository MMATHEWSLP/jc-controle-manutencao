import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { getDb } from "../db";
import { auditLogs, fuelMovements, fuelTankMeasurements, fuelTanks, fuelTypes, serviceFronts, users } from "../db/schema";
import type { SessionUser } from "./auth";
import { FUEL_LOCATION_LABELS, isFuelLocation, type FuelLocation } from "./fuel-rules";
import { DEFAULT_TOLERANCE_PERCENT, litersFromRuler, parseCalibration, reconcile, type CalibrationPoint } from "./fuel-tank-rules";

// ---------------------------------------------------------------------------
// Conciliação do tanque (medição física × saldo do sistema). Ver lib/fuel-tank-rules.ts.
// Ver: fuel.view · Lançar medição: fuel.register · Tanques, excluir e ajustar saldo: fuel.manage.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;

export class TankError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function tankErrorResponse(error: unknown) {
  return error instanceof TankError ? Response.json({ error: error.message }, { status: error.status }) : null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const number = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

function calibrationOf(text: string | null): CalibrationPoint[] {
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export async function listTanks(db: Db, visibleIds: number[]) {
  if (!visibleIds.length) return [];
  const rows = await db.select({
    id: fuelTanks.id, serviceFrontId: fuelTanks.serviceFrontId, front: serviceFronts.name, stockLocation: fuelTanks.stockLocation, fuelTypeId: fuelTanks.fuelTypeId,
    fuelType: fuelTypes.name, name: fuelTanks.name, capacityLiters: fuelTanks.capacityLiters, calibration: fuelTanks.calibration, tolerancePercent: fuelTanks.tolerancePercent, active: fuelTanks.active,
  }).from(fuelTanks).innerJoin(serviceFronts, eq(serviceFronts.id, fuelTanks.serviceFrontId)).innerJoin(fuelTypes, eq(fuelTypes.id, fuelTanks.fuelTypeId))
    .where(inArray(fuelTanks.serviceFrontId, visibleIds)).orderBy(asc(serviceFronts.name), asc(fuelTanks.stockLocation), asc(fuelTypes.name));
  return rows.map((row) => {
    const points = calibrationOf(row.calibration);
    return { ...row, calibrationPoints: points.length, calibrationText: points.map(([cm, liters]) => `${cm};${liters}`).join("\n"), maxCm: points.length ? points[points.length - 1][0] : null };
  });
}

export type TankInput = { serviceFrontId: number; stockLocation: FuelLocation; fuelTypeId: number; name: string; capacityLiters: number | null; calibrationText: string; tolerancePercent: number; active: boolean };

export function readTankBody(body: Record<string, unknown>): TankInput {
  const stockLocation = isFuelLocation(body.stockLocation) ? body.stockLocation : "FRENTE";
  const name = String(body.name ?? "").trim();
  const tolerance = number(body.tolerancePercent);
  if (!name) throw new TankError("Informe o nome do tanque (ex.: Tanque principal 30 mil).");
  if (tolerance !== null && (tolerance < 0 || tolerance > 20)) throw new TankError("A tolerância precisa ficar entre 0% e 20%.");
  const capacity = number(body.capacityLiters);
  if (capacity !== null && capacity <= 0) throw new TankError("A capacidade precisa ser maior que zero.");
  return { serviceFrontId: Number(body.serviceFrontId), stockLocation, fuelTypeId: Number(body.fuelTypeId), name, capacityLiters: capacity,
    calibrationText: String(body.calibrationText ?? ""), tolerancePercent: tolerance ?? DEFAULT_TOLERANCE_PERCENT, active: body.active !== false };
}

export async function saveTank(db: Db, user: SessionUser, visibleIds: number[], input: TankInput, id: number | null) {
  if (!visibleIds.includes(input.serviceFrontId)) throw new TankError("Você não tem acesso a esta frente.", 403);
  if (!(await db.select({ id: fuelTypes.id }).from(fuelTypes).where(eq(fuelTypes.id, input.fuelTypeId)).limit(1))[0]) throw new TankError("Escolha um combustível válido.");
  const parsed = parseCalibration(input.calibrationText);
  if (parsed.error) throw new TankError(parsed.error);
  const values = { serviceFrontId: input.serviceFrontId, stockLocation: input.stockLocation, fuelTypeId: input.fuelTypeId, name: input.name, capacityLiters: input.capacityLiters,
    calibration: parsed.points?.length ? JSON.stringify(parsed.points) : null, tolerancePercent: input.tolerancePercent, active: input.active, updatedAt: new Date().toISOString() };
  const duplicate = (await db.select({ id: fuelTanks.id }).from(fuelTanks).where(and(eq(fuelTanks.serviceFrontId, input.serviceFrontId), eq(fuelTanks.stockLocation, input.stockLocation), eq(fuelTanks.fuelTypeId, input.fuelTypeId))).limit(1))[0];
  if (duplicate && duplicate.id !== id) throw new TankError("Já existe um tanque cadastrado para essa frente, local e combustível.", 409);
  if (id) {
    const current = (await db.select({ serviceFrontId: fuelTanks.serviceFrontId }).from(fuelTanks).where(eq(fuelTanks.id, id)).limit(1))[0];
    if (!current || !visibleIds.includes(current.serviceFrontId)) throw new TankError("Tanque não encontrado.", 404);
    await db.update(fuelTanks).set(values).where(eq(fuelTanks.id, id));
  } else {
    id = (await db.insert(fuelTanks).values({ ...values, createdBy: user.id }).returning({ id: fuelTanks.id }))[0].id;
  }
  await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_TANK", entityId: String(id), action: "TANQUE DE COMBUSTÍVEL SALVO", newValue: JSON.stringify({ ...values, calibration: parsed.points?.length ?? 0 }) });
  return id;
}

// Saldo do sistema num estoque (frente + Frente/Porto + combustível) ao fim do dia `day`:
// entradas e transferências recebidas − saídas e transferências enviadas, incluindo ajustes.
export async function calculatedBalanceAt(db: Db, frontId: number, location: FuelLocation, fuelTypeId: number, day: string) {
  const rows = await db.select({
    serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, movementType: fuelMovements.movementType, quantity: fuelMovements.quantity,
  }).from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), eq(fuelMovements.fuelTypeId, fuelTypeId), lte(fuelMovements.movementDate, day),
    or(eq(fuelMovements.serviceFrontId, frontId), eq(fuelMovements.destinationFrontId, frontId))));
  let balance = 0;
  for (const row of rows) {
    const origin = row.serviceFrontId === frontId && (row.stockLocation ?? "FRENTE") === location;
    if (row.movementType === "ENTRADA") { if (origin) balance += row.quantity; continue; }
    if (origin) balance -= row.quantity;
    if (row.movementType === "TRANSFERENCIA" && (row.destinationFrontId ?? row.serviceFrontId) === frontId && (row.destinationLocation ?? "FRENTE") === location) balance += row.quantity;
  }
  return round2(balance);
}

export type MeasurementInput = { serviceFrontId: number; stockLocation: FuelLocation; fuelTypeId: number; measuredAt: string; method: "LITROS" | "REGUA"; rulerCm: number | null; liters: number | null; notes: string | null; adjust: boolean };

export function readMeasurementBody(body: Record<string, unknown>): MeasurementInput {
  const measuredAt = String(body.measuredAt ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(measuredAt)) throw new TankError("Informe a data e a hora da medição.");
  const method = body.method === "REGUA" ? "REGUA" : "LITROS";
  const rulerCm = number(body.rulerCm), liters = number(body.liters);
  if (method === "REGUA" && (rulerCm === null || rulerCm < 0)) throw new TankError("Informe a altura da régua em centímetros.");
  if (method === "LITROS" && (liters === null || liters < 0)) throw new TankError("Informe quantos litros foram medidos no tanque.");
  return { serviceFrontId: Number(body.serviceFrontId), stockLocation: isFuelLocation(body.stockLocation) ? body.stockLocation : "FRENTE", fuelTypeId: Number(body.fuelTypeId),
    measuredAt: measuredAt.slice(0, 16), method, rulerCm, liters, notes: String(body.notes ?? "").trim() || null, adjust: body.adjust === true };
}

export async function createMeasurement(db: Db, user: SessionUser, visibleIds: number[], input: MeasurementInput) {
  if (!visibleIds.includes(input.serviceFrontId)) throw new TankError("Você não tem acesso a esta frente.", 403);
  if (input.adjust && !user.permissions.includes("fuel.manage")) throw new TankError("Só quem gerencia o combustível pode ajustar o saldo pela medição.", 403);
  const day = input.measuredAt.slice(0, 10);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
  if (day > today) throw new TankError("A medição não pode ter data futura.");
  const tank = (await db.select().from(fuelTanks).where(and(eq(fuelTanks.serviceFrontId, input.serviceFrontId), eq(fuelTanks.stockLocation, input.stockLocation), eq(fuelTanks.fuelTypeId, input.fuelTypeId))).limit(1))[0] ?? null;
  let measured = input.liters;
  if (input.method === "REGUA") {
    const points = calibrationOf(tank?.calibration ?? null);
    if (!points.length) throw new TankError("Este tanque não tem tabela de régua cadastrada. Lance em litros ou cadastre a tabela em \"Tanques\".");
    measured = litersFromRuler(points, input.rulerCm!);
    if (measured === null) throw new TankError(`A altura ${input.rulerCm} cm está fora da tabela do tanque (0 a ${points[points.length - 1][0]} cm).`);
  }
  if (tank?.capacityLiters && measured! > tank.capacityLiters * 1.02) throw new TankError(`O valor medido passa da capacidade do tanque (${tank.capacityLiters.toLocaleString("pt-BR")} L). Confira a medição.`);
  const calculated = await calculatedBalanceAt(db, input.serviceFrontId, input.stockLocation, input.fuelTypeId, day);
  const tolerance = tank?.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;
  const result = reconcile(measured!, calculated, tolerance);
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    let adjustmentMovementId: number | null = null;
    if (input.adjust && result.difference !== 0) {
      adjustmentMovementId = (await tx.insert(fuelMovements).values({
        serviceFrontId: input.serviceFrontId, fuelTypeId: input.fuelTypeId, movementType: result.difference > 0 ? "ENTRADA" : "SAIDA", movementDate: day,
        quantity: Math.abs(result.difference), stockLocation: input.stockLocation, thirdParty: false, balanceAdjustment: true, originConfirmed: true, vehiclePending: false,
        responsible: user.name, notes: `Ajuste do saldo pela medição do tanque (${FUEL_LOCATION_LABELS[input.stockLocation]}) em ${day.split("-").reverse().join("/")}: sistema ${calculated} L, medido ${measured} L.`,
        createdBy: user.id, createdAt: now, updatedAt: now,
      }).returning({ id: fuelMovements.id }))[0].id;
    }
    const row = (await tx.insert(fuelTankMeasurements).values({
      serviceFrontId: input.serviceFrontId, stockLocation: input.stockLocation, fuelTypeId: input.fuelTypeId, tankId: tank?.id ?? null, measuredAt: input.measuredAt,
      method: input.method, rulerCm: input.method === "REGUA" ? input.rulerCm : null, measuredLiters: measured!, calculatedLiters: calculated, differenceLiters: result.difference,
      tolerancePercent: tolerance, adjustmentMovementId, notes: input.notes, createdBy: user.id, createdAt: now, updatedAt: now,
    }).returning({ id: fuelTankMeasurements.id }))[0];
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_TANK_MEASUREMENT", entityId: String(row.id), action: input.adjust ? "MEDIÇÃO DO TANQUE COM AJUSTE DE SALDO" : "MEDIÇÃO DO TANQUE",
      newValue: JSON.stringify({ ...input, measured, calculated, ...result, adjustmentMovementId }) });
    return { id: row.id, measured: measured!, calculated, ...result, adjustmentMovementId };
  });
}

export async function listMeasurements(db: Db, scopeFronts: number[], filters: { from: string | null; to: string | null; fuelTypeId: number | null }) {
  if (!scopeFronts.length) return [];
  const conditions = [isNull(fuelTankMeasurements.deletedAt), inArray(fuelTankMeasurements.serviceFrontId, scopeFronts)];
  if (filters.from) conditions.push(gte(fuelTankMeasurements.measuredAt, filters.from));
  if (filters.to) conditions.push(lte(fuelTankMeasurements.measuredAt, `${filters.to}T23:59`));
  if (filters.fuelTypeId) conditions.push(eq(fuelTankMeasurements.fuelTypeId, filters.fuelTypeId));
  const rows = await db.select({
    id: fuelTankMeasurements.id, serviceFrontId: fuelTankMeasurements.serviceFrontId, front: serviceFronts.name, stockLocation: fuelTankMeasurements.stockLocation,
    fuelTypeId: fuelTankMeasurements.fuelTypeId, fuelType: fuelTypes.name, measuredAt: fuelTankMeasurements.measuredAt, method: fuelTankMeasurements.method, rulerCm: fuelTankMeasurements.rulerCm,
    measuredLiters: fuelTankMeasurements.measuredLiters, calculatedLiters: fuelTankMeasurements.calculatedLiters, differenceLiters: fuelTankMeasurements.differenceLiters,
    tolerancePercent: fuelTankMeasurements.tolerancePercent, adjusted: fuelTankMeasurements.adjustmentMovementId, notes: fuelTankMeasurements.notes, createdBy: users.name,
  }).from(fuelTankMeasurements).innerJoin(serviceFronts, eq(serviceFronts.id, fuelTankMeasurements.serviceFrontId)).innerJoin(fuelTypes, eq(fuelTypes.id, fuelTankMeasurements.fuelTypeId))
    .leftJoin(users, eq(users.id, fuelTankMeasurements.createdBy)).where(and(...conditions)).orderBy(desc(fuelTankMeasurements.measuredAt), desc(fuelTankMeasurements.id)).limit(500);
  return rows.map((row) => ({ ...row, adjusted: row.adjusted !== null, ...reconcile(row.measuredLiters, row.calculatedLiters, row.tolerancePercent) }));
}

// Resumo por estoque (frente + local + combustível) no período: soma das diferenças e última medição.
export function summarizeMeasurements(rows: Awaited<ReturnType<typeof listMeasurements>>) {
  const groups = new Map<string, { front: string; stockLocation: string; fuelType: string; measurements: number; lossLiters: number; surplusLiters: number; outside: number; last: (typeof rows)[number] }>();
  for (const row of rows) {
    const key = `${row.serviceFrontId}|${row.stockLocation}|${row.fuelTypeId}`;
    const group = groups.get(key) ?? { front: row.front, stockLocation: row.stockLocation, fuelType: row.fuelType, measurements: 0, lossLiters: 0, surplusLiters: 0, outside: 0, last: row };
    group.measurements += 1;
    if (row.difference < 0) group.lossLiters = round2(group.lossLiters - row.difference); else group.surplusLiters = round2(group.surplusLiters + row.difference);
    if (row.status !== "OK") group.outside += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export async function deleteMeasurement(db: Db, user: SessionUser, visibleIds: number[], id: number) {
  const row = (await db.select().from(fuelTankMeasurements).where(and(eq(fuelTankMeasurements.id, id), isNull(fuelTankMeasurements.deletedAt))).limit(1))[0];
  if (!row || !visibleIds.includes(row.serviceFrontId)) throw new TankError("Medição não encontrada.", 404);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(fuelTankMeasurements).set({ deletedAt: now, deletedBy: user.id, updatedAt: now }).where(eq(fuelTankMeasurements.id, id));
    // O ajuste de saldo gerado pela medição sai junto (senão o saldo ficaria ajustado sem motivo).
    if (row.adjustmentMovementId) await tx.update(fuelMovements).set({ deletedAt: now, deletedBy: user.id, updatedAt: now }).where(eq(fuelMovements.id, row.adjustmentMovementId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_TANK_MEASUREMENT", entityId: String(id), action: "MEDIÇÃO DO TANQUE EXCLUÍDA", previousValue: JSON.stringify(row) });
  });
}
