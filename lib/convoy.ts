import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getD1, getDb } from "../db";
import { auditLogs, convoyFuelRecords, convoyFuelSettings, dailyRecords, employees, equipment, fuelMovements, fuelTypes, meterReadings, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import {
  convoyWarnings, estimatedConsumption, fortalezaDay, fortalezaWallTime, NO_PHOTO_LABELS, parseConvoyNumber, readConvoyPayload, validateConvoyPayload,
  type ConvoyFlag, type ConvoyPayload, type ConvoyStatus, type ConvoyUnit, type LitersStats, type NoPhotoReason,
} from "./convoy-rules";
import { ConvoyPhotoError, storeConvoyPhoto } from "./convoy-storage";
import { readingUnitFor } from "./daily-record-rules";
import { createFuelMovement, FuelCreateError } from "./fuel-create";
import { ReadingOperationError, saveReading } from "./readings";

// ---------------------------------------------------------------------------
// Abastecimentos do comboio (servidor). Fluxo:
//  1. o motorista do comboio (perfil CAMPO com "Registra abastecimento") registra no celular, mesmo
//     offline; a fila envia depois e o client_uuid gerado no celular impede duplicar;
//  2. o registro fica PENDENTE: não baixa saldo, não atualiza leitura, não entra no consumo;
//  3. quem tem fuel.convoy_approve aprova (podendo corrigir litros, leitura, equipamento, motorista),
//     rejeita (motivo) ou pede correção. A aprovação grava a saída de Frota com a MESMA função do
//     formulário de Combustível (lib/fuel-create.ts) e só então atualiza a leitura do equipamento
//     (saveReading: ciclos e alertas), se for a mais recente e maior.
// Tudo fica no log (audit_logs, entidade CONVOY_FUEL).
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;

export class ConvoyError extends Error {
  constructor(message: string, public status = 400, public data: Record<string, unknown> = {}) { super(message); }
}

export const canApproveConvoy = (user: SessionUser) => user.permissions.includes("fuel.convoy_approve");
export const canRegisterConvoy = (user: SessionUser) => user.permissions.includes("fuel.convoy_register");
const OPEN_STATUSES: ConvoyStatus[] = ["PENDENTE", "CORRECAO", "APROVANDO"];

async function log(db: Db, actorId: number, recordId: number, action: string, previous?: unknown, next?: unknown) {
  await db.insert(auditLogs).values({
    userId: actorId, entityType: "CONVOY_FUEL", entityId: String(recordId), action,
    previousValue: previous === undefined ? null : JSON.stringify(previous), newValue: next === undefined ? null : JSON.stringify(next), occurredAt: new Date().toISOString(),
  });
}

function visibleScope(user: SessionUser) {
  const fronts = frentesVisiveis(user);
  return fronts === "ALL" ? null : fronts;
}
const inScope = (scope: number[] | null, frontId: number | null) => scope === null || (frontId !== null && scope.includes(frontId));

// ---------------------------------------------------------------------------
// Configuração (linha única)
// ---------------------------------------------------------------------------
export type ConvoySettings = { pumpPhotoRequired: boolean; aiPhotoCheck: boolean };
export async function convoySettings(db: Db): Promise<ConvoySettings> {
  const row = (await db.select().from(convoyFuelSettings).where(eq(convoyFuelSettings.id, 1)).limit(1))[0];
  return { pumpPhotoRequired: row?.pumpPhotoRequired ?? false, aiPhotoCheck: row?.aiPhotoCheck ?? false };
}
export async function saveConvoySettings(db: Db, user: SessionUser, input: Partial<ConvoySettings>) {
  if (user.profile !== "ADMIN") throw new ConvoyError("Somente o administrador altera a configuração do comboio.", 403);
  const before = await convoySettings(db);
  const next = { pumpPhotoRequired: input.pumpPhotoRequired ?? before.pumpPhotoRequired, aiPhotoCheck: input.aiPhotoCheck ?? before.aiPhotoCheck };
  const now = new Date().toISOString();
  await db.insert(convoyFuelSettings).values({ id: 1, ...next, updatedBy: user.id, updatedAt: now })
    .onConflictDoUpdate({ target: convoyFuelSettings.id, set: { ...next, updatedBy: user.id, updatedAt: now } });
  await log(db, user.id, 0, "CONFIGURAÇÃO DO COMBOIO", before, next);
  return next;
}

// Diesel padrão do comboio (o aprovador pode trocar): Diesel S10 se existir, senão o primeiro "diesel".
export async function defaultConvoyFuelTypeId(db: Db) {
  const rows = await db.select({ id: fuelTypes.id, code: fuelTypes.code, name: fuelTypes.name }).from(fuelTypes).where(eq(fuelTypes.active, true)).orderBy(asc(fuelTypes.sortOrder), asc(fuelTypes.name));
  return (rows.find((row) => row.code === "DIESEL_S10") ?? rows.find((row) => /diesel/i.test(row.name)) ?? rows[0])?.id ?? null;
}

// ---------------------------------------------------------------------------
// Histórico de leituras e litros por equipamento (avisos e "última leitura")
// ---------------------------------------------------------------------------
type ReadingPoint = { value: number; at: string };
type EquipmentHistory = { readings: ReadingPoint[]; liters: number[]; avgPerDay: number | null; lastOperator: { employeeId: number | null; name: string } | null };

async function equipmentHistories(db: Db, items: Array<{ id: number; unit: ConvoyUnit; currentHours: number; currentKm: number }>, sinceDay: string) {
  const ids = items.map((item) => item.id);
  const result = new Map<number, EquipmentHistory>(items.map((item) => [item.id, { readings: [], liters: [], avgPerDay: null, lastOperator: null }]));
  if (!ids.length) return result;
  const operatorUser = alias(users, "operator_user");
  const launcher = alias(users, "launcher");
  const operatorEmployee = alias(employees, "operator_employee");
  const launcherEmployee = alias(employees, "launcher_employee");
  const [meter, daily, fuel] = await Promise.all([
    db.select({ equipmentId: meterReadings.equipmentId, readingDate: meterReadings.readingDate, hours: meterReadings.hours, km: meterReadings.km })
      .from(meterReadings).where(and(inArray(meterReadings.equipmentId, ids), gte(meterReadings.readingDate, sinceDay))),
    db.select({
      equipmentId: dailyRecords.equipmentId, recordDate: dailyRecords.recordDate, unit: dailyRecords.readingUnit, start: dailyRecords.startReading, end: dailyRecords.endReading,
      worked: dailyRecords.workedToday, operatorName: dailyRecords.operatorName, noOperator: dailyRecords.noOperator,
      fieldEmployeeId: operatorUser.employeeId, fieldName: operatorUser.name, fieldEmpName: operatorEmployee.name,
      launcherEmployeeId: launcher.employeeId, launcherName: launcher.name, launcherEmpName: launcherEmployee.name, launcherRole: launcher.role, manual: dailyRecords.manualEntry,
    }).from(dailyRecords)
      .leftJoin(operatorUser, eq(operatorUser.id, dailyRecords.fieldOperatorId)).leftJoin(operatorEmployee, eq(operatorEmployee.id, operatorUser.employeeId))
      .leftJoin(launcher, eq(launcher.id, dailyRecords.userId)).leftJoin(launcherEmployee, eq(launcherEmployee.id, launcher.employeeId))
      .where(and(inArray(dailyRecords.equipmentId, ids), gte(dailyRecords.recordDate, sinceDay))).orderBy(desc(dailyRecords.recordDate), desc(dailyRecords.id)),
    db.select({ equipmentId: fuelMovements.equipmentId, quantity: fuelMovements.quantity }).from(fuelMovements)
      .where(and(inArray(fuelMovements.equipmentId, ids), eq(fuelMovements.movementType, "SAIDA"), isNull(fuelMovements.deletedAt), eq(fuelMovements.balanceAdjustment, false), gte(fuelMovements.movementDate, sinceDay)))
      .orderBy(desc(fuelMovements.movementDate), desc(fuelMovements.id)),
  ]);
  const unitOf = new Map(items.map((item) => [item.id, item.unit]));
  for (const row of meter) {
    const unit = unitOf.get(row.equipmentId); const value = unit === "KM" ? row.km : row.hours;
    if (value !== null && value !== undefined) result.get(row.equipmentId)!.readings.push({ value, at: row.readingDate.slice(0, 16) });
  }
  const worked = new Map<number, number[]>();
  for (const row of daily) {
    const entry = result.get(row.equipmentId)!;
    if (row.unit === unitOf.get(row.equipmentId) && row.worked && row.end !== null) {
      entry.readings.push({ value: row.end, at: `${row.recordDate}T23:59` });
      if (row.start !== null && row.end > row.start) { const list = worked.get(row.equipmentId) ?? []; if (list.length < 30) list.push(row.end - row.start); worked.set(row.equipmentId, list); }
    }
    // Último operador registrado no Controle Diário (lançado pelo próprio operador ou por terceiro).
    if (!entry.lastOperator && !row.noOperator) {
      const name = row.fieldEmpName ?? row.fieldName ?? (row.manual ? row.operatorName : null) ?? (row.launcherRole === "CAMPO" ? row.launcherEmpName ?? row.launcherName : null);
      if (name) entry.lastOperator = { employeeId: row.fieldEmployeeId ?? (row.manual ? null : row.launcherRole === "CAMPO" ? row.launcherEmployeeId : null), name };
    }
  }
  for (const [id, list] of worked) result.get(id)!.avgPerDay = list.reduce((sum, value) => sum + value, 0) / list.length;
  for (const row of fuel) { const entry = row.equipmentId ? result.get(row.equipmentId) : null; if (entry && entry.liters.length < 20) entry.liters.push(row.quantity); }
  return result;
}

const statsOf = (liters: number[]): LitersStats | null => liters.length ? { count: liters.length, average: liters.reduce((sum, value) => sum + value, 0) / liters.length, max: Math.max(...liters) } : null;

// Maior leitura registrada ANTES de um momento (wall time de Fortaleza "AAAA-MM-DDTHH:MM"; null = todas).
// Leituras só crescem: a maior até o momento é a última.
function readingBefore(history: EquipmentHistory | undefined, until: string | null): ReadingPoint | null {
  let best: ReadingPoint | null = null;
  for (const point of history?.readings ?? []) if ((until === null || point.at < until) && (!best || point.value > best.value)) best = point;
  return best;
}

// ---------------------------------------------------------------------------
// App de campo: cadastro para uso offline
// ---------------------------------------------------------------------------
export async function convoyFieldCatalog(user: SessionUser) {
  if (!canRegisterConvoy(user)) throw new ConvoyError("Seu acesso não registra abastecimentos do comboio.", 403);
  const db = await getDb();
  const scope = visibleScope(user);
  const frontCondition = scope === null ? undefined : scope.length ? inArray(equipment.serviceFrontId, scope) : eq(equipment.id, -1);
  const today = fortalezaDay();
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10);
  const [rows, people, me, settings] = await Promise.all([
    db.select({
      id: equipment.id, prefix: equipment.prefix, code: equipment.code, plate: equipment.plate, type: equipment.type, brand: equipment.brand, model: equipment.model,
      controlType: equipment.controlType, status: equipment.status, currentHours: equipment.currentHours, currentKm: equipment.currentKm,
      serviceFrontId: equipment.serviceFrontId, front: serviceFronts.name,
    }).from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
      .where(and(isNull(equipment.soldAt), ne(equipment.status, "INACTIVE"), frontCondition)).orderBy(asc(equipment.sortKey)),
    db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, serviceFrontId: employees.serviceFrontId, front: serviceFronts.name })
      .from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId))
      .where(and(ne(employees.status, "DEMITIDO"), scope === null ? undefined : scope.length ? inArray(employees.serviceFrontId, scope) : eq(employees.id, -1))).orderBy(asc(employees.name)),
    db.select({ convoyEquipmentId: users.convoyEquipmentId, convoyPrefix: equipment.prefix }).from(users).leftJoin(equipment, eq(equipment.id, users.convoyEquipmentId)).where(eq(users.id, user.id)).limit(1),
    convoySettings(db),
  ]);
  const items = rows.map((row) => ({ ...row, unit: readingUnitFor(row.controlType, row.prefix) as ConvoyUnit }));
  const histories = await equipmentHistories(db, items, since);
  return {
    generatedAt: new Date().toISOString(), today, userId: user.id,
    convoy: me[0]?.convoyEquipmentId ? { id: me[0].convoyEquipmentId, prefix: me[0].convoyPrefix ?? "" } : null,
    settings: { pumpPhotoRequired: settings.pumpPhotoRequired },
    noPhotoReasons: Object.entries(NO_PHOTO_LABELS).map(([value, label]) => ({ value, label })),
    equipment: items.map((item) => {
      const history = histories.get(item.id);
      const current = item.unit === "KM" ? item.currentKm : item.currentHours;
      const best = readingBefore(history, null);
      const last = best && best.value >= current ? { value: best.value, at: best.at } : { value: current > 0 ? current : best?.value ?? null, at: null };
      return {
        id: item.id, prefix: item.prefix, code: item.code, plate: item.plate, type: item.type, model: [item.brand, item.model].filter(Boolean).join(" "),
        serviceFrontId: item.serviceFrontId, front: item.front ?? "Sem frente", unit: item.unit,
        lastReading: last.value, lastReadingDate: last.at ? last.at.slice(0, 10) : null,
        lastOperator: history?.lastOperator ?? null, litersStats: statsOf(history?.liters ?? []), avgPerDay: history?.avgPerDay ?? null,
      };
    }),
    employees: people.map((person) => ({ id: person.id, name: person.name, jobTitle: person.jobTitle, serviceFrontId: person.serviceFrontId, front: person.front })),
  };
}

// ---------------------------------------------------------------------------
// App de campo: recebimento (idempotente pelo client_uuid)
// ---------------------------------------------------------------------------
export async function receiveConvoyRecord(user: SessionUser, raw: Record<string, unknown>, files: { meter: File | null; pump: File | null }) {
  if (!canRegisterConvoy(user)) throw new ConvoyError("Seu acesso não registra abastecimentos do comboio.", 403);
  const db = await getDb();
  const payload = readConvoyPayload(raw);
  const existing = payload.clientUuid ? (await db.select({ id: convoyFuelRecords.id, status: convoyFuelRecords.status, registeredBy: convoyFuelRecords.registeredBy }).from(convoyFuelRecords).where(eq(convoyFuelRecords.clientUuid, payload.clientUuid)).limit(1))[0] : null;
  if (existing) {
    if (existing.registeredBy !== user.id) throw new ConvoyError("Registro de outro usuário.", 409);
    return { id: existing.id, status: existing.status as ConvoyStatus, duplicate: true };
  }
  const settings = await convoySettings(db);
  const problem = validateConvoyPayload(payload, { hasMeterPhoto: Boolean(files.meter), hasPumpPhoto: Boolean(files.pump), pumpPhotoRequired: settings.pumpPhotoRequired });
  if (problem) throw new ConvoyError(problem);
  const target = (await db.select({ id: equipment.id, prefix: equipment.prefix, controlType: equipment.controlType, serviceFrontId: equipment.serviceFrontId }).from(equipment).where(eq(equipment.id, payload.equipmentId)).limit(1))[0];
  if (!target) throw new ConvoyError("Equipamento não encontrado no cadastro.");
  if (!inScope(visibleScope(user), target.serviceFrontId)) throw new ConvoyError(`O equipamento ${target.prefix} não está nas suas frentes.`, 403);
  const operator = payload.operatorEmployeeId ? (await db.select({ id: employees.id, name: employees.name }).from(employees).where(eq(employees.id, payload.operatorEmployeeId)).limit(1))[0] : null;
  const me = (await db.select({ convoyEquipmentId: users.convoyEquipmentId }).from(users).where(eq(users.id, user.id)).limit(1))[0];
  let meterKey: string | null = null, pumpKey: string | null = null;
  try {
    if (files.meter && !payload.noPhoto) meterKey = await storeConvoyPhoto(files.meter, "meter");
    if (files.pump) pumpKey = await storeConvoyPhoto(files.pump, "pump");
  } catch (error) {
    if (error instanceof ConvoyPhotoError) throw new ConvoyError(error.message, error.status);
    throw error;
  }
  const now = new Date().toISOString();
  try {
    const [created] = await db.insert(convoyFuelRecords).values({
      clientUuid: payload.clientUuid, status: "PENDENTE", registeredBy: user.id, convoyEquipmentId: me?.convoyEquipmentId ?? null,
      equipmentId: target.id, serviceFrontId: target.serviceFrontId, fuelTypeId: await defaultConvoyFuelTypeId(db),
      operatorEmployeeId: operator?.id ?? null, operatorName: operator?.name ?? payload.operatorName,
      liters: payload.liters, reading: payload.reading, readingUnit: readingUnitFor(target.controlType, target.prefix), deviceLastReading: payload.deviceLastReading,
      recordedAt: payload.recordedAt, recordDate: payload.recordDate, dateJustification: payload.recordDate === fortalezaDay(new Date(payload.recordedAt)) ? null : payload.dateJustification,
      noPhoto: payload.noPhoto, noPhotoReason: payload.noPhotoReason, noPhotoNote: payload.noPhotoNote,
      meterPhotoKey: meterKey, pumpPhotoKey: pumpKey, photoTakenAt: payload.photoTakenAt,
      latitude: payload.latitude, longitude: payload.longitude, gpsAccuracy: payload.gpsAccuracy, notes: payload.notes,
      deviceWarnings: payload.deviceWarnings.length ? JSON.stringify(payload.deviceWarnings) : null, receivedAt: now, createdAt: now, updatedAt: now,
    }).returning({ id: convoyFuelRecords.id });
    await log(db, user.id, created.id, "ABASTECIMENTO DO COMBOIO RECEBIDO", undefined, {
      clientUuid: payload.clientUuid, equipment: target.prefix, liters: payload.liters, reading: payload.reading, recordedAt: payload.recordedAt, noPhoto: payload.noPhoto,
      noPhotoReason: payload.noPhotoReason, deviceWarnings: payload.deviceWarnings, latitude: payload.latitude, longitude: payload.longitude,
    });
    return { id: created.id, status: "PENDENTE" as ConvoyStatus, duplicate: false };
  } catch (error) {
    // Dois envios do mesmo registro ao mesmo tempo: o índice único segura; devolve o que ficou.
    const again = (await db.select({ id: convoyFuelRecords.id, status: convoyFuelRecords.status }).from(convoyFuelRecords).where(eq(convoyFuelRecords.clientUuid, payload.clientUuid)).limit(1))[0];
    if (again) return { id: again.id, status: again.status as ConvoyStatus, duplicate: true };
    throw error;
  }
}

// "Meus abastecimentos": status de aprovação, motivo da rejeição e pedido de correção.
export async function myConvoyRecords(user: SessionUser) {
  if (!canRegisterConvoy(user)) throw new ConvoyError("Seu acesso não registra abastecimentos do comboio.", 403);
  const db = await getDb();
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({
    id: convoyFuelRecords.id, clientUuid: convoyFuelRecords.clientUuid, status: convoyFuelRecords.status, equipment: equipment.prefix, operatorName: convoyFuelRecords.operatorName,
    liters: convoyFuelRecords.liters, reading: convoyFuelRecords.reading, readingUnit: convoyFuelRecords.readingUnit, recordedAt: convoyFuelRecords.recordedAt, recordDate: convoyFuelRecords.recordDate,
    noPhoto: convoyFuelRecords.noPhoto, rejectionReason: convoyFuelRecords.rejectionReason, correctionNote: convoyFuelRecords.correctionNote, approvedAt: convoyFuelRecords.approvedAt, rejectedAt: convoyFuelRecords.rejectedAt,
    equipmentId: convoyFuelRecords.equipmentId,
  }).from(convoyFuelRecords).innerJoin(equipment, eq(equipment.id, convoyFuelRecords.equipmentId))
    .where(and(eq(convoyFuelRecords.registeredBy, user.id), gte(convoyFuelRecords.recordDate, since))).orderBy(desc(convoyFuelRecords.recordedAt)).limit(200);
  return rows.map((row) => ({ ...row, status: row.status === "APROVANDO" ? "PENDENTE" : row.status }));
}

// Motorista responde ao "Pedir correção": novos litros/leitura/observação (e foto nova, se tirou).
export async function answerConvoyCorrection(user: SessionUser, clientUuid: string, raw: Record<string, unknown>, meter: File | null) {
  if (!canRegisterConvoy(user)) throw new ConvoyError("Seu acesso não registra abastecimentos do comboio.", 403);
  const db = await getDb();
  const record = (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.clientUuid, clientUuid.toLowerCase())).limit(1))[0];
  if (!record || record.registeredBy !== user.id) throw new ConvoyError("Registro não encontrado.", 404);
  if (record.status !== "CORRECAO" && typeof raw.answerId === "string" && raw.answerId && record.corrections?.includes(`"resposta":"${raw.answerId.slice(0, 40)}"`)) return { id: record.id, status: record.status as ConvoyStatus, duplicate: true };
  if (record.status !== "CORRECAO") throw new ConvoyError("Este registro não está aguardando correção.", 409);
  const liters = raw.liters === undefined || raw.liters === "" ? record.liters : parseConvoyNumber(raw.liters) ?? NaN;
  const reading = raw.reading === undefined || raw.reading === "" ? record.reading : parseConvoyNumber(raw.reading);
  if (!Number.isFinite(liters) || liters <= 0) throw new ConvoyError("Informe a quantidade em litros.");
  if (reading !== null && (!Number.isFinite(reading) || reading < 0)) throw new ConvoyError("Informe uma leitura válida.");
  let meterKey = record.meterPhotoKey;
  if (meter) { try { meterKey = await storeConvoyPhoto(meter, "meter"); } catch (error) { if (error instanceof ConvoyPhotoError) throw new ConvoyError(error.message, error.status); throw error; } }
  const now = new Date().toISOString();
  const answer = typeof raw.answerId === "string" ? raw.answerId.slice(0, 40) : null;
  const changes = [
    ...(liters !== record.liters ? [{ campo: "litros", de: record.liters, para: liters }] : []),
    ...(reading !== record.reading ? [{ campo: "leitura", de: record.reading, para: reading }] : []),
    ...(meterKey !== record.meterPhotoKey ? [{ campo: "foto do medidor", de: "anterior", para: "nova" }] : []),
  ].map((change) => ({ ...change, por: user.name, porId: user.id, em: now, origem: "MOTORISTA", resposta: answer }));
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 300) : "";
  // Sempre registra a resposta (com o id gerado no celular): reenviar a mesma resposta não dá erro.
  const corrections = [...(record.corrections ? JSON.parse(record.corrections) as unknown[] : []), ...changes, { campo: "resposta do motorista", de: record.correctionNote, para: note || "(sem observação)", por: user.name, porId: user.id, em: now, origem: "MOTORISTA", resposta: answer }];
  await db.update(convoyFuelRecords).set({
    liters, reading, meterPhotoKey: meterKey, noPhoto: meterKey ? false : record.noPhoto, status: "PENDENTE", corrections: JSON.stringify(corrections), aiStatus: null, aiReading: null, aiCheckedAt: null, updatedAt: now,
  }).where(eq(convoyFuelRecords.id, record.id));
  await log(db, user.id, record.id, "CORREÇÃO ENVIADA PELO MOTORISTA", { liters: record.liters, reading: record.reading }, { liters, reading, note, newPhoto: meterKey !== record.meterPhotoKey });
  return { id: record.id, status: "PENDENTE" as ConvoyStatus, duplicate: false };
}

// ---------------------------------------------------------------------------
// Aprovação
// ---------------------------------------------------------------------------
const registrar = alias(users, "convoy_registrar");
const approver = alias(users, "convoy_approver");
const rejecter = alias(users, "convoy_rejecter");
const convoyEquipment = alias(equipment, "convoy_equipment");

export type ConvoyListFilters = { status: ConvoyStatus | "ABERTOS" | "TODOS"; from: string | null; to: string | null; frontId: number | null; id?: number | null };

async function queryRecords(db: Db, where: ReturnType<typeof and>) {
  return db.select({
    record: convoyFuelRecords, equipmentPrefix: equipment.prefix, equipmentPlate: equipment.plate, equipmentModel: sql<string>`trim(concat(${equipment.brand}, ' ', ${equipment.model}))`,
    controlType: equipment.controlType, currentHours: equipment.currentHours, currentKm: equipment.currentKm, equipmentFrontId: equipment.serviceFrontId,
    frontName: serviceFronts.name, registeredByName: registrar.name, approvedByName: approver.name, rejectedByName: rejecter.name, convoyPrefix: convoyEquipment.prefix,
  }).from(convoyFuelRecords)
    .innerJoin(equipment, eq(equipment.id, convoyFuelRecords.equipmentId))
    .leftJoin(serviceFronts, eq(serviceFronts.id, convoyFuelRecords.serviceFrontId))
    .leftJoin(registrar, eq(registrar.id, convoyFuelRecords.registeredBy))
    .leftJoin(approver, eq(approver.id, convoyFuelRecords.approvedBy))
    .leftJoin(rejecter, eq(rejecter.id, convoyFuelRecords.rejectedBy))
    .leftJoin(convoyEquipment, eq(convoyEquipment.id, convoyFuelRecords.convoyEquipmentId))
    .where(where).orderBy(asc(convoyFuelRecords.recordedAt), asc(convoyFuelRecords.id)).limit(500);
}
type ListRow = Awaited<ReturnType<typeof queryRecords>>[number];

export async function listConvoyRecords(user: SessionUser, filters: ConvoyListFilters) {
  if (!canApproveConvoy(user)) throw new ConvoyError("Você não aprova abastecimentos do comboio.", 403);
  const db = await getDb();
  const scope = visibleScope(user);
  const conditions = [
    scope === null ? undefined : scope.length ? inArray(convoyFuelRecords.serviceFrontId, scope) : eq(convoyFuelRecords.id, -1),
    filters.id ? eq(convoyFuelRecords.id, filters.id) : undefined,
    filters.status === "ABERTOS" ? inArray(convoyFuelRecords.status, ["PENDENTE", "CORRECAO", "APROVANDO"]) : filters.status === "TODOS" ? undefined : eq(convoyFuelRecords.status, filters.status),
    filters.from ? gte(convoyFuelRecords.recordDate, filters.from) : undefined,
    filters.to ? lte(convoyFuelRecords.recordDate, filters.to) : undefined,
    filters.frontId ? eq(convoyFuelRecords.serviceFrontId, filters.frontId) : undefined,
  ];
  const rows = await queryRecords(db, and(...conditions));
  const oldest = rows.reduce((min, row) => (row.record.recordDate < min ? row.record.recordDate : min), fortalezaDay());
  const since = new Date(Date.parse(`${oldest}T12:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10);
  const uniqueEquipment = [...new Map(rows.map((row) => [row.record.equipmentId, { id: row.record.equipmentId, unit: row.record.readingUnit as ConvoyUnit, currentHours: row.currentHours, currentKm: row.currentKm }])).values()];
  const histories = await equipmentHistories(db, uniqueEquipment, since);
  return rows.map((row) => describeRecord(row, histories.get(row.record.equipmentId)));
}

function describeRecord(row: ListRow, history: EquipmentHistory | undefined) {
  const r = row.record;
  const unit = r.readingUnit as ConvoyUnit;
  const until = fortalezaWallTime(r.recordedAt);
  // Última leitura ANTES deste abastecimento (não muda quando um registro posterior é aprovado). Sem
  // nenhum histórico de leituras, vale a do cadastro do equipamento.
  const previous = readingBefore(history, until);
  const current = (unit === "KM" ? row.currentKm : row.currentHours) || null;
  const known = [previous?.value ?? null, r.deviceLastReading, history?.readings.length ? null : current].filter((value): value is number => value !== null);
  const lastReading = known.length ? Math.max(...known) : null;
  const lastReadingDate = previous && previous.value === lastReading ? previous.at : null;
  const diff = r.reading !== null && lastReading !== null ? r.reading - lastReading : null;
  const warnings = convoyWarnings({ liters: r.liters, reading: r.reading, unit, lastReading, lastReadingDate, recordDate: r.recordDate, litersStats: statsOf(history?.liters ?? []), avgPerDay: history?.avgPerDay ?? null });
  const flags: ConvoyFlag[] = [
    ...(r.noPhoto ? ["SEM_FOTO" as const] : []),
    ...warnings.map((warning) => warning.code),
    ...(r.aiStatus === "DIVERGE" ? ["FOTO_DIVERGE" as const] : []),
  ];
  return {
    id: r.id, clientUuid: r.clientUuid, status: r.status as ConvoyStatus, recordedAt: r.recordedAt, recordDate: r.recordDate, receivedAt: r.receivedAt,
    dateJustification: r.dateJustification,
    convoy: row.convoyPrefix, registeredBy: row.registeredByName, registeredById: r.registeredBy,
    equipmentId: r.equipmentId, equipment: row.equipmentPrefix, equipmentPlate: row.equipmentPlate, equipmentModel: row.equipmentModel,
    serviceFrontId: r.serviceFrontId, front: row.frontName, fuelTypeId: r.fuelTypeId,
    operatorEmployeeId: r.operatorEmployeeId, operatorName: r.operatorName, liters: r.liters, reading: r.reading, unit,
    lastReading, lastReadingDate, difference: diff, consumption: estimatedConsumption(unit, r.liters, diff),
    noPhoto: r.noPhoto, noPhotoReason: r.noPhotoReason as NoPhotoReason | null, noPhotoNote: r.noPhotoNote,
    hasMeterPhoto: Boolean(r.meterPhotoKey), hasPumpPhoto: Boolean(r.pumpPhotoKey), photoTakenAt: r.photoTakenAt,
    latitude: r.latitude, longitude: r.longitude, gpsAccuracy: r.gpsAccuracy, notes: r.notes,
    flags, warnings: [...(r.noPhoto ? [{ code: "SEM_FOTO", message: `Sem foto do medidor: ${r.noPhotoReason ? NO_PHOTO_LABELS[r.noPhotoReason as NoPhotoReason] : "—"}${r.noPhotoNote ? ` (${r.noPhotoNote})` : ""}.` }] : []), ...warnings,
      ...(r.aiStatus === "DIVERGE" && r.aiReading !== null ? [{ code: "FOTO_DIVERGE", message: `A foto mostra ${r.aiReading.toLocaleString("pt-BR")} e foi digitado ${r.reading?.toLocaleString("pt-BR") ?? "—"}.` }] : [])],
    deviceWarnings: r.deviceWarnings ? JSON.parse(r.deviceWarnings) as string[] : [],
    aiReading: r.aiReading, aiStatus: r.aiStatus, aiCheckedAt: r.aiCheckedAt,
    corrections: r.corrections ? JSON.parse(r.corrections) as Array<Record<string, unknown>> : [],
    correctionNote: r.correctionNote, rejectionReason: r.rejectionReason,
    approvedBy: row.approvedByName, approvedAt: r.approvedAt, rejectedBy: row.rejectedByName, rejectedAt: r.rejectedAt,
    fuelMovementId: r.fuelMovementId, readingUpdateNote: r.readingUpdateNote,
  };
}
export type ConvoyRecordView = ReturnType<typeof describeRecord>;

export async function pendingConvoyCount(user: SessionUser) {
  if (!canApproveConvoy(user)) return 0;
  const db = await getDb();
  const scope = visibleScope(user);
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(convoyFuelRecords)
    .where(and(eq(convoyFuelRecords.status, "PENDENTE"), scope === null ? undefined : scope.length ? inArray(convoyFuelRecords.serviceFrontId, scope) : eq(convoyFuelRecords.id, -1)));
  return Number(row?.count ?? 0);
}

// Litros ainda não aprovados por frente e combustível ("Saldo previsto" = saldo − pendentes).
export async function pendingConvoyLiters(db: Db, fronts: number[]) {
  if (!fronts.length) return [];
  const rows = await db.select({ serviceFrontId: convoyFuelRecords.serviceFrontId, fuelTypeId: convoyFuelRecords.fuelTypeId, liters: sql<number>`coalesce(sum(${convoyFuelRecords.liters}),0)::float8`, count: sql<number>`count(*)::int` })
    .from(convoyFuelRecords).where(and(inArray(convoyFuelRecords.status, OPEN_STATUSES), inArray(convoyFuelRecords.serviceFrontId, fronts)))
    .groupBy(convoyFuelRecords.serviceFrontId, convoyFuelRecords.fuelTypeId);
  return rows.map((row) => ({ serviceFrontId: row.serviceFrontId!, fuelTypeId: row.fuelTypeId, liters: Math.round(Number(row.liters) * 100) / 100, count: Number(row.count) }));
}

async function loadForAction(db: Db, user: SessionUser, id: number) {
  if (!canApproveConvoy(user)) throw new ConvoyError("Você não aprova abastecimentos do comboio.", 403);
  const record = (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, id)).limit(1))[0];
  if (!record || !inScope(visibleScope(user), record.serviceFrontId)) throw new ConvoyError("Registro não encontrado.", 404);
  return record;
}

export type ApproveInput = {
  liters?: number | null; reading?: number | null; equipmentId?: number | null; operatorEmployeeId?: number | null; operatorName?: string | null;
  stockLocation?: "FRENTE" | "PORTO"; fuelTypeId?: number | null; note?: string | null;
};

export async function approveConvoyRecord(user: SessionUser, id: number, input: ApproveInput) {
  const db = await getDb();
  const record = await loadForAction(db, user, id);
  if (record.status === "APROVADO") throw new ConvoyError("Este abastecimento já foi aprovado.", 409);
  if (record.status === "REJEITADO") throw new ConvoyError("Este abastecimento foi rejeitado.", 409);
  if (record.status === "APROVANDO") throw new ConvoyError("Este abastecimento está sendo aprovado por outra pessoa.", 409);
  // Correções do aprovador (valor original × novo, quem e quando).
  const now = new Date().toISOString();
  const next = {
    liters: input.liters ?? record.liters, reading: input.reading === undefined ? record.reading : input.reading, equipmentId: input.equipmentId ?? record.equipmentId,
    operatorEmployeeId: input.operatorEmployeeId === undefined ? record.operatorEmployeeId : input.operatorEmployeeId, operatorName: input.operatorName?.trim() || record.operatorName,
    fuelTypeId: input.fuelTypeId ?? record.fuelTypeId ?? await defaultConvoyFuelTypeId(db),
  };
  if (!Number.isFinite(next.liters) || next.liters <= 0) throw new ConvoyError("Informe a quantidade em litros.");
  if (next.reading !== null && (!Number.isFinite(next.reading) || next.reading < 0)) throw new ConvoyError("Informe uma leitura válida.");
  if (!next.fuelTypeId) throw new ConvoyError("Escolha o combustível.");
  const target = (await db.select({ id: equipment.id, prefix: equipment.prefix, controlType: equipment.controlType, serviceFrontId: equipment.serviceFrontId, currentHours: equipment.currentHours, currentKm: equipment.currentKm })
    .from(equipment).where(eq(equipment.id, next.equipmentId)).limit(1))[0];
  if (!target) throw new ConvoyError("Equipamento não encontrado.");
  if (!target.serviceFrontId || !inScope(visibleScope(user), target.serviceFrontId)) throw new ConvoyError(`O equipamento ${target.prefix} não está numa frente que você enxerga.`, 403);
  if (next.operatorEmployeeId) {
    const person = (await db.select({ name: employees.name }).from(employees).where(eq(employees.id, next.operatorEmployeeId)).limit(1))[0];
    if (!person) throw new ConvoyError("Motorista/operador não encontrado no cadastro.");
    next.operatorName = person.name;
  }
  const original = { liters: record.liters, reading: record.reading, equipmentId: record.equipmentId, operatorName: record.operatorName };
  const prefixes = new Map((await db.select({ id: equipment.id, prefix: equipment.prefix }).from(equipment).where(inArray(equipment.id, [record.equipmentId, next.equipmentId]))).map((row) => [row.id, row.prefix]));
  const changes = [
    ...(next.liters !== original.liters ? [{ campo: "litros", de: original.liters, para: next.liters }] : []),
    ...(next.reading !== original.reading ? [{ campo: "leitura", de: original.reading, para: next.reading }] : []),
    ...(next.equipmentId !== original.equipmentId ? [{ campo: "equipamento", de: prefixes.get(original.equipmentId), para: prefixes.get(next.equipmentId) }] : []),
    ...(next.operatorName !== original.operatorName ? [{ campo: "motorista", de: original.operatorName, para: next.operatorName }] : []),
  ].map((change) => ({ ...change, por: user.name, porId: user.id, em: now, origem: "APROVADOR" }));
  // Trava: só um aprovador por vez (dois cliques/duas pessoas não gravam duas saídas).
  const locked = await db.update(convoyFuelRecords).set({ status: "APROVANDO", updatedAt: now })
    .where(and(eq(convoyFuelRecords.id, id), inArray(convoyFuelRecords.status, ["PENDENTE", "CORRECAO"]))).returning({ id: convoyFuelRecords.id });
  if (!locked.length) throw new ConvoyError("Este abastecimento já foi tratado por outra pessoa. Atualize a lista.", 409);
  const unlock = () => db.update(convoyFuelRecords).set({ status: record.status, updatedAt: new Date().toISOString() }).where(and(eq(convoyFuelRecords.id, id), eq(convoyFuelRecords.status, "APROVANDO")));
  const registeredBy = (await db.select({ name: users.name }).from(users).where(eq(users.id, record.registeredBy)).limit(1))[0]?.name ?? "—";
  const convoyPrefix = record.convoyEquipmentId ? (await db.select({ prefix: equipment.prefix }).from(equipment).where(eq(equipment.id, record.convoyEquipmentId)).limit(1))[0]?.prefix ?? null : null;
  const notes = [`Comboio${convoyPrefix ? ` ${convoyPrefix}` : ""}: registrado por ${registeredBy}, aprovado por ${user.name}`, record.noPhoto ? `SEM FOTO (${record.noPhotoReason ? NO_PHOTO_LABELS[record.noPhotoReason as NoPhotoReason] : "—"})` : null, record.notes, input.note?.trim() || null].filter(Boolean).join(" · ");
  let movement: Awaited<ReturnType<typeof createFuelMovement>>;
  try {
    // MESMA função do formulário de Combustível (Saída > Frota): mesmas validações e mesmo saldo.
    movement = await createFuelMovement(db, user, {
      movementType: "SAIDA", thirdParty: false, fuelTypeId: next.fuelTypeId, movementDate: record.recordDate, quantity: next.liters,
      stockLocation: input.stockLocation === "PORTO" ? "PORTO" : "FRENTE", serviceFrontId: target.serviceFrontId, equipmentId: target.id, meterReading: next.reading,
      responsibleEmployeeId: next.operatorEmployeeId, responsible: next.operatorName, notes, clientRequestId: record.clientUuid,
    }, { displayedFronts: "ALL", createdVia: "COMBOIO" });
  } catch (error) {
    await unlock();
    if (error instanceof FuelCreateError) throw new ConvoyError(error.message, error.status, error.data);
    throw error;
  }
  await db.update(fuelMovements).set({ convoyRecordId: record.id }).where(eq(fuelMovements.id, movement.id));
  // Leitura do equipamento: só se for a mais recente e maior que a atual (ciclos e alertas via saveReading).
  const unit = readingUnitFor(target.controlType, target.prefix);
  let readingUpdateNote: string;
  const wall = fortalezaWallTime(record.recordedAt) ?? `${record.recordDate}T12:00`;
  if (next.reading === null) readingUpdateNote = "Sem leitura (registro sem foto): leitura do equipamento não alterada.";
  else if (target.controlType === "HOURS_KM") readingUpdateNote = "Equipamento com horímetro e KM: atualize a leitura pela tela de leituras.";
  else {
    const current = unit === "KM" ? target.currentKm : target.currentHours;
    const newer = (await db.select({ id: meterReadings.id }).from(meterReadings).where(and(eq(meterReadings.equipmentId, target.id), sql`${meterReadings.readingDate} > ${wall}`)).limit(1))[0];
    if (newer) readingUpdateNote = "Já existe leitura mais recente no equipamento: leitura não alterada.";
    else if (next.reading <= current) readingUpdateNote = `Leitura não é maior que a atual (${current.toLocaleString("pt-BR")}): não alterada.`;
    else {
      try {
        await saveReading(await getD1(), {
          equipmentId: target.id, readingDate: wall, hours: unit === "HOURS" ? next.reading : null, km: unit === "KM" ? next.reading : null,
          operator: next.operatorName, notes: `Abastecimento do comboio aprovado (registro ${record.id})`, serviceFrontId: target.serviceFrontId,
          actor: { id: user.id, name: user.name, profile: user.profile }, source: "COMBOIO",
        });
        readingUpdateNote = `Leitura do equipamento atualizada para ${next.reading.toLocaleString("pt-BR")} ${unit === "KM" ? "km" : "h"}.`;
      } catch (error) {
        readingUpdateNote = error instanceof ReadingOperationError ? `Leitura não atualizada: ${error.message}` : "Leitura não atualizada (erro inesperado).";
        if (!(error instanceof ReadingOperationError)) console.error("[convoy.approve.reading]", error);
      }
    }
  }
  const corrections = [...(record.corrections ? JSON.parse(record.corrections) as unknown[] : []), ...changes];
  await db.update(convoyFuelRecords).set({
    status: "APROVADO", approvedBy: user.id, approvedAt: new Date().toISOString(), fuelMovementId: movement.id, readingUpdateNote,
    liters: next.liters, reading: next.reading, equipmentId: target.id, serviceFrontId: target.serviceFrontId, readingUnit: unit,
    operatorEmployeeId: next.operatorEmployeeId, operatorName: next.operatorName, fuelTypeId: next.fuelTypeId,
    corrections: corrections.length ? JSON.stringify(corrections) : null, updatedAt: new Date().toISOString(),
  }).where(eq(convoyFuelRecords.id, id));
  await log(db, user.id, id, "ABASTECIMENTO DO COMBOIO APROVADO", original, { ...next, stockLocation: input.stockLocation ?? "FRENTE", fuelMovementId: movement.id, corrections: changes, readingUpdateNote });
  return { id, fuelMovementId: movement.id, duplicate: movement.duplicate, readingUpdateNote, message: `Aprovado: ${movement.message} ${readingUpdateNote}` };
}

export async function rejectConvoyRecord(user: SessionUser, id: number, reason: string) {
  const db = await getDb();
  const record = await loadForAction(db, user, id);
  const text = reason.trim().slice(0, 300);
  if (text.length < 3) throw new ConvoyError("Escreva o motivo da rejeição (o motorista vai ver).");
  const now = new Date().toISOString();
  const done = await db.update(convoyFuelRecords).set({ status: "REJEITADO", rejectionReason: text, rejectedBy: user.id, rejectedAt: now, updatedAt: now })
    .where(and(eq(convoyFuelRecords.id, id), inArray(convoyFuelRecords.status, ["PENDENTE", "CORRECAO"]))).returning({ id: convoyFuelRecords.id });
  if (!done.length) throw new ConvoyError(record.status === "APROVADO" ? "Este abastecimento já foi aprovado." : "Este abastecimento já foi tratado. Atualize a lista.", 409);
  await log(db, user.id, id, "ABASTECIMENTO DO COMBOIO REJEITADO", { status: record.status }, { reason: text });
  return { id, message: "Abastecimento rejeitado. O motorista vê o motivo no app." };
}

export async function requestConvoyCorrection(user: SessionUser, id: number, note: string) {
  const db = await getDb();
  const record = await loadForAction(db, user, id);
  const text = note.trim().slice(0, 300);
  if (text.length < 3) throw new ConvoyError("Escreva o que o motorista precisa corrigir.");
  const now = new Date().toISOString();
  const done = await db.update(convoyFuelRecords).set({ status: "CORRECAO", correctionNote: text, correctionRequestedBy: user.id, correctionRequestedAt: now, updatedAt: now })
    .where(and(eq(convoyFuelRecords.id, id), eq(convoyFuelRecords.status, "PENDENTE"))).returning({ id: convoyFuelRecords.id });
  if (!done.length) throw new ConvoyError("Só dá para pedir correção de um abastecimento pendente.", 409);
  await log(db, user.id, id, "CORREÇÃO PEDIDA AO MOTORISTA", { status: record.status }, { note: text });
  return { id, message: "Correção pedida. O motorista vê o pedido no app." };
}

// Aprovar em lote: só os itens sem nenhuma etiqueta de alerta (origem Frente, valores do motorista).
export async function approveConvoyBatch(user: SessionUser, ids: number[]) {
  const views = (await listConvoyRecords(user, { status: "PENDENTE", from: null, to: null, frontId: null })).filter((item) => ids.includes(item.id));
  const approved: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const id of ids) {
    const view = views.find((item) => item.id === id);
    if (!view) { skipped.push({ id, reason: "não está mais pendente" }); continue; }
    if (view.flags.length) { skipped.push({ id, reason: `tem etiqueta: ${view.flags.join(", ")}` }); continue; }
    try { await approveConvoyRecord(user, id, {}); approved.push(id); }
    catch (error) { skipped.push({ id, reason: error instanceof ConvoyError ? error.message : "erro inesperado" }); if (!(error instanceof ConvoyError)) console.error("[convoy.batch]", error); }
  }
  return { approved, skipped, message: `${approved.length} aprovado(s)${skipped.length ? `, ${skipped.length} não aprovado(s) (com etiqueta ou já tratados)` : ""}.` };
}

// Quem pode ver a foto: aprovador ou quem vê o Combustível, nas frentes que enxerga; o próprio motorista.
export async function convoyPhotoKey(user: SessionUser, id: number, kind: "meter" | "pump") {
  const db = await getDb();
  const record = (await db.select({ meter: convoyFuelRecords.meterPhotoKey, pump: convoyFuelRecords.pumpPhotoKey, frontId: convoyFuelRecords.serviceFrontId, registeredBy: convoyFuelRecords.registeredBy })
    .from(convoyFuelRecords).where(eq(convoyFuelRecords.id, id)).limit(1))[0];
  if (!record) return null;
  const allowed = record.registeredBy === user.id || ((canApproveConvoy(user) || user.permissions.includes("fuel.view")) && inScope(visibleScope(user), record.frontId));
  if (!allowed) return null;
  return kind === "meter" ? record.meter : record.pump;
}

// ---------------------------------------------------------------------------
// Relatório do comboio
// ---------------------------------------------------------------------------
export type ConvoyReportFilters = { from: string; to: string; convoyEquipmentId: number | null; registeredBy: number | null; equipmentId: number | null };

export async function convoyReport(user: SessionUser, filters: ConvoyReportFilters) {
  if (!canApproveConvoy(user) && !user.permissions.includes("fuel.view")) throw new ConvoyError("Sem permissão.", 403);
  const db = await getDb();
  const scope = visibleScope(user);
  const rows = await db.select({
    id: convoyFuelRecords.id, status: convoyFuelRecords.status, recordDate: convoyFuelRecords.recordDate, recordedAt: convoyFuelRecords.recordedAt, receivedAt: convoyFuelRecords.receivedAt,
    approvedAt: convoyFuelRecords.approvedAt, liters: convoyFuelRecords.liters, noPhoto: convoyFuelRecords.noPhoto, noPhotoReason: convoyFuelRecords.noPhotoReason,
    convoyId: convoyFuelRecords.convoyEquipmentId, convoy: convoyEquipment.prefix, registeredById: convoyFuelRecords.registeredBy, registeredBy: registrar.name,
    equipmentId: convoyFuelRecords.equipmentId, equipment: equipment.prefix, front: serviceFronts.name,
  }).from(convoyFuelRecords)
    .innerJoin(equipment, eq(equipment.id, convoyFuelRecords.equipmentId))
    .leftJoin(convoyEquipment, eq(convoyEquipment.id, convoyFuelRecords.convoyEquipmentId))
    .leftJoin(registrar, eq(registrar.id, convoyFuelRecords.registeredBy))
    .leftJoin(serviceFronts, eq(serviceFronts.id, convoyFuelRecords.serviceFrontId))
    .where(and(
      gte(convoyFuelRecords.recordDate, filters.from), lte(convoyFuelRecords.recordDate, filters.to),
      scope === null ? undefined : scope.length ? inArray(convoyFuelRecords.serviceFrontId, scope) : eq(convoyFuelRecords.id, -1),
      filters.convoyEquipmentId ? eq(convoyFuelRecords.convoyEquipmentId, filters.convoyEquipmentId) : undefined,
      filters.registeredBy ? eq(convoyFuelRecords.registeredBy, filters.registeredBy) : undefined,
      filters.equipmentId ? eq(convoyFuelRecords.equipmentId, filters.equipmentId) : undefined,
    )).orderBy(asc(convoyFuelRecords.recordedAt));
  type Group = { key: string; label: string; records: number; liters: number; approvedLiters: number; pending: number; rejected: number; noPhoto: number };
  const group = (map: Map<string, Group>, key: string, label: string, row: (typeof rows)[number]) => {
    const item = map.get(key) ?? { key, label, records: 0, liters: 0, approvedLiters: 0, pending: 0, rejected: 0, noPhoto: 0 };
    item.records += 1; item.liters += row.liters;
    if (row.status === "APROVADO") item.approvedLiters += row.liters;
    if (OPEN_STATUSES.includes(row.status as ConvoyStatus)) item.pending += 1;
    if (row.status === "REJEITADO") item.rejected += 1;
    if (row.noPhoto) item.noPhoto += 1;
    map.set(key, item);
  };
  const byConvoy = new Map<string, Group>(), byDriver = new Map<string, Group>(), byEquipment = new Map<string, Group>();
  const noPhotoByReason: Record<string, number> = {};
  let approvalHours = 0, approvedCount = 0;
  for (const row of rows) {
    group(byConvoy, String(row.convoyId ?? 0), row.convoy ?? "Sem comboio", row);
    group(byDriver, String(row.registeredById), row.registeredBy ?? "—", row);
    group(byEquipment, String(row.equipmentId), row.equipment, row);
    if (row.noPhoto) { const label = row.noPhotoReason ? NO_PHOTO_LABELS[row.noPhotoReason as NoPhotoReason] : "Sem motivo"; noPhotoByReason[label] = (noPhotoByReason[label] ?? 0) + 1; }
    if (row.status === "APROVADO" && row.approvedAt) { approvalHours += (Date.parse(row.approvedAt) - Date.parse(row.receivedAt)) / 3_600_000; approvedCount += 1; }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  const finish = (map: Map<string, Group>) => [...map.values()].map((item) => ({ ...item, liters: round(item.liters), approvedLiters: round(item.approvedLiters) })).sort((a, b) => b.liters - a.liters);
  const sum = (predicate: (row: (typeof rows)[number]) => boolean) => round(rows.filter(predicate).reduce((total, row) => total + row.liters, 0));
  return {
    filters,
    totals: {
      records: rows.length, liters: sum(() => true), approvedLiters: sum((row) => row.status === "APROVADO"), pendingLiters: sum((row) => OPEN_STATUSES.includes(row.status as ConvoyStatus)),
      approved: rows.filter((row) => row.status === "APROVADO").length, pending: rows.filter((row) => OPEN_STATUSES.includes(row.status as ConvoyStatus)).length,
      rejected: rows.filter((row) => row.status === "REJEITADO").length, noPhoto: rows.filter((row) => row.noPhoto).length, noPhotoByReason,
      averageApprovalHours: approvedCount ? round(approvalHours / approvedCount) : null,
    },
    byConvoy: finish(byConvoy), byDriver: finish(byDriver), byEquipment: finish(byEquipment),
    options: {
      convoys: [...new Map(rows.filter((row) => row.convoyId).map((row) => [row.convoyId!, row.convoy ?? ""])).entries()].map(([id, label]) => ({ id, label })),
      drivers: [...new Map(rows.map((row) => [row.registeredById, row.registeredBy ?? ""])).entries()].map(([id, label]) => ({ id, label })),
      equipment: [...new Map(rows.map((row) => [row.equipmentId, row.equipment])).entries()].map(([id, label]) => ({ id, label })),
    },
  };
}

// Pendentes do dia de uma frente (linha do Resumo do dia e do PDF).
export async function pendingConvoyForDay(db: Db, frontId: number, date: string, fuelTypeId: number) {
  const [row] = await db.select({ liters: sql<number>`coalesce(sum(${convoyFuelRecords.liters}),0)::float8`, count: sql<number>`count(*)::int` }).from(convoyFuelRecords)
    .where(and(eq(convoyFuelRecords.serviceFrontId, frontId), eq(convoyFuelRecords.recordDate, date), inArray(convoyFuelRecords.status, OPEN_STATUSES),
      or(eq(convoyFuelRecords.fuelTypeId, fuelTypeId), isNull(convoyFuelRecords.fuelTypeId))));
  return { liters: Math.round(Number(row?.liters ?? 0) * 100) / 100, count: Number(row?.count ?? 0) };
}

export type { ConvoyPayload };
