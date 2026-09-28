import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { updateDepartment } from "../../../../lib/departments";
import { stockErrorResponse } from "../../../../lib/stock";

type Context = { params: Promise<{ id: string }> };

// Renomear ou ativar/desativar um departamento (os lançamentos antigos continuam com ele).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "departments.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Departamento inválido." }, { status: 400 });
  try {
    const department = await updateDepartment(await getDb(), id, await request.json() as Record<string, unknown>, auth.user!.id);
    return Response.json({ department, message: `Departamento ${department.name} atualizado.` });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[departments.put]", error);
    return Response.json({ error: "Não foi possível atualizar o departamento agora." }, { status: 500 });
  }
}
