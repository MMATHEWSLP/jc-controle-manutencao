import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { applyPurchaseAction, purchaseOrderDetail } from "../../../../lib/purchases";
import { purchaseFronts } from "../../../../lib/purchase-scope";
import { stockErrorResponse } from "../../../../lib/stock";

type Context = { params: Promise<{ id: string }> };
const readId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 });
  try {
    return Response.json({ order: await purchaseOrderDetail(await getDb(), auth.user!, purchaseFronts(auth.user!, request), id) });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.detail]", error);
    return Response.json({ error: "Não foi possível carregar o pedido." }, { status: 500 });
  }
}

// Etapas do fluxo: APPROVE/REJECT, SAVE_QUOTE/SEND_TO_PAYMENT, CONFIRM_PAYMENT, DISPATCH,
// RECEIVE_ITEM e CANCEL. A permissão de cada etapa é conferida em lib/purchases.ts.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Pedido inválido." }, { status: 400 });
  try {
    const message = await applyPurchaseAction(await getDb(), auth.user!, purchaseFronts(auth.user!, request), id, await request.json() as Record<string, unknown>);
    return Response.json({ message });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.put]", error);
    return Response.json({ error: "Não foi possível atualizar o pedido agora." }, { status: 500 });
  }
}
