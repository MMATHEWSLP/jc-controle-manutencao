import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { tasks } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import {
  applyModuleGate, canManageOf, canSendTo, computeTaskPermissions, isRootRole, loadTaskHistory, loadTaskRoleGraph, loadUserAuthInfo, logTaskAudit, wasEverAssignee,
  type TaskPermissions, type TaskRoleGraph, type TaskViewer,
} from "../../../../lib/task-authorization";
import { notifyUser } from "../../../../lib/task-notifications";
import { OPEN_STATUSES, URGENCY_LABELS, displayStatusLabel, loadTaskRows, toTaskAuthRow, type TaskRow, type Urgency } from "../route";

type Context = { params: Promise<{ id: string }> };
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

async function findVisibleTask(id: number, graph: TaskRoleGraph, viewer: TaskViewer, hasEditPermission: boolean) {
  // loadTaskRows(id) não filtra deletedAt — é este método que decide se uma tarefa excluída pode
  // ser exibida (seção 17: preservada só para participantes legítimos e para o cargo raiz).
  const row = (await loadTaskRows(id))[0];
  if (!row) return null;
  const everAssignee = await wasEverAssignee(id, viewer.id);
  const permissions = applyModuleGate(computeTaskPermissions(graph, viewer, toTaskAuthRow(row), row.createdByTaskRoleId, row.assigneeTaskRoleId, everAssignee), hasEditPermission);
  if (!permissions.canView) return null;
  const isLegitParticipant = row.createdBy === viewer.id || row.assigneeId === viewer.id || everAssignee;
  if (row.deletedAt && !isLegitParticipant && !isRootRole(graph, viewer.taskRoleId)) return null;
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

function serializeDetail(row: TaskRow, permissions: TaskPermissions, root: boolean) {
  return {
    id: row.id, parentTaskId: row.parentTaskId, title: row.title, description: row.description,
    assigneeId: row.assigneeId, assigneeName: row.assigneeName,
    urgency: row.urgency, urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
    dueDate: row.dueDate, status: row.status, statusLabel: displayStatusLabel(row.status, row.viewedAt),
    createdBy: row.createdBy, createdByName: row.createdByName,
    viewedAt: row.viewedAt, viewedBy: row.viewedBy,
    completedAt: row.completedAt, completedBy: row.completedBy, completionNote: row.completionNote,
    notDoneAt: row.notDoneAt, notDoneBy: row.notDoneBy, notDoneReason: row.notDoneReason,
    cancelledAt: row.cancelledAt, cancelledBy: row.cancelledBy, cancelReason: row.cancelReason,
    deletedAt: row.deletedAt, deletedBy: row.deletedBy,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    canEdit: permissions.canEdit, canReassign: permissions.canReassign, canDelete: permissions.canDelete,
    canComplete: permissions.canComplete, canMarkNotDone: permissions.canMarkNotDone,
    canStart: permissions.canComplete && row.status === "TODO",
    canCancel: permissions.canDelete && (OPEN_STATUSES as string[]).includes(row.status),
    canRestore: root && row.deletedAt !== null,
  };
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tarefa inválida." }, { status: 400 });
    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const graph = await loadTaskRoleGraph();
    const found = await findVisibleTask(id, graph, viewer, auth.user!.permissions.includes("tasks.edit"));
    // 404 (não 403) deliberadamente: um usuário sem acesso não deve conseguir nem confirmar
    // que a tarefa existe tentando IDs diretamente.
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    let { row } = found;
    // "Visualizada": registrada automaticamente na primeira vez que o RESPONSÁVEL abre a tarefa
    // (seção 13) — nunca quando quem abre é o criador, um gerenciador ou o cargo raiz.
    if (row.assigneeId === viewer.id && !row.viewedAt && !row.deletedAt) {
      const now = new Date().toISOString();
      const db = await getDb();
      await db.update(tasks).set({ viewedAt: now, viewedBy: viewer.id }).where(eq(tasks.id, id));
      await logTaskAudit(viewer.id, id, "TASK_VIEWED", undefined, { viewedAt: now });
      row = { ...row, viewedAt: now, viewedBy: viewer.id };
    }
    const history = await loadTaskHistory(id);
    return Response.json({ task: serializeDetail(row, found.permissions, isRootRole(graph, viewer.taskRoleId)), history });
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
    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const graph = await loadTaskRoleGraph();
    const found = await findVisibleTask(id, graph, viewer, true);
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    const { row: existing, permissions } = found;

    const body = await request.json() as Record<string, unknown>;
    const action = clean(body.action);
    const db = await getDb();
    const now = new Date().toISOString();

    if (action === "RESTORE") {
      if (!isRootRole(graph, viewer.taskRoleId)) return Response.json({ error: "Somente o administrador/cargo raiz pode restaurar uma tarefa excluída." }, { status: 403 });
      if (!existing.deletedAt) return Response.json({ error: "Esta tarefa não está excluída." }, { status: 400 });
      await db.update(tasks).set({ deletedAt: null, deletedBy: null, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_RESTORED", { deletedAt: existing.deletedAt }, { deletedAt: null });
      return Response.json({ message: `Tarefa "${existing.title}" restaurada.` });
    }

    // Nenhuma outra ação mexe numa tarefa excluída — só a restauração acima. Evita reabrir uma
    // tarefa "por trás" (concluir, reatribuir etc.) enquanto ela está fora das listas normais.
    if (existing.deletedAt) return Response.json({ error: "Esta tarefa foi excluída. Peça ao administrador/cargo raiz para restaurá-la antes de qualquer alteração." }, { status: 409 });

    if (action === "START") {
      if (!permissions.canComplete) return Response.json({ error: "Somente o responsável pela tarefa pode iniciar a execução." }, { status: 403 });
      if (existing.status !== "TODO") return Response.json({ error: "Esta tarefa não está mais pendente." }, { status: 400 });
      await db.update(tasks).set({ status: "IN_PROGRESS", updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_STARTED", { status: existing.status }, { status: "IN_PROGRESS" });
      return Response.json({ message: `Tarefa "${existing.title}" marcada como em andamento.` });
    }

    if (action === "COMPLETE") {
      if (!permissions.canComplete) return Response.json({ error: "Somente o responsável pela tarefa pode concluí-la." }, { status: 403 });
      const completionNote = clean(body.completionNote);
      if (!completionNote) return Response.json({ error: "Informe a observação da conclusão." }, { status: 400 });
      await db.update(tasks).set({ status: "DONE", completedAt: now, completedBy: auth.user!.id, completionNote, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_COMPLETED", { status: existing.status }, { status: "DONE", completionNote });
      if (existing.createdBy && existing.createdBy !== auth.user!.id) await notifyUser(existing.createdBy, id, "TASK_COMPLETED", `${auth.user!.name} concluiu a tarefa "${existing.title}".`);
      return Response.json({ message: `Tarefa "${existing.title}" concluída.` });
    }

    if (action === "NOT_DONE") {
      if (!permissions.canMarkNotDone) return Response.json({ error: "Somente o responsável pela tarefa pode informar que não será realizada." }, { status: 403 });
      const notDoneReason = clean(body.notDoneReason);
      if (!notDoneReason) return Response.json({ error: "Informe a justificativa." }, { status: 400 });
      await db.update(tasks).set({ status: "NOT_DONE", notDoneAt: now, notDoneBy: auth.user!.id, notDoneReason, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_NOT_DONE", { status: existing.status }, { status: "NOT_DONE", notDoneReason });
      if (existing.createdBy && existing.createdBy !== auth.user!.id) await notifyUser(existing.createdBy, id, "TASK_NOT_DONE", `${auth.user!.name} informou que não realizará a tarefa "${existing.title}".`);
      return Response.json({ message: `Tarefa "${existing.title}" marcada como não realizada.` });
    }

    if (action === "CANCEL") {
      // Mesma faixa de permissão de editar/excluir (criador, gerenciador autorizado, cargo raiz)
      // — nunca o responsável "puro" (matriz da seção 16).
      if (!permissions.canDelete) return Response.json({ error: "Você não possui permissão para cancelar esta tarefa." }, { status: 403 });
      if (!(OPEN_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Esta tarefa já foi encerrada e não pode mais ser cancelada." }, { status: 400 });
      const cancelReason = clean(body.cancelReason);
      if (!cancelReason) return Response.json({ error: "Informe o motivo do cancelamento." }, { status: 400 });
      await db.update(tasks).set({ status: "CANCELLED", cancelledAt: now, cancelledBy: auth.user!.id, cancelReason, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_CANCELLED", { status: existing.status }, { status: "CANCELLED", cancelReason });
      if (existing.assigneeId && existing.assigneeId !== auth.user!.id) await notifyUser(existing.assigneeId, id, "TASK_CANCELLED", `A tarefa "${existing.title}" foi cancelada por ${auth.user!.name}.`);
      return Response.json({ message: `Tarefa "${existing.title}" cancelada.` });
    }

    // Edição geral: título, descrição, prazo, urgência, responsável, tarefa pai. Restrita a
    // criador, gerenciador autorizado do cargo do responsável, ou cargo raiz — nunca ao
    // responsável "puro" (ele só tem as ações guiadas acima, mesmo mandando este corpo direto).
    // O status NUNCA é sobrescrito manualmente aqui (seção 13: "não substituir status sem
    // respeitar o fluxo") — toda transição de status passa por uma ação guiada própria
    // (START/COMPLETE/NOT_DONE/CANCEL), cada uma com sua própria trilha de auditoria/notificação.
    if (!permissions.canEdit) return Response.json({ error: "Você não possui permissão para editar esta tarefa." }, { status: 403 });
    const title = clean(body.title) || existing.title;
    const description = body.description === undefined ? existing.description : (clean(body.description) || null);
    const dueDate = clean(body.dueDate) || existing.dueDate;
    const urgency = clean(body.urgency) || existing.urgency;
    const requestedAssigneeId = body.assigneeId === undefined ? existing.assigneeId : Number(body.assigneeId);
    const parentTaskId = body.parentTaskId === undefined ? existing.parentTaskId : (body.parentTaskId ? Number(body.parentTaskId) : null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return Response.json({ error: "Informe um prazo de entrega válido." }, { status: 400 });
    if (!(["LOW", "MEDIUM", "HIGH", "URGENT"] as string[]).includes(urgency)) return Response.json({ error: "Selecione um nível de urgência válido." }, { status: 400 });
    if (requestedAssigneeId === null || !Number.isInteger(requestedAssigneeId) || requestedAssigneeId <= 0) return Response.json({ error: "Selecione um responsável para a tarefa." }, { status: 400 });
    const assigneeId = requestedAssigneeId;

    const assignee = await loadUserAuthInfo(assigneeId);
    if (!assignee) return Response.json({ error: "O responsável selecionado não existe." }, { status: 400 });
    if (assignee.status !== "ACTIVE") return Response.json({ error: "O responsável selecionado está inativo." }, { status: 400 });

    const reassigning = assigneeId !== existing.assigneeId;
    if (reassigning) {
      if (!(OPEN_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Uma tarefa já encerrada (concluída, não realizada ou cancelada) não pode ser reatribuída." }, { status: 400 });
      // A nova pessoa responsável precisa pertencer a um cargo para o qual quem está reatribuindo
      // tem permissão de envio OU de gerenciamento — seção 16, nota **.
      if (assignee.taskRoleId === null) return Response.json({ error: "O responsável selecionado ainda não possui Cargo de Tarefas configurado." }, { status: 400 });
      const authorized = isRootRole(graph, viewer.taskRoleId) || canSendTo(graph, viewer.taskRoleId, assignee.taskRoleId) || canManageOf(graph, viewer.taskRoleId, assignee.taskRoleId);
      if (!authorized) return Response.json({ error: "Você não tem permissão de envio ou gerenciamento para o cargo do novo responsável." }, { status: 403 });
    }

    if (parentTaskId !== null) {
      if (parentTaskId === id) return Response.json({ error: "Uma tarefa não pode ser subtarefa dela mesma." }, { status: 400 });
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent || parent.deletedAt) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
      if (await isDescendantOf(parentTaskId, id)) return Response.json({ error: "Não é possível mover uma tarefa para dentro de sua própria subtarefa." }, { status: 400 });
    }

    // Reatribuir devolve a tarefa ao início do fluxo guiado (Pendente, sem "visualizada" do novo
    // responsável) — o snapshot do cargo também é atualizado, é o cargo "no momento do envio"
    // mais recente, para o Histórico mostrar algo coerente com quem recebeu agora.
    const assigneeRoleSnapshotId = reassigning ? assignee.taskRoleId : existing.assigneeRoleSnapshotId;
    const viewedAt = reassigning ? null : existing.viewedAt;
    const viewedBy = reassigning ? null : existing.viewedBy;

    const before = { title: existing.title, description: existing.description, dueDate: existing.dueDate, urgency: existing.urgency, assigneeId: existing.assigneeId, parentTaskId: existing.parentTaskId };
    const after = { title, description, dueDate, urgency, assigneeId, parentTaskId };
    await db.update(tasks).set({
      title, description, dueDate, urgency: urgency as Urgency,
      assigneeId, assigneeRoleSnapshotId, viewedAt, viewedBy, parentTaskId, updatedAt: now,
    }).where(eq(tasks.id, id));
    await logTaskAudit(auth.user!.id, id, "TASK_UPDATED", before, after);
    if (reassigning) {
      await logTaskAudit(auth.user!.id, id, "TASK_REASSIGNED", { assigneeId: existing.assigneeId }, { assigneeId, assigneeTaskRoleId: assignee.taskRoleId });
      if (assigneeId !== auth.user!.id) await notifyUser(assigneeId, id, "TASK_REASSIGNED_TO_YOU", `Você recebeu a tarefa "${title}" (reatribuída por ${auth.user!.name}).`);
    }
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
    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const graph = await loadTaskRoleGraph();
    const found = await findVisibleTask(id, graph, viewer, true);
    if (!found) return Response.json({ error: "Tarefa não encontrada." }, { status: 404 });
    if (!found.permissions.canDelete) return Response.json({ error: "Você não possui permissão para excluir esta tarefa." }, { status: 403 });
    if (found.row.deletedAt) return Response.json({ error: "Esta tarefa já está excluída." }, { status: 400 });

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
