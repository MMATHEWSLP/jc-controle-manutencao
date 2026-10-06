import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectImage } from "./image-signature";

// ---------------------------------------------------------------------------
// Fotos dos abastecimentos do comboio (KM/horímetro e bomba/totalizador).
//  - Com SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY no servidor: Supabase Storage, bucket PRIVADO
//    (SUPABASE_CONVOY_BUCKET, padrão "comboio", criado na primeira foto). Quem tem permissão recebe
//    um link temporário (assinado, SIGNED_URL_SECONDS) — o arquivo nunca fica público.
//  - Sem essas variáveis: pasta privada uploads/convoy no servidor (fora de /public), entregue só
//    pela rota com permissão (/api/fuel/convoy/photo/[id]).
// A chave gravada no banco diz onde a foto está ("supabase:..." ou "local:..."), então trocar a
// configuração depois não perde as fotos antigas. A imagem é conferida pela assinatura binária.
// A chave de serviço do Supabase fica só no servidor (nunca vai para o navegador).
// ---------------------------------------------------------------------------
export const CONVOY_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
export const SIGNED_URL_SECONDS = 120;
const LOCAL_DIR = path.join(process.cwd(), "uploads", "convoy");
const LOCAL_KEY = /^local:(\d{4}-\d{2}\/[0-9a-f-]{36}-(meter|pump)\.(jpg|webp|png))$/;
const SUPABASE_KEY = /^supabase:(comboio\/\d{4}-\d{2}\/[0-9a-f-]{36}-(meter|pump)\.(jpg|webp|png))$/;

export class ConvoyPhotoError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const bucket = String(process.env.SUPABASE_CONVOY_BUCKET ?? "").trim() || "comboio";
  return url && key ? { url, key, bucket } : null;
}
export const convoyStorageMode = () => (supabaseConfig() ? "SUPABASE" : "LOCAL");

const headers = (key: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${key}`, apikey: key, ...extra });

async function ensureBucket(config: NonNullable<ReturnType<typeof supabaseConfig>>) {
  const response = await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST", headers: headers(config.key, { "Content-Type": "application/json" }),
    body: JSON.stringify({ id: config.bucket, name: config.bucket, public: false, file_size_limit: CONVOY_PHOTO_MAX_BYTES, allowed_mime_types: ["image/jpeg", "image/webp", "image/png"] }),
  });
  // 409/400 "already exists" também serve.
  if (!response.ok && response.status !== 409 && response.status !== 400) throw new ConvoyPhotoError("Não foi possível preparar o armazenamento das fotos.", 503);
}

// Grava a foto e devolve a chave (ex.: "supabase:comboio/2026-10/<uuid>-meter.jpg").
export async function storeConvoyPhoto(file: File, kind: "meter" | "pump"): Promise<string> {
  if (file.size === 0 || file.size > CONVOY_PHOTO_MAX_BYTES) throw new ConvoyPhotoError("Foto acima de 6 MB ou vazia: tire a foto de novo.");
  const buffer = Buffer.from(await file.arrayBuffer());
  const format = detectImage(buffer);
  if (!format) throw new ConvoyPhotoError("Arquivo não reconhecido como foto (JPEG, PNG ou WebP).");
  const relative = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${kind}.${format.extension}`;
  const config = supabaseConfig();
  if (!config) {
    await mkdir(path.join(LOCAL_DIR, relative.slice(0, 7)), { recursive: true });
    await writeFile(path.join(LOCAL_DIR, relative), buffer);
    return `local:${relative}`;
  }
  const objectPath = `comboio/${relative}`;
  const upload = () => fetch(`${config.url}/storage/v1/object/${config.bucket}/${objectPath}`, {
    method: "POST", headers: headers(config.key, { "Content-Type": format.contentType, "x-upsert": "false", "cache-control": "private, max-age=0" }), body: buffer,
  });
  let response = await upload();
  if (response.status === 404 || response.status === 400) { await ensureBucket(config); response = await upload(); }
  if (!response.ok) throw new ConvoyPhotoError("Não foi possível guardar a foto agora. O registro será reenviado.", 503);
  return `supabase:${objectPath}`;
}

// Link temporário (Supabase) ou o arquivo em si (pasta local), para a rota com permissão.
export async function openConvoyPhoto(key: string): Promise<{ redirect: string } | { buffer: Buffer; contentType: string } | null> {
  const local = LOCAL_KEY.exec(key);
  if (local) {
    const buffer = await readFile(path.join(LOCAL_DIR, local[1])).catch(() => null);
    return buffer ? { buffer, contentType: detectImage(buffer)?.contentType ?? "application/octet-stream" } : null;
  }
  const remote = SUPABASE_KEY.exec(key);
  const config = supabaseConfig();
  if (!remote || !config) return null;
  const response = await fetch(`${config.url}/storage/v1/object/sign/${config.bucket}/${remote[1]}`, {
    method: "POST", headers: headers(config.key, { "Content-Type": "application/json" }), body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
  });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => ({}))) as { signedURL?: string; signedUrl?: string };
  const signed = data.signedURL ?? data.signedUrl;
  return signed ? { redirect: `${config.url}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}` } : null;
}

// Bytes da foto (conferência automática pelo Assistente JC).
export async function readConvoyPhotoBytes(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const local = LOCAL_KEY.exec(key);
  if (local) return openConvoyPhoto(key) as Promise<{ buffer: Buffer; contentType: string } | null>;
  const remote = SUPABASE_KEY.exec(key);
  const config = supabaseConfig();
  if (!remote || !config) return null;
  const response = await fetch(`${config.url}/storage/v1/object/authenticated/${config.bucket}/${remote[1]}`, { headers: headers(config.key) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const format = detectImage(buffer);
  return format ? { buffer, contentType: format.contentType } : null;
}
