import { getDb } from "../../../../db";
import { frentesVisiveis } from "../../../../lib/access";
import { authorize } from "../../../../lib/auth";
import { hasAny, searchStockProducts } from "../../../../lib/stock-options";

// Busca de produto para Movimentação, Ordem de Serviço e Compras, com o saldo na frente informada
// (?frente=) quando a pessoa enxerga essa frente.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!hasAny(user, ["products.view", "stock.exits_create", "work_orders.manage", "purchases.request", "purchases.buy"]))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const url = new URL(request.url);
    if ((url.searchParams.get("q") ?? "").trim().length < 2 && !(url.searchParams.get("tag") ?? "").trim()) return Response.json({ products: [] });
    const visible = frentesVisiveis(user);
    const requested = Number(url.searchParams.get("frente"));
    const frontId = Number.isInteger(requested) && requested > 0 && (visible === "ALL" || visible.includes(requested)) ? requested : null;
    return Response.json({ products: await searchStockProducts(await getDb(), url, frontId) });
  } catch (error) {
    console.error("[stock.products]", error);
    return Response.json({ error: "Não foi possível buscar os produtos agora." }, { status: 500 });
  }
}
