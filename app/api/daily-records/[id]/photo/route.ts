import { authorize } from "../../../../../lib/auth";
import { canRegister, canViewAll, DailyRecordError, loadPhotoKey, readPhoto } from "../../../../../lib/daily-records";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const id = Number((await params).id);
    const kind = new URL(request.url).searchParams.get("kind") === "problem" ? "problem" : "production";
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Registro inválido." }, { status: 400 });
    const key = await loadPhotoKey(user, id, kind);
    const photo = key ? await readPhoto(key) : null;
    if (!photo) return Response.json({ error: "Foto não encontrada." }, { status: 404 });
    return new Response(new Uint8Array(photo.buffer), { headers: { "Content-Type": photo.contentType, "Cache-Control": "private, max-age=300" } });
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-records.photo]", error);
    return Response.json({ error: "Não foi possível carregar a foto agora." }, { status: 500 });
  }
}
