import { getDb } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { listActiveSuppliers, listBrands } from "../../../lib/catalog";
import { createPurchaseOrder, listPurchaseOrders, nextPurchaseNumber, parseNewPurchase, worksOnPurchases } from "../../../lib/purchases";
import { purchaseFronts } from "../../../lib/purchase-scope";
import { stockErrorResponse } from "../../../lib/stock";
import { equipmentOptions, requestFronts } from "../../../lib/stock-options";

export async function GET(request: Request) {
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const canRequest = user.permissions.includes("purchases.request");
    const [orders, fronts, suppliers, brands, nextNumber, equipment] = await Promise.all([
      listPurchaseOrders(db, user, purchaseFronts(user, request)),
      requestFronts(db, user),
      listActiveSuppliers(db),
      listBrands(db),
      nextPurchaseNumber(db),
      canRequest ? equipmentOptions(db, user) : Promise.resolve([]),
    ]);
    return Response.json({
      orders, requestFronts: fronts, suppliers, brands, nextNumber, equipment, worksOnPurchases: worksOnPurchases(user), canRequest,
      userName: user.name,
    });
  } catch (error) {
    console.error("[purchase-orders.get]", error);
    return Response.json({ error: "Não foi possível carregar as solicitações de pedido." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "purchases.request");
  if (auth.response) return auth.response;
  try {
    const input = parseNewPurchase(await request.json() as Record<string, unknown>, auth.user!);
    const created = await createPurchaseOrder(await getDb(), auth.user!, input);
    return Response.json({ ...created, message: `Pedido ${created.number} enviado para aprovação.` }, { status: 201 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.post]", error);
    return Response.json({ error: "Não foi possível registrar o pedido agora." }, { status: 500 });
  }
}
