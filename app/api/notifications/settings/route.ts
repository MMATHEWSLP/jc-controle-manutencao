import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { serviceFronts, userServiceFronts, users } from "../../../../db/schema";
import { assertSameOrigin, authorize, type Profile } from "../../../../lib/auth";
import { EVENTS, PROFILES, isEventKey, type EventSetting } from "../../../../lib/notification-events";
import { lastDailyDay, runDailyNotifications } from "../../../../lib/notification-daily";
import { auditNotification, eventSettings, saveEventSetting } from "../../../../lib/notifications";

// Tela Notificações → Configurar (ADMIN) e Enviar: eventos com a configuração, pessoas e frentes.
export async function GET(request: Request) {
  const auth = await authorize(request, ["notifications.configure", "notifications.send"]); if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const [settings, people, fronts, links, lastDaily] = await Promise.all([
      eventSettings(),
      db.select({ id: users.id, name: users.name, profile: users.role, all: users.allServiceFronts }).from(users).where(eq(users.status, "ACTIVE")).orderBy(asc(users.name)),
      db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name)),
      db.select({ userId: userServiceFronts.userId, frontId: userServiceFronts.serviceFrontId }).from(userServiceFronts),
      lastDailyDay(),
    ]);
    return Response.json({
      events: EVENTS.map((def) => ({ ...def, setting: settings.find((item) => item.event === def.key)! })),
      people: people.map((person) => ({ ...person, fronts: person.profile === "ADMIN" || person.all ? "ALL" : links.filter((link) => link.userId === person.id).map((link) => link.frontId) })),
      fronts, lastDaily, canConfigure: auth.user!.permissions.includes("notifications.configure"),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[notifications.settings.get]", error);
    return Response.json({ error: "Não foi possível carregar a configuração." }, { status: 500 });
  }
}

// Salvar um evento: { event, enabled, push, includePermission, profiles, userIds, onlyFront }.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "notifications.configure"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const event = String(body.event ?? "");
    if (!isEventKey(event) || event === "manual") return Response.json({ error: "Evento inválido." }, { status: 400 });
    const setting: EventSetting = {
      event, enabled: body.enabled !== false, push: body.push !== false, includePermission: body.includePermission !== false, onlyFront: body.onlyFront !== false,
      profiles: (Array.isArray(body.profiles) ? body.profiles : []).filter((item): item is Profile => PROFILES.includes(item as Profile)),
      userIds: [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))],
    };
    await saveEventSetting(setting, auth.user!.id);
    await auditNotification(auth.user!.id, "NOTIFICAÇÃO CONFIGURADA", event, setting);
    return Response.json({ ok: true, message: "Configuração salva." });
  } catch (error) {
    console.error("[notifications.settings.put]", error);
    return Response.json({ error: "Não foi possível salvar." }, { status: 500 });
  }
}

// { action: "run_daily" }: roda agora a verificação diária (vencidas, estoque baixo, consumo, tarefas).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "notifications.configure"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action !== "run_daily") return Response.json({ error: "Ação inválida." }, { status: 400 });
    const result = await runDailyNotifications();
    return Response.json({ ok: true, result, message: `Verificação feita: ${result.oil} troca(s) vencida(s) nova(s), ${result.stock} produto(s) com estoque baixo novo(s), ${result.fuel} consumo(s) fora da média novo(s), ${result.tasks} tarefa(s) vencendo.` });
  } catch (error) {
    console.error("[notifications.settings.daily]", error);
    return Response.json({ error: "Não foi possível rodar a verificação." }, { status: 500 });
  }
}
