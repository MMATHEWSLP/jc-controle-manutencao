import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { equipmentModels, products, suppliers } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { parsePrice } from "../../../../lib/products-import";

type Context = { params: Promise<{ id: string }> };

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

async function loadProduct(id: number) {
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
      applicationName: equipmentModels.name,
    })
    .from(products)
    .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
    .leftJoin(equipmentModels, eq(products.equipmentModelId, equipmentModels.id))
    .where(eq(products.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  const product = await loadProduct(id);
  if (!product) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
  return Response.json({ product });
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.edit");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const existing = (await db.select().from(products).where(eq(products.id, id)).limit(1))[0];
    if (!existing) return Response.json({ error: "Produto não encontrado." }, { status: 404 });

    const body = (await request.json()) as Record<string, unknown>;
    const tag = body.tag === undefined ? existing.tag : clean(body.tag);
    if (!tag) return Response.json({ error: "Informe a TAG." }, { status: 400 });
    if (tag !== existing.tag) {
      const duplicate = await db.select({ id: products.id }).from(products).where(eq(products.tag, tag)).limit(1);
      if (duplicate[0]) return Response.json({ error: "Já existe um produto com esta TAG." }, { status: 409 });
    }
    const name = body.name === undefined ? existing.name : clean(body.name).toUpperCase();
    if (!name) return Response.json({ error: "Informe o nome do produto." }, { status: 400 });
    const price = body.price === undefined ? existing.price : parsePrice(String(body.price)) ?? NaN;
    if (!Number.isFinite(price) || price < 0) return Response.json({ error: "Informe um preço válido (maior ou igual a zero)." }, { status: 400 });

    const supplierId = body.supplierId === undefined ? existing.supplierId : body.supplierId ? Number(body.supplierId) : null;
    if (supplierId) {
      const supplier = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      if (!supplier[0]) return Response.json({ error: "Fornecedor selecionado não existe." }, { status: 400 });
    }
    const equipmentModelId = body.equipmentModelId === undefined ? existing.equipmentModelId : body.equipmentModelId ? Number(body.equipmentModelId) : null;
    if (equipmentModelId) {
      const model = await db.select({ id: equipmentModels.id }).from(equipmentModels).where(eq(equipmentModels.id, equipmentModelId)).limit(1);
      if (!model[0]) return Response.json({ error: "Modelo de equipamento selecionado não existe." }, { status: 400 });
    }

    await db
      .update(products)
      .set({
        tag,
        name,
        reference: body.reference === undefined ? existing.reference : clean(body.reference).toUpperCase() || null,
        price,
        brand: body.brand === undefined ? existing.brand : clean(body.brand) || null,
        supplierId,
        equipmentModelId,
        needsReview: body.needsReview === undefined ? existing.needsReview : Boolean(body.needsReview),
        active: body.active === undefined ? existing.active : Boolean(body.active),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(products.id, id));

    return Response.json({ product: await loadProduct(id) });
  } catch (error) {
    console.error("[products.put]", error);
    return Response.json({ error: "Não foi possível atualizar o produto agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.delete");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const deleted = await db.delete(products).where(eq(products.id, id)).returning({ id: products.id });
    if (!deleted[0]) return Response.json({ error: "Produto não encontrado." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[products.delete]", error);
    return Response.json({ error: "Não foi possível excluir o produto agora." }, { status: 500 });
  }
}
