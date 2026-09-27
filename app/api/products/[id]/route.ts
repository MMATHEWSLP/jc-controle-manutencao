import { unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { productFrontStock, productPhotos, products, suppliers } from "../../../../db/schema";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { normalizeTag, parseReferenceList } from "../../../../lib/product-rules";
import {
  assertModelsExist, assertReferencesAvailable, assertTagAvailable, loadProductExtras, parseModelIds, productAudit,
  productRuleResponse, ProductRuleError, replaceModels, replaceReferences, scopeSummary, visibleFrontList,
} from "../../../../lib/products-data";
import { parsePrice } from "../../../../lib/products-import";
import type { SessionUser } from "../../../../lib/auth";

type Context = { params: Promise<{ id: string }> };
const PHOTO_DIR = path.join(process.cwd(), "uploads", "product-photos");

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function loadProduct(id: number, user: SessionUser, request: Request) {
  const db = await getDb();
  const rows = await db
    .select({
      id: products.id,
      tag: products.tag,
      name: products.name,
      reference: products.reference,
      price: products.price,
      brand: products.brand,
      needsReview: products.needsReview,
      supplierId: products.supplierId,
      supplierName: suppliers.name,
      equipmentModelId: products.equipmentModelId,
    })
    .from(products)
    .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
    .where(eq(products.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const extra = (await loadProductExtras(db, [id], user)).get(id)!;
  return {
    ...row,
    references: extra.references,
    equipmentModelIds: extra.equipmentModelIds,
    applicationName: extra.applicationNames.length ? extra.applicationNames.join(", ") : null,
    applicationNames: extra.applicationNames,
    photoIds: extra.photoIds,
    fronts: extra.fronts,
    ...scopeSummary(extra.fronts, frentesEmExibicao(user, request)),
  };
}

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Produto inválido." }, { status: 400 });
  const product = await loadProduct(id, auth.user!, request);
  if (!product) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
  return Response.json({ product });
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.edit");
  if (auth.response) return auth.response;
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const user = auth.user!;
    const db = await getDb();
    const existing = (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];
    if (!existing) return Response.json({ error: "Produto não encontrado." }, { status: 404 });

    const body = (await request.json()) as Record<string, unknown>;
    const tag = body.tag === undefined ? existing.tag : normalizeTag(clean(body.tag));
    if (!tag) return Response.json({ error: "Informe a TAG." }, { status: 400 });
    if (tag.toUpperCase() !== existing.tag.toUpperCase()) await assertTagAvailable(db, tag, id);
    const name = body.name === undefined ? existing.name : clean(body.name).toUpperCase();
    if (!name) return Response.json({ error: "Informe o nome do produto." }, { status: 400 });
    const price = body.price === undefined ? existing.price : parsePrice(String(body.price)) ?? NaN;
    if (!Number.isFinite(price) || price < 0) return Response.json({ error: "Informe um preço válido (maior ou igual a zero)." }, { status: 400 });

    const supplierId = body.supplierId === undefined ? existing.supplierId : body.supplierId ? Number(body.supplierId) : null;
    if (supplierId) {
      const supplier = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      if (!supplier[0]) return Response.json({ error: "Fornecedor selecionado não existe." }, { status: 400 });
    }
    const references = body.references === undefined && body.reference === undefined ? undefined : parseReferenceList(body.references ?? body.reference);
    if (references) await assertReferencesAvailable(db, references, id);
    const modelIds = parseModelIds(body);
    if (modelIds) await assertModelsExist(db, modelIds);

    // Estoque por frente: só frentes que a pessoa enxerga. Informar quantidade ativa o produto na
    // frente (se ainda não estiver ativo).
    const visibleIds = new Set((await visibleFrontList(db, user)).map((front) => front.id));
    const stocks = Array.isArray(body.stocks) ? body.stocks as Array<Record<string, unknown>> : [];
    const stockChanges: Array<{ serviceFrontId: number; quantity: number }> = [];
    for (const entry of stocks) {
      const serviceFrontId = Number(entry.serviceFrontId);
      const quantity = typeof entry.quantity === "number" ? entry.quantity : parsePrice(String(entry.quantity ?? "")) ?? NaN;
      if (!visibleIds.has(serviceFrontId)) throw new ProductRuleError("Você não tem acesso ao estoque de uma das frentes informadas.", 403);
      if (!Number.isFinite(quantity) || quantity < 0) throw new ProductRuleError("Informe quantidades em estoque válidas (zero ou mais).");
      stockChanges.push({ serviceFrontId, quantity });
    }

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(products).set({
        tag,
        name,
        price,
        brand: body.brand === undefined ? existing.brand : clean(body.brand) || null,
        supplierId,
        needsReview: body.needsReview === undefined ? existing.needsReview : Boolean(body.needsReview),
        active: body.active === undefined ? existing.active : Boolean(body.active),
        updatedAt: now,
      }).where(eq(products.id, id));
      if (references) await replaceReferences(tx, id, references);
      if (modelIds) await replaceModels(tx, id, modelIds);
      for (const change of stockChanges) {
        const current = (await tx.select().from(productFrontStock).where(and(eq(productFrontStock.productId, id), eq(productFrontStock.serviceFrontId, change.serviceFrontId))).limit(1))[0];
        if (current && current.quantity === change.quantity && current.active) continue;
        await tx.insert(productFrontStock).values({ productId: id, serviceFrontId: change.serviceFrontId, quantity: change.quantity, active: true, activatedAt: now, activatedBy: user.id, updatedAt: now })
          .onConflictDoUpdate({ target: [productFrontStock.productId, productFrontStock.serviceFrontId], set: { quantity: change.quantity, active: true, updatedAt: now } });
        await productAudit(tx, user.id, id, "ESTOQUE AJUSTADO", { serviceFrontId: change.serviceFrontId, quantity: current?.quantity ?? null }, { serviceFrontId: change.serviceFrontId, quantity: change.quantity });
      }
    });

    return Response.json({ product: await loadProduct(id, user, request) });
  } catch (error) {
    const rule = productRuleResponse(error); if (rule) return rule;
    if ((error as { code?: string })?.code === "23505") return Response.json({ error: "Já existe um produto com esta TAG." }, { status: 409 });
    console.error("[products.put]", error);
    return Response.json({ error: "Não foi possível atualizar o produto agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.delete");
  if (auth.response) return auth.response;
  const id = parseId((await params).id);
  if (!id) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const photos = await db.select({ storageKey: productPhotos.storageKey }).from(productPhotos).where(eq(productPhotos.productId, id));
    // Referências, aplicações, estoque por frente e fotos saem junto (ON DELETE CASCADE).
    const deleted = await db.delete(products).where(eq(products.id, id)).returning({ id: products.id });
    if (!deleted[0]) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
    await Promise.all(photos.map((photo) => unlink(path.join(PHOTO_DIR, photo.storageKey)).catch(() => undefined)));
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[products.delete]", error);
    return Response.json({ error: "Não foi possível excluir o produto agora." }, { status: 500 });
  }
}
