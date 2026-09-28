import { getDb } from "../../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../../lib/auth";
import { stockErrorResponse } from "../../../../../../lib/stock";
import { removeWorkOrderItem } from "../../../../../../lib/work-orders";

type Context = { params: Promise<{ id: string; itemId: string }> };

// Retira uma peça lançada por engano: o estoque volta e a linha fica marcada como retirada.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "work_orders.manage");
  if (auth.response) return auth.response;
  const { id: rawId, itemId: rawItem } = await params;
  const id = Number(rawId); const itemId = Number(rawItem);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(itemId) || itemId <= 0) return Response.json({ error: "Peça inválida." }, { status: 400 });
  try {
    await removeWorkOrderItem(await getDb(), auth.user!, id, itemId);
    return Response.json({ message: "Peça retirada da O.S.; o estoque voltou." });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[work-orders.items.delete]", error);
    return Response.json({ error: "Não foi possível retirar a peça agora." }, { status: 500 });
  }
}
