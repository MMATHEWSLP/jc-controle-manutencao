import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { createFromEmployees, FieldOperatorError, type ItemDaLista } from "../../../../lib/field-operators";

// Cria em lote os acessos dos funcionários escolhidos na lista. Os códigos voltam UMA vez, só aqui.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as { items?: unknown };
    const itens: ItemDaLista[] = (Array.isArray(body.items) ? body.items : []).map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return { employeeId: Number(item.employeeId), extraFrontIds: Array.isArray(item.extraFrontIds) ? item.extraFrontIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [], code: typeof item.code === "string" && item.code.trim() ? item.code.trim() : null };
    });
    const criados = await createFromEmployees(auth.user!, itens);
    return Response.json({ criados, message: `${criados.length} acesso(s) de campo criado(s).` }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[field-operators.from-employees]", error);
    return Response.json({ error: "Não foi possível criar os acessos." }, { status: 500 });
  }
}
