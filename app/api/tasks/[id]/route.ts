import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { tasks } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { applyModuleGate, computeTaskPermissions, loadTaskHistory, loadUserAuthInfo, logTaskAudit, type HierarchyLevel, type TaskPermissions } from "../../../../lib/task-authorization";
import { STATUS_LABELS, URGENCY_LABELS, loadTaskRows, toTaskAuthRow, type TaskRow, type TaskStatus, type Urgency } from "../route";

type Context = { params: Promise<{ id: string }> };
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

async function findVisibleTask(id: number, viewer: { id: number; hierarchyLevel: HierarchyLevel }, hasEditPermission: boolean) {
  const row = (await loadTaskRows(id))[0];
  if (!row) return null;
  const permissions = applyModuleGate(computeTaskPermissions(viewer, toTaskAuthRow(row), row.assigneeHierarchyLevel as HierarchyLevel | null), hasEditPermission);
  if (!permissions.canView) return null;
  return { row, permissions };
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

function serializeDetail(row: TaskRow, permissions: TaskPermissions) {
  return {
    id: row.id, parentTaskId: row.parentTaskId, title: row.title, description: row.description,
    assigneeId: row.assigneeId, assigneeName: row.assigneeName,
    urgency: row.urgency, urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
    dueDate: row.dueDate, status: row.status, statusLabel: STATUS_LABELS[row.status as TaskStatus] ?? row.status,
    createdBy: row.createdBy, createdByName: row.createdByName,
    completedAt: row.completedAt, completedBy: row.completedBy, completionNote: row.completionNote,
    notDoneAt: row.notDoneAt, notDoneBy: row.notDoneBy, notDoneReason: row.notDoneReason,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    canEdit: permissions.canEdit, canReassign: permissions.canReassign, canDelete: permissions.canDelete,
    canComplete: permissions.canComplete, canMarkNotDone: permissions.canMarkNotDone,
  };
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tarefa inválida." }, { status: 400 });
    const viewer = { id: auth.user!.id, hierarchyLevel: auth.user!.hierarchyLevel };
    const found = await findVisibleTask(id, viewer, auth.user!.permissions.includes("tasks.edit"));
    // 404 (não 403) deliberadamente: um usuário sem acesso não deve conseguir nem confirmar
    // que a tarefa existe tentando IDs diretamente.
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    const history = await loadTaskHistory(id);
    return Response.json({ task: serializeDetail(found.row, found.permissions), history });
  } catch (error) {
    console.error("[tasks.id.get]", error);
    return Response.json({ error: "Não foi possível carregar a tarefa." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.edit"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tarefa inválida." }, { status: 400 });
    const viewer = { id: auth.user!.id, hierarchyLevel: auth.user!.hierarchyLevel };
    const found = await findVisibleTask(id, viewer, true);
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    const { row: existing, permissions } = found;

    const body = await request.json() as Record<string, unknown>;
    const action = clean(body.action);
    const db = await getDb();
    const now = new Date().toISOString();

    if (action === "COMPLETE") {
      if (!permissions.canComplete) return Response.json({ error: "Somente o responsável pela tarefa pode concluí-la." }, { status: 403 });
      const completionNote = clean(body.completionNote);
      if (!completionNote) return Response.json({ error: "Informe a observação da conclusão." }, { status: 400 });
      await db.update(tasks).set({ status: "DONE", completedAt: now, completedBy: auth.user!.id, completionNote, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_COMPLETED", { status: existing.status }, { status: "DONE", completionNote });
      return Response.json({ message: `Tarefa "${existing.title}" concluída.` });
    }

    if (action === "NOT_DONE") {
      if (!permissions.canMarkNotDone) return Response.json({ error: "Somente o responsável pela tarefa pode informar que não será realizada." }, { status: 403 });
      const notDoneReason = clean(body.notDoneReason);
      if (!notDoneReason) return Response.json({ error: "Informe a justificativa." }, { status: 400 });
      await db.update(tasks).set({ status: "NOT_DONE", notDoneAt: now, notDoneBy: auth.user!.id, notDoneReason, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_NOT_DONE", { status: existing.status }, { status: "NOT_DONE", notDoneReason });
      return Response.json({ message: `Tarefa "${existing.title}" marcada como não realizada.` });
    }

    // Edição geral: título, descrição, prazo, urgência, status manual, responsável, tarefa pai.
    // Restrita a criador ou superior hierárquico do responsável — nunca ao responsável "puro"
    // (ele só tem as ações COMPLETE / NOT_DONE acima, mesmo mandando este corpo por requisição direta).
    if (!permissions.canEdit) return Response.json({ error: "Você não possui permissão para editar esta tarefa." }, { status: 403 });
    const title = clean(body.title) || existing.title;
    const description = body.description === undefined ? existing.description : (clean(body.description) || null);
    const dueDate = clean(body.dueDate) || existing.dueDate;
    const urgency = clean(body.urgency) || existing.urgency;
    const status = clean(body.status) || existing.status;
    const requestedAssigneeId = body.assigneeId === undefined ? existing.assigneeId : Number(body.assigneeId);
    const parentTaskId = body.parentTaskId === undefined ? existing.parentTaskId : (body.parentTaskId ? Number(body.parentTaskId) : null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return Response.json({ error: "Informe um prazo de entrega válido." }, { status: 400 });
    if (!(["LOW", "MEDIUM", "HIGH", "URGENT"] as string[]).includes(urgency)) return Response.json({ error: "Selecione um nível de urgência válido." }, { status: 400 });
    if (!(["TODO", "IN_PROGRESS", "DONE", "NOT_DONE"] as string[]).includes(status)) return Response.json({ error: "Selecione um status válido." }, { status: 400 });
    if (requestedAssigneeId === null || !Number.isInteger(requestedAssigneeId) || requestedAssigneeId <= 0) return Response.json({ error: "Selecione um responsável para a tarefa." }, { status: 400 });
    const assigneeId = requestedAssigneeId;

    const assignee = await loadUserAuthInfo(assigneeId);
    if (!assignee) return Response.json({ error: "O responsável selecionado não existe." }, { status: 400 });
    if (assignee.status !== "ACTIVE") return Response.json({ error: "O responsável selecionado está inativo." }, { status: 400 });

    if (parentTaskId !== null) {
      if (parentTaskId === id) return Response.json({ error: "Uma tarefa não pode ser subtarefa dela mesma." }, { status: 400 });
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent || parent.deletedAt) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
      if (await isDescendantOf(parentTaskId, id)) return Response.json({ error: "Não é possível mover uma tarefa para dentro de sua própria subtarefa." }, { status: 400 });
    }

    let completedAt = existing.completedAt; let completedBy = existing.completedBy; let completionNote = existing.completionNote;
    if (status === "DONE" && existing.status !== "DONE") { completedAt = now; completedBy = auth.user!.id; }
    else if (status !== "DONE") { completedAt = null; completedBy = null; completionNote = null; }
    let notDoneAt = existing.notDoneAt; let notDoneBy = existing.notDoneBy; let notDoneReason = existing.notDoneReason;
    if (status === "NOT_DONE" && existing.status !== "NOT_DONE") { notDoneAt = now; notDoneBy = auth.user!.id; }
    else if (status !== "NOT_DONE") { notDoneAt = null; notDoneBy = null; notDoneReason = null; }

    const before = { title: existing.title, description: existing.description, dueDate: existing.dueDate, urgency: existing.urgency, status: existing.status, assigneeId: existing.assigneeId, parentTaskId: existing.parentTaskId };
    const after = { title, description, dueDate, urgency, status, assigneeId, parentTaskId };
    await db.update(tasks).set({
      title, description, dueDate, urgency: urgency as Urgency, status: status as TaskStatus,
      assigneeId, parentTaskId, completedAt, completedBy, completionNote, notDoneAt, notDoneBy, notDoneReason, updatedAt: now,
    }).where(eq(tasks.id, id));
    await logTaskAudit(auth.user!.id, id, "TASK_UPDATED", before, after);
    if (assigneeId !== existing.assigneeId) await logTaskAudit(auth.user!.id, id, "TASK_REASSIGNED", { assigneeId: existing.assigneeId }, { assigneeId });
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
    const viewer = { id: auth.user!.id, hierarchyLevel: auth.user!.hierarchyLevel };
    const found = await findVisibleTask(id, viewer, true);
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    if (!found.permissions.canDelete) return Response.json({ error: "Você não possui permissão para excluir esta tarefa." }, { status: 403 });

    const db = await getDb();
    const child = (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentTaskId, id), isNull(tasks.deletedAt))).limit(1))[0];
    if (child) return Response.json({ error: "Esta tarefa possui subtarefas ativas. Exclua ou mova as subtarefas antes de excluir esta tarefa." }, { status: 409 });

    const now = new Date().toISOString();
    await db.update(tasks).set({ deletedAt: now, deletedBy: auth.user!.id, updatedAt: now }).where(eq(tasks.id, id));
    await logTaskAudit(auth.user!.id, id, "TASK_DELETED", undefined, { deletedAt: now });
    return Response.json({ message: `Tarefa "${found.row.title}" excluída.` });
  } catch (error) {
    console.error("[tasks.id.delete]", error);
    return Response.json({ error: "Não foi possível excluir a tarefa." }, { status: 500 });
  }
}
