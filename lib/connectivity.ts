// Conexão "de verdade": em vez de confiar em navigator.onLine (que no iPhone costuma dizer
// "online" mesmo em modo avião), faz uma chamada rápida ao servidor com tempo limite.
export const CONNECTIVITY_EVENT = "jc-connectivity-changed";
let lastKnown = true;

export function isKnownOnline() { return lastKnown; }

function publish(online: boolean) {
  if (online === lastKnown) return;
  lastKnown = online;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CONNECTIVITY_EVENT, { detail: online }));
}

export async function checkOnline(timeoutMs = 6000): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) { publish(false); return false; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/ping?t=${Date.now()}`, { cache: "no-store", signal: controller.signal });
    publish(response.ok);
    return response.ok;
  } catch {
    publish(false);
    return false;
  } finally { clearTimeout(timer); }
}

// Marca como sem conexão quando outra chamada falhou por rede (ex.: envio do formulário).
export function reportNetworkFailure() { publish(false); }
