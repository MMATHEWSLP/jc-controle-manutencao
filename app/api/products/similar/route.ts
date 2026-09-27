import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { productFrontStock, products, serviceFronts } from "../../../../db/schema";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { findSimilarNames } from "../../../../lib/product-rules";

// Aviso NÃO bloqueante do cadastro: produtos com nome muito parecido com o digitado, para a pessoa
// decidir se é o mesmo item (ativa/usa o existente) ou um produto realmente diferente.
export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") ?? "").trim();
    const excludeId = Number(url.searchParams.get("excludeId")) || 0;
    if (name.length < 3) return Response.json({ matches: [] });
    const db = await getDb();
    const catalog = await db.select({ id: products.id, tag: products.tag, name: products.name }).from(products).where(eq(products.active, true));
    const matches = findSimilarNames(name, catalog.filter((item) => item.id !== excludeId));
    const ids = matches.map((match) => match.item.id);
    const stocks = ids.length
      ? await db.select({ productId: productFrontStock.productId, serviceFrontId: productFrontStock.serviceFrontId, name: serviceFronts.name, active: productFrontStock.active })
        .from(productFrontStock).innerJoin(serviceFronts, eq(productFrontStock.serviceFrontId, serviceFronts.id))
        .where(inArray(productFrontStock.productId, ids))
      : [];
    const displayed = frentesEmExibicao(auth.user!, request);
    return Response.json({
      matches: matches.map(({ item, score }) => {
        const fronts = stocks.filter((stock) => stock.productId === item.id && stock.active);
        return {
          id: item.id, tag: item.tag, name: item.name, score: Math.round(score * 100),
          fronts: fronts.map((front) => ({ serviceFrontId: front.serviceFrontId, name: front.name })),
          activeHere: fronts.some((front) => displayed === "ALL" || displayed.includes(front.serviceFrontId)),
        };
      }),
    });
  } catch (error) {
    console.error("[products.similar]", error);
    return Response.json({ error: "Não foi possível verificar nomes parecidos agora." }, { status: 500 });
  }
}
