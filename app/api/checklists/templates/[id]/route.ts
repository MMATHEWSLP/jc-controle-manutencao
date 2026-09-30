import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { checklistErrorResponse, readTemplateBody, saveTemplate } from "../../../../../lib/checklists";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Modelo inválido." }, { status: 400 });
  try {
    await saveTemplate(auth.user!, id, readTemplateBody(await request.json() as Record<string, unknown>));
    return Response.json({ id, message: "Modelo de checklist atualizado." });
  } catch (error) {
    const known = checklistErrorResponse(error); if (known) return known;
    console.error("[checklists.templates.put]", error);
    return Response.json({ error: "Não foi possível salvar o modelo agora." }, { status: 500 });
  }
}
