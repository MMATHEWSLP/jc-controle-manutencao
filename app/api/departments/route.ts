import { getDb } from "../../../db";
import { assertSameOrigin, authorize, type Permission } from "../../../lib/auth";
import { createDepartment, listDepartments } from "../../../lib/departments";
import { stockErrorResponse } from "../../../lib/stock";

// Lista única de Departamentos (Movimentação e Solicitação de Pedidos).
const VIEW: Permission[] = ["stock.exits_view", "purchases.view", "departments.manage", "reports.pecas"];

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!VIEW.some((permission) => user.permissions.includes(permission))) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const canManage = user.permissions.includes("departments.manage");
    const includeInactive = canManage && new URL(request.url).searchParams.get("todos") === "1";
    return Response.json({ departments: await listDepartments(await getDb(), includeInactive), canManage });
  } catch (error) {
    console.error("[departments.get]", error);
    return Response.json({ error: "Não foi possível carregar os departamentos." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "departments.manage");
  if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const result = await createDepartment(await getDb(), body.name, auth.user!.id);
    return Response.json({ department: result.department, option: result.department, message: result.created ? `Departamento ${result.department.name} cadastrado.` : `Já existia: ${result.department.name}.` }, { status: result.created ? 201 : 200 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[departments.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o departamento agora." }, { status: 500 });
  }
}
