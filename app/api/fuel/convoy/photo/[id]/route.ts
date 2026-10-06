import { authorize } from "../../../../../../lib/auth";
import { convoyPhotoKey } from "../../../../../../lib/convoy";
import { openConvoyPhoto } from "../../../../../../lib/convoy-storage";

type Context = { params: Promise<{ id: string }> };

// Foto do abastecimento do comboio (?tipo=medidor|bomba). Só quem aprova ou vê o Combustível, nas
// frentes que enxerga. No Supabase Storage (bucket privado) devolve um link temporário assinado;
// na pasta local entrega o arquivo. Nunca fica em cache compartilhado.
export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  const kind = new URL(request.url).searchParams.get("tipo") === "bomba" ? "pump" : "meter";
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Foto inválida." }, { status: 400 });
  try {
    const key = await convoyPhotoKey(auth.user!, id, kind);
    if (!key) return Response.json({ error: "Foto não encontrada ou sem permissão." }, { status: 404 });
    const photo = await openConvoyPhoto(key);
    if (!photo) return Response.json({ error: "Foto não encontrada." }, { status: 404 });
    if ("redirect" in photo) return new Response(null, { status: 302, headers: { Location: photo.redirect, "Cache-Control": "private, no-store" } });
    return new Response(new Uint8Array(photo.buffer), { headers: { "Content-Type": photo.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    console.error("[convoy.photo]", error);
    return Response.json({ error: "Não foi possível abrir a foto agora." }, { status: 500 });
  }
}
