import { ProductionError } from "../../../../lib/production";
import { productionProductOptions } from "../../../../lib/production-felling";
import { noStore, productionRoute } from "../../../../lib/production-api";

// Produtos marcados para a Produção com o preço efetivo e o saldo na frente (?frente=ID).
export async function GET(request: Request) {
  return productionRoute(request, "produtos", async ({ db, access, fronts, params }) => {
    if (!access.costs) throw new ProductionError("Os produtos com preço ficam com quem vê os custos da Produção.", 403);
    const frontId = Number(params.get("frente"));
    if (!fronts.some((front) => front.id === frontId)) throw new ProductionError("Escolha o projeto.", 400);
    return Response.json({ products: await productionProductOptions(db, frontId) }, noStore);
  });
}
