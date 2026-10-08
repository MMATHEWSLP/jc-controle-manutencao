import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { listDevices, registerDevice, removeDevice } from "../../../../lib/notifications";
import { vapidKeys } from "../../../../lib/push";

// Aparelhos da pessoa que recebem aviso fora do sistema. GET também entrega a chave pública do Web Push
// (o navegador precisa dela para ativar).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const [devices, keys] = await Promise.all([listDevices(auth.user!.id), vapidKeys()]);
    return Response.json({ devices: devices.map(({ token, ...device }) => ({ ...device, endpoint: token })), publicKey: keys.publicKey }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[notifications.devices.get]", error);
    return Response.json({ error: "Não foi possível carregar os aparelhos." }, { status: 500 });
  }
}

// Ativar neste aparelho. WEB: { kind: "WEB", subscription: { endpoint, keys: { p256dh, auth } }, label }.
// ANDROID (app, parte 4b): { kind: "ANDROID", token, label }.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label.trim() : null;
    if (body.kind === "ANDROID") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token.length < 20 || token.length > 4096) return Response.json({ error: "Token do aparelho inválido." }, { status: 400 });
      return Response.json({ ok: true, id: await registerDevice(auth.user!.id, { kind: "ANDROID", token, label }) });
    }
    const subscription = (body.subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint : "";
    const p256dh = typeof subscription.keys?.p256dh === "string" ? subscription.keys.p256dh : "";
    const key = typeof subscription.keys?.auth === "string" ? subscription.keys.auth : "";
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048 || !p256dh || !key) return Response.json({ error: "Inscrição do aparelho inválida." }, { status: 400 });
    return Response.json({ ok: true, id: await registerDevice(auth.user!.id, { kind: "WEB", token: endpoint, p256dh, auth: key, label }) });
  } catch (error) {
    console.error("[notifications.devices.post]", error);
    return Response.json({ error: "Não foi possível ativar as notificações neste aparelho." }, { status: 500 });
  }
}

// Desativar: { id } (lista "Meus aparelhos") ou { endpoint } (este aparelho, ao sair do sistema).
export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = Number(body.id) || undefined;
    const token = typeof body.endpoint === "string" ? body.endpoint : typeof body.token === "string" ? body.token : undefined;
    const removed = await removeDevice(auth.user!.id, { id, token }, body.reason === "LOGOUT" ? "SAIU" : "USUARIO");
    return Response.json({ ok: true, removed });
  } catch (error) {
    console.error("[notifications.devices.delete]", error);
    return Response.json({ error: "Não foi possível desativar." }, { status: 500 });
  }
}
