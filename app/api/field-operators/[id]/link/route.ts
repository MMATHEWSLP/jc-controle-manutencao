import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { FieldOperatorError, linkFieldOperator } from "../../../../../lib/field-operators";

type Context = { params: Promise<{ id: string }> };

// "Vincular": liga o acesso de campo ao funcionário do cadastro principal (o código não muda).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    const employeeId = Number(((await request.json()) as { employeeId?: unknown }).employeeId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(employeeId) || employeeId <= 0) return Response.json({ error: "Escolha o funcionário." }, { status: 400 });
    const { name } = await linkFieldOperator(auth.user!, id, employeeId);
    return Response.json({ ok: true, message: `Acesso vinculado ao cadastro de ${name}.` });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.link]", error);
    return Response.json({ error: "Não foi possível vincular." }, { status: 500 });
  }
}
