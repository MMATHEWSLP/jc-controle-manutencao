import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { equipment, fuelMovements, fuelTypes, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { computeFuelBalances, FUEL_MOVEMENT_LABELS, isFuelMovementType, type FuelMovementType } from "./fuel-rules";

type Db = Awaited<ReturnType<typeof getDb>>;

export function fuelLocalDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function monthStart(day: string) {
  return `${day.slice(0, 7)}-01`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FuelFilters = { from: string; to: string; fuelTypeId: number | null; movementType: FuelMovementType | null; frontId: number | null; q: string };

// Filtros do Histórico/exportação (mesma query string da tela). Período padrão = mês corrente.
export function parseFuelFilters(params: URLSearchParams): FuelFilters {
  const today = fuelLocalDay();
  const from = DATE.test(params.get("from") ?? "") ? params.get("from")! : monthStart(today);
  const to = DATE.test(params.get("to") ?? "") ? params.get("to")! : today;
  const fuelTypeId = Number(params.get("fuelTypeId")) || null;
  const movementType = isFuelMovementType(params.get("movementType")) ? params.get("movementType") as FuelMovementType : null;
  const frontId = Number(params.get("frontId")) || null;
  return { from: from <= to ? from : to, to: from <= to ? to : from, fuelTypeId, movementType, frontId, q: (params.get("q") ?? "").trim() };
}

export async function activeFuelTypes(db: Db) {
  return db.select({ id: fuelTypes.id, code: fuelTypes.code, name: fuelTypes.name, unit: fuelTypes.unit })
    .from(fuelTypes).where(eq(fuelTypes.active, true)).orderBy(asc(fuelTypes.sortOrder), asc(fuelTypes.name));
}

export async function fuelVisibleFronts(db: Db, user: SessionUser) {
  const fronts = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name));
  const visible = frentesVisiveis(user);
  return visible === "ALL" ? fronts : fronts.filter((front) => visible.includes(front.id));
}

// Frentes em exibição no módulo: o seletor global (lib/active-front.ts) já restringido ao que a
// pessoa enxerga; um filtro de frente da própria tela pode restringir ainda mais.
export function fuelScopeFronts(visibleIds: number[], displayed: number[] | "ALL", frontFilter: number | null) {
  let scope = displayed === "ALL" ? visibleIds : visibleIds.filter((id) => displayed.includes(id));
  if (frontFilter && scope.includes(frontFilter)) scope = [frontFilter];
  return scope;
}

export async function fuelBalances(db: Db, scopeFronts: number[], from: string, to: string) {
  if (scopeFronts.length === 0) return computeFuelBalances([], { fronts: [], from, to });
  const rows = await db.select({
    serviceFrontId: fuelMovements.serviceFrontId, destinationFrontId: fuelMovements.destinationFrontId, fuelTypeId: fuelMovements.fuelTypeId,
    movementType: fuelMovements.movementType, movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity,
  }).from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), or(inArray(fuelMovements.serviceFrontId, scopeFronts), inArray(fuelMovements.destinationFrontId, scopeFronts))));
  return computeFuelBalances(rows, { fronts: scopeFronts, from, to });
}

const destinationFront = alias(serviceFronts, "destination_front");
const creator = alias(users, "creator");

function historyWhere(scopeFronts: number[], filters: FuelFilters): SQL | undefined {
  if (scopeFronts.length === 0) return sql`FALSE`;
  const conditions: (SQL | undefined)[] = [
    isNull(fuelMovements.deletedAt),
    or(inArray(fuelMovements.serviceFrontId, scopeFronts), inArray(fuelMovements.destinationFrontId, scopeFronts)),
    gte(fuelMovements.movementDate, filters.from),
    lte(fuelMovements.movementDate, filters.to),
  ];
  if (filters.fuelTypeId) conditions.push(eq(fuelMovements.fuelTypeId, filters.fuelTypeId));
  if (filters.movementType) conditions.push(eq(fuelMovements.movementType, filters.movementType));
  if (filters.q) {
    const like = `%${filters.q}%`;
    conditions.push(or(ilike(equipment.prefix, like), ilike(fuelMovements.origin, like), ilike(fuelMovements.responsible, like), ilike(fuelMovements.notes, like)));
  }
  return and(...conditions);
}

export async function fuelHistory(db: Db, scopeFronts: number[], filters: FuelFilters, limit: number, offset = 0) {
  const where = historyWhere(scopeFronts, filters);
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: fuelMovements.id, serviceFrontId: fuelMovements.serviceFrontId, frontName: serviceFronts.name,
      fuelTypeId: fuelMovements.fuelTypeId, fuelName: fuelTypes.name, unit: fuelTypes.unit,
      movementType: fuelMovements.movementType, movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity,
      origin: fuelMovements.origin, equipmentId: fuelMovements.equipmentId, equipmentPrefix: equipment.prefix,
      equipmentModel: sql<string | null>`trim(concat(${equipment.brand}, ' ', ${equipment.model}))`,
      meterReading: fuelMovements.meterReading, meterUnit: fuelMovements.meterUnit,
      destinationFrontId: fuelMovements.destinationFrontId, destinationFrontName: destinationFront.name,
      responsible: fuelMovements.responsible, notes: fuelMovements.notes, createdByName: creator.name, createdAt: fuelMovements.createdAt,
    }).from(fuelMovements)
      .innerJoin(serviceFronts, eq(fuelMovements.serviceFrontId, serviceFronts.id))
      .innerJoin(fuelTypes, eq(fuelMovements.fuelTypeId, fuelTypes.id))
      .leftJoin(equipment, eq(fuelMovements.equipmentId, equipment.id))
      .leftJoin(destinationFront, eq(fuelMovements.destinationFrontId, destinationFront.id))
      .leftJoin(creator, eq(fuelMovements.createdBy, creator.id))
      .where(where).orderBy(desc(fuelMovements.movementDate), desc(fuelMovements.id)).limit(limit).offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(fuelMovements).leftJoin(equipment, eq(fuelMovements.equipmentId, equipment.id)).where(where),
  ]);
  return { rows: rows.map((row) => ({ ...row, movementLabel: FUEL_MOVEMENT_LABELS[row.movementType] })), total };
}

export type FuelHistoryRow = Awaited<ReturnType<typeof fuelHistory>>["rows"][number];

export async function fuelEquipmentContext(db: Db, equipmentId: number) {
  const row = (await db.select({ id: equipment.id, prefix: equipment.prefix, serviceFrontId: equipment.serviceFrontId, frontName: serviceFronts.name, controlType: equipment.controlType })
    .from(equipment).leftJoin(serviceFronts, eq(equipment.serviceFrontId, serviceFronts.id)).where(eq(equipment.id, equipmentId)).limit(1))[0];
  return row ?? null;
}

// Frente do lançamento: quem enxerga uma frente só nem escolhe (vai a dela); quem enxerga várias
// escolhe no formulário, com a frente do seletor global como padrão.
export function resolveFuelFront(visibleIds: number[], requested: unknown, displayed: number[] | "ALL", user: SessionUser): number | null {
  if (visibleIds.length === 1) return visibleIds[0];
  const wanted = Number(requested);
  if (Number.isInteger(wanted) && visibleIds.includes(wanted)) return wanted;
  if (requested !== undefined && requested !== null && requested !== "") return null;
  if (displayed !== "ALL" && displayed.length === 1 && visibleIds.includes(displayed[0])) return displayed[0];
  if (user.serviceFrontId && visibleIds.includes(user.serviceFrontId) && frentesVisiveis(user) !== "ALL") return user.serviceFrontId;
  return null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().replace(/\s/g, "");
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "") || null;

// Campos do formulário "Novo Registro" (a frente é resolvida à parte, por resolveFuelFront).
export function readFuelMovementBody(body: Record<string, unknown>) {
  const movementType = isFuelMovementType(body.movementType) ? body.movementType : ("" as FuelMovementType);
  const equipmentId = Number(body.equipmentId) || null;
  return {
    fuelTypeId: Number(body.fuelTypeId) || 0,
    movementType,
    movementDate: typeof body.movementDate === "string" ? body.movementDate.slice(0, 10) : "",
    quantity: numberOrNull(body.quantity) ?? NaN,
    origin: text(body.origin),
    equipmentId,
    meterReading: numberOrNull(body.meterReading),
    destinationFrontId: movementType === "TRANSFERENCIA" ? Number(body.destinationFrontId) || null : null,
    responsible: text(body.responsible),
    notes: text(body.notes),
  };
}
