import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { tasks } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import {
  applyModuleGate, canManageOf, canSendTo, computeTaskPermissions, isRootRole, loadTaskHistory, loadTaskRoleGraph, loadUserAuthInfo, logTaskAudit, wasEverAssignee,
  type TaskPermissions, type TaskRoleGraph, type TaskViewer,
} from "../../../../lib/task-authorization";
import { notifyUser } from "../../../../lib/task-notifications";
import { ACTIONABLE_STATUSES, AWAITING_STATUSES, CLOSED_STATUSES, OPEN_STATUSES, STATUS_LABELS, URGENCY_LABELS, displayStatusLabel, loadTaskRows, toTaskAuthRow, type TaskRow, type TaskStatus, type Urgency } from "../route";

type Context = { params: Promise<{ id: string }> };
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

async function findVisibleTask(id: number, graph: TaskRoleGraph, viewer: TaskViewer, hasEditPermission: boolean) {
  // loadTaskRows(id) não filtra deletedAt — é este método que decide se uma tarefa excluída pode
  // ser exibida (seção 17: preservada só para participantes legítimos e para o cargo raiz).
  const row = (await loadTaskRows(id))[0];
  if (!row) return null;
  const everAssignee = await wasEverAssignee(id, viewer.id);
  const permissions = applyModuleGate(computeTaskPermissions(graph, viewer, toTaskAuthRow(row), row.createdByTaskRoleId, row.assigneeTaskRoleId, everAssignee, row.createdByStatus), hasEditPermission);
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

function serializeDetail(row: TaskRow, permissions: TaskPermissions, root: boolean, graph: TaskRoleGraph) {
  return {
    id: row.id, parentTaskId: row.parentTaskId, title: row.title, description: row.description,
    assigneeId: row.assigneeId, assigneeName: row.assigneeName,
    // Cargo de Tarefas de cada pessoa NO MOMENTO do envio/atribuição (snapshot gravado na própria
    // tarefa) — informativo na ficha, igual ao que o Histórico já exibe (seção 3 da especificação:
    // dado que já existe no banco mas não aparecia aqui).
    assigneeRoleName: row.assigneeRoleSnapshotId ? graph.roles.get(row.assigneeRoleSnapshotId)?.name ?? null : null,
    urgency: row.urgency, urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
    dueDate: row.dueDate, status: row.status, statusLabel: displayStatusLabel(row.status, row.viewedAt),
    createdBy: row.createdBy, createdByName: row.createdByName,
    createdByRoleName: row.creatorRoleSnapshotId ? graph.roles.get(row.creatorRoleSnapshotId)?.name ?? null : null,
    viewedAt: row.viewedAt, viewedBy: row.viewedBy,
    requestedCompletionBy: row.requestedCompletionBy, requestedCompletionAt: row.requestedCompletionAt,
    completedAt: row.completedAt, completedBy: row.completedBy, completionNote: row.completionNote,
    completionApprovedBy: row.completionApprovedBy, completionApprovedAt: row.completionApprovedAt, completionRejectionReason: row.completionRejectionReason,
    requestedNonExecutionBy: row.requestedNonExecutionBy, requestedNonExecutionAt: row.requestedNonExecutionAt,
    notDoneAt: row.notDoneAt, notDoneBy: row.notDoneBy, notDoneReason: row.notDoneReason,
    nonExecutionApprovedBy: row.nonExecutionApprovedBy, nonExecutionApprovedAt: row.nonExecutionApprovedAt, nonExecutionRejectionReason: row.nonExecutionRejectionReason,
    cancelledAt: row.cancelledAt, cancelledBy: row.cancelledBy, cancelReason: row.cancelReason,
    deletedAt: row.deletedAt, deletedBy: row.deletedBy,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    canEdit: permissions.canEdit && !(CLOSED_STATUSES as string[]).includes(row.status),
    canReassign: permissions.canReassign && !(CLOSED_STATUSES as string[]).includes(row.status),
    canDelete: permissions.canDelete,
    canRequestCompletion: permissions.canRequestCompletion && (ACTIONABLE_STATUSES as string[]).includes(row.status),
    canRequestNotDone: permissions.canRequestNotDone && (ACTIONABLE_STATUSES as string[]).includes(row.status),
    canDecide: permissions.canDecide && (AWAITING_STATUSES as string[]).includes(row.status),
    canStart: permissions.canRequestCompletion && row.status === "TODO",
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
    return Response.json({ task: serializeDetail(row, found.permissions, isRootRole(graph, viewer.taskRoleId), graph), history });
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
      if (!permissions.canRequestCompletion) return Response.json({ error: "Somente o responsável pela tarefa pode iniciar a execução." }, { status: 403 });
      if (existing.status !== "TODO") return Response.json({ error: "Esta tarefa não está mais pendente." }, { status: 400 });
      await db.update(tasks).set({ status: "IN_PROGRESS", updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_STARTED", { status: existing.status }, { status: "IN_PROGRESS" });
      return Response.json({ message: `Tarefa "${existing.title}" marcada como em andamento.` });
    }

    // Fluxo de aprovação (seções 12-17): o responsável nunca conclui/não-realiza diretamente —
    // ele SOLICITA (REQUEST_*), e só o criador (ou o cargo raiz, quando o criador não pode
    // decidir — ver `creatorCanDecide`) aprova/rejeita ou autoriza/recusa (APPROVE/REJECT/
    // AUTHORIZE/DENY). Enquanto aguarda, a tarefa permanece na lista ativa (seção 17).

    if (action === "REQUEST_COMPLETION") {
      if (!permissions.canRequestCompletion) return Response.json({ error: "Somente o responsável pela tarefa pode solicitar a conclusão." }, { status: 403 });
      if (!(ACTIONABLE_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Esta tarefa não está em um estado que permita solicitar conclusão." }, { status: 400 });
      const completionNote = clean(body.completionNote);
      if (!completionNote) return Response.json({ error: "Informe a observação da conclusão." }, { status: 400 });
      await db.update(tasks).set({
        status: "AWAITING_COMPLETION_APPROVAL", statusBeforeApprovalRequest: existing.status as "TODO" | "IN_PROGRESS",
        requestedCompletionBy: auth.user!.id, requestedCompletionAt: now, completionNote, completionRejectionReason: null, updatedAt: now,
      }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_COMPLETION_REQUESTED", { status: existing.status }, { status: "AWAITING_COMPLETION_APPROVAL", completionNote });
      if (existing.createdBy && existing.createdBy !== auth.user!.id) await notifyUser(existing.createdBy, id, "TASK_COMPLETION_REQUESTED", `${auth.user!.name} solicitou a conclusão da tarefa "${existing.title}" e aguarda sua aprovação.`);
      return Response.json({ message: `Conclusão da tarefa "${existing.title}" enviada para aprovação.` });
    }

    if (action === "APPROVE_COMPLETION" || action === "REJECT_COMPLETION") {
      if (!permissions.canDecide) return Response.json({ error: "Você não possui permissão para decidir sobre esta tarefa." }, { status: 403 });
      // Idempotência (seção 16): se já não está mais aguardando esta decisão, devolve o estado
      // atual sem gravar nada de novo — evita duplicar aprovação/rejeição em clique duplo.
      if (existing.status !== "AWAITING_COMPLETION_APPROVAL") {
        return Response.json({ message: `Esta tarefa já está com o status "${STATUS_LABELS[existing.status as TaskStatus] ?? existing.status}". Nenhuma nova decisão foi registrada.` });
      }
      if (action === "APPROVE_COMPLETION") {
        await db.update(tasks).set({
          status: "DONE", completedAt: now, completedBy: existing.requestedCompletionBy,
          completionApprovedBy: auth.user!.id, completionApprovedAt: now, completionRejectionReason: null, updatedAt: now,
        }).where(eq(tasks.id, id));
        await logTaskAudit(auth.user!.id, id, "TASK_COMPLETION_APPROVED", { status: existing.status }, { status: "DONE" });
        if (existing.requestedCompletionBy && existing.requestedCompletionBy !== auth.user!.id) await notifyUser(existing.requestedCompletionBy, id, "TASK_COMPLETION_APPROVED", `${auth.user!.name} aprovou a conclusão da tarefa "${existing.title}".`);
        return Response.json({ message: `Conclusão da tarefa "${existing.title}" aprovada.` });
      }
      const completionRejectionReason = clean(body.completionRejectionReason);
      if (!completionRejectionReason) return Response.json({ error: "Informe o motivo da rejeição." }, { status: 400 });
      const revertedStatus = existing.statusBeforeApprovalRequest ?? "IN_PROGRESS";
      await db.update(tasks).set({ status: revertedStatus, completionRejectionReason, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_COMPLETION_REJECTED", { status: existing.status }, { status: revertedStatus, completionRejectionReason });
      if (existing.requestedCompletionBy && existing.requestedCompletionBy !== auth.user!.id) await notifyUser(existing.requestedCompletionBy, id, "TASK_COMPLETION_REJECTED", `${auth.user!.name} rejeitou a conclusão da tarefa "${existing.title}": ${completionRejectionReason}`);
      return Response.json({ message: `Conclusão da tarefa "${existing.title}" rejeitada. A tarefa voltou para "${STATUS_LABELS[revertedStatus as TaskStatus]}".` });
    }

    if (action === "REQUEST_NOT_DONE") {
      if (!permissions.canRequestNotDone) return Response.json({ error: "Somente o responsável pela tarefa pode informar que não será realizada." }, { status: 403 });
      if (!(ACTIONABLE_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Esta tarefa não está em um estado que permita solicitar não realização." }, { status: 400 });
      const notDoneReason = clean(body.notDoneReason);
      if (!notDoneReason) return Response.json({ error: "Informe a justificativa." }, { status: 400 });
      await db.update(tasks).set({
        status: "AWAITING_NOT_DONE_AUTHORIZATION", statusBeforeApprovalRequest: existing.status as "TODO" | "IN_PROGRESS",
        requestedNonExecutionBy: auth.user!.id, requestedNonExecutionAt: now, notDoneReason, nonExecutionRejectionReason: null, updatedAt: now,
      }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_NOT_DONE_REQUESTED", { status: existing.status }, { status: "AWAITING_NOT_DONE_AUTHORIZATION", notDoneReason });
      if (existing.createdBy && existing.createdBy !== auth.user!.id) await notifyUser(existing.createdBy, id, "TASK_NOT_DONE_REQUESTED", `${auth.user!.name} solicitou não realizar a tarefa "${existing.title}" e aguarda sua autorização.`);
      return Response.json({ message: `Pedido de não realização da tarefa "${existing.title}" enviado para autorização.` });
    }

    if (action === "AUTHORIZE_NOT_DONE" || action === "DENY_NOT_DONE") {
      if (!permissions.canDecide) return Response.json({ error: "Você não possui permissão para decidir sobre esta tarefa." }, { status: 403 });
      if (existing.status !== "AWAITING_NOT_DONE_AUTHORIZATION") {
        return Response.json({ message: `Esta tarefa já está com o status "${STATUS_LABELS[existing.status as TaskStatus] ?? existing.status}". Nenhuma nova decisão foi registrada.` });
      }
      if (action === "AUTHORIZE_NOT_DONE") {
        await db.update(tasks).set({
          status: "NOT_DONE", notDoneAt: now, notDoneBy: existing.requestedNonExecutionBy,
          nonExecutionApprovedBy: auth.user!.id, nonExecutionApprovedAt: now, nonExecutionRejectionReason: null, updatedAt: now,
        }).where(eq(tasks.id, id));
        await logTaskAudit(auth.user!.id, id, "TASK_NOT_DONE_AUTHORIZED", { status: existing.status }, { status: "NOT_DONE" });
        if (existing.requestedNonExecutionBy && existing.requestedNonExecutionBy !== auth.user!.id) await notifyUser(existing.requestedNonExecutionBy, id, "TASK_NOT_DONE_AUTHORIZED", `${auth.user!.name} autorizou a não realização da tarefa "${existing.title}".`);
        return Response.json({ message: `Não realização da tarefa "${existing.title}" autorizada.` });
      }
      const nonExecutionRejectionReason = clean(body.nonExecutionRejectionReason);
      if (!nonExecutionRejectionReason) return Response.json({ error: "Informe o motivo da recusa." }, { status: 400 });
      const revertedStatus = existing.statusBeforeApprovalRequest ?? "IN_PROGRESS";
      await db.update(tasks).set({ status: revertedStatus, nonExecutionRejectionReason, updatedAt: now }).where(eq(tasks.id, id));
      await logTaskAudit(auth.user!.id, id, "TASK_NOT_DONE_DENIED", { status: existing.status }, { status: revertedStatus, nonExecutionRejectionReason });
      if (existing.requestedNonExecutionBy && existing.requestedNonExecutionBy !== auth.user!.id) await notifyUser(existing.requestedNonExecutionBy, id, "TASK_NOT_DONE_DENIED", `${auth.user!.name} não autorizou a não realização da tarefa "${existing.title}": ${nonExecutionRejectionReason}. A tarefa continua obrigatória.`);
      return Response.json({ message: `Não realização da tarefa "${existing.title}" recusada. A tarefa voltou para "${STATUS_LABELS[revertedStatus as TaskStatus]}".` });
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
    // (START/REQUEST_COMPLETION/APPROVE_COMPLETION/REJECT_COMPLETION/REQUEST_NOT_DONE/
    // AUTHORIZE_NOT_DONE/DENY_NOT_DONE/CANCEL), cada uma com sua própria trilha de
    // auditoria/notificação.
    // Ficha somente leitura para tarefa encerrada (seção 4/11 da especificação): a checagem no
    // frontend (canEdit) já esconde o botão, mas a validação real é aqui — nunca confiar só na UI.
    if ((CLOSED_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Esta tarefa já foi encerrada (concluída, não realizada ou cancelada) e não pode mais ser editada." }, { status: 400 });
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
      // Nunca reatribuir com um pedido de aprovação em aberto — o novo responsável não foi quem
      // pediu a conclusão/não realização registrada, e decidir/rejeitar depois ficaria confuso.
      if (!(ACTIONABLE_STATUSES as string[]).includes(existing.status)) return Response.json({ error: "Esta tarefa não pode ser reatribuída no status atual (já encerrada ou aguardando uma decisão de aprovação)." }, { status: 400 });
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
