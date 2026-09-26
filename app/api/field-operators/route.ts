import { assertSameOrigin, authorize } from "../../../lib/auth";
import { createFieldOperator, FieldOperatorError, listFieldOperators, parseFieldOperatorInput } from "../../../lib/field-operators";

export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try { return Response.json({ operators: await listFieldOperators(auth.user!) }); }
  catch (error) { console.error("[field-operators.get]", error); return Response.json({ error: "Não foi possível carregar os funcionários." }, { status: 500 }); }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const input = parseFieldOperatorInput(await request.json() as Record<string, unknown>, true);
    const id = await createFieldOperator(auth.user!, input);
    return Response.json({ ok: true, id, message: `${input.name} cadastrado. Informe o código a ele pessoalmente.` }, { status: 201 });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário." }, { status: 500 });
  }
}
