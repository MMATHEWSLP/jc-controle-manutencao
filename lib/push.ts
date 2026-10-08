import webpush from "web-push";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { notificationState } from "../db/schema";
import { DEFAULT_SITE_URL, siteUrl } from "./site";

// ---------------------------------------------------------------------------
// Web Push (aviso no iPhone com o app na Tela de Início, iOS 16.4+, e no navegador do computador ou
// do Android). As chaves VAPID são geradas pelo próprio sistema no primeiro uso e guardadas no banco
// (notification_state "vapid"); VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no servidor têm prioridade.
// Trocar as chaves invalida as inscrições já feitas (cada aparelho precisa ativar de novo).
// ---------------------------------------------------------------------------
export type VapidKeys = { publicKey: string; privateKey: string };
let cached: VapidKeys | null = null;

export async function vapidKeys(): Promise<VapidKeys> {
  const fromEnv = { publicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? "", privateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? "" };
  if (fromEnv.publicKey && fromEnv.privateKey) return fromEnv;
  if (cached) return cached;
  const db = await getDb();
  const read = async () => (await db.select({ value: notificationState.value }).from(notificationState).where(eq(notificationState.key, "vapid")).limit(1))[0]?.value;
  let stored = await read();
  if (!stored) {
    // Dois pedidos ao mesmo tempo: só o primeiro grava; o outro lê o que ficou.
    await db.insert(notificationState).values({ key: "vapid", value: JSON.stringify(webpush.generateVAPIDKeys()) }).onConflictDoNothing();
    stored = await read();
  }
  const parsed = JSON.parse(String(stored)) as VapidKeys;
  cached = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
  return cached;
}

// Contato do servidor exigido pela Apple/Google: precisa ser https:// (ou mailto:) e não pode ser localhost.
function subject() {
  const configured = process.env.VAPID_SUBJECT?.trim();
  if (configured) return configured;
  const site = siteUrl();
  return /^https:\/\//.test(site) && !/localhost|127\.0\.0\.1/.test(site) ? site : DEFAULT_SITE_URL;
}

export type PushPayload = { title: string; body: string; url: string; tag?: string | null };
export type PushResult = { ok: true } | { ok: false; invalid: boolean; error: string };
export type WebSubscription = { endpoint: string; p256dh: string; auth: string };

// invalid = o serviço de push disse que a inscrição não existe mais (aparelho desativou, app removido).
export async function sendWebPush(subscription: WebSubscription, payload: PushPayload): Promise<PushResult> {
  const keys = await vapidKeys();
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 3600, urgency: "high", timeout: 15_000 },
    );
    return { ok: true };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    const body = String((error as { body?: string }).body ?? "").slice(0, 200);
    const message = status ? `HTTP ${status}${body ? ` ${body}` : ""}` : error instanceof Error ? error.message : String(error);
    return { ok: false, invalid: status === 404 || status === 410, error: message.slice(0, 300) };
  }
}

// Só para testes: esquece a chave lida (o banco de teste é recriado entre execuções).
export function resetVapidCache() { cached = null; }
