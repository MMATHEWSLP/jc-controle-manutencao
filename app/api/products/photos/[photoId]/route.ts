import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { productPhotos } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { detectImage } from "../../../../../lib/image-signature";
import { productAudit } from "../../../../../lib/products-data";

type Context = { params: Promise<{ photoId: string }> };
const PRODUCT_PHOTO_DIR = path.join(process.cwd(), "uploads", "product-photos");

async function findPhoto(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  const db = await getDb();
  return (await db.select().from(productPhotos).where(eq(productPhotos.id, id)).limit(1))[0] ?? null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const photo = await findPhoto((await params).photoId);
  if (!photo) return Response.json({ error: "Foto não encontrada." }, { status: 404 });
  const buffer = await readFile(path.join(PRODUCT_PHOTO_DIR, photo.storageKey)).catch(() => null);
  if (!buffer) return Response.json({ error: "Arquivo da foto não foi encontrado no servidor." }, { status: 404 });
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": detectImage(buffer)?.contentType ?? "application/octet-stream", "Cache-Control": "private, max-age=3600" } });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.edit");
  if (auth.response) return auth.response;
  try {
    const photo = await findPhoto((await params).photoId);
    if (!photo) return Response.json({ error: "Foto não encontrada." }, { status: 404 });
    const db = await getDb();
    await db.delete(productPhotos).where(eq(productPhotos.id, photo.id));
    await productAudit(db, auth.user!.id, photo.productId, "FOTO DO PRODUTO REMOVIDA", { photoId: photo.id }, undefined);
    await unlink(path.join(PRODUCT_PHOTO_DIR, photo.storageKey)).catch(() => undefined);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[products.photos.delete]", error);
    return Response.json({ error: "Não foi possível remover a foto agora." }, { status: 500 });
  }
}
