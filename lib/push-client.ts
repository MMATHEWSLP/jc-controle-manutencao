// ---------------------------------------------------------------------------
// Avisos no celular pelo navegador (Web Push): ativar neste aparelho, saber se já está ativo e
// desligar do login ao sair. Roda só no navegador. No iPhone só funciona com o app adicionado à Tela
// de Início (iOS 16.4 ou mais novo); o app Android usa o Firebase (parte 4b), não este caminho.
// ---------------------------------------------------------------------------
export type PushSupport = "OK" | "IOS_INSTALL" | "ANDROID_APP" | "UNSUPPORTED" | "DENIED";
export const PUSH_CHANGED_EVENT = "jc:push-changed";

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isAndroidApp = () => /JCSistemaAndroid/i.test(navigator.userAgent);

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "UNSUPPORTED";
  if (isAndroidApp()) return "ANDROID_APP";
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!capable) return isIos() && !standalone() ? "IOS_INSTALL" : "UNSUPPORTED";
  if (Notification.permission === "denied") return "DENIED";
  return "OK";
}

// Nome que aparece em "Meus aparelhos".
export function deviceLabel() {
  const ua = navigator.userAgent;
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

// Pede a permissão (precisa vir de um toque do usuário), inscreve o aparelho e cadastra no login atual.
export async function enablePush() {
  const support = pushSupport();
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

// Inscrição deste aparelho (null = ainda não ativou).
export async function currentSubscription() {
  if (pushSupport() !== "OK" || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Ao abrir o sistema já com a permissão dada: confirma o aparelho no login atual (outro funcionário
// que entrar no mesmo celular passa a receber, o anterior não).
export async function syncPush() {
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await send("POST", { kind: "WEB", subscription: subscription.toJSON(), label: deviceLabel() }).catch(() => undefined);
  return Boolean(subscription);
}

// Desativar neste aparelho (botão) ou ao sair do sistema (o celular continua inscrito, mas deixa de
// receber deste login; quem entrar depois ativa de novo sem pedir permissão).
export async function disablePush(reason: "USUARIO" | "LOGOUT") {
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await send("DELETE", { endpoint: subscription.endpoint, reason }).catch(() => undefined);
  if (reason === "USUARIO") await subscription.unsubscribe().catch(() => undefined);
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
}
