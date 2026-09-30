import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { employees, equipment, fuelMovements, fuelTypes, serviceFronts, thirdParties, thirdPartyVehicles, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { consumptionByMovement } from "./third-parties";
import { computeFuelBalances, computeFuelCosts, FUEL_LOCATION_LABELS, fuelMovementLabel, isFuelLocation, isFuelMovementType, type FuelLocation, type FuelMovementType } from "./fuel-rules";

type Db = Awaited<ReturnType<typeof getDb>>;

export function fuelLocalDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function monthStart(day: string) {
  return `${day.slice(0, 7)}-01`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// movementType "TERCEIROS" = só as saídas para terceiros. location = estoque Frente/Porto (origem ou destino).
// pending = pendências da carga de histórico: VEICULO (veículo a identificar), ORIGEM (Frente/Porto
// a confirmar) ou IMPORTADOS (todo lançamento vindo de importação).
export type FuelPendingFilter = "VEICULO" | "ORIGEM" | "IMPORTADOS";
// thirdPartyId / vehicleId = empresa e veículo do cadastro de Terceiros.
export type FuelFilters = { from: string; to: string; fuelTypeId: number | null; movementType: FuelMovementType | "TERCEIROS" | "PRESTADORES" | null; location: FuelLocation | null; frontId: number | null; q: string; pending: FuelPendingFilter | null; thirdPartyId: number | null; vehicleId: number | null; equipmentId?: number | null };

// Filtros do Histórico/exportação (mesma query string da tela). Período padrão = mês corrente.
export function parseFuelFilters(params: URLSearchParams): FuelFilters {
  const today = fuelLocalDay();
  const from = DATE.test(params.get("from") ?? "") ? params.get("from")! : monthStart(today);
  const to = DATE.test(params.get("to") ?? "") ? params.get("to")! : today;
  const fuelTypeId = Number(params.get("fuelTypeId")) || null;
  const rawType = params.get("movementType");
  const movementType = rawType === "TERCEIROS" || rawType === "PRESTADORES" ? rawType : isFuelMovementType(rawType) ? rawType : null;
  const location = isFuelLocation(params.get("location")) ? params.get("location") as FuelLocation : null;
  const frontId = Number(params.get("frontId")) || null;
  const rawPending = params.get("pending");
  const pending = rawPending === "VEICULO" || rawPending === "ORIGEM" || rawPending === "IMPORTADOS" ? rawPending : null;
  return {
    from: from <= to ? from : to, to: from <= to ? to : from, fuelTypeId, movementType, location, frontId, q: (params.get("q") ?? "").trim(), pending,
    thirdPartyId: Number(params.get("thirdPartyId")) || null, vehicleId: Number(params.get("vehicleId")) || null,
  };
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
    serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType, movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity,
    balanceAdjustment: fuelMovements.balanceAdjustment,
  }).from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), or(inArray(fuelMovements.serviceFrontId, scopeFronts), inArray(fuelMovements.destinationFrontId, scopeFronts))));
  return computeFuelBalances(rows, { fronts: scopeFronts, from, to });
}

const destinationFront = alias(serviceFronts, "destination_front");
const creator = alias(users, "creator");

function historyWhere(scopeFronts: number[], filters: FuelFilters): SQL | undefined {
  if (scopeFronts.length === 0) return sql`FALSE`;
  const conditions: (SQL | undefined)[] = [
    isNull(fuelMovements.deletedAt),
    // Ajustes de saldo não são movimentação: não aparecem no Histórico nem na exportação.
    eq(fuelMovements.balanceAdjustment, false),
    or(inArray(fuelMovements.serviceFrontId, scopeFronts), inArray(fuelMovements.destinationFrontId, scopeFronts)),
    gte(fuelMovements.movementDate, filters.from),
    lte(fuelMovements.movementDate, filters.to),
  ];
  if (filters.fuelTypeId) conditions.push(eq(fuelMovements.fuelTypeId, filters.fuelTypeId));
  if (filters.thirdPartyId) conditions.push(eq(fuelMovements.thirdPartyId, filters.thirdPartyId));
  if (filters.vehicleId) conditions.push(eq(fuelMovements.thirdPartyVehicleId, filters.vehicleId));
  // Equipamento da frota (Assistente JC).
  if (filters.equipmentId) conditions.push(eq(fuelMovements.equipmentId, filters.equipmentId));
  // TERCEIROS = saída para terceiros geral; PRESTADORES = prestadores de serviço.
  if (filters.movementType === "TERCEIROS") conditions.push(and(eq(fuelMovements.thirdParty, true), sql`coalesce(${fuelMovements.thirdPartyKind}, 'GERAL') <> 'PRESTADOR'`));
  else if (filters.movementType === "PRESTADORES") conditions.push(and(eq(fuelMovements.thirdParty, true), eq(fuelMovements.thirdPartyKind, "PRESTADOR")));
  else if (filters.movementType) conditions.push(eq(fuelMovements.movementType, filters.movementType));
  if (filters.pending === "VEICULO") conditions.push(eq(fuelMovements.vehiclePending, true));
  else if (filters.pending === "ORIGEM") conditions.push(eq(fuelMovements.originConfirmed, false));
  else if (filters.pending === "IMPORTADOS") conditions.push(isNotNull(fuelMovements.importSource));
  if (filters.location) conditions.push(or(eq(fuelMovements.stockLocation, filters.location), and(eq(fuelMovements.movementType, "TRANSFERENCIA"), eq(fuelMovements.destinationLocation, filters.location))));
  if (filters.q) {
    const like = `%${filters.q}%`;
    conditions.push(or(ilike(equipment.prefix, like), ilike(fuelMovements.origin, like), ilike(fuelMovements.thirdPartyDescription, like), ilike(fuelMovements.providerCompany, like), ilike(fuelMovements.providerEquipment, like), ilike(fuelMovements.responsible, like), ilike(fuelMovements.notes, like), ilike(fuelMovements.importedVehicle, like)));
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
      origin: fuelMovements.origin, stockLocation: fuelMovements.stockLocation, destinationLocation: fuelMovements.destinationLocation,
      thirdParty: fuelMovements.thirdParty, thirdPartyKind: fuelMovements.thirdPartyKind, thirdPartyDescription: fuelMovements.thirdPartyDescription,
      providerCompany: fuelMovements.providerCompany, providerEquipment: fuelMovements.providerEquipment, unitPrice: fuelMovements.unitPrice,
      responsibleEmployeeId: fuelMovements.responsibleEmployeeId, equipmentId: fuelMovements.equipmentId, equipmentPrefix: equipment.prefix,
      equipmentModel: sql<string | null>`trim(concat(${equipment.brand}, ' ', ${equipment.model}))`,
      meterReading: fuelMovements.meterReading, meterUnit: fuelMovements.meterUnit,
      destinationFrontId: fuelMovements.destinationFrontId, destinationFrontName: destinationFront.name,
      responsible: fuelMovements.responsible, notes: fuelMovements.notes, createdByName: creator.name, createdAt: fuelMovements.createdAt,
      importSource: fuelMovements.importSource, originConfirmed: fuelMovements.originConfirmed, vehiclePending: fuelMovements.vehiclePending, importedVehicle: fuelMovements.importedVehicle,
      thirdPartyId: fuelMovements.thirdPartyId, thirdPartyVehicleId: fuelMovements.thirdPartyVehicleId, fullTank: fuelMovements.fullTank,
      consumptionOutlier: fuelMovements.consumptionOutlier, readingException: fuelMovements.readingException,
      thirdPartyName: thirdParties.name, vehiclePlate: thirdPartyVehicles.plate,
    }).from(fuelMovements)
      .innerJoin(serviceFronts, eq(fuelMovements.serviceFrontId, serviceFronts.id))
      .innerJoin(fuelTypes, eq(fuelMovements.fuelTypeId, fuelTypes.id))
      .leftJoin(equipment, eq(fuelMovements.equipmentId, equipment.id))
      .leftJoin(destinationFront, eq(fuelMovements.destinationFrontId, destinationFront.id))
      .leftJoin(creator, eq(fuelMovements.createdBy, creator.id))
      .leftJoin(thirdParties, eq(fuelMovements.thirdPartyId, thirdParties.id))
      .leftJoin(thirdPartyVehicles, eq(fuelMovements.thirdPartyVehicleId, thirdPartyVehicles.id))
      .where(where).orderBy(desc(fuelMovements.movementDate), desc(fuelMovements.id)).limit(limit).offset(offset),
    db.select({ total: sql<number>`count(*)::int` }).from(fuelMovements).leftJoin(equipment, eq(fuelMovements.equipmentId, equipment.id)).where(where),
  ]);
  // Consumo dos abastecimentos de veículos de terceiros (calculado com todo o histórico do veículo).
  const [costs, consumption] = await Promise.all([fuelCosts(db), consumptionByMovement(db, rows.flatMap((row) => (row.thirdPartyVehicleId ? [row.thirdPartyVehicleId] : [])))]);
  return {
    rows: rows.map((row) => ({
      ...row,
      consumption: consumption.get(row.id) ?? null,
      unitCost: costs.get(row.id)?.unitCost ?? null,
      cost: costs.get(row.id)?.cost ?? null,
      movementLabel: fuelMovementLabel(row),
      stockLocationLabel: FUEL_LOCATION_LABELS[row.stockLocation],
      destinationLocationLabel: row.destinationLocation ? FUEL_LOCATION_LABELS[row.destinationLocation] : null,
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// Resumo do Histórico (cards da tela e início do PDF): contagem e litros por tipo de movimentação,
// calculados no banco com o MESMO filtro da listagem (historyWhere), sobre todas as páginas.
// Saldo da movimentação = entradas − saídas (transferência só muda de estoque, fica à parte).
// ---------------------------------------------------------------------------
export type FuelTotals = { count: number; liters: number };
export type FuelHistorySummary = {
  show: { entries: boolean; exits: boolean; transfers: boolean };
  entries: FuelTotals; exits: FuelTotals; transfers: FuelTotals; balance: number | null;
  byFuel: Array<{ fuelTypeId: number; fuelName: string; entries: FuelTotals; exits: FuelTotals; transfers: FuelTotals }>;
};

export async function fuelHistorySummary(db: Db, scopeFronts: number[], filters: FuelFilters): Promise<FuelHistorySummary> {
  const rows = await db.select({
    fuelTypeId: fuelMovements.fuelTypeId, fuelName: fuelTypes.name, movementType: fuelMovements.movementType,
    count: sql<number>`count(*)::int`, liters: sql<number>`coalesce(sum(${fuelMovements.quantity}),0)::float8`,
  }).from(fuelMovements)
    .innerJoin(fuelTypes, eq(fuelMovements.fuelTypeId, fuelTypes.id))
    .leftJoin(equipment, eq(fuelMovements.equipmentId, equipment.id))
    .where(historyWhere(scopeFronts, filters))
    .groupBy(fuelMovements.fuelTypeId, fuelTypes.name, fuelMovements.movementType);
  const empty = (): FuelTotals => ({ count: 0, liters: 0 });
  const add = (target: FuelTotals, row: { count: number; liters: number }) => { target.count += Number(row.count); target.liters = Math.round((target.liters + Number(row.liters)) * 100) / 100; };
  const entries = empty(), exits = empty(), transfers = empty();
  const byFuel = new Map<number, FuelHistorySummary["byFuel"][number]>();
  for (const row of rows) {
    const fuel = byFuel.get(row.fuelTypeId) ?? { fuelTypeId: row.fuelTypeId, fuelName: row.fuelName, entries: empty(), exits: empty(), transfers: empty() };
    const [total, perFuel] = row.movementType === "ENTRADA" ? [entries, fuel.entries] : row.movementType === "SAIDA" ? [exits, fuel.exits] : [transfers, fuel.transfers];
    add(total, row); add(perFuel, row);
    byFuel.set(row.fuelTypeId, fuel);
  }
  // Filtro de um tipo só mostra só o card daquele tipo (terceiros/prestadores e empresa/veículo são saídas).
  const type = filters.movementType;
  const show = type === "ENTRADA" ? { entries: true, exits: false, transfers: false }
    // Empresa/veículo de terceiro só existem em saídas.
    : type === "SAIDA" || type === "TERCEIROS" || type === "PRESTADORES" || filters.thirdPartyId || filters.vehicleId ? { entries: false, exits: true, transfers: false }
    : type === "TRANSFERENCIA" ? { entries: false, exits: false, transfers: true }
    : { entries: true, exits: true, transfers: transfers.count > 0 };
  return {
    show, entries, exits, transfers,
    balance: show.entries && show.exits ? Math.round((entries.liters - exits.liters) * 100) / 100 : null,
    byFuel: [...byFuel.values()].sort((a, b) => a.fuelName.localeCompare(b.fuelName, "pt-BR")),
  };
}

// Custo médio ponderado de todos os estoques (lib/fuel-rules.ts:computeFuelCosts). Replaya o
// razão inteiro porque transferências levam custo de uma frente para outra.
export async function fuelCosts(db: Db) {
  const rows = await db.select({
    id: fuelMovements.id, serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType,
    movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity, unitPrice: fuelMovements.unitPrice,
  }).from(fuelMovements).where(isNull(fuelMovements.deletedAt));
  return computeFuelCosts(rows);
}

// Responsável escolhido na lista de Funcionários: grava o id e usa o nome do cadastro. Sem id,
// vale o nome digitado (exceção prevista no formulário).
export async function resolveResponsible(db: Db, employeeId: number | null, typed: string | null) {
  if (!employeeId) return { responsibleEmployeeId: null, responsible: typed };
  const row = (await db.select({ id: employees.id, name: employees.name, status: employees.status }).from(employees).where(eq(employees.id, employeeId)).limit(1))[0];
  if (!row) throw new Error("RESPONSIBLE_NOT_FOUND");
  return { responsibleEmployeeId: row.id, responsible: row.name };
}

// Campos da saída para terceiro do cadastro (empresa, veículo, leitura, tanque cheio e confirmações).
// A leitura do veículo do terceiro vem em "thirdPartyReading" ("meterReading" é a do equipamento da
// frota); "meterReading" ainda é aceito para envios antigos guardados na fila offline.
export function readThirdPartyFuelFields(body: Record<string, unknown>) {
  const reading = numberOrNull(body.thirdPartyReading !== undefined ? body.thirdPartyReading : body.meterReading);
  return {
    thirdPartyId: Number(body.thirdPartyId) || null, vehicleId: Number(body.thirdPartyVehicleId) || null,
    reading: reading === null || Number.isNaN(reading) ? null : reading, fullTank: body.fullTank !== false,
    readingException: body.readingException === true, confirmTank: body.confirmTank === true, confirmOutlier: body.confirmOutlier === true,
  };
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

export function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().replace(/\s/g, "");
  // Formato brasileiro: "1.234,50" e também "411.208" (ponto de milhar sem vírgula). "347.5" continua decimal.
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : /^-?\d{1,3}(\.\d{3})+$/.test(text) ? text.replaceAll(".", "") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "") || null;

// Campos do formulário "Novo Registro" (a frente é resolvida à parte, por resolveFuelFront).
export function readFuelMovementBody(body: Record<string, unknown>) {
  const movementType = isFuelMovementType(body.movementType) ? body.movementType : ("" as FuelMovementType);
  const thirdParty = movementType === "SAIDA" && body.thirdParty === true;
  const provider = thirdParty && body.thirdPartyKind === "PRESTADOR";
  const transfer = movementType === "TRANSFERENCIA";
  const entry = movementType === "ENTRADA";
  const noEquipment = thirdParty || transfer || entry;
  return {
    fuelTypeId: Number(body.fuelTypeId) || 0,
    movementType,
    movementDate: typeof body.movementDate === "string" ? body.movementDate.slice(0, 10) : "",
    quantity: numberOrNull(body.quantity) ?? NaN,
    stockLocation: (isFuelLocation(body.stockLocation) ? body.stockLocation : "") as FuelLocation,
    thirdParty,
    thirdPartyKind: thirdParty ? (provider ? "PRESTADOR" as const : "GERAL" as const) : null,
    thirdPartyDescription: thirdParty && !provider ? text(body.thirdPartyDescription) : null,
    providerCompany: provider ? text(body.providerCompany) : null,
    providerEquipment: provider ? text(body.providerEquipment) : null,
    // Valor por litro só existe na Entrada (base do custo das saídas).
    unitPrice: entry ? numberOrNull(body.unitPrice) : null,
    equipmentId: noEquipment ? null : Number(body.equipmentId) || null,
    meterReading: noEquipment ? null : numberOrNull(body.meterReading),
    // Destino da transferência: sem filial escolhida = mesma frente (Frente ↔ Porto).
    destinationFrontId: transfer ? Number(body.destinationFrontId) || null : null,
    destinationLocation: transfer && isFuelLocation(body.destinationLocation) ? body.destinationLocation : null,
    responsibleEmployeeId: Number(body.responsibleEmployeeId) || null,
    responsible: text(body.responsible),
    notes: text(body.notes),
  };
}
