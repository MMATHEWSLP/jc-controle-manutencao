import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { cancelStockExit } from "../../../../lib/stock-exits";
import { stockErrorResponse } from "../../../../lib/stock";

type Context = { params: Promise<{ id: string }> };

// Estorno de uma saída: o estoque volta para a frente e a saída fica marcada como estornada.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "stock.exits_cancel");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Saída inválida." }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const number = await cancelStockExit(await getDb(), auth.user!, id, typeof body.reason === "string" ? body.reason.trim() : "");
    return Response.json({ message: `Saída ${number} estornada; o estoque voltou para a frente.` });
  } catch (error) {
    const stock = stockErrorResponse(error); if (stock) return stock;
    console.error("[stock-exits.cancel]", error);
    return Response.json({ error: "Não foi possível estornar a saída agora." }, { status: 500 });
  }
}
