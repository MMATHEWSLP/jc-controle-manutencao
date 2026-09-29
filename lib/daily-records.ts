import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, dailyRecordFuelings, dailyRecordTrips, dailyRecords, equipment, equipmentCurrentAssignments, serviceFrontChangeRequests, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { readingUnitFor, type DailyRecordValue, type ReadingUnit } from "./daily-record-rules";

// Fotos seguem o mesmo padrão da foto do equipamento: otimizadas (WebP) no navegador,
// validadas aqui pela assinatura binária real e gravadas com nome aleatório — nunca
// com o nome original do arquivo.
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "daily-records");
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SIGNATURES: Array<{ contentType: string; extension: string; check: (b: Buffer) => boolean }> = [
  { contentType: "image/webp", extension: "webp", check: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { contentType: "image/jpeg", extension: "jpg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: "image/png", extension: "png", check: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
];
export function detectImage(buffer: Buffer) { return SIGNATURES.find((format) => format.check(buffer)) ?? null; }

export class DailyRecordError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// Quem pode editar/excluir (daily.manage) também precisa enxergar os registros de todos.
export function canViewAll(user: SessionUser) { return user.permissions.includes("daily.view_all") || canManage(user); }
export function canManage(user: SessionUser) { return user.permissions.includes("daily.manage"); }
export function canRegister(user: SessionUser) { return user.permissions.includes("daily.register"); }

// Buffer já validado -> grava e devolve a chave relativa (ex.: "2026-09/uuid.webp").
export async function storePhoto(file: File): Promise<string> {
  if (file.size === 0 || file.size > MAX_PHOTO_BYTES) throw new DailyRecordError("Cada foto deve ter no máximo 8 MB após a otimização.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const format = detectImage(buffer);
  if (!format) throw new DailyRecordError("Arquivo não reconhecido como imagem. Envie uma foto em JPEG, PNG ou WebP.");
  const folder = new Date().toISOString().slice(0, 7);
  const key = `${folder}/${randomUUID()}.${format.extension}`;
  await mkdir(path.join(UPLOAD_DIR, folder), { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, key), buffer);
  return key;
}

// Mesmo operador = mesma conta + mesmo nome digitado (lançamento manual), sem diferenciar maiúsculas.
// Espelha o índice único daily_records_user_equipment_date_operator_unique.
function sameOperator(operatorName: string | null) {
  return sql`coalesce(lower(${dailyRecords.operatorName}), '') = lower(${operatorName ?? ""})`;
}
const DUPLICATE_INDEX = /daily_records_user_equipment_date_(operator_)?unique/;
function duplicateMessage(operatorName: string | null) {
  return operatorName ? `Já existe um Controle Diário deste equipamento nesta data lançado por você para ${operatorName}.` : "Você já enviou o Controle Diário deste equipamento nesta data.";
}

export async function removePhoto(key: string | null) {
  if (key && /^\d{4}-\d{2}\/[0-9a-f-]{36}\.(webp|jpg|png)$/.test(key)) await unlink(path.join(UPLOAD_DIR, key)).catch(() => undefined);
}

export async function readPhoto(key: string) {
  if (!/^\d{4}-\d{2}\/[0-9a-f-]{36}\.(webp|jpg|png)$/.test(key)) return null;
  const buffer = await readFile(path.join(UPLOAD_DIR, key)).catch(() => null);
  if (!buffer) return null;
  return { buffer, contentType: detectImage(buffer)?.contentType ?? "application/octet-stream" };
}

// Equipamentos que o operador pode escolher: frentes que ele enxerga (lib/access.ts), sem os inativos.
function equipmentScope(user: SessionUser): SQL | undefined {
  const fronts = frentesVisiveis(user);
  if (fronts === "ALL") return undefined;
  return fronts.length ? inArray(equipment.serviceFrontId, fronts) : eq(equipment.id, -1);
}

export async function loadEquipmentOptions(user: SessionUser) {
  const db = await getDb();
  const rows = await db.select({
    id: equipment.id, prefix: equipment.prefix, code: equipment.code, plate: equipment.plate, type: equipment.type, brand: equipment.brand, model: equipment.model,
    controlType: equipment.controlType, status: equipment.status, serviceFrontId: equipment.serviceFrontId, front: serviceFronts.name,
  }).from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
    .where(and(isNull(equipment.soldAt), equipmentScope(user))).orderBy(equipment.sortKey, equipment.prefix);
  return rows.filter((row) => row.status !== "INACTIVE").map((row) => ({
    id: row.id, prefix: row.prefix, code: row.code, plate: row.plate, type: row.type, brand: row.brand, model: row.model,
    serviceFrontId: row.serviceFrontId, front: row.front ?? "Sem frente", readingUnit: readingUnitFor(row.controlType, row.prefix),
  }));
}

export async function requireEquipment(user: SessionUser, equipmentId: number) {
  const db = await getDb();
  const row = (await db.select({ id: equipment.id, prefix: equipment.prefix, controlType: equipment.controlType, status: equipment.status,
    serviceFrontId: equipment.serviceFrontId, currentHours: equipment.currentHours, currentKm: equipment.currentKm })
    .from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
  if (!row) throw new DailyRecordError("Equipamento não encontrado.", 404);
  const fronts = frentesVisiveis(user);
  if (fronts !== "ALL" && (row.serviceFrontId === null || !fronts.includes(row.serviceFrontId))) throw new DailyRecordError("Você não possui acesso a este equipamento.", 403);
  return { ...row, readingUnit: readingUnitFor(row.controlType, row.prefix) as ReadingUnit };
}

export async function loadAssignment(userId: number) {
  const db = await getDb();
  return (await db.select({ equipmentId: equipmentCurrentAssignments.equipmentId }).from(equipmentCurrentAssignments)
    .where(eq(equipmentCurrentAssignments.userId, userId)).limit(1))[0]?.equipmentId ?? null;
}

export async function saveAssignment(userId: number, equipmentId: number) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.insert(equipmentCurrentAssignments).values({ userId, equipmentId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: equipmentCurrentAssignments.userId, set: { equipmentId, updatedAt: now } });
}

// Leitura sugerida para "KM/Horímetro inicial": a maior entre o último fechamento do
// Controle Diário deste equipamento (na mesma unidade) e a leitura atual do cadastro
// (que o módulo de troca de óleo mantém). Leituras só crescem, então a maior é a mais recente.
export async function loadLastReading(user: SessionUser, equipmentId: number) {
  const item = await requireEquipment(user, equipmentId);
  const db = await getDb();
  const last = (await db.select({ endReading: dailyRecords.endReading, recordDate: dailyRecords.recordDate }).from(dailyRecords)
    .where(and(eq(dailyRecords.equipmentId, equipmentId), eq(dailyRecords.readingUnit, item.readingUnit), eq(dailyRecords.workedToday, true)))
    .orderBy(desc(dailyRecords.recordDate), desc(dailyRecords.id)).limit(1))[0];
  const current = item.readingUnit === "KM" ? item.currentKm : item.currentHours;
  const daily = last?.endReading ?? null;
  const history = await loadReadingHistory(equipmentId, item.readingUnit);
  if (daily !== null && daily >= current) return { value: daily, unit: item.readingUnit, source: "DAILY_RECORD" as const, date: last!.recordDate, history };
  if (current > 0) return { value: current, unit: item.readingUnit, source: "EQUIPMENT" as const, date: null, history };
  return { value: daily, unit: item.readingUnit, source: daily === null ? null : "DAILY_RECORD" as const, date: last?.recordDate ?? null, history };
}

// Média de trabalho por dia do equipamento nos últimos 30 registros (base do aviso de "muito
// acima/abaixo do normal" em checkReading). excludeId: ignora o registro em edição.
export async function loadReadingHistory(equipmentId: number, unit: ReadingUnit, excludeId?: number) {
  const db = await getDb();
  const rows = await db.select({ id: dailyRecords.id, start: dailyRecords.startReading, end: dailyRecords.endReading }).from(dailyRecords)
    .where(and(eq(dailyRecords.equipmentId, equipmentId), eq(dailyRecords.readingUnit, unit), eq(dailyRecords.workedToday, true)))
    .orderBy(desc(dailyRecords.recordDate), desc(dailyRecords.id)).limit(31);
  const worked = rows.filter((row) => row.id !== excludeId && row.start !== null && row.end !== null && row.end > row.start).slice(0, 30).map((row) => row.end! - row.start!);
  if (!worked.length) return { avgPerDay: 0, samples: 0 };
  return { avgPerDay: worked.reduce((total, value) => total + value, 0) / worked.length, samples: worked.length };
}

// Data da última leitura deste equipamento ANTES da data do registro — base do cálculo de
// "trabalhado por dia" em checkReading() (lib/daily-record-rules.ts).
export async function lastReadingDateBefore(equipmentId: number, unit: ReadingUnit, recordDate: string) {
  const db = await getDb();
  return (await db.select({ recordDate: dailyRecords.recordDate }).from(dailyRecords)
    .where(and(eq(dailyRecords.equipmentId, equipmentId), eq(dailyRecords.readingUnit, unit), eq(dailyRecords.workedToday, true), lt(dailyRecords.recordDate, recordDate)))
    .orderBy(desc(dailyRecords.recordDate), desc(dailyRecords.id)).limit(1))[0]?.recordDate ?? null;
}

export async function createDailyRecord(user: SessionUser, value: DailyRecordValue, photos: { problem: File | null; production: File | null }, options: { frontChangeRequested?: boolean; frontChangeReason?: string | null } = {}) {
  const item = await requireEquipment(user, value.equipmentId);
  const db = await getDb();
  if (value.serviceFrontId !== null) {
    const front = (await db.select({ id: serviceFronts.id, active: serviceFronts.active }).from(serviceFronts).where(eq(serviceFronts.id, value.serviceFrontId)).limit(1))[0];
    if (!front || !front.active) throw new DailyRecordError("Frente de serviço inválida ou inativa.");
  }
  const duplicate = (await db.select({ id: dailyRecords.id }).from(dailyRecords)
    .where(and(eq(dailyRecords.userId, user.id), eq(dailyRecords.equipmentId, value.equipmentId), eq(dailyRecords.recordDate, value.recordDate), sameOperator(value.operatorName))).limit(1))[0];
  if (duplicate) throw new DailyRecordError(duplicateMessage(value.operatorName), 409);

  const stored: string[] = [];
  try {
    const problemPhotoKey = value.inactiveOrProblem && photos.problem ? await storePhoto(photos.problem) : null;
    if (problemPhotoKey) stored.push(problemPhotoKey);
    const productionPhotoKey = value.hadProduction && photos.production ? await storePhoto(photos.production) : null;
    if (productionPhotoKey) stored.push(productionPhotoKey);
    if (value.hadProduction && !productionPhotoKey) throw new DailyRecordError(value.productionType === "BALDEIO" ? "Anexe a foto da ficha do baldeio." : "Anexe a foto da produção.");

    const now = new Date().toISOString();
    const id = await db.transaction(async (tx) => {
      const [record] = await tx.insert(dailyRecords).values({
        equipmentId: value.equipmentId, userId: user.id, recordDate: value.recordDate, workedToday: value.workedToday, noWorkReason: value.noWorkReason,
        serviceFrontId: value.serviceFrontId, location: value.location, readingUnit: item.readingUnit, startReading: value.startReading, endReading: value.endReading,
        inactiveOrProblem: value.inactiveOrProblem, problemReason: value.problemReason, problemPhotoKey,
        hadProduction: value.hadProduction, productionType: value.productionType, productionPhotoKey, notes: value.notes, createdAt: now, updatedAt: now,
        officialServiceFrontId: item.serviceFrontId,
        // Lançamento manual: user_id continua sendo a conta que lançou (auditoria).
        operatorName: value.operatorName, manualEntry: value.operatorName !== null,
      }).returning({ id: dailyRecords.id });
      // Frente informada diferente da oficial = pedido de mudança de frente. O cadastro do
      // equipamento NÃO muda aqui: só quando ADMIN/GESTOR aprovar (lib/front-requests.ts).
      if (options.frontChangeRequested && value.workedToday && value.serviceFrontId !== null && value.serviceFrontId !== item.serviceFrontId) {
        const reasonLine = `${now.slice(0, 10).split("-").reverse().join("/")} · ${value.operatorName ? `${value.operatorName} (lançado por ${user.name})` : user.name}: ${options.frontChangeReason?.trim() || "informou pelo Controle Diário"}`;
        const pending = (await tx.select({ id: serviceFrontChangeRequests.id, reason: serviceFrontChangeRequests.reason }).from(serviceFrontChangeRequests)
          .where(and(eq(serviceFrontChangeRequests.equipmentId, value.equipmentId), eq(serviceFrontChangeRequests.status, "PENDING"))).limit(1))[0];
        let requestId: number;
        if (pending) {
          // Já existe pedido aberto para o equipamento: não cria outro, só acrescenta a nova indicação.
          await tx.update(serviceFrontChangeRequests).set({ requestedServiceFrontId: value.serviceFrontId, reason: [pending.reason, reasonLine].filter(Boolean).join("\n"), updatedAt: now })
            .where(eq(serviceFrontChangeRequests.id, pending.id));
          requestId = pending.id;
        } else {
          const [created] = await tx.insert(serviceFrontChangeRequests).values({
            equipmentId: value.equipmentId, currentServiceFrontId: item.serviceFrontId, requestedServiceFrontId: value.serviceFrontId, reason: reasonLine,
            requestedBy: user.id, requestedAt: now, status: "PENDING", createdAt: now, updatedAt: now,
          }).returning({ id: serviceFrontChangeRequests.id });
          requestId = created.id;
        }
        await tx.update(dailyRecords).set({ frontChangeRequestId: requestId }).where(eq(dailyRecords.id, record.id));
      }
      if (value.fuelings.length) await tx.insert(dailyRecordFuelings).values(value.fuelings.map((fueling, index) => ({
        dailyRecordId: record.id, fuelingNumber: index + 1, liters: fueling.liters, meterReading: fueling.reading, createdAt: now, updatedAt: now })));
      if (value.trips.length) await tx.insert(dailyRecordTrips).values(value.trips.map((trip, index) => ({
        dailyRecordId: record.id, tripNumber: index + 1, logsQuantity: trip.logs, meters: trip.meters, createdAt: now, updatedAt: now })));
      await tx.insert(equipmentCurrentAssignments).values({ userId: user.id, equipmentId: value.equipmentId, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: equipmentCurrentAssignments.userId, set: { equipmentId: value.equipmentId, updatedAt: now } });
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_RECORD", entityId: String(record.id), action: "CONTROLE DIÁRIO REGISTRADO",
        newValue: JSON.stringify({ equipment: item.prefix, recordDate: value.recordDate, workedToday: value.workedToday, manualEntry: value.operatorName !== null, operatorName: value.operatorName }), occurredAt: now });
      return record.id;
    });
    return { id, prefix: item.prefix };
  } catch (error) {
    for (const key of stored) await removePhoto(key);
    if (error instanceof Error && DUPLICATE_INDEX.test(`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
      throw new DailyRecordError(duplicateMessage(value.operatorName), 409);
    }
    throw error;
  }
}

export async function listDailyRecords(user: SessionUser, filters: { from?: string; to?: string; equipmentId?: number; id?: number; onlyMine: boolean }) {
  const db = await getDb();
  const conditions: SQL[] = [];
  if (filters.onlyMine || !canViewAll(user)) conditions.push(eq(dailyRecords.userId, user.id));
  else {
    const fronts = frentesVisiveis(user);
    if (fronts !== "ALL") conditions.push(fronts.length ? inArray(equipment.serviceFrontId, fronts) : eq(dailyRecords.id, -1));
  }
  if (filters.from) conditions.push(gte(dailyRecords.recordDate, filters.from));
  if (filters.to) conditions.push(lte(dailyRecords.recordDate, filters.to));
  if (filters.equipmentId) conditions.push(eq(dailyRecords.equipmentId, filters.equipmentId));
  if (filters.id) conditions.push(eq(dailyRecords.id, filters.id));
  const rows = await db.select({
    id: dailyRecords.id, recordDate: dailyRecords.recordDate, equipmentId: dailyRecords.equipmentId, prefix: equipment.prefix,
    userId: dailyRecords.userId, operator: sql<string>`coalesce(${dailyRecords.operatorName}, ${users.name})`, launchedBy: users.name,
    manualEntry: dailyRecords.manualEntry, operatorName: dailyRecords.operatorName, workedToday: dailyRecords.workedToday, noWorkReason: dailyRecords.noWorkReason,
    serviceFrontId: dailyRecords.serviceFrontId, front: serviceFronts.name, location: dailyRecords.location, readingUnit: dailyRecords.readingUnit,
    startReading: dailyRecords.startReading, endReading: dailyRecords.endReading, inactiveOrProblem: dailyRecords.inactiveOrProblem,
    problemReason: dailyRecords.problemReason, hasProblemPhoto: dailyRecords.problemPhotoKey, hadProduction: dailyRecords.hadProduction,
    productionType: dailyRecords.productionType, hasProductionPhoto: dailyRecords.productionPhotoKey, notes: dailyRecords.notes, createdAt: dailyRecords.createdAt,
    officialServiceFrontId: dailyRecords.officialServiceFrontId, frontRequestStatus: serviceFrontChangeRequests.status,
  }).from(dailyRecords).innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId)).innerJoin(users, eq(users.id, dailyRecords.userId))
    .leftJoin(serviceFronts, eq(serviceFronts.id, dailyRecords.serviceFrontId))
    .leftJoin(serviceFrontChangeRequests, eq(serviceFrontChangeRequests.id, dailyRecords.frontChangeRequestId))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(dailyRecords.recordDate), desc(dailyRecords.id)).limit(300);
  const ids = rows.map((row) => row.id);
  const [fuelings, trips] = ids.length ? await Promise.all([
    db.select().from(dailyRecordFuelings).where(inArray(dailyRecordFuelings.dailyRecordId, ids)).orderBy(dailyRecordFuelings.fuelingNumber),
    db.select().from(dailyRecordTrips).where(inArray(dailyRecordTrips.dailyRecordId, ids)).orderBy(dailyRecordTrips.tripNumber),
  ]) : [[], []];
  return rows.map((row) => ({
    ...row, hasProblemPhoto: Boolean(row.hasProblemPhoto), hasProductionPhoto: Boolean(row.hasProductionPhoto),
    fuelings: fuelings.filter((item) => item.dailyRecordId === row.id).map((item) => ({ number: item.fuelingNumber, liters: item.liters, reading: item.meterReading, location: item.location })),
    trips: trips.filter((item) => item.dailyRecordId === row.id).map((item) => ({ number: item.tripNumber, logs: item.logsQuantity, meters: item.meters })),
  }));
}

export async function loadPhotoKey(user: SessionUser, recordId: number, kind: "problem" | "production") {
  const db = await getDb();
  const row = (await db.select({ userId: dailyRecords.userId, serviceFrontId: equipment.serviceFrontId, problem: dailyRecords.problemPhotoKey, production: dailyRecords.productionPhotoKey })
    .from(dailyRecords).innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId)).where(eq(dailyRecords.id, recordId)).limit(1))[0];
  if (!row) throw new DailyRecordError("Registro não encontrado.", 404);
  if (row.userId !== user.id) {
    const fronts = frentesVisiveis(user);
    const inScope = fronts === "ALL" || (row.serviceFrontId !== null && fronts.includes(row.serviceFrontId));
    if (!canViewAll(user) || !inScope) throw new DailyRecordError("Você não possui acesso a este registro.", 403);
  }
  return kind === "problem" ? row.problem : row.production;
}

// ---------------------------------------------------------------------------
// Edição e exclusão (somente daily.manage, nas frentes que o usuário enxerga).
// Cada alteração grava em audit_logs o registro completo como era antes.
// ---------------------------------------------------------------------------
async function loadRecordSnapshot(recordId: number) {
  const db = await getDb();
  const record = (await db.select().from(dailyRecords).where(eq(dailyRecords.id, recordId)).limit(1))[0];
  if (!record) return null;
  const [fuelings, trips] = await Promise.all([
    db.select().from(dailyRecordFuelings).where(eq(dailyRecordFuelings.dailyRecordId, recordId)).orderBy(dailyRecordFuelings.fuelingNumber),
    db.select().from(dailyRecordTrips).where(eq(dailyRecordTrips.dailyRecordId, recordId)).orderBy(dailyRecordTrips.tripNumber),
  ]);
  return { record, fuelings, trips };
}

export async function requireManagedRecord(user: SessionUser, recordId: number) {
  if (!canManage(user)) throw new DailyRecordError("Você não possui permissão para editar ou excluir registros.", 403);
  const snapshot = await loadRecordSnapshot(recordId);
  if (!snapshot) throw new DailyRecordError("Registro não encontrado.", 404);
  await requireEquipment(user, snapshot.record.equipmentId); // escopo por frente
  return snapshot;
}

export async function updateDailyRecord(user: SessionUser, recordId: number, value: DailyRecordValue, photos: { problem: File | null; production: File | null; keepProblem: boolean; keepProduction: boolean }) {
  const before = await requireManagedRecord(user, recordId);
  const item = await requireEquipment(user, value.equipmentId);
  const db = await getDb();
  if (value.serviceFrontId !== null) {
    const front = (await db.select({ id: serviceFronts.id, active: serviceFronts.active }).from(serviceFronts).where(eq(serviceFronts.id, value.serviceFrontId)).limit(1))[0];
    if (!front || !front.active) throw new DailyRecordError("Frente de serviço inválida ou inativa.");
  }
  // O registro continua sendo da conta que lançou; só não pode colidir com outro dela no mesmo dia
  // (no lançamento manual, para o mesmo operador). Só o registro manual tem o nome editável.
  const operatorName = before.record.manualEntry ? value.operatorName ?? before.record.operatorName : before.record.operatorName;
  const duplicate = (await db.select({ id: dailyRecords.id }).from(dailyRecords)
    .where(and(eq(dailyRecords.userId, before.record.userId), eq(dailyRecords.equipmentId, value.equipmentId), eq(dailyRecords.recordDate, value.recordDate), sameOperator(operatorName))).limit(2))
    .find((row) => row.id !== recordId);
  if (duplicate) throw new DailyRecordError("Esse operador já tem outro registro deste equipamento nesta data.", 409);

  const stored: string[] = [];
  const oldKeys = { problem: before.record.problemPhotoKey, production: before.record.productionPhotoKey };
  try {
    const newProblem = value.inactiveOrProblem && photos.problem ? await storePhoto(photos.problem) : null;
    if (newProblem) stored.push(newProblem);
    const newProduction = value.hadProduction && photos.production ? await storePhoto(photos.production) : null;
    if (newProduction) stored.push(newProduction);
    const problemPhotoKey = value.inactiveOrProblem ? newProblem ?? (photos.keepProblem ? oldKeys.problem : null) : null;
    const productionPhotoKey = value.hadProduction ? newProduction ?? (photos.keepProduction ? oldKeys.production : null) : null;
    if (value.hadProduction && !productionPhotoKey) throw new DailyRecordError(value.productionType === "BALDEIO" ? "Anexe a foto da ficha do baldeio." : "Anexe a foto da produção.");

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(dailyRecords).set({
        equipmentId: value.equipmentId, recordDate: value.recordDate, workedToday: value.workedToday, noWorkReason: value.noWorkReason,
        serviceFrontId: value.serviceFrontId, location: value.location, readingUnit: item.readingUnit, startReading: value.startReading, endReading: value.endReading,
        inactiveOrProblem: value.inactiveOrProblem, problemReason: value.problemReason, problemPhotoKey,
        hadProduction: value.hadProduction, productionType: value.productionType, productionPhotoKey, notes: value.notes, operatorName, updatedAt: now,
      }).where(eq(dailyRecords.id, recordId));
      await tx.delete(dailyRecordFuelings).where(eq(dailyRecordFuelings.dailyRecordId, recordId));
      await tx.delete(dailyRecordTrips).where(eq(dailyRecordTrips.dailyRecordId, recordId));
      if (value.fuelings.length) await tx.insert(dailyRecordFuelings).values(value.fuelings.map((fueling, index) => ({
        dailyRecordId: recordId, fuelingNumber: index + 1, liters: fueling.liters, meterReading: fueling.reading, createdAt: now, updatedAt: now })));
      if (value.trips.length) await tx.insert(dailyRecordTrips).values(value.trips.map((trip, index) => ({
        dailyRecordId: recordId, tripNumber: index + 1, logsQuantity: trip.logs, meters: trip.meters, createdAt: now, updatedAt: now })));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_RECORD", entityId: String(recordId), action: "CONTROLE DIÁRIO EDITADO",
        previousValue: JSON.stringify(before), newValue: JSON.stringify({ ...value, operatorName, problemPhotoKey, productionPhotoKey }), occurredAt: now });
    });
    // Fotos substituídas/removidas só são apagadas depois que a gravação deu certo.
    if (oldKeys.problem && oldKeys.problem !== problemPhotoKey) await removePhoto(oldKeys.problem);
    if (oldKeys.production && oldKeys.production !== productionPhotoKey) await removePhoto(oldKeys.production);
    return { id: recordId, prefix: item.prefix };
  } catch (error) {
    for (const key of stored) await removePhoto(key);
    if (error instanceof Error && DUPLICATE_INDEX.test(`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
      throw new DailyRecordError("Esse operador já tem outro registro deste equipamento nesta data.", 409);
    }
    throw error;
  }
}

export async function deleteDailyRecord(user: SessionUser, recordId: number) {
  const before = await requireManagedRecord(user, recordId);
  const db = await getDb();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(dailyRecordFuelings).where(eq(dailyRecordFuelings.dailyRecordId, recordId));
    await tx.delete(dailyRecordTrips).where(eq(dailyRecordTrips.dailyRecordId, recordId));
    await tx.delete(dailyRecords).where(eq(dailyRecords.id, recordId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "DAILY_RECORD", entityId: String(recordId), action: "CONTROLE DIÁRIO EXCLUÍDO",
      previousValue: JSON.stringify(before), occurredAt: now });
  });
  await removePhoto(before.record.problemPhotoKey);
  await removePhoto(before.record.productionPhotoKey);
}
