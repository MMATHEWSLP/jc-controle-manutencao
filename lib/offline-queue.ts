// Fila do Controle Diário no próprio celular (IndexedDB), para registrar sem internet.
// O registro fica guardado com as fotos e é enviado sozinho quando a conexão volta
// (ao reconectar, ao voltar para o app e a cada 30 s enquanto houver pendência).
//
// Cada item guarda o id do usuário que preencheu: só é enviado quando ESSE usuário está
// logado, para um registro nunca ser gravado em nome de outro funcionário que use o mesmo celular.
import { checkOnline } from "./connectivity";

// Fotos são guardadas como bytes (ArrayBuffer) e não como Blob: alguns iPhones recusam
// gravar Blob no IndexedDB. Itens antigos (com Blob) continuam sendo aceitos no envio.
export type StoredPhoto = { data: ArrayBuffer; type: string } | Blob;

export type QueuedDailyRecord = {
  id: string;
  userId: number;
  createdAt: string;
  payload: string;
  problemPhoto: StoredPhoto | null;
  productionPhoto: StoredPhoto | null;
  summary: { prefix: string; recordDate: string; equipmentId: number | null; endReading: number | null };
  status: "PENDING" | "ERROR";
  error: string | null;
};

export const QUEUE_EVENT = "jc-offline-queue-changed";
// Disparado com detail = quantidade enviada, para o app avisar "N registro(s) enviado(s)".
export const QUEUE_SENT_EVENT = "jc-offline-queue-sent";
const DB_NAME = "jc-sistema-offline";
const STORE = "daily-records";
// Fila genérica (checklist, abastecimento, leituras): guarda a requisição pronta para reenviar.
const REQUESTS = "requests";

export type QueuedRequestKind = "CHECKLIST" | "FUEL" | "METER";
export type QueuedRequest = {
  id: string;
  userId: number;
  createdAt: string;
  kind: QueuedRequestKind;
  url: string;
  method: "POST";
  body: string;
  // Com formField o envio é multipart (body vai nesse campo, junto com as fotos); sem ele, JSON.
  formField: string | null;
  photos: Array<{ field: string; data: StoredPhoto }>;
  summary: string;
  status: "PENDING" | "ERROR";
  error: string | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(REQUESTS)) request.result.createObjectStore(REQUESTS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, storeName = STORE): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_EVENT)); };

async function toStored(blob: Blob | null): Promise<StoredPhoto | null> {
  return blob ? { data: await blob.arrayBuffer(), type: blob.type || "image/webp" } : null;
}
function toBlob(photo: StoredPhoto | null): Blob | null {
  if (!photo) return null;
  return photo instanceof Blob ? photo : new Blob([photo.data], { type: photo.type });
}

export async function listQueued(userId?: number): Promise<QueuedDailyRecord[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await withStore<QueuedDailyRecord[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedDailyRecord[]>).catch(() => []);
  return all.filter((item) => userId === undefined || item.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function enqueue(item: Omit<QueuedDailyRecord, "id" | "createdAt" | "status" | "error" | "problemPhoto" | "productionPhoto"> & { problemPhoto: Blob | null; productionPhoto: Blob | null }) {
  const record: QueuedDailyRecord = {
    ...item, problemPhoto: await toStored(item.problemPhoto), productionPhoto: await toStored(item.productionPhoto),
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "PENDING", error: null,
  };
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

export async function listQueuedRequests(userId?: number, kind?: QueuedRequestKind): Promise<QueuedRequest[]> {
  if (typeof indexedDB === "undefined") return [];
  const all = await withStore<QueuedRequest[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedRequest[]>, REQUESTS).catch(() => []);
  return all.filter((item) => (userId === undefined || item.userId === userId) && (!kind || item.kind === kind)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Guarda uma requisição para enviar depois. O body deve levar um clientRequestId: se o
// servidor já tiver recebido o envio (ex.: a resposta se perdeu), ele não duplica.
export async function enqueueRequest(item: { userId: number; kind: QueuedRequestKind; url: string; method?: "POST"; body: string; formField?: string | null; photos?: Array<{ field: string; blob: Blob }>; summary: string }) {
  const photos = [];
  for (const photo of item.photos ?? []) photos.push({ field: photo.field, data: (await toStored(photo.blob))! });
  const record: QueuedRequest = {
    id: crypto.randomUUID(), userId: item.userId, createdAt: new Date().toISOString(), kind: item.kind, url: item.url, method: item.method ?? "POST",
    body: item.body, formField: item.formField ?? null, photos, summary: item.summary, status: "PENDING", error: null,
  };
  await withStore("readwrite", (store) => store.put(record), REQUESTS);
  notify();
  return record;
}

export async function removeQueuedRequest(id: string) {
  await withStore("readwrite", (store) => store.delete(id), REQUESTS);
  notify();
}

// Todos os pendentes (Controle Diário + fila genérica), para o aviso do topo.
export async function countPending(userId?: number) {
  const [daily, requests] = await Promise.all([listQueued(userId), listQueuedRequests(userId)]);
  return daily.filter((item) => item.status === "PENDING").length + requests.filter((item) => item.status === "PENDING").length;
}

function requestInit(item: QueuedRequest): RequestInit {
  if (!item.formField) return { method: item.method, headers: { "Content-Type": "application/json" }, body: item.body };
  const form = new FormData();
  form.set(item.formField, item.body);
  for (const photo of item.photos) { const blob = toBlob(photo.data); if (blob) form.set(photo.field, blob, `${photo.field}.webp`); }
  return { method: item.method, body: form };
}

let running: Promise<number> | null = null;

// Envia os pendentes do usuário logado. Devolve quantos foram enviados.
export function syncQueue(): Promise<number> {
  if (running) return running;
  // A trava é liberada no .finally() da promessa (e não num try/finally interno): quando a função
  // retorna antes do primeiro await, um finally interno rodaria ANTES desta atribuição e a
  // trava ficaria presa para sempre, bloqueando todos os envios seguintes.
  running = (async () => {
    let sent = 0;
    const pendingAll = (await listQueued()).filter((item) => item.status === "PENDING");
    const pendingRequests = (await listQueuedRequests()).filter((item) => item.status === "PENDING");
    if (!pendingAll.length && !pendingRequests.length) return 0;
    if (!(await checkOnline())) return 0;
    const session = await fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as { user?: { id: number } } | null;
    const userId = session?.user?.id;
    if (!userId) return 0;
    for (const item of pendingAll.filter((entry) => entry.userId === userId)) {
      const form = new FormData();
      form.set("payload", item.payload);
      const problem = toBlob(item.problemPhoto), production = toBlob(item.productionPhoto);
      if (problem) form.set("problemPhoto", problem, "problema.webp");
      if (production) form.set("productionPhoto", production, "producao.webp");
      let response: Response;
      try { response = await fetch("/api/daily-records", { method: "POST", body: form }); }
      catch { break; } // caiu a conexão no meio: tenta de novo depois
      if (response.ok) { await withStore("readwrite", (store) => store.delete(item.id)); sent++; continue; }
      if (response.status >= 500 || response.status === 401 || response.headers.get("X-Offline")) break;
      // Recusado (ex.: 409 = já existe registro deste equipamento nesta data). Nunca some em
      // silêncio: fica na lista com o motivo, e o operador confere e descarta.
      const body = await response.json().catch(() => ({})) as { error?: string };
      await markError(item, response.status === 409
        ? `${body.error ?? "Já existe um registro deste equipamento nesta data."} Confira em "Meus registros" e descarte este se estiver repetido.`
        : body.error ?? "O servidor recusou este registro.");
    }
    for (const item of pendingRequests.filter((entry) => entry.userId === userId)) {
      let response: Response;
      try { response = await fetch(item.url, requestInit(item)); }
      catch { break; }
      if (response.ok) { await withStore("readwrite", (store) => store.delete(item.id), REQUESTS); sent++; continue; }
      if (response.status >= 500 || response.status === 401 || response.headers.get("X-Offline")) break;
      const body = await response.json().catch(() => ({})) as { error?: string };
      await withStore("readwrite", (store) => store.put({ ...item, status: "ERROR", error: body.error ?? "O servidor recusou este envio." }), REQUESTS);
    }
    return sent;
  })().finally(() => {
    running = null;
    notify();
  });
  running.then((sent) => { if (sent > 0 && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(QUEUE_SENT_EVENT, { detail: sent })); }).catch(() => undefined);
  return running;
}

// Apaga dados de telas guardados no celular (usado ao sair/entrar com outro usuário).
// A fila do Controle Diário NÃO é apagada: registros pendentes nunca se perdem.
export function clearCachedUserData() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({ type: "CLEAR_USER_DATA" });
}
