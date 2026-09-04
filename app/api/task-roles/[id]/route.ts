import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { taskRoles } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { logRoleAudit } from "../../../../lib/task-authorization";

type Context = { params: Promise<{ id: string }> };
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

// Edição de cargo: nome, ordem visual e ativo/inativo. Não existe DELETE — "excluir" um cargo,
// pela especificação, é desativá-lo (preserva os snapshots históricos de tarefas antigas que
// referenciam esse cargo). O cargo raiz nunca pode ser desativado nem perder o nome de forma que
// deixe de haver exatamente um cargo raiz ativo.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente o administrador pode alterar cargos de tarefas." }, { status: 403 });
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Cargo inválido." }, { status: 400 });
    const db = await getDb();
    const current = (await db.select().from(taskRoles).where(eq(taskRoles.id, id)).limit(1))[0];
    if (!current) return Response.json({ error: "Cargo não encontrado." }, { status: 404 });

    const body = await request.json() as Record<string, unknown>;
    const name = body.name === undefined ? current.name : clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome do cargo." }, { status: 400 });
    const requestedOrder = Number(body.visualOrder);
    const visualOrder = body.visualOrder === undefined ? current.visualOrder : (Number.isInteger(requestedOrder) ? requestedOrder : current.visualOrder);
    const requestedActive = body.active === undefined ? current.active : Boolean(body.active);
    if (current.isRoot && !requestedActive) return Response.json({ error: "O cargo raiz não pode ser desativado — ele é o único com acesso administrativo garantido ao sistema." }, { status: 400 });
    const active = requestedActive;

    const before = { name: current.name, visualOrder: current.visualOrder, active: current.active };
    const saved = (await db.update(taskRoles).set({ name, visualOrder, active, updatedAt: new Date().toISOString() }).where(eq(taskRoles.id, id)).returning())[0];
    await logRoleAudit(auth.user!.id, String(id), "TASK_ROLE_UPDATED", before, { name, visualOrder, active });
    return Response.json({ role: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint") || message.includes("duplicate key")) return Response.json({ error: "Já existe um cargo com este nome." }, { status: 409 });
    console.error("[task-roles.id.put]", error);
    return Response.json({ error: "Não foi possível atualizar o cargo." }, { status: 500 });
  }
}
