// Abastecimentos do comboio no celular (IndexedDB próprio, "jc-comboio"):
//  - catalog: cadastro baixado com internet (equipamentos com a última leitura, funcionários, motivos);
//  - queue: registros e fotos guardados com o UUID gerado no celular. Status: PENDENTE_ENVIO →
//    ENVIADO (o servidor recebeu; a foto é apagada do celular) ou ERRO (recusado, com o motivo);
//  - records: última lista de "Meus abastecimentos" vinda do servidor (para ver sem internet).
// O envio é automático (ao reconectar, ao voltar para o app e a cada 30 s). O servidor usa o UUID
// para nunca duplicar, então reenviar é sempre seguro. Cada item guarda o usuário que registrou e só
// é enviado com ESSE usuário logado.
import { checkOnline } from "./connectivity";

export type StoredBlob = { data: ArrayBuffer; type: string };
export type ConvoyQueueStatus = "PENDENTE_ENVIO" | "ENVIADO" | "ERRO";
export type ConvoyQueueItem = {
  clientUuid: string; userId: number; createdAt: string; kind: "NOVO" | "CORRECAO"; targetUuid: string | null;
  payload: Record<string, unknown>; meterPhoto: StoredBlob | null; pumpPhoto: StoredBlob | null;
  summary: { equipment: string; liters: number; operator: string; reading: number | null; unit: string; noPhoto: boolean };
  status: ConvoyQueueStatus; error: string | null; sentAt: string | null; serverId: number | null;
};

export const CONVOY_QUEUE_EVENT = "jc-convoy-queue-changed";
export const CONVOY_SENT_EVENT = "jc-convoy-queue-sent";
const DB_NAME = "jc-comboio";
const SENT_KEEP_DAYS = 3;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog", { keyPath: "userId" });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "clientUuid" });
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "userId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(CONVOY_QUEUE_EVENT)); };

// Pede ao navegador para não apagar estes dados quando faltar espaço (fila e fotos não enviadas).
export async function requestPersistentStorage() {
  try { return Boolean(await navigator.storage?.persist?.()); } catch { return false; }
}

export async function saveCatalog<T extends { userId: number }>(catalog: T) { await run("catalog", "readwrite", (store) => store.put(catalog)); }
export async function loadCatalog<T>(userId: number): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null;
  return (await run<T | undefined>("catalog", "readonly", (store) => store.get(userId) as IDBRequest<T | undefined>).catch(() => undefined)) ?? null;
}
export async function saveMyRecords<T>(userId: number, records: T[]) { await run("records", "readwrite", (store) => store.put({ userId, records, savedAt: new Date().toISOString() })); }
export async function loadMyRecords<T>(userId: number): Promise<{ records: T[]; savedAt: string } | null> {
  if (typeof indexedDB === "undefined") return null;
  return (await run<{ records: T[]; savedAt: string } | undefined>("records", "readonly", (store) => store.get(userId) as IDBRequest<{ records: T[]; savedAt: string } | undefined>).catch(() => undefined)) ?? null;
}

export async function listConvoyQueue(userId?: number): Promise<ConvoyQueueItem[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await run<ConvoyQueueItem[]>("queue", "readonly", (store) => store.getAll() as IDBRequest<ConvoyQueueItem[]>).catch(() => [] as ConvoyQueueItem[]);
  return all.filter((item) => userId === undefined || item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const toStored = async (blob: Blob | null): Promise<StoredBlob | null> => (blob ? { data: await blob.arrayBuffer(), type: blob.type || "image/jpeg" } : null);
const toBlob = (stored: StoredBlob | null) => (stored ? new Blob([stored.data], { type: stored.type }) : null);

export async function enqueueConvoy(item: Omit<ConvoyQueueItem, "createdAt" | "status" | "error" | "sentAt" | "serverId" | "meterPhoto" | "pumpPhoto"> & { meterPhoto: Blob | null; pumpPhoto: Blob | null }) {
  const record: ConvoyQueueItem = {
    ...item, meterPhoto: await toStored(item.meterPhoto), pumpPhoto: await toStored(item.pumpPhoto),
    createdAt: new Date().toISOString(), status: "PENDENTE_ENVIO", error: null, sentAt: null, serverId: null,
  };
  await run("queue", "readwrite", (store) => store.put(record));
  notify();
  return record;
}

export async function discardConvoy(clientUuid: string) { await run("queue", "readwrite", (store) => store.delete(clientUuid)); notify(); }
export async function retryConvoy(clientUuid: string) {
  const item = (await listConvoyQueue()).find((entry) => entry.clientUuid === clientUuid);
  if (!item) return;
  await run("queue", "readwrite", (store) => store.put({ ...item, status: "PENDENTE_ENVIO", error: null }));
  notify();
}

export async function countConvoyPending(userId?: number) {
  return (await listConvoyQueue(userId)).filter((item) => item.status !== "ENVIADO").length;
}

function requestFor(item: ConvoyQueueItem) {
  const form = new FormData();
  form.set("payload", JSON.stringify(item.payload));
  const meter = toBlob(item.meterPhoto), pump = toBlob(item.pumpPhoto);
  if (meter) form.set("meterPhoto", meter, "medidor.jpg");
  if (pump) form.set("pumpPhoto", pump, "bomba.jpg");
  const url = item.kind === "CORRECAO" && item.targetUuid ? `/api/fuel/convoy/field/records/${item.targetUuid}/correction` : "/api/fuel/convoy/field/records";
  return { url, init: { method: "POST", body: form } as RequestInit };
}

let running: Promise<number> | null = null;

// Envia os pendentes do usuário logado. Devolve quantos foram recebidos pelo servidor.
export function syncConvoyQueue(): Promise<number> {
  if (running) return running;
  running = (async () => {
    const all = await listConvoyQueue();
    // Limpeza: enviados há mais de SENT_KEEP_DAYS dias saem do celular.
    const limit = Date.now() - SENT_KEEP_DAYS * 86_400_000;
    for (const item of all.filter((entry) => entry.status === "ENVIADO" && entry.sentAt && Date.parse(entry.sentAt) < limit)) await run("queue", "readwrite", (store) => store.delete(item.clientUuid));
    const pending = all.filter((item) => item.status === "PENDENTE_ENVIO").reverse();
    if (!pending.length) return 0;
    if (!(await checkOnline())) return 0;
    const session = await fetch("/api/auth/session", { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).catch(() => null) as { user?: { id: number } } | null;
    const userId = session?.user?.id;
    if (!userId) return 0;
    let sent = 0;
    for (const item of pending.filter((entry) => entry.userId === userId)) {
      const { url, init } = requestFor(item);
      let response: Response;
      try { response = await fetch(url, init); }
      catch { break; } // caiu a conexão: tenta de novo depois
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { id?: number };
        await run("queue", "readwrite", (store) => store.put({ ...item, status: "ENVIADO", error: null, sentAt: new Date().toISOString(), serverId: body.id ?? null, meterPhoto: null, pumpPhoto: null }));
        sent++;
        continue;
      }
      if (response.status >= 500 || response.status === 401 || response.headers.get("X-Offline")) break;
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      await run("queue", "readwrite", (store) => store.put({ ...item, status: "ERRO", error: body.error ?? "O servidor recusou este registro." }));
    }
    return sent;
  })().finally(() => { running = null; notify(); });
  running.then((sent) => { if (sent > 0 && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CONVOY_SENT_EVENT, { detail: sent })); }).catch(() => undefined);
  return running;
}
