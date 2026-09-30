import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { checklistErrorResponse, listTemplates, readTemplateBody, saveTemplate } from "../../../../lib/checklists";

export async function GET(request: Request) {
  const auth = await authorize(request, "daily.manage");
  if (auth.response) return auth.response;
  try { return Response.json(await listTemplates()); }
  catch (error) { console.error("[checklists.templates.get]", error); return Response.json({ error: "Não foi possível carregar os modelos agora." }, { status: 500 }); }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.manage");
  if (auth.response) return auth.response;
  try {
    const id = await saveTemplate(auth.user!, null, readTemplateBody(await request.json() as Record<string, unknown>));
    return Response.json({ id, message: "Modelo de checklist criado." });
  } catch (error) {
    const known = checklistErrorResponse(error); if (known) return known;
    console.error("[checklists.templates.post]", error);
    return Response.json({ error: "Não foi possível salvar o modelo agora." }, { status: 500 });
  }
}
