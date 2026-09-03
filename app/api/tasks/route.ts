import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../db";
import { tasks, users } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";

export type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";

export const URGENCY_LABELS: Record<Urgency, string> = { LOW:"Baixa", MEDIUM:"Média", HIGH:"Alta", URGENT:"Urgente" };
export const STATUS_LABELS: Record<TaskStatus, string> = { TODO:"A fazer", IN_PROGRESS:"Em andamento", DONE:"Concluída" };

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function isOverdue(dueDate: string, status: string) { return status !== "DONE" && dueDate < todayIso(); }
function isDueSoon(dueDate: string, status: string) {
  if (status === "DONE" || isOverdue(dueDate, status)) return false;
  const diffDays = Math.round((new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${todayIso()}T00:00:00Z`).getTime()) / 86_400_000);
  return diffDays >= 0 && diffDays <= 2;
}

export async function loadTaskRows() {
  const db = await getDb();
  const assignee = alias(users, "assignee_user");
  const creator = alias(users, "creator_user");
  return db.select({
    id: tasks.id, parentTaskId: tasks.parentTaskId, title: tasks.title, description: tasks.description,
    assigneeId: tasks.assigneeId, assigneeName: assignee.name,
    urgency: tasks.urgency, dueDate: tasks.dueDate, status: tasks.status,
    createdBy: tasks.createdBy, createdByName: creator.name, completedAt: tasks.completedAt,
    createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
  }).from(tasks)
    .leftJoin(assignee, eq(tasks.assigneeId, assignee.id))
    .leftJoin(creator, eq(tasks.createdBy, creator.id))
    .orderBy(asc(tasks.dueDate));
}

type TaskRow = Awaited<ReturnType<typeof loadTaskRows>>[number];

function scopedRows(rows: TaskRow[], userId: number, manage: boolean) {
  if (manage) return rows.map((row) => ({ ...row, contextOnly: false }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) { if (row.parentTaskId !== null) { const list = childrenOf.get(row.parentTaskId) ?? []; list.push(row.id); childrenOf.set(row.parentTaskId, list); } }
  const isOwned = (row: TaskRow) => row.assigneeId === userId || row.createdBy === userId;
  const fullAccess = new Set<number>(rows.filter(isOwned).map((row) => row.id));
  const queue = [...fullAccess];
  let index = 0;
  while (index < queue.length) {
    const current = queue[index]; index += 1;
    for (const childId of childrenOf.get(current) ?? []) if (!fullAccess.has(childId)) { fullAccess.add(childId); queue.push(childId); }
  }
  const contextOnly = new Set<number>();
  for (const id of fullAccess) {
    let node = byId.get(id);
    while (node && node.parentTaskId !== null) {
      const parentId: number = node.parentTaskId;
      if (!fullAccess.has(parentId)) contextOnly.add(parentId);
      node = byId.get(parentId);
    }
  }
  const includedIds = new Set([...fullAccess, ...contextOnly]);
  return rows.filter((row) => includedIds.has(row.id)).map((row) => ({ ...row, contextOnly: contextOnly.has(row.id) }));
}

type ScopedRow = ReturnType<typeof scopedRows>[number];
type TaskNode = ScopedRow & { editable: boolean; children: TaskNode[]; urgencyLabel: string; statusLabel: string; overdue: boolean; dueSoon: boolean; progressPercent: number | null; totalDescendants: number; completedDescendants: number };

function serializeNode(row: ScopedRow, childrenByParent: Map<number, ScopedRow[]>, userId: number, manage: boolean): TaskNode {
  const children = (childrenByParent.get(row.id) ?? []).map((child) => serializeNode(child, childrenByParent, userId, manage));
  const totalDescendants = children.reduce((sum, child) => sum + child.totalDescendants + 1, 0);
  const completedDescendants = children.reduce((sum, child) => sum + child.completedDescendants + (child.status === "DONE" ? 1 : 0), 0);
  return {
    ...row, children,
    editable: manage || row.assigneeId === userId || row.createdBy === userId,
    urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
    statusLabel: STATUS_LABELS[row.status as TaskStatus] ?? row.status,
    overdue: isOverdue(row.dueDate, row.status), dueSoon: isDueSoon(row.dueDate, row.status),
    progressPercent: totalDescendants === 0 ? null : Math.round((completedDescendants / totalDescendants) * 100),
    totalDescendants, completedDescendants,
  };
}

export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const manage = auth.user!.permissions.includes("tasks.manage");
    const rows = await loadTaskRows();
    const scoped = scopedRows(rows, auth.user!.id, manage);
    const scopedIds = new Set(scoped.map((row) => row.id));
    const childrenByParent = new Map<number, ScopedRow[]>();
    for (const row of scoped) { if (row.parentTaskId !== null) { const list = childrenByParent.get(row.parentTaskId) ?? []; list.push(row); childrenByParent.set(row.parentTaskId, list); } }
    const roots = scoped.filter((row) => row.parentTaskId === null || !scopedIds.has(row.parentTaskId));
    const tree = roots.map((row) => serializeNode(row, childrenByParent, auth.user!.id, manage));

    const db = await getDb();
    const assignableUsers = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.status, "ACTIVE")).orderBy(asc(users.name));
    return Response.json({
      tasks: tree, assignableUsers,
      canCreate: auth.user!.permissions.includes("tasks.create"), canEdit: auth.user!.permissions.includes("tasks.edit"), manage,
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
    const body = await request.json() as Record<string, unknown>;
    const title = clean(body.title);
    const description = clean(body.description);
    const dueDate = clean(body.dueDate);
    const urgency = clean(body.urgency) || "MEDIUM";
    const status = clean(body.status) || "TODO";
    const assigneeId = body.assigneeId ? Number(body.assigneeId) : null;
    const parentTaskId = body.parentTaskId ? Number(body.parentTaskId) : null;
    if (!title) return Response.json({ error: "Informe o título da tarefa." }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return Response.json({ error: "Informe um prazo de entrega válido." }, { status: 400 });
    if (!(["LOW", "MEDIUM", "HIGH", "URGENT"] as string[]).includes(urgency)) return Response.json({ error: "Selecione um nível de urgência válido." }, { status: 400 });
    if (!(["TODO", "IN_PROGRESS", "DONE"] as string[]).includes(status)) return Response.json({ error: "Selecione um status válido." }, { status: 400 });

    const db = await getDb();
    if (parentTaskId) {
      const parent = (await db.select({ id: tasks.id, dueDate: tasks.dueDate }).from(tasks).where(eq(tasks.id, parentTaskId)).limit(1))[0];
      if (!parent) return Response.json({ error: "Tarefa principal não encontrada." }, { status: 400 });
      if (dueDate > parent.dueDate) return Response.json({ error: "O prazo da subtarefa não pode ser posterior ao prazo da tarefa principal." }, { status: 400 });
    }
    if (assigneeId) {
      const assignee = (await db.select({ id: users.id }).from(users).where(eq(users.id, assigneeId)).limit(1))[0];
      if (!assignee) return Response.json({ error: "Responsável selecionado não encontrado." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const inserted = (await db.insert(tasks).values({
      parentTaskId, title, description: description || null, assigneeId,
      urgency: urgency as Urgency, dueDate, status: status as TaskStatus,
      createdBy: auth.user!.id, completedAt: status === "DONE" ? now : null, updatedAt: now,
    }).returning())[0];
    return Response.json({ message: `Tarefa "${title}" criada.`, id: inserted.id }, { status: 201 });
  } catch (error) {
    console.error("[tasks.post]", error);
    return Response.json({ error: "Não foi possível criar a tarefa." }, { status: 500 });
  }
}
