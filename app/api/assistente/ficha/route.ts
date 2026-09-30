import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { AssistantError, readFuelSheet, type FichaImage } from "../../../../lib/assistant";
import { canUseAssistant, FICHA_MAX_BYTES, FICHA_MAX_PHOTOS, FICHA_MEDIA_TYPES, type FichaMediaType } from "../../../../lib/assistant-config";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

export const maxDuration = 300;

// Leitor de fichas: recebe as fotos (multipart, campo "fotos"), devolve as linhas no formato do
// modelo de importação com as dúvidas por célula. Não grava nenhum lançamento.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canUseAssistant(user)) return Response.json({ error: "O Assistente JC não está liberado para o seu perfil." }, { status: 403 });
  try {
    let form: FormData;
    try { form = await request.formData(); } catch { return Response.json({ error: "Envie as fotos da ficha." }, { status: 400 }); }
    const files = form.getAll("fotos").filter((item): item is File => typeof item === "object" && item !== null && "arrayBuffer" in item);
    if (files.length === 0) return Response.json({ error: "Escolha pelo menos uma foto da ficha." }, { status: 400 });
    if (files.length > FICHA_MAX_PHOTOS) return Response.json({ error: `Envie no máximo ${FICHA_MAX_PHOTOS} fotos por vez.` }, { status: 400 });
    const images: FichaImage[] = [];
    for (const file of files) {
      const mediaType = (file.type || "").toLowerCase() as FichaMediaType;
      if (!FICHA_MEDIA_TYPES.includes(mediaType)) return Response.json({ error: `"${file.name}" não é uma foto (use JPG, PNG ou WEBP).` }, { status: 400 });
      if (file.size > FICHA_MAX_BYTES) return Response.json({ error: `"${file.name}" é grande demais (máx. ${Math.round(FICHA_MAX_BYTES / 1_000_000)} MB).` }, { status: 400 });
      const bytes = Buffer.from(await file.arrayBuffer());
      images.push({ name: String(file.name || "foto").slice(0, 80), mediaType, data: bytes.toString("base64"), bytes: bytes.length });
    }
    const note = String(form.get("nota") ?? "").trim().slice(0, 300);
    const result = await readFuelSheet({ db: await getDb(), user, displayed: frentesEmExibicao(user, request) }, images, note);
    return Response.json(result);
  } catch (error) {
    if (error instanceof AssistantError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[assistente.ficha]", error);
    return Response.json({ error: "Não foi possível ler a ficha agora. Tente de novo em instantes." }, { status: 500 });
  }
}
