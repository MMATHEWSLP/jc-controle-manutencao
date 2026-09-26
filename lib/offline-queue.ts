// Fila do Controle Diário no próprio celular (IndexedDB), para registrar sem internet.
// O registro fica guardado com as fotos e é enviado sozinho quando a conexão volta
// (evento "online", ao abrir o app e a cada minuto enquanto houver pendência).
//
// Cada item guarda o id do usuário que preencheu: só é enviado quando ESSE usuário está
// logado, para um registro nunca ser gravado em nome de outro funcionário que use o mesmo celular.

export type QueuedDailyRecord = {
  id: string;
  userId: number;
  createdAt: string;
  payload: string;
  problemPhoto: Blob | null;
  productionPhoto: Blob | null;
  summary: { prefix: string; recordDate: string; equipmentId: number | null; endReading: number | null };
  status: "PENDING" | "ERROR";
  error: string | null;
};

export const QUEUE_EVENT = "jc-offline-queue-changed";
const DB_NAME = "jc-sistema-offline";
const STORE = "daily-records";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_EVENT)); };

export async function listQueued(userId?: number): Promise<QueuedDailyRecord[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await withStore<QueuedDailyRecord[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedDailyRecord[]>).catch(() => []);
  return all.filter((item) => userId === undefined || item.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function enqueue(item: Omit<QueuedDailyRecord, "id" | "createdAt" | "status" | "error">) {
  const record: QueuedDailyRecord = { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "PENDING", error: null };
  await withStore("readwrite", (store) => store.put(record));
  notify();
  return record;
}

export async function removeQueued(id: string) {
  await withStore("readwrite", (store) => store.delete(id));
  notify();
}

async function markError(item: QueuedDailyRecord, error: string) {
  await withStore("readwrite", (store) => store.put({ ...item, status: "ERROR", error }));
}

let running: Promise<number> | null = null;

// Envia os pendentes do usuário logado. Devolve quantos foram enviados.
export function syncQueue(): Promise<number> {
  if (running) return running;
  // A trava é liberada no .finally() da promessa (e não num try/finally interno): quando a função
  // retorna antes do primeiro await (ex.: sem internet), um finally interno rodaria ANTES desta
  // atribuição e a trava ficaria presa para sempre, bloqueando todos os envios seguintes.
  running = (async () => {
    let sent = 0;
    if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
    const pendingAll = (await listQueued()).filter((item) => item.status === "PENDING");
    if (!pendingAll.length) return 0;
    const session = await fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as { user?: { id: number } } | null;
    const userId = session?.user?.id;
    if (!userId) return 0;
    for (const item of pendingAll.filter((entry) => entry.userId === userId)) {
      const form = new FormData();
      form.set("payload", item.payload);
      if (item.problemPhoto) form.set("problemPhoto", item.problemPhoto, "problema.webp");
      if (item.productionPhoto) form.set("productionPhoto", item.productionPhoto, "producao.webp");
      let response: Response;
      try { response = await fetch("/api/daily-records", { method: "POST", body: form }); }
      catch { break; } // sem conexão de verdade: tenta de novo depois
      // 409 = já estava gravado (ex.: a resposta de uma tentativa anterior se perdeu no caminho).
      if (response.ok || response.status === 409) { await withStore("readwrite", (store) => store.delete(item.id)); sent++; continue; }
      if (response.status >= 500 || response.status === 401 || response.headers.get("X-Offline")) break;
      const body = await response.json().catch(() => ({})) as { error?: string };
      await markError(item, body.error ?? "O servidor recusou este registro.");
    }
    return sent;
  })().finally(() => {
    running = null;
    notify();
  });
  return running;
}

// Apaga dados de telas guardados no celular (usado ao sair/entrar com outro usuário).
// A fila do Controle Diário NÃO é apagada: registros pendentes nunca se perdem.
export function clearCachedUserData() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: "CLEAR_USER_DATA" });
}
