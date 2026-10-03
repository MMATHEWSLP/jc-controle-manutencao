import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { assertCodeNotObvious, FieldOperatorError, parseFieldOperatorInput, updateFieldOperator } from "../../../../lib/field-operators";

type Context = { params: Promise<{ id: string }> };

// Edita nome/função/frentes, ativa ou inativa, e troca o código (campo "code" opcional).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Funcionário inválido." }, { status: 400 });
    const input = parseFieldOperatorInput(await request.json() as Record<string, unknown>, false);
    assertCodeNotObvious(input.code);
    const { name } = await updateFieldOperator(auth.user!, id, input);
    return Response.json({ ok: true, message: input.code ? `${name} atualizado, com código novo.` : `${name} atualizado.` });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.put]", error);
    return Response.json({ error: "Não foi possível salvar o funcionário." }, { status: 500 });
  }
}
