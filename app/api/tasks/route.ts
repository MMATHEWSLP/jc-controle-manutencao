import { asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../db";
import { tasks, users } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import {
  applyModuleGate, canSendTo, computeTaskPermissions, isRootRole, loadEverAssigneeTaskIds, loadTaskRoleGraph, loadUserAuthInfo, logTaskAudit,
  type TaskAuthRow, type TaskRoleGraph, type TaskViewer,
} from "../../../lib/task-authorization";

export type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "NOT_DONE";

export const URGENCY_LABELS: Record<Urgency, string> = { LOW: "Baixa", MEDIUM: "Média", HIGH: "Alta", URGENT: "Urgente" };
export const STATUS_LABELS: Record<TaskStatus, string> = { TODO: "Pendente", IN_PROGRESS: "Em andamento", DONE: "Concluída", NOT_DONE: "Não realizada" };

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function isOverdue(dueDate: string, status: string) { return status !== "DONE" && status !== "NOT_DONE" && dueDate < todayIso(); }
function isDueSoon(dueDate: string, status: string) {
  if (status === "DONE" || status === "NOT_DONE" || isOverdue(dueDate, status)) return false;
  const diffDays = Math.round((new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${todayIso()}T00:00:00Z`).getTime()) / 86_400_000);
  return diffDays >= 0 && diffDays <= 2;
}

// `id` informado: busca a tarefa por ID sem filtrar por deletedAt — quem chama decide se uma
// tarefa excluída pode ser exibida (ver findVisibleTask em [id]/route.ts, que só libera acesso a
// participantes legítimos ou ao cargo raiz, conforme a seção 19 da especificação). Sem `id`: lista
// geral, que nunca mostra tarefas excluídas, a menos que `includeDeleted` seja passado (usado pelo
// Histórico, que também preserva tarefas excluídas para quem tinha participação legítima).
export async function loadTaskRows(id?: number, includeDeleted = false) {
  const db = await getDb();
  const assignee = alias(users, "assignee_user");
  const creator = alias(users, "creator_user");
  const query = db.select({
    id: tasks.id, parentTaskId: tasks.parentTaskId, title: tasks.title, description: tasks.description,
    assigneeId: tasks.assigneeId, assigneeName: assignee.name, assigneeTaskRoleId: assignee.taskRoleId,
    urgency: tasks.urgency, dueDate: tasks.dueDate, status: tasks.status,
    createdBy: tasks.createdBy, createdByName: creator.name, createdByTaskRoleId: creator.taskRoleId,
    creatorRoleSnapshotId: tasks.creatorRoleSnapshotId, assigneeRoleSnapshotId: tasks.assigneeRoleSnapshotId,
    completedAt: tasks.completedAt, completedBy: tasks.completedBy, completionNote: tasks.completionNote,
    notDoneAt: tasks.notDoneAt, notDoneBy: tasks.notDoneBy, notDoneReason: tasks.notDoneReason,
    deletedAt: tasks.deletedAt, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
  }).from(tasks)
    .leftJoin(assignee, eq(tasks.assigneeId, assignee.id))
    .leftJoin(creator, eq(tasks.createdBy, creator.id))
    .orderBy(asc(tasks.dueDate));
  if (id) return query.where(eq(tasks.id, id));
  return includeDeleted ? query : query.where(isNull(tasks.deletedAt));
}

export type TaskRow = Awaited<ReturnType<typeof loadTaskRows>>[number];

export function toTaskAuthRow(row: TaskRow): TaskAuthRow {
  return { id: row.id, createdBy: row.createdBy, assigneeId: row.assigneeId, deletedAt: row.deletedAt };
}

type TaskNode = TaskRow & {
  children: TaskNode[]; urgencyLabel: string; statusLabel: string; overdue: boolean; dueSoon: boolean;
  progressPercent: number | null; totalDescendants: number; completedDescendants: number;
  canEdit: boolean; canReassign: boolean; canDelete: boolean; canComplete: boolean; canMarkNotDone: boolean;
  viewerIsCreator: boolean; viewerIsAssignee: boolean;
};

function serializeNode(row: TaskRow, childrenByParent: Map<number, TaskRow[]>, graph: TaskRoleGraph, viewer: TaskViewer, everAssigneeIds: Set<number>, hasEditPermission: boolean): TaskNode {
  const auth = toTaskAuthRow(row);
  const permissions = applyModuleGate(computeTaskPermissions(graph, viewer, auth, row.createdByTaskRoleId, row.assigneeTaskRoleId, everAssigneeIds.has(row.id)), hasEditPermission);
  const children = (childrenByParent.get(row.id) ?? []).map((child) => serializeNode(child, childrenByParent, graph, viewer, everAssigneeIds, hasEditPermission));
  const totalDescendants = children.reduce((sum, child) => sum + child.totalDescendants + 1, 0);
  const completedDescendants = children.reduce((sum, child) => sum + child.completedDescendants + (child.status === "DONE" ? 1 : 0), 0);
  return {
    ...row, children,
    urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
    statusLabel: STATUS_LABELS[row.status as TaskStatus] ?? row.status,
    overdue: isOverdue(row.dueDate, row.status), dueSoon: isDueSoon(row.dueDate, row.status),
    progressPercent: totalDescendants === 0 ? null : Math.round((completedDescendants / totalDescendants) * 100),
    totalDescendants, completedDescendants,
    canEdit: permissions.canEdit, canReassign: permissions.canReassign, canDelete: permissions.canDelete,
    canComplete: permissions.canComplete, canMarkNotDone: permissions.canMarkNotDone,
    viewerIsCreator: row.createdBy === viewer.id, viewerIsAssignee: row.assigneeId === viewer.id,
  };
}

export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const [rows, graph, everAssigneeIds] = await Promise.all([loadTaskRows(), loadTaskRoleGraph(), loadEverAssigneeTaskIds(viewer.id)]);
    // Visibilidade: só entram no conjunto (e, portanto, só aparecem em qualquer lugar da árvore)
    // as tarefas em que o usuário é criador, responsável atual, já foi responsável, cargo raiz,
    // ou tem conexão de visualização/gerenciamento configurada no Gestor de Cargos de Tarefas
    // para o cargo do criador ou do responsável desta tarefa. Nenhuma outra tarefa é exposta,
    // nem mesmo como "contexto" de uma subtarefa visível.
    const visible = rows.filter((row) => computeTaskPermissions(graph, viewer, toTaskAuthRow(row), row.createdByTaskRoleId, row.assigneeTaskRoleId, everAssigneeIds.has(row.id)).canView);
    const visibleIds = new Set(visible.map((row) => row.id));
    const childrenByParent = new Map<number, TaskRow[]>();
    for (const row of visible) { if (row.parentTaskId !== null) { const list = childrenByParent.get(row.parentTaskId) ?? []; list.push(row); childrenByParent.set(row.parentTaskId, list); } }
    const roots = visible.filter((row) => row.parentTaskId === null || !visibleIds.has(row.parentTaskId));
    const hasEditPermission = auth.user!.permissions.includes("tasks.edit");
    const tree = roots.map((row) => serializeNode(row, childrenByParent, graph, viewer, everAssigneeIds, hasEditPermission));

    const db = await getDb();
    const activeUsers = await db.select({ id: users.id, name: users.name, taskRoleId: users.taskRoleId }).from(users).where(eq(users.status, "ACTIVE")).orderBy(asc(users.name));
    const root = isRootRole(graph, viewer.taskRoleId);
    // Só pode ser escolhido como responsável quem pertence a um cargo para o qual o cargo atual
    // do criador tem permissão de envio (ou o criador é o cargo raiz) — seção 10 do spec.
    const assignableUsers = activeUsers.filter((user) => root || canSendTo(graph, viewer.taskRoleId, user.taskRoleId)).map((user) => ({ id: user.id, name: user.name }));
    const canSendAny = root || (graph.connectionsBySource.get(viewer.taskRoleId ?? -1) ?? []).some((connection) => connection.canSend);
    return Response.json({
      tasks: tree, assignableUsers,
      canCreate: auth.user!.permissions.includes("tasks.create") && canSendAny && viewer.taskRoleId !== null,
      viewerHasTaskRole: viewer.taskRoleId !== null,
    });
  } catch (error) {
    console.error("[tasks.get]", error);
    return Response.json({ error: "Não foi possível carregar as tarefas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.create"); if (auth.response) return auth.response;
  try {
    const creatorRoleId = auth.user!.taskRoleId;
    if (creatorRoleId === null) return Response.json({ error: "Seu Cargo de Tarefas ainda não foi configurado. Procure o administrador para regularizar seu cadastro antes de criar tarefas." }, { status: 403 });

    const body = await request.json() as Record<string, unknown>;
    const title = clean(body.title);
    const description = clean(body.description);
    const dueDate = clean(body.dueDate);
    const urgency = clean(body.urgency) || "MEDIUM";
    const assigneeId = Number(body.assigneeId);
    const parentTaskId = body.parentTaskId ? Number(body.parentTaskId) : null;
    if (!title) return Response.json({ error: "Informe o título da tarefa." }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return Response.json({ error: "Informe um prazo de entrega válido." }, { status: 400 });
    if (!(["LOW", "MEDIUM", "HIGH", "URGENT"] as string[]).includes(urgency)) return Response.json({ error: "Selecione um nível de urgência válido." }, { status: 400 });
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) return Response.json({ error: "Selecione um responsável para a tarefa." }, { status: 400 });

    const assignee = await loadUserAuthInfo(assigneeId);
    if (!assignee) return Response.json({ error: "O responsável selecionado não existe." }, { status: 400 });
    if (assignee.status !== "ACTIVE") return Response.json({ error: "O responsável selecionado está inativo." }, { status: 400 });
    if (assignee.taskRoleId === null) return Response.json({ error: "O responsável selecionado ainda não possui Cargo de Tarefas configurado. Peça ao administrador para regularizar o cadastro dele." }, { status: 400 });

    const graph = await loadTaskRoleGraph();
    if (!isRootRole(graph, creatorRoleId) && !canSendTo(graph, creatorRoleId, assignee.taskRoleId)) {
      return Response.json({ error: "Seu cargo de tarefas não tem permissão para enviar tarefas ao cargo deste responsável. Peça ao administrador para configurar essa ligação no Gestor de Cargos de Tarefas." }, { status: 403 });
    }

    const db = await getDb();
    if (parentTaskId) {
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent || parent.deletedAt) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const inserted = (await db.insert(tasks).values({
      parentTaskId, title, description: description || null, assigneeId,
      creatorRoleSnapshotId: creatorRoleId, assigneeRoleSnapshotId: assignee.taskRoleId,
      urgency: urgency as Urgency, dueDate, status: "TODO",
      createdBy: auth.user!.id, updatedAt: now,
    }).returning())[0];
    await logTaskAudit(auth.user!.id, inserted.id, "TASK_CREATED", undefined, { title, assigneeId, dueDate, urgency, parentTaskId, assigneeTaskRoleId: assignee.taskRoleId });
    return Response.json({ message: `Tarefa "${title}" criada.`, id: inserted.id }, { status: 201 });
  } catch (error) {
    console.error("[tasks.post]", error);
    return Response.json({ error: "Não foi possível criar a tarefa." }, { status: 500 });
  }
}
