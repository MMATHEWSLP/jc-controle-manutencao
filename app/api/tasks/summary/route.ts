import { isRootRole, loadTaskRoleGraph, type TaskViewer } from "../../../../lib/task-authorization";
import { authorize } from "../../../../lib/auth";
import { loadTaskRows } from "../route";

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isOverdue(dueDate: string, status: string) { return status !== "DONE" && status !== "NOT_DONE" && status !== "CANCELLED" && dueDate < todayIso(); }

// Painel resumido (seção 19) — sempre restrito ao que o próprio usuário (ou, para o cargo raiz,
// o usuário/cargo escolhido no filtro) pode ver. Nunca soma tarefas de terceiros para quem não é
// ADMIN/cargo raiz: `targetUserId`/`targetRoleId` só têm efeito quando o requisitante é raiz.
export async function GET(request: Request) {
  const auth = await authorize(request, "tasks.view"); if (auth.response) return auth.response;
  try {
    const viewer: TaskViewer = { id: auth.user!.id, taskRoleId: auth.user!.taskRoleId };
    const graph = await loadTaskRoleGraph();
    const root = isRootRole(graph, viewer.taskRoleId);

    const url = new URL(request.url);
    const requestedUserId = Number(url.searchParams.get("userId"));
    const requestedRoleId = Number(url.searchParams.get("roleId"));
    const from = url.searchParams.get("from") ?? `${todayIso().slice(0, 7)}-01`;
    const to = url.searchParams.get("to") ?? todayIso();

    const rows = await loadTaskRows();
    const byUser = root && Number.isInteger(requestedUserId) && requestedUserId > 0 ? requestedUserId : viewer.id;
    const byRole = root && Number.isInteger(requestedRoleId) && requestedRoleId > 0 ? requestedRoleId : null;

    const isReceived = (row: typeof rows[number]) => byRole !== null ? row.assigneeTaskRoleId === byRole : row.assigneeId === byUser;
    const isSent = (row: typeof rows[number]) => byRole !== null ? row.createdByTaskRoleId === byRole : row.createdBy === byUser;
    const inPeriod = (row: typeof rows[number]) => row.createdAt.slice(0, 10) >= from && row.createdAt.slice(0, 10) <= to;

    const received = rows.filter(isReceived);
    const sent = rows.filter(isSent);

    const summary = {
      receivedPending: received.filter((row) => row.status === "TODO").length,
      receivedInProgress: received.filter((row) => row.status === "IN_PROGRESS").length,
      receivedOverdue: received.filter((row) => isOverdue(row.dueDate, row.status)).length,
      sentAwaitingResponse: sent.filter((row) => row.status === "TODO" || row.status === "IN_PROGRESS").length,
      completedInPeriod: received.filter((row) => row.status === "DONE" && inPeriod(row)).length,
      notDoneInPeriod: received.filter((row) => row.status === "NOT_DONE" && inPeriod(row)).length,
    };
    return Response.json({ summary, scope: byRole !== null ? { roleId: byRole } : { userId: byUser }, period: { from, to } });
  } catch (error) {
    console.error("[tasks.summary.get]", error);
    return Response.json({ error: "Não foi possível carregar o painel resumido." }, { status: 500 });
  }
}
