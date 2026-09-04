import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { taskRoles } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { logRoleAudit } from "../../../lib/task-authorization";

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

// Lista de cargos ATIVOS — disponível para qualquer usuário autenticado (nomes de cargo não são
// sensíveis; usada no cadastro de usuário, nos filtros do Histórico e ao montar "Nova tarefa").
// O mapa completo (cargos inativos, contagem de usuários, conexões) é exclusivo do ADMIN/cargo
// raiz e fica em GET /api/task-roles/map.
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const rows = await db.select({ id: taskRoles.id, name: taskRoles.name, visualOrder: taskRoles.visualOrder, isRoot: taskRoles.isRoot })
      .from(taskRoles).where(eq(taskRoles.active, true)).orderBy(asc(taskRoles.visualOrder));
    return Response.json({ roles: rows });
  } catch (error) {
    console.error("[task-roles.get]", error);
    return Response.json({ error: "Não foi possível carregar os cargos de tarefas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente o administrador pode criar cargos de tarefas." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome do cargo." }, { status: 400 });
    const db = await getDb();
    const maxOrder = (await db.select({ visualOrder: taskRoles.visualOrder }).from(taskRoles).orderBy(asc(taskRoles.visualOrder)))
      .reduce((max, row) => Math.max(max, row.visualOrder), 0);
    const requestedOrder = Number(body.visualOrder);
    const visualOrder = Number.isInteger(requestedOrder) && requestedOrder > 0 ? requestedOrder : maxOrder + 1;
    const inserted = (await db.insert(taskRoles).values({ name, visualOrder, isRoot: false, active: true }).returning())[0];
    await logRoleAudit(auth.user!.id, String(inserted.id), "TASK_ROLE_CREATED", undefined, { name, visualOrder });
    return Response.json({ role: inserted }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint") || message.includes("duplicate key")) return Response.json({ error: "Já existe um cargo com este nome." }, { status: 409 });
    console.error("[task-roles.post]", error);
    return Response.json({ error: "Não foi possível criar o cargo." }, { status: 500 });
  }
}
