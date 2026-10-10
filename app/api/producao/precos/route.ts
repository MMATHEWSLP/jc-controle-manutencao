import { listProductionProducts, ProductionError, scopedFrontIds, searchProductsToMark, setFrontPrice, setProductionUse } from "../../../../lib/production";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";

// Produtos marcados "Usar na Produção" com o preço do produto e o de cada frente em exibição.
// ?buscar=texto devolve produtos do estoque ainda não marcados (TAG ou nome).
export async function GET(request: Request) {
  return productionRoute(request, "precos.get", async ({ db, access, fronts, params }) => {
    if (!access.costs) throw new ProductionError("Os preços da Produção ficam com quem vê os custos da Produção.", 403);
    const search = params.get("buscar");
    if (search !== null) return Response.json({ candidates: await searchProductsToMark(db, search) }, noStore);
    const frontIds = scopedFrontIds(fronts, params.get("frentes"));
    return Response.json({ products: await listProductionProducts(db, frontIds), fronts: fronts.filter((front) => frontIds.includes(front.id)) }, noStore);
  });
}

// Marcar/desmarcar "Usar na Produção" ({ productId, productionUse }).
export async function POST(request: Request) {
  return productionRoute(request, "precos.marcar", async ({ db, user }) => {
    const body = await readBody(request);
    const value = body.productionUse !== false;
    await setProductionUse(db, user, Number(body.productId), value);
    return Response.json({ message: value ? "Produto marcado para a Produção." : "Produto retirado da Produção." });
  }, { write: true });
}

// Preço do produto numa frente ({ productId, serviceFrontId, price }); vazio volta ao preço do produto.
export async function PUT(request: Request) {
  return productionRoute(request, "precos.salvar", async ({ db, user, fronts }) => {
    await setFrontPrice(db, user, fronts, await readBody(request));
    return Response.json({ message: "Preço salvo." });
  }, { write: true });
}
