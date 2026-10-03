import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { employeeErrorResponse } from "../../../../lib/employees";
import { createManual, FieldOperatorError, parseManualInput } from "../../../../lib/field-operators";

// Cadastro manual (quem não está na lista: temporário, prestador). Com "Criar também no cadastro de
// Funcionários" (padrão) grava o funcionário pela mesma função do menu FUNCIONÁRIOS e já vincula.
// Nome parecido existente → 409 com a lista, para a pessoa decidir.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const criado = await createManual(auth.user!, parseManualInput(await request.json() as Record<string, unknown>));
    return Response.json({ criados: [criado], message: `${criado.name} cadastrado.` }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message, ...error.extra }, { status: error.status });
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[field-operators.manual]", error);
    return Response.json({ error: "Não foi possível cadastrar." }, { status: 500 });
  }
}
