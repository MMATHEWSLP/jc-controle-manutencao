import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { tasks, users } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import type { TaskStatus, Urgency } from "../route";

type Context = { params: Promise<{ id: string }> };
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

async function findTask(id: number) {
  const db = await getDb();
  return (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0] ?? null;
}

function canManageTask(task: { assigneeId: number | null; createdBy: number | null }, userId: number, manage: boolean) {
  return manage || task.assigneeId === userId || task.createdBy === userId;
}

async function isDescendantOf(candidateParentId: number, taskId: number) {
  const db = await getDb();
  const rows = await db.select({ id: tasks.id, parentTaskId: tasks.parentTaskId }).from(tasks);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let cursor = byId.get(candidateParentId) ?? null;
  while (cursor) {
    if (cursor.id === taskId) return true;
    cursor = cursor.parentTaskId === null ? null : byId.get(cursor.parentTaskId) ?? null;
  }
  return false;
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.edit"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tarefa inválida." }, { status: 400 });
    const existing = await findTask(id);
    if (!existing) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    const manage = auth.user!.permissions.includes("tasks.manage");
    if (!canManageTask(existing, auth.user!.id, manage)) return Response.json({ error: "Você não possui acesso para editar esta tarefa." }, { status: 403 });

    const body = await request.json() as Record<string, unknown>;
    const title = clean(body.title) || existing.title;
    const description = body.description === undefined ? existing.description : (clean(body.description) || null);
    const dueDate = clean(body.dueDate) || existing.dueDate;
    const urgency = clean(body.urgency) || existing.urgency;
    const status = clean(body.status) || existing.status;
    const assigneeId = body.assigneeId === undefined ? existing.assigneeId : (body.assigneeId ? Number(body.assigneeId) : null);
    const parentTaskId = body.parentTaskId === undefined ? existing.parentTaskId : (body.parentTaskId ? Number(body.parentTaskId) : null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return Response.json({ error: "Informe um prazo de entrega válido." }, { status: 400 });
    if (!(["LOW", "MEDIUM", "HIGH", "URGENT"] as string[]).includes(urgency)) return Response.json({ error: "Selecione um nível de urgência válido." }, { status: 400 });
    if (!(["TODO", "IN_PROGRESS", "DONE"] as string[]).includes(status)) return Response.json({ error: "Selecione um status válido." }, { status: 400 });

    const db = await getDb();
    if (parentTaskId !== null) {
      if (parentTaskId === id) return Response.json({ error: "Uma tarefa não pode ser subtarefa dela mesma." }, { status: 400 });
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
      if (await isDescendantOf(parentTaskId, id)) return Response.json({ error: "Não é possível mover uma tarefa para dentro de sua própria subtarefa." }, { status: 400 });
    }
    if (assigneeId) {
      const assignee = (await db.select({ id: users.id }).from(users).where(eq(users.id, assigneeId)).limit(1))[0];
      if (!assignee) return Response.json({ error: "Responsável selecionado não encontrado." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const completedAt = status === "DONE" ? (existing.status === "DONE" ? existing.completedAt : now) : null;
    await db.update(tasks).set({
      title, description, dueDate, urgency: urgency as Urgency, status: status as TaskStatus,
      assigneeId, parentTaskId, completedAt, updatedAt: now,
    }).where(eq(tasks.id, id));
    return Response.json({ message: `Tarefa "${title}" atualizada.` });
  } catch (error) {
    console.error("[tasks.id.put]", error);
    return Response.json({ error: "Não foi possível atualizar a tarefa." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.edit"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tarefa inválida." }, { status: 400 });
    const existing = await findTask(id);
    if (!existing) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    const manage = auth.user!.permissions.includes("tasks.manage");
    if (!canManageTask(existing, auth.user!.id, manage)) return Response.json({ error: "Você não possui acesso para excluir esta tarefa." }, { status: 403 });

    const db = await getDb();
    const child = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentTaskId, id)).limit(1))[0];
    if (child) return Response.json({ error: "Esta tarefa possui subtarefas. Exclua ou mova as subtarefas antes de excluir esta tarefa." }, { status: 409 });

    await db.delete(tasks).where(eq(tasks.id, id));
    return Response.json({ message: `Tarefa "${existing.title}" excluída.` });
  } catch (error) {
    console.error("[tasks.id.delete]", error);
    return Response.json({ error: "Não foi possível excluir a tarefa." }, { status: 500 });
  }
}
