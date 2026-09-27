import { and, asc, count, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipmentModels, products, suppliers } from "../../../db/schema";
import { frentesEmExibicao, seesMultipleFronts } from "../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { nextSequentialTag, normalizeTag, parseReferenceList } from "../../../lib/product-rules";
import {
  activateInFront, assertModelsExist, assertReferencesAvailable, assertTagAvailable, loadProductExtras, parseModelIds,
  productAudit, productRuleResponse, replaceModels, replaceReferences, resolveCreationFront, scopeSummary, visibleFrontList,
} from "../../../lib/products-data";
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
    })
    .from(products)
    .leftJoin(suppliers, eq(products.supplierId, suppliers.id))
    .leftJoin(equipmentModels, eq(products.equipmentModelId, equipmentModels.id));
}

export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const sortParam = (url.searchParams.get("sortBy") ?? "tag") as SortKey;
    const sortBy = sortParam in SORTABLE ? sortParam : "tag";
    const sortDir = url.searchParams.get("sortDir") === "desc" ? desc : asc;
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize")) || 50));
    const displayed = frentesEmExibicao(user, request);
    const where = buildProductWhere(url, displayed);

    const db = await getDb();
    const [rows, [{ value: total }], brandRows, fronts] = await Promise.all([
      baseQuery(db).where(where).orderBy(sortDir(SORTABLE[sortBy]), asc(products.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ value: count() }).from(products).where(where),
      db.selectDistinct({ brand: products.brand }).from(products).where(and(eq(products.active, true), isNotNull(products.brand))),
      visibleFrontList(db, user),
    ]);
    const extras = await loadProductExtras(db, rows.map((row) => row.id), user);

    return Response.json({
      products: rows.map((row) => {
        const extra = extras.get(row.id)!;
        return {
          id: row.id,
          tag: row.tag,
          name: row.name,
          reference: row.reference,
          references: extra.references,
          price: row.price,
          brand: row.brand,
          needsReview: row.needsReview,
          supplierId: row.supplierId,
          supplierName: row.supplierName,
          equipmentModelId: row.equipmentModelId,
          equipmentModelIds: extra.equipmentModelIds,
          applicationName: extra.applicationNames.length ? extra.applicationNames.join(", ") : null,
          applicationNames: extra.applicationNames,
          photoIds: extra.photoIds,
          fronts: extra.fronts,
          ...scopeSummary(extra.fronts, displayed),
        };
      }),
      total,
      page,
      pageSize,
      availableBrands: brandRows.map((row) => row.brand).filter((brand): brand is string => Boolean(brand)).sort((a, b) => a.localeCompare(b, "pt-BR")),
      scope: {
        allFronts: displayed === "ALL",
        frontIds: displayed === "ALL" ? fronts.map((front) => front.id) : displayed,
        multiFront: seesMultipleFronts(user),
      },
      visibleFronts: fronts,
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
    const user = auth.user!;
    const body = (await request.json()) as Record<string, unknown>;
    const name = clean(body.name).toUpperCase();
    const references = parseReferenceList(body.references ?? body.reference);
    const price = parsePrice(String(body.price ?? "0")) ?? NaN;
    const brand = clean(body.brand) || null;
    const supplierId = body.supplierId ? Number(body.supplierId) : null;
    const modelIds = parseModelIds(body) ?? [];

    if (!name) return Response.json({ error: "Informe o nome do produto." }, { status: 400 });
    if (!Number.isFinite(price) || price < 0) return Response.json({ error: "Informe um preço válido (maior ou igual a zero)." }, { status: 400 });

    const db = await getDb();
    // TAG em branco = próxima da sequência.
    let tag = normalizeTag(clean(body.tag));
    if (!tag) tag = nextSequentialTag((await db.select({ tag: products.tag }).from(products)).map((row) => row.tag));
    await assertTagAvailable(db, tag);
    await assertReferencesAvailable(db, references);
    await assertModelsExist(db, modelIds);
    if (supplierId) {
      const supplier = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      if (!supplier[0]) return Response.json({ error: "Fornecedor selecionado não existe." }, { status: 400 });
    }
    const serviceFrontId = await resolveCreationFront(db, user, body.serviceFrontId, frentesEmExibicao(user, request));

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(products).values({ tag, name, price, brand, supplierId }).returning();
      await replaceReferences(tx, row.id, references);
      await replaceModels(tx, row.id, modelIds);
      // Nasce ativo só na frente de quem cadastrou, com estoque zerado. Nas outras frentes ele já
      // aparece (apagado) e pode ser ativado lá — sem duplicar o cadastro.
      await activateInFront(tx, row.id, serviceFrontId, user.id);
      await productAudit(tx, user.id, row.id, "PRODUTO CADASTRADO", undefined, { tag, name, references, modelIds, serviceFrontId });
      return row;
    });
    return Response.json({ product: created }, { status: 201 });
  } catch (error) {
    const rule = productRuleResponse(error); if (rule) return rule;
    if ((error as { code?: string })?.code === "23505") return Response.json({ error: "Já existe um produto com esta TAG." }, { status: 409 });
    console.error("[products.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o produto agora." }, { status: 500 });
  }
}

