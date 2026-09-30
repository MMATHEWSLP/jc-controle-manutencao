import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { componentDetail, componentErrorResponse, deleteComponent, readComponentBody, saveComponent } from "../../../../lib/components";

type Context = { params: Promise<{ id: string }> };
const readId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

// Linha do tempo (eventos) de um pneu/bateria.
export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "equipment.view");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Item inválido." }, { status: 400 });
  try { return Response.json(await componentDetail(await getDb(), auth.user!, id)); }
  catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.detail]", error);
    return Response.json({ error: "Não foi possível carregar o histórico agora." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "maintenance.edit");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Item inválido." }, { status: 400 });
  try {
    await saveComponent(await getDb(), auth.user!, readComponentBody(await request.json() as Record<string, unknown>), id);
    return Response.json({ id, message: "Cadastro atualizado." });
  } catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.put]", error);
    return Response.json({ error: "Não foi possível salvar agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "maintenance.edit");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Item inválido." }, { status: 400 });
  try {
    await deleteComponent(await getDb(), auth.user!, id);
    return Response.json({ message: "Item excluído." });
  } catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.delete]", error);
    return Response.json({ error: "Não foi possível excluir agora." }, { status: 500 });
  }
}
