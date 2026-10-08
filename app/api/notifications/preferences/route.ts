import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { eventDef, isEventKey } from "../../../../lib/notification-events";
import { preferences, setMuted } from "../../../../lib/notifications";

// Eventos que a pessoa recebe e os que ela silenciou.
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try { return Response.json({ events: await preferences(auth.user!) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { console.error("[notifications.preferences.get]", error); return Response.json({ error: "Não foi possível carregar as preferências." }, { status: 500 }); }
}

// { event, muted }
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const event = String(body.event ?? "");
    if (!isEventKey(event) || eventDef(event)?.locked) return Response.json({ error: "Evento inválido." }, { status: 400 });
    await setMuted(auth.user!.id, event, body.muted === true);
    return Response.json({ ok: true, message: body.muted === true ? `"${eventDef(event)!.label}" silenciado.` : `"${eventDef(event)!.label}" volta a avisar.` });
  } catch (error) { console.error("[notifications.preferences.put]", error); return Response.json({ error: "Não foi possível salvar." }, { status: 500 }); }
}
