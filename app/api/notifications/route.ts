import { assertSameOrigin, authorize } from "../../../lib/auth";
import { maybeRunDaily } from "../../../lib/notification-daily";
import { listNotifications, markAllRead, markUnread, openNotification, unreadCount } from "../../../lib/notifications";

// Sino da própria pessoa (qualquer perfil, inclusive o acesso de campo). ?count=1 = só o número de não
// lidas (consultado a cada minuto); essa consulta também dispara a rotina diária (lib/notification-daily.ts).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const headers = { "Cache-Control": "private, no-store" };
    if (new URL(request.url).searchParams.get("count") === "1") {
      maybeRunDaily();
      return Response.json({ unread: await unreadCount(user.id) }, { headers });
    }
    const [items, unread] = await Promise.all([listNotifications(user.id), unreadCount(user.id)]);
    return Response.json({ items, unread }, { headers });
  } catch (error) {
    console.error("[notifications.get]", error);
    return Response.json({ error: "Não foi possível carregar as notificações." }, { status: 500 });
  }
}

// { id, action: "OPEN" } marca como lida e devolve a tela a abrir; { id, action: "UNREAD" }; { action: "READ_ALL" }.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const user = auth.user!;
    if (body.action === "READ_ALL") { await markAllRead(user.id); return Response.json({ ok: true, unread: 0 }); }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Notificação inválida." }, { status: 400 });
    if (body.action === "UNREAD") { await markUnread(user.id, id); return Response.json({ ok: true, unread: await unreadCount(user.id) }); }
    const opened = await openNotification(user.id, id);
    if (!opened) return Response.json({ error: "Notificação não encontrada." }, { status: 404 });
    return Response.json({ ok: true, link: opened.link, unread: await unreadCount(user.id) });
  } catch (error) {
    console.error("[notifications.put]", error);
    return Response.json({ error: "Não foi possível atualizar a notificação." }, { status: 500 });
  }
}
