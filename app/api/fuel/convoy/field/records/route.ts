import { after } from "next/server";
import { assertSameOrigin, authorize } from "../../../../../../lib/auth";
import { ConvoyError, myConvoyRecords, receiveConvoyRecord } from "../../../../../../lib/convoy";
import { checkConvoyPhoto } from "../../../../../../lib/convoy-ai";
import { notifyConvoyPending } from "../../../../../../lib/convoy-notify";
import { runAfterResponse } from "../../../../../../lib/notifications";

// "Meus abastecimentos" do motorista do comboio (status, motivo da rejeição, pedido de correção).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_register");
  if (auth.response) return auth.response;
  try {
    return Response.json({ records: await myConvoyRecords(auth.user!) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.field.records.get]", error);
    return Response.json({ error: "Não foi possível carregar os seus abastecimentos." }, { status: 500 });
  }
}

// Envio da fila do celular (multipart: payload JSON + meterPhoto + pumpPhoto). O clientUuid gerado
// no celular faz o reenvio nunca duplicar: o mesmo registro devolve 200 com duplicate=true.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.convoy_register");
  if (auth.response) return auth.response;
  try {
    const form = await request.formData();
    const payload = JSON.parse(String(form.get("payload") ?? "{}")) as Record<string, unknown>;
    const file = (name: string) => { const value = form.get(name); return value instanceof File && value.size > 0 ? value : null; };
    const result = await receiveConvoyRecord(auth.user!, payload, { meter: file("meterPhoto"), pump: file("pumpPhoto") });
    // Conferência automática da foto (se ligada): depois da resposta, sem atrasar o celular.
    if (!result.duplicate) after(() => checkConvoyPhoto(result.id).then(() => undefined).catch((error) => console.error("[convoy.ai.after]", error)));
    // Quem aprova fica sabendo ("N abastecimentos aguardando aprovação" na frente).
    if (!result.duplicate) runAfterResponse("convoy.pending", () => notifyConvoyPending(result.id));
    return Response.json({ ...result, message: result.duplicate ? "Este abastecimento já tinha sido recebido." : "Registrado — aguardando aprovação." }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Envio incompleto. Tente de novo." }, { status: 400 });
    console.error("[convoy.field.records.post]", error);
    return Response.json({ error: "Não foi possível receber o abastecimento agora." }, { status: 500 });
  }
}
