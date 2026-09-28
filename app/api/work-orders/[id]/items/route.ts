import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { stockErrorResponse } from "../../../../../lib/stock";
import { addWorkOrderItem, parseWorkOrderItem } from "../../../../../lib/work-orders";

type Context = { params: Promise<{ id: string }> };

// Lança uma peça na O.S.: sai do estoque da frente da O.S. na hora (lib/stock.ts).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "work_orders.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "O.S. inválida." }, { status: 400 });
  try {
    const input = parseWorkOrderItem(await request.json() as Record<string, unknown>);
    await addWorkOrderItem(await getDb(), auth.user!, id, input);
    return Response.json({ message: "Peça lançada e baixada do estoque." }, { status: 201 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[work-orders.items.post]", error);
    return Response.json({ error: "Não foi possível lançar a peça agora." }, { status: 500 });
  }
}
