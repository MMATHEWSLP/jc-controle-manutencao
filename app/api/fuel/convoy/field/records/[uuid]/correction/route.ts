import { assertSameOrigin, authorize } from "../../../../../../../../lib/auth";
import { answerConvoyCorrection, ConvoyError } from "../../../../../../../../lib/convoy";
import { notifyConvoyPending } from "../../../../../../../../lib/convoy-notify";
import { runAfterResponse } from "../../../../../../../../lib/notifications";

type Context = { params: Promise<{ uuid: string }> };

// Motorista responde ao "Pedir correção" (litros, leitura, foto nova e observação): volta para Pendente.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.convoy_register");
  if (auth.response) return auth.response;
  try {
    const form = await request.formData();
    const payload = JSON.parse(String(form.get("payload") ?? "{}")) as Record<string, unknown>;
    const photo = form.get("meterPhoto");
    const result = await answerConvoyCorrection(auth.user!, (await params).uuid, payload, photo instanceof File && photo.size > 0 ? photo : null);
    if (!result.duplicate) runAfterResponse("convoy.corrected", () => notifyConvoyPending(result.id, true));
    return Response.json({ ...result, message: "Correção enviada — aguardando aprovação." });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.field.correction]", error);
    return Response.json({ error: "Não foi possível enviar a correção agora." }, { status: 500 });
  }
}
