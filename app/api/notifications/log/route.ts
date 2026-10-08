import { authorize } from "../../../../lib/auth";
import { isEventKey } from "../../../../lib/notification-events";
import { dispatchDetail, dispatchLog } from "../../../../lib/notifications";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Registro de envios: ?de&ate&evento&falhas=1; ?id=N = destinatários e cada envio ao celular (com o erro).
export async function GET(request: Request) {
  const auth = await authorize(request, "notifications.configure"); if (auth.response) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    const id = Number(params.get("id"));
    if (Number.isInteger(id) && id > 0) return Response.json({ recipients: await dispatchDetail(id) }, { headers: { "Cache-Control": "private, no-store" } });
    const today = new Date().toISOString().slice(0, 10);
    const from = ISO.test(params.get("de") ?? "") ? params.get("de")! : new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const to = ISO.test(params.get("ate") ?? "") ? params.get("ate")! : today;
    const event = params.get("evento") ?? "";
    const rows = await dispatchLog({ from, to, event: isEventKey(event) ? event : null, onlyFailures: params.get("falhas") === "1" });
    return Response.json({ rows, from, to }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[notifications.log]", error);
    return Response.json({ error: "Não foi possível carregar o registro." }, { status: 500 });
  }
}
