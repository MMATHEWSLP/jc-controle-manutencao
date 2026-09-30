import { getDb } from "../../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../../lib/auth";
import { componentErrorResponse, undoLastEvent } from "../../../../../../lib/components";

type Context = { params: Promise<{ id: string; eventId: string }> };

// Desfaz o último lançamento do item.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "maintenance.edit");
  if (auth.response) return auth.response;
  const values = await params;
  const id = Number(values.id), eventId = Number(values.eventId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(eventId) || eventId <= 0) return Response.json({ error: "Lançamento inválido." }, { status: 400 });
  try {
    await undoLastEvent(await getDb(), auth.user!, id, eventId);
    return Response.json({ message: "Lançamento desfeito." });
  } catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.events.delete]", error);
    return Response.json({ error: "Não foi possível desfazer agora." }, { status: 500 });
  }
}
