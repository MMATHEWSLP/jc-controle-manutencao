import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { addEvent, componentErrorResponse, readEventBody } from "../../../../../lib/components";

type Context = { params: Promise<{ id: string }> };

// Lança montagem, rodízio, desmontagem, recapagem, conserto, inspeção ou descarte.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "maintenance.create");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Item inválido." }, { status: 400 });
  try {
    const result = await addEvent(await getDb(), auth.user!, id, readEventBody(await request.json() as Record<string, unknown>));
    return Response.json({ ...result, message: "Lançamento registrado." });
  } catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.events.post]", error);
    return Response.json({ error: "Não foi possível registrar agora." }, { status: 500 });
  }
}
