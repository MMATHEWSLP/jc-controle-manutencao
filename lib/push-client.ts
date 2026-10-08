// ---------------------------------------------------------------------------
// Avisos no celular: ativar neste aparelho, saber se já está ativo e desligar do login ao sair. Roda
// só no navegador.
//  - Navegador e iPhone (Web Push): no iPhone só com o app adicionado à Tela de Início (iOS 16.4+).
//  - App Android: o app recebe pelo Firebase; a página pede o token pela ponte window.JCAndroid
//    (android-app/…/WebBridge.kt) e cadastra o aparelho como ANDROID.
// ---------------------------------------------------------------------------
export type PushSupport = "OK" | "IOS_INSTALL" | "ANDROID_APP" | "ANDROID_SETUP" | "UNSUPPORTED" | "DENIED";
export const PUSH_CHANGED_EVENT = "jc:push-changed";
const ANDROID_EVENT = "jc:android-push";
// Desligado pela pessoa no app Android (o token do Firebase continua no celular; não recadastrar sozinho).
const ANDROID_OFF = "jc-push-android-off";

type AndroidState = { available: boolean; permission: "granted" | "denied" | "default"; token: string };
type AndroidBridge = { pushState?: () => string; requestPush?: () => void };
const bridge = () => (window as unknown as { JCAndroid?: AndroidBridge }).JCAndroid;
function androidState(): AndroidState | null {
  try { const raw = bridge()?.pushState?.(); return raw ? JSON.parse(raw) as AndroidState : null; } catch { return null; }
}
const androidOff = () => { try { return window.localStorage.getItem(ANDROID_OFF) === "1"; } catch { return false; } };
const setAndroidOff = (off: boolean) => { try { if (off) window.localStorage.setItem(ANDROID_OFF, "1"); else window.localStorage.removeItem(ANDROID_OFF); } catch { /* sem armazenamento */ } };

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isAndroidApp = () => /JCSistemaAndroid/i.test(navigator.userAgent);

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "UNSUPPORTED";
  if (isAndroidApp()) {
    // App antigo (sem a ponte): pedir para atualizar. App sem o Firebase configurado: aviso só no sino.
    const state = androidState();
    if (!state) return "ANDROID_APP";
    if (!state.available) return "ANDROID_SETUP";
    return state.permission === "denied" ? "DENIED" : "OK";
  }
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!capable) return isIos() && !standalone() ? "IOS_INSTALL" : "UNSUPPORTED";
  if (Notification.permission === "denied") return "DENIED";
  return "OK";
}

// Nome que aparece em "Meus aparelhos".
export function deviceLabel() {
  const ua = navigator.userAgent;
  if (isAndroidApp()) return "Android · app JC Sistema";
  const system = /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) ? "iPad" : /android/i.test(ua) ? "Android" : /windows/i.test(ua) ? "Windows" : /mac os/i.test(ua) ? "Mac" : /linux/i.test(ua) ? "Linux" : "Aparelho";
  const browser = /edg\//i.test(ua) ? "Edge" : /firefox|fxios/i.test(ua) ? "Firefox" : /crios|chrome/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Navegador";
  return `${system} · ${standalone() ? "app" : browser}`;
}

function keyBytes(base64url: string) {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => Boolean(a) && new Uint8Array(a!).length === b.length && new Uint8Array(a!).every((byte, index) => byte === b[index]);

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register("/sw.js");
}

async function send(method: "POST" | "DELETE", body: unknown) {
  const response = await fetch("/api/notifications/devices", { method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Não foi possível falar com o servidor.");
}

// App Android: pede a permissão e o token ao app (resposta pelo evento jc:android-push).
function androidToken() {
  return new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => { window.removeEventListener(ANDROID_EVENT, done); reject(new Error("O app não respondeu. Tente de novo.")); }, 30_000);
    function done(event: Event) {
      window.clearTimeout(timer);
      const detail = (event as CustomEvent<{ token?: string; error?: string }>).detail ?? {};
      if (detail.token) resolve(detail.token);
      else reject(new Error(detail.error || "Sem permissão, o aviso não chega neste aparelho. Libere as notificações do app JC Sistema nos ajustes do celular."));
    }
    window.addEventListener(ANDROID_EVENT, done, { once: true });
    bridge()!.requestPush!();
  });
}

// Pede a permissão (precisa vir de um toque do usuário), inscreve o aparelho e cadastra no login atual.
export async function enablePush() {
  const support = pushSupport();
  if (isAndroidApp() && support === "OK") {
    const token = await androidToken();
    await send("POST", { kind: "ANDROID", token, label: deviceLabel() });
    setAndroidOff(false);
    window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
    return;
  }
  if (support === "IOS_INSTALL") throw new Error("No iPhone, primeiro adicione o sistema à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra por lá.");
  if (support === "DENIED") throw new Error("As notificações estão bloqueadas para este site. Libere nos ajustes do aparelho/navegador e tente de novo.");
  if (support !== "OK") throw new Error("Este navegador não recebe notificações.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Sem permissão, o aviso não chega neste aparelho.");
  const { publicKey } = await (await fetch("/api/notifications/devices", { cache: "no-store" })).json() as { publicKey: string };
  const key = keyBytes(publicKey);
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  // Inscrição feita com outra chave (o servidor trocou as chaves): refaz.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) { await subscription.unsubscribe().catch(() => undefined); subscription = null; }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await send("POST", { kind: "WEB", subscription: subscription.toJSON(), label: deviceLabel() });
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
}

// O que identifica este aparelho no servidor: endpoint do Web Push ou token do Firebase (null = não ativou).
export async function currentDeviceToken() {
  if (isAndroidApp()) { const state = androidState(); return state?.available && state.permission === "granted" && state.token && !androidOff() ? state.token : null; }
  return (await currentSubscription().catch(() => null))?.endpoint ?? null;
}

// Inscrição deste aparelho (null = ainda não ativou).
export async function currentSubscription() {
  if (isAndroidApp() || pushSupport() !== "OK" || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Ao abrir o sistema já com a permissão dada: confirma o aparelho no login atual (outro funcionário
// que entrar no mesmo celular passa a receber, o anterior não).
export async function syncPush() {
  if (isAndroidApp()) {
    const token = await currentDeviceToken();
    if (token) await send("POST", { kind: "ANDROID", token, label: deviceLabel() }).catch(() => undefined);
    return Boolean(token);
  }
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await send("POST", { kind: "WEB", subscription: subscription.toJSON(), label: deviceLabel() }).catch(() => undefined);
  return Boolean(subscription);
}

// Desativar neste aparelho (botão) ou ao sair do sistema (o celular continua inscrito, mas deixa de
// receber deste login; quem entrar depois ativa de novo sem pedir permissão).
export async function disablePush(reason: "USUARIO" | "LOGOUT") {
  if (isAndroidApp()) {
    const token = await currentDeviceToken();
    if (token) await send("DELETE", { token, reason }).catch(() => undefined);
    // Ao sair, a tela não avisa a mudança: senão o sino recadastraria o aparelho antes do fim da sessão.
    if (reason === "USUARIO") { setAndroidOff(true); window.dispatchEvent(new Event(PUSH_CHANGED_EVENT)); }
    return;
  }
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await send("DELETE", { endpoint: subscription.endpoint, reason }).catch(() => undefined);
  if (reason === "USUARIO") { await subscription.unsubscribe().catch(() => undefined); window.dispatchEvent(new Event(PUSH_CHANGED_EVENT)); }
}
