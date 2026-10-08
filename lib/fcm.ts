import crypto from "node:crypto";
import type { PushPayload, PushResult } from "./push";

// ---------------------------------------------------------------------------
// Aviso no app Android pelo Firebase Cloud Messaging (API HTTP v1). A chave é a conta de serviço do
// projeto Firebase (arquivo JSON baixado em Configurações do projeto → Contas de serviço), cadastrada
// na Hostinger como FIREBASE_SERVICE_ACCOUNT (o conteúdo do arquivo, ou o mesmo conteúdo em base64).
// Sem ela, o aviso continua no sino e o registro de envios mostra o motivo.
// O app recebe só dados (title, body, url, tag) e monta o aviso ele mesmo (android-app/…/PushService.kt).
// ---------------------------------------------------------------------------
type ServiceAccount = { projectId: string; clientEmail: string; privateKey: string };
const endpoints = { token: "https://oauth2.googleapis.com/token", fcm: "https://fcm.googleapis.com" };
let cachedToken: { value: string; expires: number; email: string } | null = null;

export function fcmAccount(raw = process.env.FIREBASE_SERVICE_ACCOUNT): ServiceAccount | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8")) as Record<string, unknown>;
    const projectId = String(json.project_id ?? ""), clientEmail = String(json.client_email ?? ""), privateKey = String(json.private_key ?? "").replace(/\\n/g, "\n");
    return projectId && clientEmail && privateKey.includes("PRIVATE KEY") ? { projectId, clientEmail, privateKey } : null;
  } catch { return null; }
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

// Token de acesso do Google (OAuth com JWT assinado pela conta de serviço), guardado até perto de vencer.
async function accessToken(account: ServiceAccount) {
  if (cachedToken && cachedToken.email === account.clientEmail && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: account.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: endpoints.token, iat: now, exp: now + 3600 }))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), account.privateKey);
  const response = await fetch(endpoints.token, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64(signature)}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) throw new Error(`Google recusou a conta de serviço: ${data.error_description ?? data.error ?? `HTTP ${response.status}`}`);
  cachedToken = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000, email: account.clientEmail };
  return data.access_token;
}

// invalid = o Firebase diz que o token não existe mais (app desinstalado, dados apagados).
export async function sendFcm(token: string, payload: PushPayload): Promise<PushResult> {
  const account = fcmAccount();
  if (!account) return { ok: false, invalid: false, error: "FIREBASE_SERVICE_ACCOUNT não configurado na Hostinger" };
  try {
    const response = await fetch(`${endpoints.fcm}/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessToken(account)}` },
      body: JSON.stringify({ message: { token, data: { title: payload.title, body: payload.body, url: payload.url, tag: payload.tag ?? "" }, android: { priority: "HIGH", ttl: "86400s" } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    const code = data.error?.details?.find((item) => item.errorCode)?.errorCode ?? data.error?.status ?? "";
    if (response.status === 401) cachedToken = null;
    const invalid = response.status === 404 || code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /token/i.test(data.error?.message ?? ""));
    return { ok: false, invalid, error: `HTTP ${response.status}${code ? ` ${code}` : ""}${data.error?.message ? `: ${data.error.message}` : ""}`.slice(0, 300) };
  } catch (error) {
    return { ok: false, invalid: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

// Só para testes: aponta para um servidor local e esquece o token guardado.
export function useFcmEndpointsForTests(next: Partial<typeof endpoints>) { Object.assign(endpoints, next); cachedToken = null; }
