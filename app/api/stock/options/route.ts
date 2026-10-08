import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { hasAny, stockOptions } from "../../../../lib/stock-options";

// Frentes e equipamentos para os formulários de Movimentação e Ordem de Serviço.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  // reports.pecas: filtro por equipamento em RELATÓRIOS → Saídas de produtos.
  if (!hasAny(auth.user!, ["stock.exits_view", "stock.exits_create", "work_orders.view", "work_orders.manage", "reports.pecas"]))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    return Response.json(await stockOptions(await getDb(), auth.user!));
  } catch (error) {
    console.error("[stock.options]", error);
    return Response.json({ error: "Não foi possível carregar as opções agora." }, { status: 500 });
  }
}
