import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { auditLogs, taskRoles } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";
import {
  canManageOf, canViewReceivedOf, canViewSentOf, isRootRole, loadEverAssigneeTaskIds, loadTaskRoleGraph, type TaskViewer,
} from "../../../../lib/task-authorization";
import { OPEN_STATUSES, URGENCY_LABELS, displayStatusLabel, loadTaskRows, type Urgency } from "../route";

function clean(value: string | null) { return (value ?? "").trim(); }

// Histórico individual de Tarefas — seção 13. Duas visões (scope=received/sent), sempre
// centradas no usuário autenticado: por padrão só as tarefas em que ele mesmo participou
// (responsável atual ou já foi responsável, para "received"; criador, para "sent"). Um terceiro
// só entra na lista por conexão de visualizar/gerenciar do Gestor de Cargos de Tarefas — e,
// nesse caso, nunca vê tarefas excluídas (essas ficam só com os participantes legítimos e o
// cargo raiz, seção 19). Diferente da lista principal (GET /api/tasks), inclui tarefas excluídas
// e não monta árvore: cada linha é independente, pensada para busca/filtro/exportação.
export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "sent" ? "sent" : "received";
    const q = clean(url.searchParams.get("q")).toLocaleLowerCase("pt-BR");
    const status = clean(url.searchParams.get("status"));
    const urgency = clean(url.searchParams.get("urgency"));
    const roleId = Number(url.searchParams.get("roleId"));
    const creatorId = Number(url.searchParams.get("creatorId"));
    const assigneeId = Number(url.searchParams.get("assigneeId"));
    const from = clean(url.searchParams.get("from"));
    const to = clean(url.searchParams.get("to"));
    const overdueOnly = url.searchParams.get("overdueOnly") === "1";

    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const [rows, graph, everAssigneeIds, roleRows] = await Promise.all([
      loadTaskRows(undefined, true), loadTaskRoleGraph(), loadEverAssigneeTaskIds(viewer.id), (await getDb()).select().from(taskRoles),
    ]);
    const roleNameById = new Map(roleRows.map((role) => [role.id, role.name]));
    const root = isRootRole(graph, viewer.taskRoleId);

    type Entry = typeof rows[number] & { historyStatus: string; historyStatusLabel: string; reassignedAt: string | null; creatorRoleName: string | null; assigneeRoleName: string | null };
    const visible: Entry[] = [];
    for (const row of rows) {
      const isParticipant = scope === "received"
        ? (row.assigneeId === viewer.id || everAssigneeIds.has(row.id))
        : row.createdBy === viewer.id;
      const thirdPartyView = scope === "received"
        ? (canViewReceivedOf(graph, viewer.taskRoleId, row.assigneeTaskRoleId) || canManageOf(graph, viewer.taskRoleId, row.assigneeTaskRoleId))
        : canViewSentOf(graph, viewer.taskRoleId, row.createdByTaskRoleId);
      const visibleHere = root || isParticipant || (thirdPartyView && !row.deletedAt);
      if (!visibleHere) continue;
      const wasReassignedAway = scope === "received" && row.assigneeId !== viewer.id && everAssigneeIds.has(row.id) && !root;
      visible.push({
        ...row,
        historyStatus: wasReassignedAway ? "REASSIGNED" : row.status,
        historyStatusLabel: wasReassignedAway ? "Reatribuída" : displayStatusLabel(row.status, row.viewedAt),
        reassignedAt: null,
        creatorRoleName: row.creatorRoleSnapshotId ? roleNameById.get(row.creatorRoleSnapshotId) ?? null : null,
        assigneeRoleName: row.assigneeRoleSnapshotId ? roleNameById.get(row.assigneeRoleSnapshotId) ?? null : null,
      });
    }

    // Para as linhas "Reatribuída", busca a data em que ESTE usuário deixou de ser o responsável
    // (evento TASK_REASSIGNED cujo previousValue.assigneeId é o próprio usuário).
    const reassignedIds = visible.filter((row) => row.historyStatus === "REASSIGNED").map((row) => row.id);
    if (reassignedIds.length > 0) {
      const db = await getDb();
      const events = await db.select({ entityId: auditLogs.entityId, previousValue: auditLogs.previousValue, occurredAt: auditLogs.occurredAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, "TASK"), eq(auditLogs.action, "TASK_REASSIGNED"), inArray(auditLogs.entityId, reassignedIds.map(String))));
      const dateByTaskId = new Map<number, string>();
      for (const event of events) {
        if (!event.previousValue) continue;
        try {
          const parsed = JSON.parse(event.previousValue) as Record<string, unknown>;
          if (Number(parsed.assigneeId) === viewer.id) dateByTaskId.set(Number(event.entityId), event.occurredAt);
        } catch { /* ignora entradas malformadas */ }
      }
      for (const row of visible) if (row.historyStatus === "REASSIGNED") row.reassignedAt = dateByTaskId.get(row.id) ?? null;
    }

    const filtered = visible.filter((row) => {
      if (status && row.status !== status) return false;
      if (urgency && row.urgency !== urgency) return false;
      if (Number.isInteger(creatorId) && creatorId > 0 && row.createdBy !== creatorId) return false;
      if (Number.isInteger(assigneeId) && assigneeId > 0 && row.assigneeId !== assigneeId) return false;
      if (Number.isInteger(roleId) && roleId > 0) {
        const relevantRoleId = scope === "received" ? row.assigneeTaskRoleId : row.createdByTaskRoleId;
        if (relevantRoleId !== roleId) return false;
      }
      if (from && row.createdAt.slice(0, 10) < from) return false;
      if (to && row.createdAt.slice(0, 10) > to) return false;
      if (overdueOnly && !((OPEN_STATUSES as string[]).includes(row.status) && row.dueDate < new Date().toISOString().slice(0, 10))) return false;
      if (q) { const haystack = `${row.title} ${row.assigneeName ?? ""} ${row.createdByName ?? ""}`.toLocaleLowerCase("pt-BR"); if (!haystack.includes(q)) return false; }
      return true;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return Response.json({
      scope,
      entries: filtered.map((row) => ({
        id: row.id, title: row.title, description: row.description,
        assigneeId: row.assigneeId, assigneeName: row.assigneeName, assigneeRoleName: row.assigneeRoleName,
        createdBy: row.createdBy, createdByName: row.createdByName, creatorRoleName: row.creatorRoleName,
        urgency: row.urgency, urgencyLabel: URGENCY_LABELS[row.urgency as Urgency] ?? row.urgency,
        dueDate: row.dueDate, status: row.historyStatus, statusLabel: row.historyStatusLabel,
        reassignedAt: row.reassignedAt, deletedAt: row.deletedAt,
        completionNote: row.completionNote, notDoneReason: row.notDoneReason, cancelReason: row.cancelReason,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      })),
      taskRoles: roleRows.map((role) => ({ id: role.id, name: role.name })),
    });
  } catch (error) {
    console.error("[tasks.history.get]", error);
    return Response.json({ error: "Não foi possível carregar o histórico de tarefas." }, { status: 500 });
  }
}
