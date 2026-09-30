import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, checklistAnswers, checklistSubmissions, checklistTemplateItems, checklistTemplates, dailyRecords, equipment, serviceFronts, users, workOrders } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { checklistStatus, validateChecklist, workOrderDescription, type ChecklistItem } from "./checklist-rules";
import { canManage, canRegister, canViewAll, DailyRecordError, readPhoto, removePhoto, requireEquipment, storePhoto } from "./daily-records";
import { workOrderNumber } from "./document-numbers";

// ---------------------------------------------------------------------------
// Checklist pré-uso (Controle Diário → Checklist). Preencher: daily.register (inclui o login de
// campo). Ver o painel de todos: daily.view_all ou daily.manage. Modelos: daily.manage.
// ---------------------------------------------------------------------------
export class ChecklistError extends Error {
  constructor(message: string, public status = 400, public fields?: Record<number, string>) { super(message); }
}
export function checklistErrorResponse(error: unknown) {
  if (error instanceof ChecklistError) return Response.json({ error: error.message, fields: error.fields }, { status: error.status });
  if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}

const localDay = (offsetDays = 0) => {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(date);
};

type Db = Awaited<ReturnType<typeof getDb>>;

// Modelo do tipo do equipamento; sem modelo próprio, o padrão (equipment_type NULL).
export async function templateFor(db: Db, equipmentType: string | null) {
  const templates = await db.select().from(checklistTemplates).where(eq(checklistTemplates.active, true));
  const key = (equipmentType ?? "").trim().toUpperCase();
  const template = templates.find((item) => item.equipmentType && item.equipmentType.trim().toUpperCase() === key) ?? templates.find((item) => item.equipmentType === null) ?? null;
  if (!template) return null;
  const items = await db.select({ id: checklistTemplateItems.id, label: checklistTemplateItems.label, blocking: checklistTemplateItems.blocking, photoRequired: checklistTemplateItems.photoRequired })
    .from(checklistTemplateItems).where(and(eq(checklistTemplateItems.templateId, template.id), eq(checklistTemplateItems.active, true))).orderBy(asc(checklistTemplateItems.position), asc(checklistTemplateItems.id));
  return { ...template, items };
}

export async function checklistForEquipment(user: SessionUser, equipmentId: number) {
  const item = await requireEquipment(user, equipmentId);
  const db = await getDb();
  const type = (await db.select({ type: equipment.type }).from(equipment).where(eq(equipment.id, item.id)).limit(1))[0]?.type ?? null;
  const template = await templateFor(db, type);
  const today = localDay();
  const done = await db.select({ id: checklistSubmissions.id, status: checklistSubmissions.status, operatorName: checklistSubmissions.operatorName, createdAt: checklistSubmissions.createdAt })
    .from(checklistSubmissions).where(and(eq(checklistSubmissions.equipmentId, item.id), eq(checklistSubmissions.checklistDate, today))).orderBy(desc(checklistSubmissions.id));
  return { equipmentId: item.id, prefix: item.prefix, readingUnit: item.readingUnit, template, today, doneToday: done };
}

type SubmitPayload = { equipmentId: number; checklistDate: string; operatorName: string | null; meterReading: number | null; notes: string | null; clientRequestId: string | null; answers: Array<{ itemId: number; ok: boolean | null; comment: string }> };

export function readSubmitPayload(raw: string): SubmitPayload {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { throw new ChecklistError("Dados do checklist inválidos."); }
  const answers = Array.isArray(body.answers) ? body.answers.map((answer: Record<string, unknown>) => ({ itemId: Number(answer.itemId), ok: answer.ok === true ? true : answer.ok === false ? false : null, comment: String(answer.comment ?? "").trim().slice(0, 500) })) : [];
  const reading = body.meterReading === null || body.meterReading === undefined || body.meterReading === "" ? null : Number(String(body.meterReading).replace(",", "."));
  return {
    equipmentId: Number(body.equipmentId), checklistDate: String(body.checklistDate ?? localDay()), operatorName: String(body.operatorName ?? "").trim().slice(0, 120) || null,
    meterReading: reading !== null && Number.isFinite(reading) && reading >= 0 ? reading : null, notes: String(body.notes ?? "").trim().slice(0, 1000) || null,
    clientRequestId: typeof body.clientRequestId === "string" && /^[0-9a-f-]{36}$/.test(body.clientRequestId) ? body.clientRequestId : null, answers,
  };
}

export async function submitChecklist(user: SessionUser, payload: SubmitPayload, photos: Map<number, File>) {
  if (!canRegister(user)) throw new ChecklistError("Você não possui permissão para preencher o checklist.", 403);
  const db = await getDb();
  if (payload.clientRequestId) {
    // Reenvio da fila offline de um checklist que já chegou: não duplica.
    const existing = (await db.select({ id: checklistSubmissions.id, status: checklistSubmissions.status }).from(checklistSubmissions).where(eq(checklistSubmissions.clientRequestId, payload.clientRequestId)).limit(1))[0];
    if (existing) return { id: existing.id, status: existing.status, workOrderNumber: null, duplicate: true };
  }
  const item = await requireEquipment(user, payload.equipmentId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.checklistDate) || payload.checklistDate > localDay() || payload.checklistDate < localDay(-3)) throw new ChecklistError("A data do checklist precisa ser de hoje ou dos últimos 3 dias.");
  const equipmentRow = (await db.select({ type: equipment.type, serviceFrontId: equipment.serviceFrontId }).from(equipment).where(eq(equipment.id, item.id)).limit(1))[0];
  const template = await templateFor(db, equipmentRow?.type ?? null);
  if (!template || !template.items.length) throw new ChecklistError("Não há modelo de checklist cadastrado. Peça ao administrador para cadastrar os itens.", 409);
  const items: ChecklistItem[] = template.items;
  const answers = items.map((entry) => { const answer = payload.answers.find((candidate) => candidate.itemId === entry.id); return { itemId: entry.id, ok: answer?.ok ?? null, comment: answer?.comment ?? "", hasPhoto: photos.has(entry.id) }; });
  const errors = validateChecklist(items, answers);
  if (Object.keys(errors).length) throw new ChecklistError("Confira os itens destacados.", 400, errors);
  const status = checklistStatus(items, answers);
  const operator = user.profile === "CAMPO" ? user.name : payload.operatorName ?? user.name;
  const failed = items.filter((entry) => answers.find((answer) => answer.itemId === entry.id)?.ok === false)
    .map((entry) => ({ ...entry, comment: answers.find((answer) => answer.itemId === entry.id)!.comment }));

  // Fotos gravadas antes da transação; se algo falhar, são apagadas.
  const stored = new Map<number, string>();
  try {
    for (const entry of failed) { const file = photos.get(entry.id); if (file) stored.set(entry.id, await storePhoto(file)); }
    const now = new Date().toISOString();
    return await db.transaction(async (tx) => {
      let workOrderId: number | null = null;
      let createdOrder = false;
      if (failed.length && template.openWorkOrder && equipmentRow?.serviceFrontId) {
        const open = (await tx.select({ id: workOrders.id }).from(workOrders).where(and(eq(workOrders.equipmentId, item.id), eq(workOrders.status, "OPEN"))).orderBy(desc(workOrders.id)).limit(1))[0];
        if (open) workOrderId = open.id;
        else {
          workOrderId = (await tx.insert(workOrders).values({
            equipmentId: item.id, serviceFrontId: equipmentRow.serviceFrontId, openedAt: payload.checklistDate, meterReading: payload.meterReading,
            meterUnit: item.readingUnit === "KM" ? "KM" : "HOURS", description: workOrderDescription(item.prefix, operator, failed), status: "OPEN", createdBy: user.id, createdAt: now, updatedAt: now,
          }).returning({ id: workOrders.id }))[0].id;
          createdOrder = true;
          await tx.insert(auditLogs).values({ userId: user.id, entityType: "WORK_ORDER", entityId: String(workOrderId), action: "O.S. ABERTA PELO CHECKLIST PRÉ-USO", newValue: JSON.stringify({ equipmentId: item.id, failed: failed.map((entry) => entry.label) }) });
        }
      }
      const submission = (await tx.insert(checklistSubmissions).values({
        equipmentId: item.id, userId: user.id, operatorName: operator, serviceFrontId: equipmentRow?.serviceFrontId ?? null, templateId: template.id, checklistDate: payload.checklistDate,
        meterReading: payload.meterReading, status, failedItems: failed.length, workOrderId, notes: payload.notes, clientRequestId: payload.clientRequestId, createdAt: now, updatedAt: now,
      }).returning({ id: checklistSubmissions.id }))[0];
      await tx.insert(checklistAnswers).values(items.map((entry) => {
        const answer = answers.find((candidate) => candidate.itemId === entry.id)!;
        return { submissionId: submission.id, itemId: entry.id, label: entry.label, blocking: entry.blocking, ok: answer.ok === true, comment: answer.ok ? null : answer.comment, photoKey: stored.get(entry.id) ?? null };
      }));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "CHECKLIST", entityId: String(submission.id), action: "CHECKLIST PRÉ-USO ENVIADO", newValue: JSON.stringify({ equipmentId: item.id, status, failed: failed.length, workOrderId }) });
      return { id: submission.id, status, workOrderNumber: workOrderId ? workOrderNumber(workOrderId) : null, createdOrder, duplicate: false };
    });
  } catch (error) {
    for (const key of stored.values()) await removePhoto(key);
    throw error;
  }
}

// Painel: checklists de uma data (todos que a pessoa enxerga, ou só os dela) + equipamentos que
// trabalharam nos últimos 7 dias e ainda não têm checklist nessa data.
export async function listChecklists(user: SessionUser, filters: { date: string; status: string | null; onlyMine: boolean }) {
  const db = await getDb();
  const fronts = frentesVisiveis(user);
  const scope = fronts === "ALL" ? undefined : fronts.length ? inArray(equipment.serviceFrontId, fronts) : eq(equipment.id, -1);
  const mine = filters.onlyMine || !canViewAll(user);
  const conditions = [eq(checklistSubmissions.checklistDate, filters.date), scope, mine ? eq(checklistSubmissions.userId, user.id) : undefined,
    filters.status && ["OK", "PENDENCIA", "BLOQUEADO"].includes(filters.status) ? eq(checklistSubmissions.status, filters.status as "OK") : undefined];
  const rows = await db.select({
    id: checklistSubmissions.id, equipmentId: checklistSubmissions.equipmentId, prefix: equipment.prefix, type: equipment.type, front: serviceFronts.name, status: checklistSubmissions.status,
    failedItems: checklistSubmissions.failedItems, operatorName: checklistSubmissions.operatorName, userName: users.name, meterReading: checklistSubmissions.meterReading,
    workOrderId: checklistSubmissions.workOrderId, notes: checklistSubmissions.notes, createdAt: checklistSubmissions.createdAt,
  }).from(checklistSubmissions).innerJoin(equipment, eq(equipment.id, checklistSubmissions.equipmentId)).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
    .leftJoin(users, eq(users.id, checklistSubmissions.userId)).where(and(...conditions.filter(Boolean))).orderBy(sql`CASE ${checklistSubmissions.status} WHEN 'BLOQUEADO' THEN 0 WHEN 'PENDENCIA' THEN 1 ELSE 2 END`, equipment.sortKey);
  const ids = rows.map((row) => row.id);
  const failures = ids.length ? await db.select({ id: checklistAnswers.id, submissionId: checklistAnswers.submissionId, label: checklistAnswers.label, blocking: checklistAnswers.blocking, comment: checklistAnswers.comment, hasPhoto: sql<boolean>`${checklistAnswers.photoKey} IS NOT NULL` })
    .from(checklistAnswers).where(and(inArray(checklistAnswers.submissionId, ids), eq(checklistAnswers.ok, false))).orderBy(asc(checklistAnswers.id)) : [];
  const missing = mine ? [] : await db.selectDistinct({ id: equipment.id, prefix: equipment.prefix, type: equipment.type, front: serviceFronts.name, sortKey: equipment.sortKey })
    .from(dailyRecords).innerJoin(equipment, eq(equipment.id, dailyRecords.equipmentId)).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
    .where(and(gte(dailyRecords.recordDate, shiftDay(filters.date, -7)), eq(dailyRecords.workedToday, true), isNull(equipment.soldAt), scope,
      sql`NOT EXISTS (SELECT 1 FROM ${checklistSubmissions} c WHERE c.equipment_id = ${equipment.id} AND c.checklist_date = ${filters.date})`)).orderBy(equipment.sortKey);
  return {
    date: filters.date, canSeeAll: !mine,
    totals: { total: rows.length, ok: rows.filter((row) => row.status === "OK").length, pending: rows.filter((row) => row.status === "PENDENCIA").length, blocked: rows.filter((row) => row.status === "BLOQUEADO").length, missing: missing.length },
    rows: rows.map((row) => ({ ...row, workOrderNumber: row.workOrderId ? workOrderNumber(row.workOrderId) : null, failures: failures.filter((failure) => failure.submissionId === row.id) })),
    missing,
  };
}

function shiftDay(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}

export async function checklistPhoto(user: SessionUser, answerId: number) {
  const db = await getDb();
  const row = (await db.select({ photoKey: checklistAnswers.photoKey, userId: checklistSubmissions.userId, serviceFrontId: checklistSubmissions.serviceFrontId })
    .from(checklistAnswers).innerJoin(checklistSubmissions, eq(checklistSubmissions.id, checklistAnswers.submissionId)).where(eq(checklistAnswers.id, answerId)).limit(1))[0];
  if (!row?.photoKey) throw new ChecklistError("Foto não encontrada.", 404);
  if (row.userId !== user.id) {
    const fronts = frentesVisiveis(user);
    if (!canViewAll(user) || (fronts !== "ALL" && (row.serviceFrontId === null || !fronts.includes(row.serviceFrontId)))) throw new ChecklistError("Você não possui acesso a esta foto.", 403);
  }
  return readPhoto(row.photoKey);
}

// ---------------------------------------------------------------------------
// Modelos (daily.manage)
// ---------------------------------------------------------------------------
export async function listTemplates() {
  const db = await getDb();
  const templates = await db.select().from(checklistTemplates).orderBy(sql`${checklistTemplates.equipmentType} NULLS FIRST`);
  const items = await db.select().from(checklistTemplateItems).orderBy(asc(checklistTemplateItems.position), asc(checklistTemplateItems.id));
  const types = await db.selectDistinct({ type: equipment.type }).from(equipment).where(isNull(equipment.soldAt)).orderBy(asc(equipment.type));
  return { templates: templates.map((template) => ({ ...template, items: items.filter((item) => item.templateId === template.id && item.active) })), equipmentTypes: types.map((row) => row.type) };
}

type TemplateInput = { name: string; equipmentType: string | null; openWorkOrder: boolean; active: boolean; items: Array<{ id: number | null; label: string; blocking: boolean; photoRequired: boolean }> };

export function readTemplateBody(body: Record<string, unknown>): TemplateInput {
  const name = String(body.name ?? "").trim();
  if (!name) throw new ChecklistError("Informe o nome do modelo.");
  const items = (Array.isArray(body.items) ? body.items : []).map((item: Record<string, unknown>) => ({
    id: Number(item.id) > 0 ? Number(item.id) : null, label: String(item.label ?? "").trim().slice(0, 160), blocking: item.blocking === true, photoRequired: item.photoRequired !== false,
  })).filter((item) => item.label);
  if (!items.length) throw new ChecklistError("O modelo precisa de pelo menos um item.");
  return { name, equipmentType: String(body.equipmentType ?? "").trim() || null, openWorkOrder: body.openWorkOrder !== false, active: body.active !== false, items };
}

export async function saveTemplate(user: SessionUser, id: number | null, input: TemplateInput) {
  if (!canManage(user)) throw new ChecklistError("Somente quem gerencia o Controle Diário altera os modelos de checklist.", 403);
  const db = await getDb();
  const clash = (await db.select({ id: checklistTemplates.id }).from(checklistTemplates).where(sql`coalesce(${checklistTemplates.equipmentType}, '') = ${input.equipmentType ?? ""}`).limit(1))[0];
  if (clash && clash.id !== id) throw new ChecklistError(input.equipmentType ? `Já existe um modelo para ${input.equipmentType}.` : "Já existe o modelo padrão.", 409);
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    let templateId = id;
    if (templateId) {
      const updated = await tx.update(checklistTemplates).set({ name: input.name, equipmentType: input.equipmentType, openWorkOrder: input.openWorkOrder, active: input.active, updatedAt: now }).where(eq(checklistTemplates.id, templateId)).returning({ id: checklistTemplates.id });
      if (!updated.length) throw new ChecklistError("Modelo não encontrado.", 404);
    } else {
      templateId = (await tx.insert(checklistTemplates).values({ name: input.name, equipmentType: input.equipmentType, openWorkOrder: input.openWorkOrder, active: input.active, createdBy: user.id, createdAt: now, updatedAt: now }).returning({ id: checklistTemplates.id }))[0].id;
    }
    // Itens que saíram da lista são desativados (as respostas antigas continuam com o texto gravado).
    const keep = input.items.map((item) => item.id).filter((value): value is number => value !== null);
    const existing = await tx.select({ id: checklistTemplateItems.id }).from(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, templateId));
    for (const row of existing) if (!keep.includes(row.id)) await tx.update(checklistTemplateItems).set({ active: false, updatedAt: now }).where(eq(checklistTemplateItems.id, row.id));
    for (const [position, item] of input.items.entries()) {
      if (item.id && existing.some((row) => row.id === item.id)) await tx.update(checklistTemplateItems).set({ label: item.label, blocking: item.blocking, photoRequired: item.photoRequired, position, active: true, updatedAt: now }).where(eq(checklistTemplateItems.id, item.id));
      else await tx.insert(checklistTemplateItems).values({ templateId, label: item.label, blocking: item.blocking, photoRequired: item.photoRequired, position, createdAt: now, updatedAt: now });
    }
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "CHECKLIST_TEMPLATE", entityId: String(templateId), action: id ? "MODELO DE CHECKLIST ALTERADO" : "MODELO DE CHECKLIST CRIADO", newValue: JSON.stringify(input) });
    return templateId;
  });
}
