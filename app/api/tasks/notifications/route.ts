import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { countUnreadNotifications, listNotifications, markAllNotificationsRead, markNotificationRead } from "../../../../lib/task-notifications";

export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(auth.user!.id),
      countUnreadNotifications(auth.user!.id),
    ]);
    return Response.json({ notifications, unreadCount });
  } catch (error) {
    console.error("[tasks.notifications.get]", error);
    return Response.json({ error: "Não foi possível carregar as notificações." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "MARK_ALL_READ") {
      await markAllNotificationsRead(auth.user!.id);
      return Response.json({ ok: true });
    }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Notificação inválida." }, { status: 400 });
    await markNotificationRead(auth.user!.id, id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[tasks.notifications.put]", error);
    return Response.json({ error: "Não foi possível atualizar a notificação." }, { status: 500 });
  }
}
