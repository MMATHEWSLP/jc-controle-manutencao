import { getDb } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { employeeToday, listCompanies } from "../../../lib/employees";
import { assertCodeNotObvious, createFieldOperator, FieldOperatorError, listFieldOperators, parseFieldOperatorInput } from "../../../lib/field-operators";

export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  const user = auth.user!;
  try {
    const canCreateEmployee = user.permissions.includes("employees.manage");
    return Response.json({
      // Motorista só do comboio (não faz o Controle Diário) é cadastrado no setor Abastecimentos.
      operators: (await listFieldOperators(user)).filter((row) => row.fieldDailyAccess || !row.convoyFuelRegister), canImport: user.profile === "ADMIN", canCreateEmployee,
      companies: canCreateEmployee ? (await listCompanies(await getDb())).map((row) => row.name) : [], today: employeeToday(),
    });
  }
  catch (error) { console.error("[field-operators.get]", error); return Response.json({ error: "Não foi possível carregar os funcionários." }, { status: 500 }); }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const input = parseFieldOperatorInput(await request.json() as Record<string, unknown>, true);
    assertCodeNotObvious(input.code);
    const id = await createFieldOperator(auth.user!, input);
    return Response.json({ ok: true, id, message: `${input.name} cadastrado. Informe o código a ele pessoalmente.` }, { status: 201 });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário." }, { status: 500 });
  }
}
