import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { FrontRequestError, reviewFrontRequest } from "../../../../../lib/front-requests";

type Context = { params: Promise<{ id: string }> };

// body: { action: "APPROVE" | "REJECT", note } — recusar exige justificativa.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.front_requests"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    const body = await request.json() as Record<string, unknown>;
    const action = body.action === "APPROVE" ? "APPROVE" : body.action === "REJECT" ? "REJECT" : null;
    if (!Number.isInteger(id) || id <= 0 || !action) return Response.json({ error: "Solicitação inválida." }, { status: 400 });
    const message = await reviewFrontRequest(auth.user!, id, action, typeof body.note === "string" ? body.note : "");
    return Response.json({ ok: true, message });
  } catch (error) {
    if (error instanceof FrontRequestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[front-requests.review]", error);
    return Response.json({ error: "Não foi possível concluir a análise." }, { status: 500 });
  }
}
