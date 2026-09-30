import { and, asc, eq, isNull } from "drizzle-orm";
import { getD1, type getDb } from "../db";
import { auditLogs, componentEvents, components, equipment, users } from "../db/schema";
import type { SessionUser } from "./auth";
import {
  COMPONENT_KIND_LABELS, EVENT_LABELS, ComponentRuleError, componentAlert, costPerUnit, lifeUsedPercent, mainUsage, monthsBetween, replay, totalUsage, usageUnitOf, validateEvent,
  type ComponentEvent, type ComponentEventType, type ComponentKind, type ComponentStatus, type UsageUnit,
} from "./component-rules";
import { canSeeFleetCosts } from "./fleet-costs";
import { activeFleetSql, equipmentScopeSql } from "./front-scope";

// ---------------------------------------------------------------------------
// Pneus e baterias: cadastro, linha do tempo de eventos, custo por km/hora e alertas.
// Ver: equipment.view · Cadastrar e lançar eventos: maintenance.create · Editar cadastro, excluir
// e desfazer o último evento: maintenance.edit. Valores (custo) só para ADMIN e GESTOR, como em
// Custos e Consumo.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Row = Record<string, unknown>;

export class ComponentError extends Error {
  constructor(message: string, public status = 400, public field?: string) { super(message); }
}
export function componentErrorResponse(error: unknown) {
  if (error instanceof ComponentError) return Response.json({ error: error.message, field: error.field ?? null }, { status: error.status });
  if (error instanceof ComponentRuleError) return Response.json({ error: error.message, field: error.field ?? null }, { status: 400 });
  return null;
}

const uniqueViolation = (error: unknown) => {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
};
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
const round2 = (value: number) => Math.round(value * 100) / 100;
const text = (value: unknown, max = 160) => { const clean = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max); return clean || null; };
const number = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : NaN;
};
const isKind = (value: unknown): value is ComponentKind => value === "TIRE" || value === "BATTERY";

export const canRegisterComponents = (user: SessionUser) => user.permissions.includes("maintenance.create");
export const canManageComponents = (user: SessionUser) => user.permissions.includes("maintenance.edit");

export type EquipmentOption = { id: number; prefix: string; type: string; front: string | null; unit: UsageUnit; currentReading: number };

// Equipamentos da frota ativa que o usuário enxerga (para montar e para filtrar).
export async function componentEquipment(user: SessionUser): Promise<EquipmentOption[]> {
  const d1 = await getD1();
  const scope = equipmentScopeSql(user, "OPERATIONAL");
  const rows = (await d1.prepare(`SELECT e.id,e.prefix,e.type,e.control_type,e.current_km,e.current_hours,sf.name AS front FROM equipment e
    LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE ${scope.clause} AND ${activeFleetSql("e")} ORDER BY e.sort_key`).bind(...scope.values).all<Row>()).results;
  return rows.map((row) => {
    const unit = usageUnitOf(String(row.control_type));
    return { id: Number(row.id), prefix: String(row.prefix), type: String(row.type), front: row.front == null ? null : String(row.front), unit, currentReading: Number(unit === "KM" ? row.current_km : row.current_hours) || 0 };
  });
}

export async function listComponents(db: Db, user: SessionUser, filters: { kind: ComponentKind | null; status: ComponentStatus | null; equipmentId: number | null; q: string | null }) {
  const [equipmentList, rows] = await Promise.all([
    componentEquipment(user),
    db.select().from(components).where(isNull(components.deletedAt)).orderBy(asc(components.kind), asc(components.code)),
  ]);
  const byId = new Map(equipmentList.map((item) => [item.id, item]));
  const showCost = canSeeFleetCosts(user);
  const day = today();
  const q = filters.q?.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "") ?? null;
  const items = rows
    // Montado em equipamento de frente que o usuário não enxerga: fica de fora.
    .filter((row) => row.equipmentId === null || byId.has(row.equipmentId))
    .map((row) => {
      const current = row.equipmentId ? byId.get(row.equipmentId) ?? null : null;
      const state = { status: row.status, mountedReading: row.mountedReading, mountedUnit: row.mountedUnit, usage: { KM: row.usageKm, HOURS: row.usageHours } };
      const usage = totalUsage({ ...state, equipmentId: row.equipmentId, position: row.position, mountedAt: row.mountedAt, recapCount: row.recapCount, eventsCost: row.eventsCost, lastTreadDepth: row.lastTreadDepth, lastEventDate: null },
        current && row.mountedUnit === current.unit ? current.currentReading : null);
      const main = mainUsage(usage);
      const ageMonths = monthsBetween(row.purchaseDate ?? row.createdAt.slice(0, 10), day);
      const lifePercent = lifeUsedPercent(row.kind, row.expectedLife, main.value, ageMonths);
      const totalCost = round2((row.purchaseCost ?? 0) + row.eventsCost);
      return {
        id: row.id, kind: row.kind, code: row.code, brand: row.brand, model: row.model, size: row.size, purchaseDate: row.purchaseDate, supplier: row.supplier,
        expectedLife: row.expectedLife, warrantyMonths: row.warrantyMonths, status: row.status, equipmentId: row.equipmentId, prefix: current?.prefix ?? null,
        front: current?.front ?? null, position: row.position, mountedAt: row.mountedAt, recapCount: row.recapCount, lastTreadDepth: row.lastTreadDepth, notes: row.notes,
        usage: main.value, unit: main.unit, ageMonths, lifePercent,
        alert: componentAlert({ kind: row.kind, status: row.status, lifePercent, lastTreadDepth: row.lastTreadDepth, warrantyMonths: row.warrantyMonths, ageMonths }),
        purchaseCost: showCost ? row.purchaseCost : null, totalCost: showCost ? totalCost : null, costPerUnit: showCost ? costPerUnit(totalCost, main.value) : null,
      };
    })
    .filter((row) => (!filters.kind || row.kind === filters.kind) && (!filters.status || row.status === filters.status) && (!filters.equipmentId || row.equipmentId === filters.equipmentId)
      && (!q || `${row.code} ${row.brand} ${row.model ?? ""} ${row.size ?? ""} ${row.prefix ?? ""}`.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(q)));
  return {
    items, equipment: equipmentList, canSeeCosts: showCost, canRegister: canRegisterComponents(user), canManage: canManageComponents(user),
    totals: {
      tires: items.filter((row) => row.kind === "TIRE").length, batteries: items.filter((row) => row.kind === "BATTERY").length,
      mounted: items.filter((row) => row.status === "MOUNTED").length, stock: items.filter((row) => row.status === "STOCK").length,
      alerts: items.filter((row) => row.alert).length,
    },
    brands: showCost ? brandSummary(items) : [],
  };
}

// Custo por km/hora por marca/modelo: soma do custo (compra + recapagens + consertos) ÷ uso total.
// Os descartados (vida completa) mostram o custo real; os em uso entram na média geral.
export function brandSummary(items: Array<{ kind: ComponentKind; brand: string; model: string | null; status: ComponentStatus; usage: number; unit: UsageUnit; totalCost: number | null }>) {
  const groups = new Map<string, { kind: ComponentKind; brand: string; model: string | null; unit: UsageUnit; count: number; discarded: number; usage: number; cost: number; discardedUsage: number; discardedCost: number }>();
  for (const item of items) {
    if (item.kind !== "TIRE" || item.usage <= 0 || item.totalCost === null) continue;
    const key = `${item.brand.toUpperCase()}|${(item.model ?? "").toUpperCase()}|${item.unit}`;
    const group = groups.get(key) ?? { kind: item.kind, brand: item.brand, model: item.model, unit: item.unit, count: 0, discarded: 0, usage: 0, cost: 0, discardedUsage: 0, discardedCost: 0 };
    group.count++; group.usage += item.usage; group.cost += item.totalCost;
    if (item.status === "DISCARDED") { group.discarded++; group.discardedUsage += item.usage; group.discardedCost += item.totalCost; }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group, usage: round2(group.usage), cost: round2(group.cost), costPerUnit: costPerUnit(group.cost, group.usage),
    discardedCostPerUnit: costPerUnit(group.discardedCost, group.discardedUsage), averageLife: group.discarded ? round2(group.discardedUsage / group.discarded) : null,
  })).sort((a, b) => (a.costPerUnit ?? Infinity) - (b.costPerUnit ?? Infinity));
}

export async function componentDetail(db: Db, user: SessionUser, id: number) {
  const row = (await db.select().from(components).where(and(eq(components.id, id), isNull(components.deletedAt))).limit(1))[0];
  if (!row) throw new ComponentError("Item não encontrado.", 404);
  const visible = await componentEquipment(user);
  if (row.equipmentId && !visible.some((item) => item.id === row.equipmentId)) throw new ComponentError("Item não encontrado.", 404);
  const showCost = canSeeFleetCosts(user);
  const events = await db.select({
    id: componentEvents.id, eventType: componentEvents.eventType, eventDate: componentEvents.eventDate, equipmentId: componentEvents.equipmentId, prefix: equipment.prefix,
    position: componentEvents.position, fromPosition: componentEvents.fromPosition, reading: componentEvents.reading, unit: componentEvents.unit, cost: componentEvents.cost,
    treadDepth: componentEvents.treadDepth, notes: componentEvents.notes, userName: users.name, createdAt: componentEvents.createdAt,
  }).from(componentEvents).leftJoin(equipment, eq(equipment.id, componentEvents.equipmentId)).leftJoin(users, eq(users.id, componentEvents.userId))
    .where(and(eq(componentEvents.componentId, id), isNull(componentEvents.deletedAt))).orderBy(asc(componentEvents.eventDate), asc(componentEvents.id));
  return { events: events.map((event) => ({ ...event, cost: showCost ? event.cost : null, label: EVENT_LABELS[row.kind][event.eventType] ?? event.eventType })) };
}

type ComponentBody = { kind: ComponentKind; code: string; brand: string; model: string | null; size: string | null; purchaseDate: string | null; purchaseCost: number | null; supplier: string | null; expectedLife: number | null; warrantyMonths: number | null; notes: string | null };

export function readComponentBody(raw: Record<string, unknown>): ComponentBody {
  if (!isKind(raw.kind)) throw new ComponentError("Escolha pneu ou bateria.", 400, "kind");
  const code = text(raw.code, 40)?.toUpperCase() ?? null;
  if (!code) throw new ComponentError(raw.kind === "TIRE" ? "Informe o número de fogo do pneu." : "Informe o número de série da bateria.", 400, "code");
  const brand = text(raw.brand, 60);
  if (!brand) throw new ComponentError("Informe a marca.", 400, "brand");
  const purchaseDate = text(raw.purchaseDate, 10);
  if (purchaseDate && (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) || purchaseDate > today())) throw new ComponentError("Data de compra inválida.", 400, "purchaseDate");
  const purchaseCost = number(raw.purchaseCost), expectedLife = number(raw.expectedLife), warrantyMonths = number(raw.warrantyMonths);
  if (purchaseCost !== null && (Number.isNaN(purchaseCost) || purchaseCost < 0)) throw new ComponentError("Valor de compra inválido.", 400, "purchaseCost");
  if (expectedLife !== null && (Number.isNaN(expectedLife) || expectedLife <= 0)) throw new ComponentError("Vida esperada inválida.", 400, "expectedLife");
  if (warrantyMonths !== null && (Number.isNaN(warrantyMonths) || warrantyMonths < 0 || !Number.isInteger(warrantyMonths))) throw new ComponentError("Garantia inválida (meses).", 400, "warrantyMonths");
  return { kind: raw.kind, code, brand: brand.toUpperCase(), model: text(raw.model, 60), size: text(raw.size, 40), purchaseDate, purchaseCost, supplier: text(raw.supplier, 120), expectedLife, warrantyMonths, notes: text(raw.notes, 500) };
}

export async function saveComponent(db: Db, user: SessionUser, body: ComponentBody, id: number | null) {
  const values = { ...body, purchaseCost: canSeeFleetCosts(user) ? body.purchaseCost : undefined, updatedAt: new Date().toISOString() };
  try {
    if (id === null) {
      const row = (await db.insert(components).values({ ...values, purchaseCost: values.purchaseCost ?? null, createdBy: user.id }).returning({ id: components.id }))[0];
      await db.insert(auditLogs).values({ userId: user.id, entityType: "COMPONENT", entityId: String(row.id), action: `${COMPONENT_KIND_LABELS[body.kind].toUpperCase()} CADASTRADO`, newValue: JSON.stringify(body) });
      return row.id;
    }
    const current = (await db.select({ kind: components.kind }).from(components).where(and(eq(components.id, id), isNull(components.deletedAt))).limit(1))[0];
    if (!current) throw new ComponentError("Item não encontrado.", 404);
    if (current.kind !== body.kind) throw new ComponentError("Não é possível trocar o tipo (pneu/bateria) de um item cadastrado.", 400, "kind");
    await db.update(components).set(values).where(eq(components.id, id));
    await db.insert(auditLogs).values({ userId: user.id, entityType: "COMPONENT", entityId: String(id), action: "PNEU/BATERIA EDITADO", newValue: JSON.stringify(body) });
    return id;
  } catch (error) {
    if (uniqueViolation(error)) throw new ComponentError(`Já existe ${body.kind === "TIRE" ? "pneu" : "bateria"} com o número ${body.code}.`, 409, "code");
    throw error;
  }
}

export async function deleteComponent(db: Db, user: SessionUser, id: number) {
  const row = (await db.select().from(components).where(and(eq(components.id, id), isNull(components.deletedAt))).limit(1))[0];
  if (!row) throw new ComponentError("Item não encontrado.", 404);
  if (row.status === "MOUNTED") throw new ComponentError("Desmonte o item antes de excluir. Para registrar o fim da vida útil, use \"Descarte\".");
  const now = new Date().toISOString();
  await db.update(components).set({ deletedAt: now, updatedAt: now }).where(eq(components.id, id));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "COMPONENT", entityId: String(id), action: "PNEU/BATERIA EXCLUÍDO", previousValue: JSON.stringify(row) });
}

type EventBody = { eventType: ComponentEventType; eventDate: string; equipmentId: number | null; position: string | null; reading: number | null; cost: number | null; treadDepth: number | null; notes: string | null };

export function readEventBody(raw: Record<string, unknown>): EventBody {
  const eventType = String(raw.eventType ?? "") as ComponentEventType;
  if (!["MOUNT", "ROTATE", "UNMOUNT", "RECAP", "REPAIR", "INSPECTION", "DISCARD"].includes(eventType)) throw new ComponentError("Escolha o tipo de lançamento.", 400, "eventType");
  const reading = number(raw.reading), cost = number(raw.cost), treadDepth = number(raw.treadDepth), equipmentId = number(raw.equipmentId);
  if (Number.isNaN(reading)) throw new ComponentError("Leitura inválida.", 400, "reading");
  if (Number.isNaN(cost)) throw new ComponentError("Custo inválido.", 400, "cost");
  if (Number.isNaN(treadDepth)) throw new ComponentError("Sulco inválido.", 400, "treadDepth");
  const notes = text(raw.notes, 500);
  if (eventType === "DISCARD" && (!notes || notes.length < 3)) throw new ComponentError("Informe o motivo do descarte.", 400, "notes");
  return { eventType, eventDate: String(raw.eventDate ?? "").slice(0, 10), equipmentId: equipmentId && equipmentId > 0 ? equipmentId : null, position: text(raw.position, 20)?.toUpperCase() ?? null, reading, cost, treadDepth, notes };
}

async function loadEvents(db: Db, id: number): Promise<ComponentEvent[]> {
  return db.select({ id: componentEvents.id, eventType: componentEvents.eventType, eventDate: componentEvents.eventDate, equipmentId: componentEvents.equipmentId, position: componentEvents.position,
    reading: componentEvents.reading, unit: componentEvents.unit, cost: componentEvents.cost, treadDepth: componentEvents.treadDepth })
    .from(componentEvents).where(and(eq(componentEvents.componentId, id), isNull(componentEvents.deletedAt))).orderBy(asc(componentEvents.eventDate), asc(componentEvents.id));
}

// Grava o resumo (situação atual) recalculado a partir dos eventos.
async function persistState(db: Db, id: number, events: ComponentEvent[]) {
  const state = replay(events);
  await db.update(components).set({
    status: state.status, equipmentId: state.equipmentId, position: state.position, mountedAt: state.mountedAt, mountedReading: state.mountedReading, mountedUnit: state.mountedUnit,
    usageKm: state.usage.KM, usageHours: state.usage.HOURS, recapCount: state.recapCount, eventsCost: state.eventsCost, lastTreadDepth: state.lastTreadDepth, updatedAt: new Date().toISOString(),
  }).where(eq(components.id, id));
  return state;
}

const positionTaken = (position: string | null) => new ComponentError(`A posição ${position ?? ""} deste equipamento já tem um item montado. Desmonte-o primeiro.`, 409, "position");

export async function addEvent(db: Db, user: SessionUser, id: number, body: EventBody) {
  const row = (await db.select().from(components).where(and(eq(components.id, id), isNull(components.deletedAt))).limit(1))[0];
  if (!row) throw new ComponentError("Item não encontrado.", 404);
  const visible = await componentEquipment(user);
  if (row.equipmentId && !visible.some((item) => item.id === row.equipmentId)) throw new ComponentError("Item não encontrado.", 404);
  const events = await loadEvents(db, id);
  const state = replay(events);
  const equipmentId = body.eventType === "MOUNT" ? body.equipmentId : state.equipmentId;
  const target = equipmentId ? visible.find((item) => item.id === equipmentId) ?? null : null;
  if (body.eventType === "MOUNT" && body.equipmentId && !target) throw new ComponentError("Equipamento não encontrado ou fora das frentes que você enxerga.", 403, "equipmentId");
  const event: ComponentEvent = {
    eventType: body.eventType, eventDate: body.eventDate, equipmentId,
    position: body.eventType === "MOUNT" || body.eventType === "ROTATE" ? body.position : state.position,
    reading: body.reading, unit: target?.unit ?? state.mountedUnit, cost: canSeeFleetCosts(user) ? body.cost : null, treadDepth: body.treadDepth,
  };
  validateEvent(row.kind, state, event, today());
  if (event.eventType === "MOUNT" || event.eventType === "ROTATE") {
    const occupied = await db.select({ id: components.id, position: components.position }).from(components)
      .where(and(eq(components.equipmentId, equipmentId!), eq(components.kind, row.kind), eq(components.status, "MOUNTED"), isNull(components.deletedAt)));
    if (occupied.some((item) => item.id !== id && (item.position ?? "").toUpperCase() === (event.position ?? "").toUpperCase())) throw positionTaken(event.position);
  }
  try {
    return await db.transaction(async (tx) => {
      const inserted = (await tx.insert(componentEvents).values({
        componentId: id, eventType: event.eventType, eventDate: event.eventDate, equipmentId: event.equipmentId, position: event.position,
        fromPosition: event.eventType === "ROTATE" ? state.position : null, reading: event.reading, unit: event.unit, cost: event.cost, treadDepth: body.treadDepth, notes: body.notes, userId: user.id,
      }).returning({ id: componentEvents.id }))[0];
      const next = await persistState(tx as unknown as Db, id, [...events, { ...event, id: inserted.id }]);
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "COMPONENT", entityId: String(id), action: `PNEU/BATERIA: ${EVENT_LABELS[row.kind][event.eventType]?.toUpperCase()}`, newValue: JSON.stringify({ ...body, cost: event.cost }) });
      return { eventId: inserted.id, status: next.status };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw positionTaken(event.position);
    throw error;
  }
}

// Desfaz o último lançamento (os anteriores só podem sair na ordem inversa).
export async function undoLastEvent(db: Db, user: SessionUser, id: number, eventId: number) {
  const row = (await db.select().from(components).where(and(eq(components.id, id), isNull(components.deletedAt))).limit(1))[0];
  if (!row) throw new ComponentError("Item não encontrado.", 404);
  const events = await loadEvents(db, id);
  const last = events[events.length - 1];
  if (!last || last.id !== eventId) throw new ComponentError("Só é possível desfazer o último lançamento deste item.", 409);
  try {
    await db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.update(componentEvents).set({ deletedAt: now, deletedBy: user.id, updatedAt: now }).where(eq(componentEvents.id, eventId));
      await persistState(tx as unknown as Db, id, events.slice(0, -1));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "COMPONENT", entityId: String(id), action: "PNEU/BATERIA: LANÇAMENTO DESFEITO", previousValue: JSON.stringify(last) });
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new ComponentError("Não dá para desfazer: a posição anterior já está ocupada por outro item.", 409);
    throw error;
  }
}
