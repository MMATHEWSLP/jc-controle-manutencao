import { assertSameOrigin } from "../../../../../lib/auth";
import { FieldAuthError, verifyFieldOperator } from "../../../../../lib/field-auth";

// Passo 1 do acesso de campo: confere nome + código e devolve nome, função e frente para a
// tela de confirmação ("Sou eu"). Não cria sessão.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const operator = await verifyFieldOperator(request, Number(body.operatorId), String(body.code ?? "").trim());
    return Response.json({ operator });
  } catch (error) {
    if (error instanceof FieldAuthError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[auth.field.verify]", error);
    return Response.json({ error: "Não foi possível conferir agora. Tente novamente." }, { status: 503 });
  }
}
