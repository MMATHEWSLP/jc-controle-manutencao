import { and, asc, count, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipmentModels, products, suppliers } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { buildProductWhere } from "../../../lib/products-filters";
import { parsePrice } from "../../../lib/products-import";

const SORTABLE = {
  tag: products.tag,
  name: products.name,
  reference: products.reference,
  price: products.price,
  supplier: suppliers.name,
  brand: products.brand,
  application: equipmentModels.name,
} as const;
type SortKey = keyof typeof SORTABLE;

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function baseQuery(db: Awaited<ReturnType<typeof getDb>>) {
  return db
    .select({
      id: products.id,
      tag: products.tag,
      name: products.name,
      reference: products.reference,
      price: products.price,
      brand: products.brand,
      needsReview: products.needsReview,
      active: products.active,
      supplierId: products.supplierId,
      supplierName: suppliers.name,
      equipmentModelId: products.equipmentModelId,
      applicationName: equipmentModels.name,
    })
    .from(products)
    .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
    .leftJoin(equipmentModels, eq(products.equipmentModelId, equipmentModels.id));
}

export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const sortParam = (url.searchParams.get("sortBy") ?? "tag") as SortKey;
    const sortBy = sortParam in SORTABLE ? sortParam : "tag";
    const sortDir = url.searchParams.get("sortDir") === "desc" ? desc : asc;
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize")) || 50));
    const where = buildProductWhere(url);

    const db = await getDb();
    const [rows, [{ value: total }], brandRows] = await Promise.all([
      baseQuery(db).where(where).orderBy(sortDir(SORTABLE[sortBy]), asc(products.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ value: count() }).from(products).where(where),
      db.selectDistinct({ brand: products.brand }).from(products).where(and(eq(products.active, true), isNotNull(products.brand))),
    ]);

    return Response.json({
      products: rows.map((row) => ({
        id: row.id,
        tag: row.tag,
        name: row.name,
        reference: row.reference,
        price: row.price,
        brand: row.brand,
        needsReview: row.needsReview,
        supplierId: row.supplierId,
        supplierName: row.supplierName,
        equipmentModelId: row.equipmentModelId,
        applicationName: row.applicationName,
      })),
      total,
      page,
      pageSize,
      availableBrands: brandRows.map((row) => row.brand).filter((brand): brand is string => Boolean(brand)).sort((a, b) => a.localeCompare(b, "pt-BR")),
    });
  } catch (error) {
    console.error("[products.get]", error);
    return Response.json({ error: "Não foi possível carregar os produtos agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.create");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const tag = clean(body.tag);
    const name = clean(body.name).toUpperCase();
    const reference = clean(body.reference).toUpperCase() || null;
    const price = parsePrice(String(body.price ?? "0")) ?? NaN;
    const brand = clean(body.brand) || null;
    const supplierId = body.supplierId ? Number(body.supplierId) : null;
    const equipmentModelId = body.equipmentModelId ? Number(body.equipmentModelId) : null;

    if (!tag) return Response.json({ error: "Informe a TAG." }, { status: 400 });
    if (!name) return Response.json({ error: "Informe o nome do produto." }, { status: 400 });
    if (!Number.isFinite(price) || price < 0) return Response.json({ error: "Informe um preço válido (maior ou igual a zero)." }, { status: 400 });

    const db = await getDb();
    const duplicate = await db.select({ id: products.id }).from(products).where(eq(products.tag, tag)).limit(1);
    if (duplicate[0]) return Response.json({ error: "Já existe um produto com esta TAG." }, { status: 409 });

    if (supplierId) {
      const supplier = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      if (!supplier[0]) return Response.json({ error: "Fornecedor selecionado não existe." }, { status: 400 });
    }
    if (equipmentModelId) {
      const model = await db.select({ id: equipmentModels.id }).from(equipmentModels).where(eq(equipmentModels.id, equipmentModelId)).limit(1);
      if (!model[0]) return Response.json({ error: "Modelo de equipamento selecionado não existe." }, { status: 400 });
    }

    const [created] = await db.insert(products).values({ tag, name, reference, price, brand, supplierId, equipmentModelId }).returning();
    return Response.json({ product: created }, { status: 201 });
  } catch (error) {
    console.error("[products.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o produto agora." }, { status: 500 });
  }
}
