import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { dailyRecords, equipment, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { canManage, canViewAll } from "./daily-records";
import { HISTORY_PAGE_SIZE, likePattern, workedAmount, type DailyHistoryFilters } from "./daily-history-rules";

// Histórico de Registros Diários: uma consulta só (filtros + escopo + ordenação) para a tela e
// para as exportações, para que o PDF/Excel tragam exatamente o que está na lista.

// Operador exibido: "Sem operador", o cadastro de campo vinculado, o nome digitado no lançamento
// manual/importação ou, no login de campo, o próprio usuário.
const fieldOperator = alias(users, "field_operator");
const operatorExpr = sql<string>`CASE WHEN ${dailyRecords.noOperator} THEN 'Sem operador' ELSE coalesce(${fieldOperator.name}, ${dailyRecords.operatorName}, ${users.name}) END`;
// Registro "não trabalhou" não grava frente: usa a frente oficial do equipamento no dia.
const frontIdExpr = sql<number | null>`coalesce(${dailyRecords.serviceFrontId}, ${dailyRecords.officialServiceFrontId})`;

function scopeConditions(user: SessionUser): SQL[] {
  // Mesma regra de listDailyRecords: quem não vê todos só vê o que a própria conta lançou.
  if (!canViewAll(user)) return [eq(dailyRecords.userId, user.id)];
  const fronts = frentesVisiveis(user);
  if (fronts === "ALL") return [];
  return [fronts.length ? inArray(equipment.serviceFrontId, fronts) : eq(dailyRecords.id, -1)];
}

function filterConditions(filters: DailyHistoryFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.from) conditions.push(gte(dailyRecords.recordDate, filters.from));
  if (filters.to) conditions.push(lte(dailyRecords.recordDate, filters.to));
  if (filters.frontId) conditions.push(sql`${frontIdExpr} = ${filters.frontId}`);
  if (filters.q) {
    const pattern = likePattern(filters.q);
    conditions.push(or(ilike(equipment.prefix, pattern), ilike(equipment.code, pattern), ilike(equipment.model, pattern), ilike(equipment.plate, pattern), sql`${operatorExpr} ilike ${pattern}`)!);
  }
  if (filters.operators.length) conditions.push(inArray(sql`lower(${operatorExpr})`, filters.operators.map((name) => name.toLowerCase())));
  if (filters.location) conditions.push(sql`coalesce(${dailyRecords.location}, '') ilike ${likePattern(filters.location)}`);
  if (filters.origin === "APP") conditions.push(isNull(dailyRecords.importBatchId));
  if (filters.origin === "IMPORTADO") conditions.push(isNotNull(dailyRecords.importBatchId));
  if (filters.review) conditions.push(eq(dailyRecords.reviewStatus, "CONFERIR"));
  return conditions;
}

function baseQuery<T extends Record<string, unknown>>(db: Awaited<ReturnType<typeof getDb>>, fields: T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- seleção dinâmica (lista x contagem)
  return db.select(fields as any).from(dailyRecords)
    .innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId))
    .innerJoin(users, eq(users.id, dailyRecords.userId))
    .leftJoin(fieldOperator, eq(fieldOperator.id, dailyRecords.fieldOperatorId))
    .leftJoin(serviceFronts, sql`${serviceFronts.id} = ${frontIdExpr}`);
}

const rowFields = {
  id: dailyRecords.id, recordDate: dailyRecords.recordDate, equipmentId: dailyRecords.equipmentId, prefix: equipment.prefix,
  equipmentModel: sql<string>`trim(concat_ws(' ', ${equipment.brand}, ${equipment.model}))`,
  operator: operatorExpr, launchedBy: users.name, manualEntry: dailyRecords.manualEntry,
  front: serviceFronts.name, location: dailyRecords.location, readingUnit: dailyRecords.readingUnit,
  startReading: dailyRecords.startReading, endReading: dailyRecords.endReading,
  workedToday: dailyRecords.workedToday, noWorkReason: dailyRecords.noWorkReason,
  inactiveOrProblem: dailyRecords.inactiveOrProblem, problemReason: dailyRecords.problemReason,
  hadProduction: dailyRecords.hadProduction, productionType: dailyRecords.productionType, notes: dailyRecords.notes, createdAt: dailyRecords.createdAt,
  importBatchId: dailyRecords.importBatchId, origin: dailyRecords.origin, reviewStatus: dailyRecords.reviewStatus, reviewReason: dailyRecords.reviewReason,
  fieldOperatorId: dailyRecords.fieldOperatorId, noOperator: dailyRecords.noOperator, operatorName: dailyRecords.operatorName, locationOriginal: dailyRecords.locationOriginal,
  reportedDieselLiters: dailyRecords.reportedDieselLiters, dieselNote: dailyRecords.dieselNote, totalTrips: dailyRecords.totalTrips, portVolumeM3: dailyRecords.portVolumeM3,
  fuelingCount: sql<number>`(select count(*) from daily_record_fuelings f where f.daily_record_id = ${dailyRecords.id})::int`,
  fuelingLiters: sql<number>`(select coalesce(sum(f.liters), 0) from daily_record_fuelings f where f.daily_record_id = ${dailyRecords.id})::float8`,
  tripCount: sql<number>`(select count(*) from daily_record_trips t where t.daily_record_id = ${dailyRecords.id})::int`,
  logsTotal: sql<number>`(select coalesce(sum(t.logs_quantity), 0) from daily_record_trips t where t.daily_record_id = ${dailyRecords.id})::int`,
  metersTotal: sql<number | null>`(select sum(t.meters) from daily_record_trips t where t.daily_record_id = ${dailyRecords.id})::float8`,
};

type RawRow = {
  id: number; recordDate: string; equipmentId: number; prefix: string; equipmentModel: string; operator: string; launchedBy: string; manualEntry: boolean;
  front: string | null; location: string | null; readingUnit: "HOURS" | "KM"; startReading: number | null; endReading: number | null;
  workedToday: boolean; noWorkReason: string | null; inactiveOrProblem: boolean; problemReason: string | null;
  hadProduction: boolean; productionType: "BALDEIO" | "PORTO" | null; notes: string | null; createdAt: string;
  importBatchId: number | null; origin: string; reviewStatus: "OK" | "CONFERIR"; reviewReason: string | null; fieldOperatorId: number | null; noOperator: boolean; operatorName: string | null;
  locationOriginal: string | null; reportedDieselLiters: number | null; dieselNote: string | null; totalTrips: number | null; portVolumeM3: number | null;
  fuelingCount: number; fuelingLiters: number; tripCount: number; logsTotal: number; metersTotal: number | null;
};
export type DailyHistoryRow = RawRow & { worked: number | null; canEdit: boolean; imported: boolean };

async function selectRows(user: SessionUser, filters: DailyHistoryFilters, limit: number, offset: number) {
  const db = await getDb();
  const conditions = [...scopeConditions(user), ...filterConditions(filters)];
  const rows = await baseQuery(db, rowFields).where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(dailyRecords.recordDate), asc(equipment.sortKey), asc(equipment.prefix), asc(sql`lower(${operatorExpr})`), asc(dailyRecords.id))
    .limit(limit).offset(offset) as unknown as RawRow[];
  const editable = canManage(user);
  return rows.map((row) => ({ ...row, fuelingCount: Number(row.fuelingCount), fuelingLiters: Number(row.fuelingLiters), tripCount: Number(row.tripCount),
    logsTotal: Number(row.logsTotal), metersTotal: row.metersTotal === null ? null : Number(row.metersTotal), worked: workedAmount(row), canEdit: editable, imported: row.importBatchId !== null }));
}

export async function listDailyHistory(user: SessionUser, filters: DailyHistoryFilters, page: number, pageSize = HISTORY_PAGE_SIZE) {
  const db = await getDb();
  const conditions = [...scopeConditions(user), ...filterConditions(filters)];
  const [countRow] = await baseQuery(db, { total: sql<number>`count(*)::int` }).where(conditions.length ? and(...conditions) : undefined) as unknown as Array<{ total: number }>;
  const total = Number(countRow?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  const rows = total ? await selectRows(user, filters, pageSize, (current - 1) * pageSize) : [];
  return { rows, total, page: current, pages, pageSize };
}

export async function exportDailyHistory(user: SessionUser, filters: DailyHistoryFilters, limit: number) {
  return selectRows(user, filters, limit, 0);
}

// Colaboradores para o multi-select: todos que já têm registro dentro do escopo do usuário
// (operador de campo pelo nome da conta; lançamento manual pelo nome digitado).
export async function listHistoryOperators(user: SessionUser) {
  const db = await getDb();
  const conditions = scopeConditions(user);
  const rows = await db.selectDistinct({ name: operatorExpr }).from(dailyRecords)
    .innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId))
    .innerJoin(users, eq(users.id, dailyRecords.userId))
    .leftJoin(fieldOperator, eq(fieldOperator.id, dailyRecords.fieldOperatorId))
    .where(conditions.length ? and(...conditions) : undefined).limit(2000);
  const byKey = new Map<string, string>();
  for (const row of rows) { const name = String(row.name ?? "").trim(); if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name); }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }));
}
