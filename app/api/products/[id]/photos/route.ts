import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { count, eq, max } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { productPhotos, products } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { detectImage } from "../../../../../lib/image-signature";
import { productAudit } from "../../../../../lib/products-data";

type Context = { params: Promise<{ id: string }> };

// Mesmo desenho da foto do equipamento: a imagem chega já otimizada (WebP, ~1600px) pelo navegador,
// aqui só validamos a assinatura binária e gravamos com nome seguro (nunca o nome original).
const PRODUCT_PHOTO_DIR = path.join(process.cwd(), "uploads", "product-photos");
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PHOTOS = 12;

export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!user.permissions.includes("products.create") && !user.permissions.includes("products.edit"))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  const productId = Number((await params).id);
  if (!Number.isInteger(productId) || productId <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const product = (await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1))[0];
    if (!product) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
    const form = await request.formData();
    const files = form.getAll("files").filter((file): file is File => file instanceof File);
    if (files.length === 0) return Response.json({ error: "Envie ao menos uma imagem." }, { status: 400 });
    const [{ total }] = await db.select({ total: count() }).from(productPhotos).where(eq(productPhotos.productId, productId));
    if (total + files.length > MAX_PHOTOS) return Response.json({ error: `Cada produto aceita no máximo ${MAX_PHOTOS} fotos.` }, { status: 400 });

    const buffers: Array<{ buffer: Buffer; extension: string }> = [];
    for (const file of files) {
      if (file.size === 0 || file.size > MAX_BYTES) return Response.json({ error: "Cada imagem deve ter no máximo 8 MB após a otimização." }, { status: 400 });
      const buffer = Buffer.from(await file.arrayBuffer());
      const format = detectImage(buffer);
      if (!format) return Response.json({ error: "Arquivo não reconhecido como imagem válida. Envie fotos em JPEG, PNG ou WebP." }, { status: 400 });
      buffers.push({ buffer, extension: format.extension });
    }
    await mkdir(PRODUCT_PHOTO_DIR, { recursive: true });
    const [{ last }] = await db.select({ last: max(productPhotos.position) }).from(productPhotos).where(eq(productPhotos.productId, productId));
    let position = (last ?? -1) + 1;
    const created: number[] = [];
    for (const [index, item] of buffers.entries()) {
      const storageKey = `${productId}-${Date.now()}-${index}-${crypto.randomUUID().slice(0, 8)}.${item.extension}`;
      await writeFile(path.join(PRODUCT_PHOTO_DIR, storageKey), item.buffer);
      const [row] = await db.insert(productPhotos).values({ productId, storageKey, position: position++, uploadedBy: user.id }).returning({ id: productPhotos.id });
      created.push(row.id);
    }
    await productAudit(db, user.id, productId, "FOTOS DO PRODUTO ADICIONADAS", undefined, { photoIds: created });
    return Response.json({ photoIds: created }, { status: 201 });
  } catch (error) {
    console.error("[products.photos.post]", error);
    return Response.json({ error: "Não foi possível salvar as fotos agora. Tente novamente." }, { status: 500 });
  }
}
