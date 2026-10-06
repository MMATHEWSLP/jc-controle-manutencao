import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { createConvoyDriver, listConvoyDrivers } from "../../../../../lib/convoy-drivers";
import { employeeErrorResponse } from "../../../../../lib/employees";
import { FieldOperatorError } from "../../../../../lib/field-operators";

// Setor ABASTECIMENTOS → Motoristas do comboio: lista e cadastro. O PIN volta UMA vez, só no cadastro.
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try { return Response.json(await listConvoyDrivers(auth.user!), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { console.error("[convoy.drivers.get]", error); return Response.json({ error: "Não foi possível carregar os motoristas do comboio." }, { status: 500 }); }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const created = await createConvoyDriver(auth.user!, await request.json() as Record<string, unknown>);
    return Response.json({ ...created, message: `${created.name} agora é motorista do comboio.` }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message, ...error.extra }, { status: error.status });
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[convoy.drivers.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o motorista." }, { status: 500 });
  }
}
