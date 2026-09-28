import { getDb } from "../../../db";
import { frentesVisiveis } from "../../../lib/access";
import { frentesEmExibicao } from "../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { stockErrorResponse } from "../../../lib/stock";
import { isIsoDay } from "../../../lib/stock-options";
import { listWorkOrders, mechanicNames, openWorkOrder, parseOpenWorkOrder } from "../../../lib/work-orders";

// Listagem das O.S. (frentes em exibição ∩ frentes da pessoa) e abertura de O.S. nova.
export async function GET(request: Request) {
  const auth = await authorize(request, "work_orders.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const equipmentId = Number(url.searchParams.get("equipamento"));
    const from = url.searchParams.get("de"); const to = url.searchParams.get("ate");
    const displayed = frentesEmExibicao(user, request);
    const db = await getDb();
    const [orders, mechanics] = await Promise.all([
      listWorkOrders(db, displayed === "ALL" ? frentesVisiveis(user) : displayed, {
        status: status === "OPEN" || status === "CLOSED" ? status : null, equipmentId: Number.isInteger(equipmentId) && equipmentId > 0 ? equipmentId : null,
        from: isIsoDay(from) ? from : null, to: isIsoDay(to) ? to : null,
      }),
      mechanicNames(db),
    ]);
    return Response.json({
      orders, mechanics, canManage: user.permissions.includes("work_orders.manage"), canClose: user.permissions.includes("work_orders.close"),
    });
  } catch (error) {
    console.error("[work-orders.get]", error);
    return Response.json({ error: "Não foi possível carregar as ordens de serviço." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "work_orders.manage");
  if (auth.response) return auth.response;
  try {
    const input = parseOpenWorkOrder(await request.json() as Record<string, unknown>);
    const created = await openWorkOrder(await getDb(), auth.user!, input);
    return Response.json({ ...created, message: `O.S. ${created.number} aberta.` }, { status: 201 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[work-orders.post]", error);
    return Response.json({ error: "Não foi possível abrir a O.S. agora." }, { status: 500 });
  }
}
