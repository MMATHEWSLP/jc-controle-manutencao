// Checagem da sessão no navegador/celular. Regra: SÓ a resposta explícita do servidor ("sessão
// inválida") leva à tela de login. Sem sinal, sinal fraco, tempo esgotado ou servidor fora, o app
// continua com o último usuário confirmado, guardado no aparelho (só dados de tela: nome, perfil,
// permissões, frentes — o servidor confere a sessão de novo em cada envio).
import { classifySessionCheck, type SessionCheck } from "./session-rules";

const STORAGE_KEY = "jc-sessao-usuario";

// "app" = aberto pela tela de início (iPhone/Android); vai para o log do servidor quando a sessão cai.
export function displayMode() {
  if (typeof window === "undefined") return "navegador";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? "app" : "navegador";
}

export async function checkSession<T>(timeoutMs = 10_000): Promise<{ state: SessionCheck; user: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", headers: { "X-JC-Display": displayMode() }, signal: controller.signal });
    const body = await response.json().catch(() => null) as { user?: T | null } | null;
    const state = classifySessionCheck({ status: response.status, offline: Boolean(response.headers.get("X-Offline")) }, body);
    return { state, user: state === "LOGGED_IN" ? (body!.user as T) : null };
  } catch {
    return { state: "UNKNOWN", user: null };
  } finally { clearTimeout(timer); }
}

export function saveSessionUser(user: unknown) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); } catch { /* aparelho sem armazenamento */ }
}

export function loadSessionUser<T>(): T | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    const user = value ? JSON.parse(value) as T & { id?: unknown } : null;
    return user && typeof user.id === "number" ? user : null;
  } catch { return null; }
}

export function clearSessionUser() {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignora */ }
}

// "Sair" sem sinal: o servidor não ficou sabendo, então o cookie ainda vale. Fica marcado no
// aparelho e o app conclui a saída na próxima abertura com internet (sem entrar sozinho de novo).
const PENDING_LOGOUT_KEY = "jc-sair-pendente";

export async function logoutRequest() {
  clearSessionUser();
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    if (!response.ok && response.status !== 401) throw new Error("logout");
    window.localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    try { window.localStorage.setItem(PENDING_LOGOUT_KEY, "1"); } catch { /* ignora */ }
  }
}

// true = havia uma saída pendente; o app abre na tela de login.
export async function finishPendingLogout() {
  let pending = false;
  try { pending = window.localStorage.getItem(PENDING_LOGOUT_KEY) === "1"; } catch { return false; }
  if (pending) await logoutRequest();
  return pending;
}

export function clearPendingLogout() {
  try { window.localStorage.removeItem(PENDING_LOGOUT_KEY); } catch { /* ignora */ }
}
