import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getD1, getDb } from "../../../../../db";
import { equipment } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { equipmentAccessResponse, requireEquipmentAccess } from "../../../../../lib/front-scope";

// A foto é processada (orientação EXIF, corte/redimensionamento a ~1600px no
// lado maior, conversão para WebP) inteiramente no navegador antes do envio —
// o projeto não usa uma biblioteca nativa de imagem no servidor (evita o risco
// de um binário nativo incompatível com o ambiente de deploy do Hostinger).
// Reencodar via canvas já descarta todo o EXIF original (inclusive GPS) como
// efeito colateral do próprio recorte de pixels, então o servidor nunca lida
// com metadados sensíveis. Aqui só validamos a assinatura binária real do
// arquivo recebido (nunca o Content-Type informado pelo cliente) e gravamos
// com um nome seguro baseado no ID do equipamento — nunca no nome original.
type Context = { params: Promise<{ id: string }> };

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "equipment-photos");
const MAX_BYTES = 8 * 1024 * 1024;

const MAGIC_SIGNATURES: Array<{ contentType: string; extension: string; check: (buffer: Buffer) => boolean }> = [
  { contentType: "image/webp", extension: "webp", check: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { contentType: "image/jpeg", extension: "jpg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { contentType: "image/png", extension: "png", check: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
];

function detectImage(buffer: Buffer) {
  return MAGIC_SIGNATURES.find((format) => format.check(buffer)) ?? null;
}

async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

function parseEquipmentId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "equipment.view"); if (auth.response) return auth.response;
  try {
    const equipmentId = parseEquipmentId((await params).id);
    if (!equipmentId) return Response.json({ error: "Equipamento inválido." }, { status: 400 });
    const d1 = await getD1();
    await requireEquipmentAccess(d1, auth.user!, equipmentId, "OIL");
    const db = await getDb();
    const row = (await db.select({ photoKey: equipment.photoKey }).from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
    if (!row?.photoKey) return Response.json({ error: "Este equipamento ainda não tem foto cadastrada." }, { status: 404 });
    const buffer = await readFile(path.join(UPLOAD_DIR, row.photoKey)).catch(() => null);
    if (!buffer) return Response.json({ error: "Arquivo da foto não foi encontrado no servidor." }, { status: 404 });
    const format = detectImage(buffer);
    return new Response(buffer, { headers: { "Content-Type": format?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    const access = equipmentAccessResponse(error); if (access) return access;
    console.error("[equipment.photo.get]", error);
    return Response.json({ error: "Não foi possível carregar a foto agora." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "equipment.edit"); if (auth.response) return auth.response;
  try {
    const equipmentId = parseEquipmentId((await params).id);
    if (!equipmentId) return Response.json({ error: "Equipamento inválido." }, { status: 400 });
    const d1 = await getD1();
    const access = await requireEquipmentAccess(d1, auth.user!, equipmentId, "OIL");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Envie um arquivo de imagem." }, { status: 400 });
    if (file.size === 0 || file.size > MAX_BYTES) return Response.json({ error: "A imagem deve ter no máximo 8 MB após a otimização." }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const format = detectImage(buffer);
    if (!format) return Response.json({ error: "Arquivo não reconhecido como imagem válida. Envie uma foto em JPEG, PNG ou WebP." }, { status: 400 });

    const db = await getDb();
    const current = (await db.select({ photoKey: equipment.photoKey }).from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
    await ensureUploadDir();
    const storageKey = `${equipmentId}-${Date.now()}.${format.extension}`;
    await writeFile(path.join(UPLOAD_DIR, storageKey), buffer);
    const now = new Date().toISOString();
    await db.update(equipment).set({ photoKey: storageKey, updatedAt: now }).where(eq(equipment.id, equipmentId));
    await d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(auth.user!.id, "EQUIPMENT", String(equipmentId), "FOTO DO EQUIPAMENTO ATUALIZADA", JSON.stringify({ photoKey: current?.photoKey ?? null }), JSON.stringify({ photoKey: storageKey }), now).run();
    // Só remove o arquivo antigo depois que o novo já foi gravado em disco E
    // o banco já aponta para ele — uma falha no meio do caminho preserva a
    // foto anterior intacta.
    if (current?.photoKey && current.photoKey !== storageKey) await unlink(path.join(UPLOAD_DIR, current.photoKey)).catch(() => undefined);
    return Response.json({ photoKey: storageKey, prefix: access.prefix });
  } catch (error) {
    const access = equipmentAccessResponse(error); if (access) return access;
    console.error("[equipment.photo.post]", error);
    return Response.json({ error: "Não foi possível salvar a foto agora. Tente novamente." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "equipment.edit"); if (auth.response) return auth.response;
  try {
    const equipmentId = parseEquipmentId((await params).id);
    if (!equipmentId) return Response.json({ error: "Equipamento inválido." }, { status: 400 });
    const d1 = await getD1();
    await requireEquipmentAccess(d1, auth.user!, equipmentId, "OIL");
    const db = await getDb();
    const current = (await db.select({ photoKey: equipment.photoKey }).from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
    if (!current?.photoKey) return Response.json({ error: "Este equipamento não tem foto para remover." }, { status: 404 });
    const now = new Date().toISOString();
    await db.update(equipment).set({ photoKey: null, updatedAt: now }).where(eq(equipment.id, equipmentId));
    await d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(auth.user!.id, "EQUIPMENT", String(equipmentId), "FOTO DO EQUIPAMENTO REMOVIDA", JSON.stringify({ photoKey: current.photoKey }), JSON.stringify({ photoKey: null }), now).run();
    await unlink(path.join(UPLOAD_DIR, current.photoKey)).catch(() => undefined);
    return Response.json({ message: "Foto removida." });
  } catch (error) {
    const access = equipmentAccessResponse(error); if (access) return access;
    console.error("[equipment.photo.delete]", error);
    return Response.json({ error: "Não foi possível remover a foto agora." }, { status: 500 });
  }
}
