import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { dailyRecordFuelings, dailyRecordTrips, dailyRecords, equipment, serviceFrontChangeRequests, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { canViewAll } from "./daily-records";

// ---------------------------------------------------------------------------
// Histórico de Registros Diários: filtros combináveis (AND), ordenação e paginação.
// A mesma função alimenta a tela, o PDF e o Excel — a exportação sai exatamente com o que
// está filtrado na tela.
// ---------------------------------------------------------------------------
export type HistoryFilters = { q: string; from: string | null; to: string | null; frontId: number | null; operators: string[] };

const isoDate = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

// Parâmetros da URL (os mesmos que a tela guarda na barra de endereço).
export function parseHistoryFilters(params: URLSearchParams): HistoryFilters {
  const frontId = Number(params.get("frente"));
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    from: isoDate(params.get("de")),
    to: isoDate(params.get("ate")),
    frontId: Number.isInteger(frontId) && frontId > 0 ? frontId : null,
    operators: params.getAll("colab").map((value) => value.trim()).filter(Boolean).slice(0, 50),
  };
}

// Operador exibido: nome digitado no lançamento manual ou, se não houver, o funcionário da conta.
const operatorExpr = sql<string>`COALESCE(${dailyRecords.operatorName}, ${users.name})`;
// Busca sem acento e sem diferenciar maiúsculas (Postgres sem extensão unaccent).
// Também ignora espaços, pontos e hífens (igual à busca do formulário): "sk05" acha "SK-05".
const fold = (value: SQL | string) => sql`regexp_replace(translate(lower(${value}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'), '[[:space:]._/-]+', '', 'g')`;
const foldText = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s._/-]+/g, "");

function scopeCondition(user: SessionUser): SQL | undefined {
  if (!canViewAll(user)) return eq(dailyRecords.userId, user.id);
  const fronts = frentesVisiveis(user);
  if (fronts === "ALL") return undefined;
  if (!fronts.length) return sql`1=0`;
  return or(inArray(dailyRecords.serviceFrontId, fronts), inArray(equipment.serviceFrontId, fronts));
}

function conditions(user: SessionUser, filters: HistoryFilters) {
  const list: SQL[] = [];
  const scope = scopeCondition(user);
  if (scope) list.push(scope);
  if (filters.from) list.push(gte(dailyRecords.recordDate, filters.from));
  if (filters.to) list.push(lte(dailyRecords.recordDate, filters.to));
  if (filters.frontId) list.push(eq(dailyRecords.serviceFrontId, filters.frontId));
  if (filters.operators.length) list.push(inArray(operatorExpr, filters.operators));
  if (filters.q) {
    const term = `%${foldText(filters.q).replace(/[%_\\]/g, "")}%`;
    list.push(sql`(${fold(sql`${equipment.prefix}`)} LIKE ${term} OR ${fold(sql`${equipment.code}`)} LIKE ${term} OR ${fold(sql`coalesce(${equipment.model},'')`)} LIKE ${term} OR ${fold(operatorExpr)} LIKE ${term})`);
  }
  return list.length ? and(...list) : undefined;
}

function baseSelect() {
  return {
    id: dailyRecords.id, recordDate: dailyRecords.recordDate, equipmentId: dailyRecords.equipmentId, prefix: equipment.prefix, equipmentModel: equipment.model,
    userId: dailyRecords.userId, operator: operatorExpr, accountName: users.name, operatorName: dailyRecords.operatorName,
    workedToday: dailyRecords.workedToday, noWorkReason: dailyRecords.noWorkReason, serviceFrontId: dailyRecords.serviceFrontId, front: serviceFronts.name,
    location: dailyRecords.location, readingUnit: dailyRecords.readingUnit, startReading: dailyRecords.startReading, endReading: dailyRecords.endReading,
    inactiveOrProblem: dailyRecords.inactiveOrProblem, problemReason: dailyRecords.problemReason, hasProblemPhoto: dailyRecords.problemPhotoKey,
    hadProduction: dailyRecords.hadProduction, productionType: dailyRecords.productionType, hasProductionPhoto: dailyRecords.productionPhotoKey,
    notes: dailyRecords.notes, createdAt: dailyRecords.createdAt, officialServiceFrontId: dailyRecords.officialServiceFrontId, frontRequestStatus: serviceFrontChangeRequests.status,
  };
}

async function query(user: SessionUser, filters: HistoryFilters, limit: number, offset: number) {
  const db = await getDb();
  const rows = await db.select(baseSelect()).from(dailyRecords)
    .innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId))
    .innerJoin(users, eq(users.id, dailyRecords.userId))
    .leftJoin(serviceFronts, eq(serviceFronts.id, dailyRecords.serviceFrontId))
    .leftJoin(serviceFrontChangeRequests, eq(serviceFrontChangeRequests.id, dailyRecords.frontChangeRequestId))
    .where(conditions(user, filters))
    // Data mais recente primeiro; no mesmo dia, ordem alfabética do equipamento e depois do operador.
    .orderBy(desc(dailyRecords.recordDate), asc(equipment.sortKey), asc(equipment.prefix), asc(operatorExpr), desc(dailyRecords.id))
    .limit(limit).offset(offset);
  const ids = rows.map((row) => row.id);
  const [fuelings, trips] = ids.length ? await Promise.all([
    db.select().from(dailyRecordFuelings).where(inArray(dailyRecordFuelings.dailyRecordId, ids)).orderBy(dailyRecordFuelings.fuelingNumber),
    db.select().from(dailyRecordTrips).where(inArray(dailyRecordTrips.dailyRecordId, ids)).orderBy(dailyRecordTrips.tripNumber),
  ]) : [[], []];
  return rows.map((row) => {
    const worked = row.workedToday && row.startReading !== null && row.endReading !== null ? row.endReading - row.startReading : null;
    return {
      ...row, worked, manualEntry: row.operatorName !== null,
      hasProblemPhoto: Boolean(row.hasProblemPhoto), hasProductionPhoto: Boolean(row.hasProductionPhoto),
      fuelings: fuelings.filter((item) => item.dailyRecordId === row.id).map((item) => ({ number: item.fuelingNumber, liters: item.liters, location: item.location })),
      trips: trips.filter((item) => item.dailyRecordId === row.id).map((item) => ({ number: item.tripNumber, logs: item.logsQuantity, meters: item.meters })),
    };
  });
}

export type HistoryRow = Awaited<ReturnType<typeof query>>[number];

export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_EXPORT_LIMIT = 10_000;

export async function loadHistoryPage(user: SessionUser, filters: HistoryFilters, page: number) {
  const db = await getDb();
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(dailyRecords)
    .innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId))
    .innerJoin(users, eq(users.id, dailyRecords.userId))
    .where(conditions(user, filters));
  const records = await query(user, filters, HISTORY_PAGE_SIZE, (page - 1) * HISTORY_PAGE_SIZE);
  return { records, total, page, pageSize: HISTORY_PAGE_SIZE };
}

export async function loadHistoryForExport(user: SessionUser, filters: HistoryFilters) {
  return query(user, filters, HISTORY_EXPORT_LIMIT, 0);
}

// Colaboradores para o filtro de seleção múltipla: quem já tem registro dentro do escopo do usuário.
export async function loadHistoryOperators(user: SessionUser) {
  const db = await getDb();
  const rows = await db.selectDistinct({ name: operatorExpr }).from(dailyRecords)
    .innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId))
    .innerJoin(users, eq(users.id, dailyRecords.userId))
    .where(scopeCondition(user)).limit(2000);
  return rows.map((row) => row.name).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export function describeHistoryFilters(filters: HistoryFilters, frontName: string | null) {
  const br = (value: string) => value.split("-").reverse().join("/");
  const parts = [
    filters.from || filters.to ? `Período: ${filters.from ? br(filters.from) : "início"} a ${filters.to ? br(filters.to) : "hoje"}` : "Período: todos",
    `Frente: ${frontName ?? "todas"}`,
  ];
  if (filters.q) parts.push(`Busca: "${filters.q}"`);
  if (filters.operators.length) parts.push(`Colaboradores: ${filters.operators.join(", ")}`);
  return parts.join(" · ");
}
