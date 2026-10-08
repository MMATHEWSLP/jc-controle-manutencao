import { after } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, notificationDeliveries, notificationDevices, notificationDispatches, notificationEventSettings, notificationMutes, notifications, userPermissions, userServiceFronts, users } from "../db/schema";
import { resolvePermissions, type Profile, type SessionUser } from "./auth";
import { EVENTS, clip, eventDef, groupRecipients, manualRecipients, parseSetting, type Candidate, type EventKey, type EventSetting, type ManualTarget, type NotificationLink } from "./notification-events";
import { sendFcm } from "./fcm";
import { sendWebPush, type PushPayload } from "./push";
import { siteUrl } from "./site";

// ---------------------------------------------------------------------------
// Central de notificações: grava o aviso no sino de cada destinatário e manda para os aparelhos dele
// (Web Push no iPhone/navegador, Firebase no app Android). Regras de quem recebe em lib/notification-events.ts.
//
// Quem chama nunca deve falhar por causa de notificação: use queueNotification() nas rotas (roda
// depois da resposta, com o erro só no log).
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
const now = () => new Date().toISOString();

export type NotifyInput = {
  event: EventKey;
  title: string;
  body: string;
  link?: NotificationLink | null;
  // Frente do evento: decide quem recebe nos eventos de grupo e aparece no registro. frontIds = o
  // evento vale para mais de uma frente (ex.: mudança de frente: a atual e a pedida).
  frontId?: number | null;
  frontIds?: readonly number[];
  // DIRETO e AVULSO: as pessoas que recebem.
  to?: readonly number[];
  // Agrupamento: a notificação ainda não lida com a mesma chave é atualizada (título, texto e contador).
  // count = total já conhecido (ex.: pendentes da frente); sem count, soma 1. title = título pelo total.
  group?: { key: string; count?: number; title?: (count: number) => string } | null;
  // Quem causou: não recebe aviso de grupo da própria ação; no avulso, quem enviou.
  actorId?: number | null;
  // AVULSO: mandar também para o celular (padrão: sim).
  push?: boolean;
};

// Usuários ativos com permissões e frentes resolvidas (mesmas regras de lib/auth.ts e lib/access.ts).
export async function loadCandidates(db?: Db): Promise<Candidate[]> {
  const conn = db ?? await getDb();
  const [people, overrides, fronts] = await Promise.all([
    conn.select({ id: users.id, role: users.role, status: users.status, all: users.allServiceFronts, convoy: users.convoyFuelRegister, daily: users.fieldDailyAccess }).from(users),
    conn.select({ userId: userPermissions.userId, permission: userPermissions.permission, enabled: userPermissions.enabled }).from(userPermissions),
    conn.select({ userId: userServiceFronts.userId, frontId: userServiceFronts.serviceFrontId }).from(userServiceFronts),
  ]);
  return people.map((person) => ({
    id: person.id, profile: person.role as Profile, active: person.status === "ACTIVE", allServiceFronts: person.all,
    serviceFrontIds: fronts.filter((row) => row.userId === person.id).map((row) => row.frontId),
    permissions: resolvePermissions(person.role as Profile, overrides.filter((row) => row.userId === person.id), { convoy: person.convoy, daily: person.daily }),
  }));
}

export async function eventSetting(event: EventKey, db?: Db): Promise<EventSetting> {
  const conn = db ?? await getDb();
  const row = (await conn.select().from(notificationEventSettings).where(eq(notificationEventSettings.event, event)).limit(1))[0];
  return parseSetting(event, row);
}

export async function eventSettings(): Promise<EventSetting[]> {
  const db = await getDb();
  const rows = await db.select().from(notificationEventSettings);
  return EVENTS.map((def) => parseSetting(def.key, rows.find((row) => row.event === def.key)));
}

export async function saveEventSetting(setting: EventSetting, actorId: number) {
  const db = await getDb();
  const values = { enabled: setting.enabled, push: setting.push, includePermission: setting.includePermission, onlyFront: setting.onlyFront, profiles: JSON.stringify(setting.profiles), userIds: JSON.stringify(setting.userIds), updatedBy: actorId, updatedAt: now() };
  await db.insert(notificationEventSettings).values({ event: setting.event, ...values }).onConflictDoUpdate({ target: notificationEventSettings.event, set: values });
}

// Registro de auditoria das ações do ADMIN na central (configuração, envio avulso).
export async function auditNotification(actorId: number, action: string, entityId: string, value: unknown) {
  const db = await getDb();
  await db.insert(auditLogs).values({ userId: actorId, entityType: "NOTIFICATION", entityId, action, newValue: JSON.stringify(value) });
}

// Grava o aviso e manda para o celular. Devolve o disparo (ou null se o evento está desligado/ninguém recebe).
export async function notify(input: NotifyInput): Promise<{ dispatchId: number; recipients: number } | null> {
  const def = eventDef(input.event);
  if (!def) throw new Error(`Evento de notificação desconhecido: ${input.event}`);
  const db = await getDb();
  const setting = await eventSetting(input.event, db);
  if (def.audience !== "AVULSO" && !setting.enabled) return null;
  const candidates = await loadCandidates(db);
  const active = new Set(candidates.filter((user) => user.active).map((user) => user.id));
  let ids: number[];
  const frontIds = input.frontIds ?? (input.frontId ? [input.frontId] : []);
  if (def.audience === "GRUPO") ids = groupRecipients(candidates, setting, def, frontIds).filter((id) => id !== input.actorId);
  else ids = [...new Set(input.to ?? [])].filter((id) => active.has(id));
  if (ids.length && !def.locked) {
    const muted = await db.select({ userId: notificationMutes.userId }).from(notificationMutes).where(and(eq(notificationMutes.event, input.event), inArray(notificationMutes.userId, ids)));
    const silenced = new Set(muted.map((row) => row.userId));
    ids = ids.filter((id) => !silenced.has(id));
  }
  if (!ids.length) return null;
  const groupTitle = (count: number) => clip((input.group?.title?.(count) ?? input.title).trim(), 120);
  const title = groupTitle(input.group?.count ?? 1);
  const body = clip(input.body.trim(), 600);
  const link = input.link ? JSON.stringify(input.link) : null;
  const [dispatch] = await db.insert(notificationDispatches).values({ event: input.event, title, body, link, serviceFrontId: input.frontId ?? null, recipients: ids.length, createdBy: input.actorId ?? null }).returning({ id: notificationDispatches.id });
  const rows: { id: number; userId: number; title: string }[] = [];
  for (const userId of ids) {
    if (input.group) {
      const [updated] = await db.update(notifications).set({ title, body, link, dispatchId: dispatch.id, groupCount: input.group.count ?? sql`${notifications.groupCount} + 1`, updatedAt: now() })
        .where(and(eq(notifications.userId, userId), eq(notifications.groupKey, input.group.key), isNull(notifications.readAt))).returning({ id: notifications.id, count: notifications.groupCount });
      if (updated) {
        // Somou 1 ao que já estava no sino: o título acompanha o total ("3 abastecimentos aprovados").
        const current = groupTitle(updated.count);
        if (current !== title) await db.update(notifications).set({ title: current }).where(eq(notifications.id, updated.id));
        rows.push({ id: updated.id, userId, title: current });
        continue;
      }
    }
    const [created] = await db.insert(notifications).values({ userId, dispatchId: dispatch.id, event: input.event, title, body, link, groupKey: input.group?.key ?? null, groupCount: input.group?.count ?? 1 }).returning({ id: notifications.id });
    rows.push({ id: created.id, userId, title });
  }
  const push = def.audience === "AVULSO" ? input.push !== false : setting.push;
  if (push) await deliverPush(dispatch.id, rows, { title, body, tag: input.group?.key ?? null });
  return { dispatchId: dispatch.id, recipients: ids.length };
}

// O motivo de um aviso agrupado mudou sem evento novo (ex.: abastecimentos aprovados): o aviso ainda não
// lido passa a mostrar o total certo, ou sai das não lidas quando não sobrou nada. Sem aviso no celular.
export async function syncGroup(groupKey: string, count: number, title: string) {
  const db = await getDb();
  const open = and(eq(notifications.groupKey, groupKey), isNull(notifications.readAt));
  if (count <= 0) await db.update(notifications).set({ readAt: now() }).where(open);
  else await db.update(notifications).set({ groupCount: count, title: clip(title, 120) }).where(open);
}

// Envia para todos os aparelhos ativos de cada destinatário e registra o resultado de cada envio.
async function deliverPush(dispatchId: number, rows: readonly { id: number; userId: number; title?: string }[], message: { title: string; body: string; tag: string | null }) {
  if (!rows.length) return;
  const db = await getDb();
  const devices = await db.select().from(notificationDevices).where(and(inArray(notificationDevices.userId, rows.map((row) => row.userId)), isNull(notificationDevices.disabledAt)));
  const base = siteUrl();
  await Promise.all(devices.map(async (device) => {
    const row = rows.find((item) => item.userId === device.userId)!;
    const payload: PushPayload = { title: clip(row.title ?? message.title, 80), body: clip(message.body, 180), url: `${base}/?notificacao=${row.id}`, tag: message.tag };
    // WEB = Web Push (iPhone/navegador); ANDROID = app Android pelo Firebase (lib/fcm.ts).
    const android = device.kind === "ANDROID";
    if (!android && (!device.p256dh || !device.auth)) return;
    const result = android ? await sendFcm(device.token, payload) : await sendWebPush({ endpoint: device.token, p256dh: device.p256dh!, auth: device.auth! }, payload);
    const at = now();
    await db.insert(notificationDeliveries).values({ dispatchId, notificationId: row.id, userId: device.userId, deviceId: device.id, channel: android ? "FCM" : "WEB_PUSH", status: result.ok ? "SENT" : result.invalid ? "INVALID" : "FAILED", error: result.ok ? null : result.error });
    if (result.ok) await db.update(notificationDevices).set({ lastSuccessAt: at, lastError: null, failures: 0, updatedAt: at }).where(eq(notificationDevices.id, device.id));
    else await db.update(notificationDevices).set({ lastError: result.error, failures: sql`${notificationDevices.failures} + 1`, updatedAt: at, ...(result.invalid ? { disabledAt: at, disabledReason: "INVALIDO" } : {}) }).where(eq(notificationDevices.id, device.id));
  }));
}

// Nas rotas: roda depois da resposta (o usuário não espera) e nunca derruba a ação.
const pending = new Set<Promise<unknown>>();
export function runAfterResponse(name: string, job: () => Promise<unknown>) {
  const run = () => job().then(() => undefined).catch((error) => console.error(`[notify ${name}]`, error));
  try { after(run); }
  catch {
    // Fora de uma requisição (scripts, testes): roda já; os testes esperam com flushNotifications().
    const promise = run().finally(() => pending.delete(promise));
    pending.add(promise);
  }
}
export function queueNotification(input: NotifyInput) { runAfterResponse(input.event, () => notify(input)); }

// "Notificar" e "Mensagem" que acompanham as ações (padrão: notificar, sem mensagem).
export function notifyOptions(body: Record<string, unknown>) {
  const message = typeof body.notifyMessage === "string" ? body.notifyMessage.trim().slice(0, 300) : "";
  return { notify: body.notify !== false, message: message || null };
}
export async function flushNotifications() { while (pending.size) await Promise.all([...pending]); }

// ---------------------------------------------------------------------------
// Sino da própria pessoa.
// ---------------------------------------------------------------------------
export type NotificationItem = { id: number; event: string; title: string; body: string; link: NotificationLink | null; count: number; createdAt: string; updatedAt: string; readAt: string | null };
const parseLink = (value: string | null): NotificationLink | null => { try { return value ? JSON.parse(value) as NotificationLink : null; } catch { return null; } };

export async function listNotifications(userId: number, limit = 50): Promise<NotificationItem[]> {
  const db = await getDb();
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.updatedAt), desc(notifications.id)).limit(limit);
  return rows.map((row) => ({ id: row.id, event: row.event, title: row.title, body: row.body, link: parseLink(row.link), count: row.groupCount, createdAt: row.createdAt, updatedAt: row.updatedAt, readAt: row.readAt }));
}

export async function unreadCount(userId: number) {
  const db = await getDb();
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.total ?? 0;
}

// Marca como lida e devolve a tela a abrir (toque no sino ou no aviso do celular).
export async function openNotification(userId: number, id: number) {
  const db = await getDb();
  const [row] = await db.update(notifications).set({ readAt: sql`coalesce(${notifications.readAt}, ${now()})` }).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning({ link: notifications.link });
  return row ? { link: parseLink(row.link) } : null;
}

export async function markUnread(userId: number, id: number) {
  const db = await getDb();
  await db.update(notifications).set({ readAt: null }).where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
}

export async function markAllRead(userId: number) {
  const db = await getDb();
  await db.update(notifications).set({ readAt: now() }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

// Eventos que a pessoa pode receber (para a lista "silenciar"), com o que ela já silenciou.
export async function preferences(user: SessionUser) {
  const db = await getDb();
  const [muted, settings] = await Promise.all([
    db.select({ event: notificationMutes.event }).from(notificationMutes).where(eq(notificationMutes.userId, user.id)),
    eventSettings(),
  ]);
  const has = (permission: string) => (user.permissions as readonly string[]).includes(permission);
  const relevant = (key: EventKey) => {
    const def = eventDef(key)!;
    const setting = settings.find((item) => item.event === key)!;
    if (!setting.enabled || def.locked) return false;
    if (def.audience === "GRUPO") return setting.userIds.includes(user.id) || (user.profile !== "CAMPO" && ((setting.includePermission && def.permission && has(def.permission)) || setting.profiles.includes(user.profile)));
    if (key.startsWith("convoy.")) return has("fuel.convoy_register");
    if (key.startsWith("task.")) return has("tasks.view");
    if (key === "front_change.answered") return user.profile === "CAMPO" || has("daily.register");
    return true;
  };
  return EVENTS.filter((def) => relevant(def.key)).map((def) => ({ event: def.key, area: def.area, label: def.label, description: def.description, muted: muted.some((row) => row.event === def.key) }));
}

export async function setMuted(userId: number, event: EventKey, muted: boolean) {
  const db = await getDb();
  if (muted) await db.insert(notificationMutes).values({ userId, event }).onConflictDoNothing();
  else await db.delete(notificationMutes).where(and(eq(notificationMutes.userId, userId), eq(notificationMutes.event, event)));
}

// ---------------------------------------------------------------------------
// Aparelhos.
// ---------------------------------------------------------------------------
export type DeviceInput = { kind: "WEB" | "ANDROID"; token: string; p256dh?: string | null; auth?: string | null; label?: string | null };

// O mesmo aparelho (mesmo token) passa para quem entrou por último nele: nunca avisa o login anterior.
export async function registerDevice(userId: number, input: DeviceInput) {
  const db = await getDb();
  const at = now();
  const values = { userId, kind: input.kind, p256dh: input.p256dh ?? null, auth: input.auth ?? null, label: input.label ? clip(input.label, 80) : null, lastSeenAt: at, disabledAt: null, disabledReason: null, updatedAt: at };
  const [row] = await db.insert(notificationDevices).values({ token: input.token, ...values }).onConflictDoUpdate({ target: notificationDevices.token, set: { ...values, failures: sql`CASE WHEN ${notificationDevices.userId} = ${userId} THEN ${notificationDevices.failures} ELSE 0 END` } }).returning({ id: notificationDevices.id });
  return row.id;
}

// Sair do sistema / desativar no aparelho: o token deixa de receber.
export async function removeDevice(userId: number, match: { id?: number; token?: string }, reason = "USUARIO") {
  const db = await getDb();
  const at = now();
  const where = match.id ? eq(notificationDevices.id, match.id) : match.token ? eq(notificationDevices.token, match.token) : null;
  if (!where) return 0;
  const rows = await db.update(notificationDevices).set({ disabledAt: at, disabledReason: reason, updatedAt: at }).where(and(where, eq(notificationDevices.userId, userId), isNull(notificationDevices.disabledAt))).returning({ id: notificationDevices.id });
  return rows.length;
}

export async function listDevices(userId: number) {
  const db = await getDb();
  return db.select({ id: notificationDevices.id, kind: notificationDevices.kind, label: notificationDevices.label, token: notificationDevices.token, createdAt: notificationDevices.createdAt, lastSeenAt: notificationDevices.lastSeenAt, lastSuccessAt: notificationDevices.lastSuccessAt, lastError: notificationDevices.lastError })
    .from(notificationDevices).where(and(eq(notificationDevices.userId, userId), isNull(notificationDevices.disabledAt))).orderBy(desc(notificationDevices.lastSeenAt));
}

// "Enviar teste para os meus aparelhos": usa o caminho normal (sino + celular), sem depender de evento.
export async function sendTest(user: SessionUser) {
  const devices = await listDevices(user.id);
  if (!devices.length) return { devices: 0, sent: 0, failed: 0 };
  const db = await getDb();
  const title = "Teste de notificação";
  const body = `Se você está vendo isto no celular, as notificações estão funcionando, ${user.name.split(" ")[0]}.`;
  const [dispatch] = await db.insert(notificationDispatches).values({ event: "manual", title, body, recipients: 1, createdBy: user.id }).returning({ id: notificationDispatches.id });
  const [row] = await db.insert(notifications).values({ userId: user.id, dispatchId: dispatch.id, event: "manual", title, body }).returning({ id: notifications.id });
  await deliverPush(dispatch.id, [{ id: row.id, userId: user.id }], { title, body, tag: null });
  const results = await db.select({ status: notificationDeliveries.status }).from(notificationDeliveries).where(eq(notificationDeliveries.dispatchId, dispatch.id));
  return { devices: devices.length, sent: results.filter((item) => item.status === "SENT").length, failed: results.filter((item) => item.status !== "SENT").length };
}

// ---------------------------------------------------------------------------
// Envio avulso (ADMIN) e registro de envios.
// ---------------------------------------------------------------------------
export async function sendManual(actor: SessionUser, message: { title: string; body: string; link: NotificationLink | null; push: boolean }, target: ManualTarget) {
  const ids = manualRecipients(await loadCandidates(), target);
  if (!ids.length) return null;
  return notify({ event: "manual", title: message.title, body: message.body, link: message.link, to: ids, actorId: actor.id, push: message.push, frontId: target.frontIds.length === 1 ? target.frontIds[0] : null });
}

export type DispatchLogFilters = { from: string; to: string; event: string | null; onlyFailures: boolean };
export async function dispatchLog(f: DispatchLogFilters) {
  const db = await getDb();
  const result = await db.execute(sql`SELECT d.id, d.event, d.title, d.body, d.created_at, d.recipients, sf.name AS front, u.name AS created_by,
      count(dl.id) FILTER (WHERE dl.status = 'SENT')::int AS sent, count(dl.id) FILTER (WHERE dl.status <> 'SENT')::int AS failed,
      (SELECT count(*) FROM notifications n WHERE n.dispatch_id = d.id AND n.read_at IS NOT NULL)::int AS read
    FROM notification_dispatches d LEFT JOIN service_fronts sf ON sf.id = d.service_front_id LEFT JOIN users u ON u.id = d.created_by
    LEFT JOIN notification_deliveries dl ON dl.dispatch_id = d.id
    WHERE left(d.created_at, 10) BETWEEN ${f.from} AND ${f.to} ${f.event ? sql`AND d.event = ${f.event}` : sql``}
    GROUP BY d.id, sf.name, u.name ${f.onlyFailures ? sql`HAVING count(dl.id) FILTER (WHERE dl.status <> 'SENT') > 0` : sql``}
    ORDER BY d.created_at DESC, d.id DESC LIMIT 500`);
  return (result as unknown as { rows: Record<string, unknown>[] }).rows.map((row) => ({
    id: Number(row.id), event: String(row.event), label: eventDef(String(row.event))?.label ?? String(row.event), title: String(row.title), body: String(row.body), createdAt: String(row.created_at),
    recipients: Number(row.recipients), sent: Number(row.sent), failed: Number(row.failed), read: Number(row.read), front: row.front === null ? null : String(row.front), createdBy: row.created_by === null ? null : String(row.created_by),
  }));
}

// Detalhe de um disparo: cada destinatário, se leu, e cada envio ao celular com o erro.
export async function dispatchDetail(dispatchId: number) {
  const db = await getDb();
  const result = await db.execute(sql`SELECT u.id AS user_id, u.name, n.read_at,
      (SELECT json_agg(json_build_object('channel', dl.channel, 'status', dl.status, 'error', dl.error, 'device', coalesce(nd.label, nd.kind), 'at', dl.created_at) ORDER BY dl.id)
        FROM notification_deliveries dl LEFT JOIN notification_devices nd ON nd.id = dl.device_id WHERE dl.dispatch_id = ${dispatchId} AND dl.user_id = u.id) AS deliveries
    FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.dispatch_id = ${dispatchId} ORDER BY u.name`);
  return (result as unknown as { rows: Record<string, unknown>[] }).rows.map((row) => ({
    userId: Number(row.user_id), name: String(row.name), readAt: row.read_at === null ? null : String(row.read_at),
    deliveries: (row.deliveries as { channel: string; status: string; error: string | null; device: string; at: string }[] | null) ?? [],
  }));
}
