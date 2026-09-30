import { authorize } from "../../../../../lib/auth";
import { checklistErrorResponse, checklistPhoto } from "../../../../../lib/checklists";

type Context = { params: Promise<{ answerId: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const id = Number((await params).answerId);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Foto inválida." }, { status: 400 });
  try {
    const photo = await checklistPhoto(auth.user!, id);
    if (!photo) return Response.json({ error: "Foto não encontrada." }, { status: 404 });
    return new Response(new Uint8Array(photo.buffer), { headers: { "Content-Type": photo.contentType, "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    const known = checklistErrorResponse(error); if (known) return known;
    console.error("[checklists.photo]", error);
    return Response.json({ error: "Não foi possível carregar a foto agora." }, { status: 500 });
  }
}
