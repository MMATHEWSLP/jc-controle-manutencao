import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../db";
import { tasks, users } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { applyModuleGate, computeTaskPermissions, loadUserAuthInfo, logTaskAudit, type HierarchyLevel, type TaskAuthRow } from "../../../lib/task-authorization";

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

export async function loadTaskRows(id?: number) {
  const db = await getDb();
  const assignee = alias(users, "assignee_user");
  const creator = alias(users, "creator_user");
  const query = db.select({
    id: tasks.id, parentTaskId: tasks.parentTaskId, title: tasks.title, description: tasks.description,
    assigneeId: tasks.assigneeId, assigneeName: assignee.name, assigneeHierarchyLevel: assignee.hierarchyLevel,
    urgency: tasks.urgency, dueDate: tasks.dueDate, status: tasks.status,
    createdBy: tasks.createdBy, createdByName: creator.name, completedAt: tasks.completedAt, completedBy: tasks.completedBy, completionNote: tasks.completionNote,
    notDoneAt: tasks.notDoneAt, notDoneBy: tasks.notDoneBy, notDoneReason: tasks.notDoneReason,
    deletedAt: tasks.deletedAt, createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
  }).from(tasks)
    .leftJoin(assignee, eq(tasks.assigneeId, assignee.id))
    .leftJoin(creator, eq(tasks.createdBy, creator.id))
    .orderBy(asc(tasks.dueDate));
  return id ? query.where(and(eq(tasks.id, id), isNull(tasks.deletedAt))) : query.where(isNull(tasks.deletedAt));
}

export type TaskRow = Awaited<ReturnType<typeof loadTaskRows>>[number];

export function toTaskAuthRow(row: TaskRow): TaskAuthRow {
  return { id: row.id, createdBy: row.createdBy, assigneeId: row.assigneeId, deletedAt: row.deletedAt };
}

type TaskNode = TaskRow & {
  children: TaskNode[]; urgencyLabel: string; statusLabel: string; overdue: boolean; dueSoon: boolean;
  progressPercent: number | null; totalDescendants: number; completedDescendants: number;
  canEdit: boolean; canReassign: boolean; canDelete: boolean; canComplete: boolean; canMarkNotDone: boolean;
};

function serializeNode(row: TaskRow, childrenByParent: Map<number, TaskRow[]>, viewer: { id: number; hierarchyLevel: HierarchyLevel }, hasEditPermission: boolean): TaskNode {
  const permissions = applyModuleGate(computeTaskPermissions(viewer, toTaskAuthRow(row), (row.assigneeHierarchyLevel as HierarchyLevel | null)), hasEditPermission);
  const children = (childrenByParent.get(row.id) ?? []).map((child) => serializeNode(child, childrenByParent, viewer, hasEditPermission));
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
  };
}

export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const viewer = { id: auth.user!.id, hierarchyLevel: auth.user!.hierarchyLevel };
    const rows = await loadTaskRows();
    // Visibilidade: só entram no conjunto (e, portanto, só aparecem em qualquer lugar da árvore)
    // as tarefas em que o usuário é criador, responsável, ou superior hierárquico do responsável.
    // Nenhuma tarefa fora dessas condições é exposta, nem mesmo como "contexto" de uma subtarefa visível.
    const visible = rows.filter((row) => computeTaskPermissions(viewer, toTaskAuthRow(row), row.assigneeHierarchyLevel as HierarchyLevel | null).canView);
    const visibleIds = new Set(visible.map((row) => row.id));
    const childrenByParent = new Map<number, TaskRow[]>();
    for (const row of visible) { if (row.parentTaskId !== null) { const list = childrenByParent.get(row.parentTaskId) ?? []; list.push(row); childrenByParent.set(row.parentTaskId, list); } }
    const roots = visible.filter((row) => row.parentTaskId === null || !visibleIds.has(row.parentTaskId));
    const hasEditPermission = auth.user!.permissions.includes("tasks.edit");
    const tree = roots.map((row) => serializeNode(row, childrenByParent, viewer, hasEditPermission));

    const db = await getDb();
    const assignableUsers = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.status, "ACTIVE")).orderBy(asc(users.name));
    return Response.json({ tasks: tree, assignableUsers, canCreate: auth.user!.permissions.includes("tasks.create") });
  } catch (error) {
    console.error("[tasks.get]", error);
    return Response.json({ error: "Não foi possível carregar as tarefas." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "tasks.create"); if (auth.response) return auth.response;
  try {
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

    const db = await getDb();
    if (parentTaskId) {
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate, deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent || parent.deletedAt) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const inserted = (await db.insert(tasks).values({
      parentTaskId, title, description: description || null, assigneeId,
      urgency: urgency as Urgency, dueDate, status: "TODO",
      createdBy: auth.user!.id, updatedAt: now,
    }).returning())[0];
    await logTaskAudit(auth.user!.id, inserted.id, "TASK_CREATED", undefined, { title, assigneeId, dueDate, urgency, parentTaskId });
    return Response.json({ message: `Tarefa "${title}" criada.`, id: inserted.id }, { status: 201 });
  } catch (error) {
    console.error("[tasks.post]", error);
    return Response.json({ error: "Não foi possível criar a tarefa." }, { status: 500 });
  }
}

