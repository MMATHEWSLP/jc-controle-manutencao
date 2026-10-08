import { assertSameOrigin, authorize, type Profile } from "../../../../lib/auth";
import { PROFILES, type NotificationLink } from "../../../../lib/notification-events";
import { auditNotification, sendManual } from "../../../../lib/notifications";

const ids = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];

// Notificação avulsa: { title, body, link?: { secao }, push, target: { all, profiles, frontIds, userIds } }.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "notifications.send"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (title.length < 3) return Response.json({ error: "Escreva o título (ao menos 3 letras)." }, { status: 400 });
    if (text.length < 3) return Response.json({ error: "Escreva a mensagem." }, { status: 400 });
    const raw = (body.target ?? {}) as Record<string, unknown>;
    const target = { all: raw.all === true, profiles: (Array.isArray(raw.profiles) ? raw.profiles : []).filter((item): item is Profile => PROFILES.includes(item as Profile)), frontIds: ids(raw.frontIds), userIds: ids(raw.userIds) };
    if (!target.all && !target.profiles.length && !target.userIds.length) return Response.json({ error: "Escolha quem recebe: todos, perfis ou pessoas." }, { status: 400 });
    const linkRaw = body.link as { secao?: unknown } | null | undefined;
    const link: NotificationLink | null = linkRaw && typeof linkRaw.secao === "string" && linkRaw.secao ? { secao: linkRaw.secao.slice(0, 60) } : null;
    const result = await sendManual(auth.user!, { title, body: text, link, push: body.push !== false }, target);
    if (!result) return Response.json({ error: "Ninguém se encaixa nessa escolha (pessoas ativas)." }, { status: 400 });
    await auditNotification(auth.user!.id, "NOTIFICAÇÃO AVULSA ENVIADA", String(result.dispatchId), { title, target, recipients: result.recipients });
    return Response.json({ ok: true, ...result, message: `Notificação enviada para ${result.recipients} pessoa(s).` });
  } catch (error) {
    console.error("[notifications.send]", error);
    return Response.json({ error: "Não foi possível enviar." }, { status: 500 });
  }
}
