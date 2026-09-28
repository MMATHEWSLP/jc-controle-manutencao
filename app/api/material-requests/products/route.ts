import { asc, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { productReferences, products } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";
import { buildProductWhere } from "../../../../lib/products-filters";

// Busca de produtos cadastrados para os itens da Solicitação de Materiais (TAG, nome ou referência —
// mesma busca da tela Produtos). Liberada para quem pede ou envia materiais, mesmo sem acesso ao
// módulo Produtos: devolve só identificação, sem preço nem estoque.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!user.permissions.includes("materials.request") && !user.permissions.includes("materials.ship"))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const url = new URL(request.url);
    if ((url.searchParams.get("q") ?? "").trim().length < 2 && !(url.searchParams.get("tag") ?? "").trim()) return Response.json({ products: [] });
    const db = await getDb();
    const rows = await db.select({ id: products.id, tag: products.tag, name: products.name, reference: products.reference }).from(products)
      .where(buildProductWhere(url, "ALL")).orderBy(asc(products.name)).limit(20);
    const references = rows.length ? await db.select({ productId: productReferences.productId, reference: productReferences.reference }).from(productReferences).where(inArray(productReferences.productId, rows.map((row) => row.id))) : [];
    return Response.json({ products: rows.map((row) => ({ ...row, references: references.filter((item) => item.productId === row.id).map((item) => item.reference) })) });
  } catch (error) {
    console.error("[material-requests.products]", error);
    return Response.json({ error: "Não foi possível buscar os produtos agora." }, { status: 500 });
  }
}
