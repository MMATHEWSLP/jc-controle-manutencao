import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { stockErrorResponse } from "../../../../lib/stock";
import { setWorkOrderStatus, updateWorkOrder, workOrderDetail } from "../../../../lib/work-orders";

type Context = { params: Promise<{ id: string }> };
const readId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "work_orders.view");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "O.S. inválida." }, { status: 400 });
  try {
    return Response.json({ order: await workOrderDetail(await getDb(), auth.user!, id) });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[work-orders.detail]", error);
    return Response.json({ error: "Não foi possível carregar a O.S." }, { status: 500 });
  }
}

// action: UPDATE (descrição, KM/horímetro, mecânicos) · CLOSE (fechar; também pelo botão rápido da
// listagem) · REOPEN.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  const id = await readId(params);
  if (!id) return Response.json({ error: "O.S. inválida." }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const db = await getDb();
    if (body.action === "CLOSE" || body.action === "REOPEN") {
      if (!user.permissions.includes("work_orders.close")) return Response.json({ error: "Você não possui permissão para fechar ou reabrir O.S." }, { status: 403 });
      const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
      const number = await setWorkOrderStatus(db, user, id, body.action === "CLOSE" ? "CLOSED" : "OPEN", notes);
      return Response.json({ message: body.action === "CLOSE" ? `O.S. ${number} fechada.` : `O.S. ${number} reaberta.` });
    }
    if (!user.permissions.includes("work_orders.manage")) return Response.json({ error: "Você não possui permissão para editar O.S." }, { status: 403 });
    await updateWorkOrder(db, user, id, body);
    return Response.json({ message: "O.S. atualizada." });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[work-orders.put]", error);
    return Response.json({ error: "Não foi possível atualizar a O.S." }, { status: 500 });
  }
}
