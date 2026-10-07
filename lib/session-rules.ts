// ---------------------------------------------------------------------------
// Regras da sessão de login (puras, sem banco) — usadas no servidor (lib/auth.ts) e no celular
// (app/page.tsx). Testadas em tests/session-rules.test.mjs.
//
// Por que existe: no iPhone, o app da tela de início caía na tela de login (1) quando a sessão
// vencia — 12 h fixas para o campo, 7 dias fixos para os demais, sem renovar com o uso — e (2)
// quando a checagem da sessão falhava por falta de sinal ou servidor lento, que o app tratava
// como "deslogado". Agora a validade renova a cada uso e só a resposta explícita do servidor
// ("sessão inválida") leva ao login.
// ---------------------------------------------------------------------------

// FIELD: funcionário de campo (Controle Diário e comboio). REMEMBER: login com "Manter conectado".
// SHORT: login sem marcar "Manter conectado".
export type SessionKind = "FIELD" | "REMEMBER" | "SHORT";
export const SESSION_KINDS: SessionKind[] = ["FIELD", "REMEMBER", "SHORT"];
export const isSessionKind = (value: unknown): value is SessionKind => typeof value === "string" && (SESSION_KINDS as string[]).includes(value);

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
// Prazo SEM USO: cada uso empurra a validade para agora + este prazo (sessão deslizante).
export const SESSION_WINDOW_SECONDS: Record<SessionKind, number> = { FIELD: 30 * DAY, REMEMBER: 30 * DAY, SHORT: 12 * HOUR };
// O cookie só carrega o código da sessão; quem decide se ainda vale é o servidor (tabela
// user_sessions). Por isso o cookie é sempre persistente e longo: um cookie sem Max-Age é apagado
// pelo iPhone quando o app da tela de início é fechado.
export const SESSION_COOKIE_SECONDS = 30 * DAY;
// Renovar grava no banco: no máximo uma vez a cada 15 min por sessão.
export const RENEW_AFTER_SECONDS = 15 * 60;
// Sessões encerradas ficam guardadas este tempo (com o motivo) para o log; depois a faxina apaga.
export const ENDED_SESSION_KEEP_SECONDS = 30 * DAY;

export function sessionKindFor(profile: string, remember: boolean): SessionKind {
  if (profile === "CAMPO") return "FIELD";
  return remember ? "REMEMBER" : "SHORT";
}

export function sessionExpiry(kind: SessionKind, now: Date) {
  return new Date(now.getTime() + SESSION_WINDOW_SECONDS[kind] * 1000).toISOString();
}

// Renovação a cada uso. Sessão antiga (sem tipo, aberta antes desta regra): a de campo passa a
// deslizar 30 dias já no primeiro uso; as demais valem até a validade que já tinham.
export function slidingRenewal(session: { kind: SessionKind | null; lastSeenAt: string | null; expiresAt: string }, profile: string, now: Date): { kind: SessionKind; expiresAt: string } | null {
  const kind = session.kind ?? (profile === "CAMPO" ? "FIELD" : null);
  if (!kind) return null;
  const lastSeen = session.lastSeenAt ? Date.parse(session.lastSeenAt) : NaN;
  const fresh = session.kind !== null && Number.isFinite(lastSeen) && now.getTime() - lastSeen < RENEW_AFTER_SECONDS * 1000;
  if (fresh) return null;
  const expiresAt = sessionExpiry(kind, now);
  // Nunca encurta uma validade que já era maior (ex.: sessão antiga com prazo mais longo).
  return { kind, expiresAt: expiresAt > session.expiresAt ? expiresAt : session.expiresAt };
}

// Motivo do fim de uma sessão (para o log). REVOGADA vem acompanhada do motivo gravado na revogação.
export type RevokeReason = "LOGOUT" | "PIN_TROCADO" | "SENHA_TROCADA" | "INATIVADO";
export type SessionEndReason = "EXPIROU" | "INATIVADO" | "INVALIDA" | `REVOGADA:${string}`;

export function sessionEndReason(row: { revokedAt: string | null; revokeReason: string | null; expiresAt: string; userActive: boolean } | null, now: Date): SessionEndReason | null {
  if (!row) return "INVALIDA";
  if (row.revokedAt) return `REVOGADA:${row.revokeReason ?? "SEM_MOTIVO"}`;
  if (row.expiresAt <= now.toISOString()) return "EXPIROU";
  if (!row.userActive) return "INATIVADO";
  return null;
}

// ---------------------------------------------------------------------------
// No celular: o que fazer com a resposta da checagem da sessão (/api/auth/session).
//  LOGGED_IN  = o servidor confirmou o usuário;
//  LOGGED_OUT = o servidor respondeu explicitamente que a sessão não vale → tela de login;
//  UNKNOWN    = sem sinal, tempo esgotado, servidor fora (5xx) ou resposta do modo offline → o app
//               continua com o último usuário confirmado guardado no aparelho (nunca desloga).
// ---------------------------------------------------------------------------
export type SessionCheck = "LOGGED_IN" | "LOGGED_OUT" | "UNKNOWN";

export function classifySessionCheck(response: { status: number; offline?: boolean } | null, body: unknown): SessionCheck {
  if (!response || response.offline) return "UNKNOWN";
  if (response.status === 401) return "LOGGED_OUT";
  if (response.status < 200 || response.status >= 300) return "UNKNOWN";
  if (!body || typeof body !== "object" || !("user" in body)) return "UNKNOWN";
  const user = (body as { user: unknown }).user;
  if (user === null) return "LOGGED_OUT";
  return user && typeof user === "object" && typeof (user as { id?: unknown }).id === "number" ? "LOGGED_IN" : "UNKNOWN";
}
