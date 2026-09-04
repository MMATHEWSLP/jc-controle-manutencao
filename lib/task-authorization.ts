// Módulo central de autorização do módulo Tarefas.
//
// Todas as rotas de API de Tarefas (app/api/tasks/**) e do Gestor de Cargos de Tarefas
// (app/api/task-roles/**) devem usar exclusivamente as funções daqui para decidir quem pode
// ver, editar, reatribuir, concluir, marcar como não realizada, excluir uma tarefa, ou enviar
// tarefas para um cargo — nunca reimplementar essa lógica em cada rota. Isso evita regras
// divergentes entre telas/endpoints (exigência explícita da especificação).
//
// Modelo (substitui a hierarquia numérica implícita usada antes): cada usuário tem um
// Cargo de Tarefas (`users.taskRoleId`, tabela `task_roles`), independente do `role` (perfil)
// que já existia e continua controlando as permissões de tela/ação em todo o restante do
// sistema. As permissões entre cargos vêm exclusivamente das conexões configuradas no Gestor
// de Cargos de Tarefas (`task_role_connections`) — nada é concedido automaticamente por um
// cargo estar "acima" de outro na ordem visual. O único cargo com acesso global é o cargo raiz
// (`is_root`), equivalente ao antigo ADMIN.

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, taskRoleConnections, taskRoles, users } from "../db/schema";

export type TaskRoleRow = { id: number; name: string; visualOrder: number; isRoot: boolean; active: boolean };
export type TaskRoleConnectionRow = {
  id: number; sourceRoleId: number; targetRoleId: number;
  canSend: boolean; canViewReceived: boolean; canViewSent: boolean; canManage: boolean;
  createdBy: number | null; updatedBy: number | null; createdAt: string; updatedAt: string;
};

export type TaskRoleGraph = {
  roles: Map<number, TaskRoleRow>;
  rootRoleId: number | null;
  connectionsBySource: Map<number, TaskRoleConnectionRow[]>;
};

// Carrega todos os cargos (ativos e inativos — quem chama decide o que exibir) e todas as
// conexões numa única leitura, para reaproveitar em várias checagens de permissão sem repetir
// consultas. Barato o suficiente para carregar a cada requisição neste porte de sistema.
export async function loadTaskRoleGraph(): Promise<TaskRoleGraph> {
  const db = await getDb();
  const [roleRows, connectionRows] = await Promise.all([
    db.select().from(taskRoles).orderBy(asc(taskRoles.visualOrder)),
    db.select().from(taskRoleConnections),
  ]);
  const roles = new Map(roleRows.map((row) => [row.id, row as TaskRoleRow]));
  const rootRoleId = roleRows.find((row) => row.isRoot && row.active)?.id ?? null;
  const connectionsBySource = new Map<number, TaskRoleConnectionRow[]>();
  for (const row of connectionRows) {
    const list = connectionsBySource.get(row.sourceRoleId) ?? [];
    list.push(row as TaskRoleConnectionRow);
    connectionsBySource.set(row.sourceRoleId, list);
  }
  return { roles, rootRoleId, connectionsBySource };
}

function connectionBetween(graph: TaskRoleGraph, sourceRoleId: number, targetRoleId: number) {
  return graph.connectionsBySource.get(sourceRoleId)?.find((row) => row.targetRoleId === targetRoleId) ?? null;
}

// Cargo raiz: única exceção às regras de conexão — acesso global, explícito e auditável (nunca
// concedido "por engano" a outro cargo, mesmo que ele esteja no topo da ordem visual).
export function isRootRole(graph: TaskRoleGraph, roleId: number | null): boolean {
  return roleId !== null && roleId === graph.rootRoleId;
}

// "A pode enviar para B" — usado ao criar/reatribuir tarefas. Não implica o inverso (B enviar
// para A) nem é transitivo (A→B e B→C não autoriza A→C).
export function canSendTo(graph: TaskRoleGraph, sourceRoleId: number | null, targetRoleId: number | null): boolean {
  if (sourceRoleId === null || targetRoleId === null) return false;
  if (isRootRole(graph, sourceRoleId)) return true;
  return connectionBetween(graph, sourceRoleId, targetRoleId)?.canSend ?? false;
}

// "A pode visualizar as tarefas RECEBIDAS pelo cargo B" (tarefas em que alguém de B é o
// responsável). Gerenciar implica visualizar; visualizar não implica gerenciar.
export function canViewReceivedOf(graph: TaskRoleGraph, viewerRoleId: number | null, targetRoleId: number | null): boolean {
  if (viewerRoleId === null || targetRoleId === null) return false;
  if (isRootRole(graph, viewerRoleId)) return true;
  const row = connectionBetween(graph, viewerRoleId, targetRoleId);
  return Boolean(row && (row.canViewReceived || row.canManage));
}

// "A pode visualizar as tarefas ENVIADAS pelo cargo B" (tarefas em que alguém de B é o
// criador). Somente leitura — nunca concede edição, reatribuição ou exclusão.
export function canViewSentOf(graph: TaskRoleGraph, viewerRoleId: number | null, targetRoleId: number | null): boolean {
  if (viewerRoleId === null || targetRoleId === null) return false;
  if (isRootRole(graph, viewerRoleId)) return true;
  return connectionBetween(graph, viewerRoleId, targetRoleId)?.canViewSent ?? false;
}

// "A pode gerenciar as tarefas RECEBIDAS pelo cargo B" — editar, reatribuir, excluir, consultar
// histórico completo. Só se aplica ao lado "responsável" (recebidas), nunca ao lado "criador".
export function canManageOf(graph: TaskRoleGraph, viewerRoleId: number | null, targetRoleId: number | null): boolean {
  if (viewerRoleId === null || targetRoleId === null) return false;
  if (isRootRole(graph, viewerRoleId)) return true;
  return connectionBetween(graph, viewerRoleId, targetRoleId)?.canManage ?? false;
}

export type TaskAuthRow = { id: number; createdBy: number | null; assigneeId: number | null; deletedAt: string | null };
export type TaskViewer = { id: number; taskRoleId: number | null };

export function isTaskCreator(viewer: TaskViewer, task: TaskAuthRow) {
  return task.createdBy !== null && task.createdBy === viewer.id;
}
export function isTaskAssignee(viewer: TaskViewer, task: TaskAuthRow) {
  return task.assigneeId !== null && task.assigneeId === viewer.id;
}

export type TaskPermissions = { canView: boolean; canEdit: boolean; canReassign: boolean; canDelete: boolean; canComplete: boolean; canMarkNotDone: boolean };

// Todas as ações mutáveis (editar, reatribuir, excluir, concluir, marcar como não realizada)
// exigem, além da regra de cargo, que o usuário tenha a permissão de módulo "tasks.edit" —
// a mesma condição que a rota de API já verifica antes de aceitar qualquer PUT/DELETE.
export function applyModuleGate(permissions: TaskPermissions, hasEditPermission: boolean): TaskPermissions {
  if (hasEditPermission) return permissions;
  return { ...permissions, canEdit: false, canReassign: false, canDelete: false, canComplete: false, canMarkNotDone: false };
}

// creatorRoleId/assigneeRoleId aqui são o cargo ATUAL de cada pessoa (não o snapshot gravado na
// tarefa) — ver o comentário em db/schema.ts: a autorização sempre reflete a estrutura de cargos
// vigente agora, para que uma mudança de cargo produza efeito imediato sem reescrever tarefas.
// `everAssignee` cobre a regra "quem já foi responsável pode consultar sua participação
// histórica" (seção 16.2) — calculado a partir do histórico de auditoria pelo chamador.
export function computeTaskPermissions(
  graph: TaskRoleGraph,
  viewer: TaskViewer,
  task: TaskAuthRow,
  creatorRoleId: number | null,
  assigneeRoleId: number | null,
  everAssignee: boolean,
): TaskPermissions {
  const creator = isTaskCreator(viewer, task);
  const assignee = isTaskAssignee(viewer, task);
  const root = isRootRole(graph, viewer.taskRoleId);
  const managesAssignee = canManageOf(graph, viewer.taskRoleId, assigneeRoleId);
  const managerRole = creator || managesAssignee || root;
  const canView = creator || assignee || everAssignee || root || managesAssignee
    || canViewReceivedOf(graph, viewer.taskRoleId, assigneeRoleId)
    || canViewSentOf(graph, viewer.taskRoleId, creatorRoleId);
  return {
    canView,
    canEdit: managerRole,
    canReassign: managerRole,
    canDelete: managerRole,
    // Concluir/Não realizar é sempre uma ação do responsável ATUAL — nem o criador, nem um
    // gerenciador autorizado, nem o cargo raiz podem executá-la em nome de outra pessoa; só
    // acumulam a permissão quando também são, eles próprios, o responsável (seção 17/18).
    canComplete: assignee,
    canMarkNotDone: assignee,
  };
}

export type UserAuthInfo = { id: number; status: "ACTIVE" | "INACTIVE"; taskRoleId: number | null };

export async function loadUserAuthInfo(userId: number): Promise<UserAuthInfo | null> {
  const db = await getDb();
  const row = (await db.select({ id: users.id, status: users.status, taskRoleId: users.taskRoleId }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return row ?? null;
}

export async function loadUserAuthInfoMap(userIds: number[]): Promise<Map<number, UserAuthInfo>> {
  const uniqueIds = [...new Set(userIds)];
  const map = new Map<number, UserAuthInfo>();
  if (uniqueIds.length === 0) return map;
  const db = await getDb();
  const rows = await db.select({ id: users.id, status: users.status, taskRoleId: users.taskRoleId }).from(users).where(inArray(users.id, uniqueIds));
  for (const row of rows) map.set(row.id, row);
  return map;
}

// Só o ADMIN (role de perfil) pode definir/alterar o Cargo de Tarefas de outro usuário,
// e ninguém — nem o próprio ADMIN — pode alterar o próprio cargo.
export function canChangeTaskRole(actor: { id: number; profile: string }, targetUserId: number) {
  if (actor.id === targetUserId) return false;
  return actor.profile === "ADMIN";
}

// "Já foi responsável": varre uma única vez os eventos TASK_CREATED/TASK_REASSIGNED de todas as
// tarefas (o `assigneeId` fica registrado em previousValue/newValue de cada evento) e devolve o
// conjunto de tarefas em que este usuário apareceu como responsável em algum momento — mesmo que
// hoje não seja mais. Usado para preservar o acesso ao Histórico de Recebidas após reatribuição
// (seção 13.1/16.2), sem precisar de uma tabela paralela.
export async function loadEverAssigneeTaskIds(userId: number): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.select({ entityId: auditLogs.entityId, previousValue: auditLogs.previousValue, newValue: auditLogs.newValue })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "TASK"), inArray(auditLogs.action, ["TASK_CREATED", "TASK_REASSIGNED"])));
  const ids = new Set<number>();
  for (const row of rows) {
    for (const raw of [row.previousValue, row.newValue]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Number(parsed.assigneeId) === userId) ids.add(Number(row.entityId));
      } catch { /* entradas antigas/malformadas são ignoradas, nunca derrubam a consulta */ }
    }
  }
  return ids;
}

// Auditoria do Gestor de Cargos de Tarefas (seção 22): criação/edição/desativação de cargo e
// alterações no mapa de conexões. Mesma tabela `audit_logs`, entidade própria "TASK_ROLE" para
// não se misturar com o histórico de tarefas ("TASK") nem de usuários ("USER").
export async function logRoleAudit(actorId: number, entityId: string, action: string, previousValue?: unknown, newValue?: unknown) {
  const db = await getDb();
  await db.insert(auditLogs).values({
    userId: actorId, entityType: "TASK_ROLE", entityId, action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

// Mesma regra de `loadEverAssigneeTaskIds`, mas restrita a UMA tarefa — mais barato quando só se
// precisa saber se este usuário já foi responsável desta tarefa específica (checagem de acesso
// em GET/PUT/DELETE de /api/tasks/[id]).
export async function wasEverAssignee(taskId: number, userId: number): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select({ previousValue: auditLogs.previousValue, newValue: auditLogs.newValue })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "TASK"), eq(auditLogs.entityId, String(taskId)), inArray(auditLogs.action, ["TASK_CREATED", "TASK_REASSIGNED"])));
  for (const row of rows) {
    for (const raw of [row.previousValue, row.newValue]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (Number(parsed.assigneeId) === userId) return true;
      } catch { /* entradas antigas/malformadas são ignoradas */ }
    }
  }
  return false;
}

// Histórico de tarefas: reaproveita a tabela genérica `audit_logs` já existente no sistema
// (mesma usada para o histórico de usuários) em vez de criar uma tabela paralela.
// Fica imutável para usuários comuns porque não existe nenhuma rota de API que
// atualize ou apague linhas de audit_logs — só inserção.
//
// Cada evento carrega também um retrato do ator no momento da ação (nome, função profissional
// e Cargo de Tarefas) dentro de `newValue`, atendendo à seção 15 sem precisar de colunas novas.
export async function logTaskAudit(actorId: number, taskId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  const db = await getDb();
  const actor = (await db.select({ name: users.name, profile: users.role, taskRoleId: users.taskRoleId }).from(users).where(eq(users.id, actorId)).limit(1))[0];
  const roleName = actor?.taskRoleId
    ? (await db.select({ name: taskRoles.name }).from(taskRoles).where(eq(taskRoles.id, actor.taskRoleId)).limit(1))[0]?.name ?? null
    : null;
  const actorSnapshot = { actorName: actor?.name ?? null, actorProfessionalRole: actor?.profile ?? null, actorTaskRoleId: actor?.taskRoleId ?? null, actorTaskRoleName: roleName };
  const enrichedNewValue = { ...(newValue && typeof newValue === "object" ? newValue as Record<string, unknown> : {}), ...actorSnapshot };
  await db.insert(auditLogs).values({
    userId: actorId, entityType: "TASK", entityId: String(taskId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: JSON.stringify(enrichedNewValue),
  });
}

export type TaskHistoryEntry = { id: number; userId: number | null; userName: string | null; action: string; previousValue: string | null; newValue: string | null; occurredAt: string };

export async function loadTaskHistory(taskId: number): Promise<TaskHistoryEntry[]> {
  const db = await getDb();
  return db.select({
    id: auditLogs.id, userId: auditLogs.userId, userName: users.name, action: auditLogs.action,
    previousValue: auditLogs.previousValue, newValue: auditLogs.newValue, occurredAt: auditLogs.occurredAt,
  }).from(auditLogs).leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(eq(auditLogs.entityType, "TASK"), eq(auditLogs.entityId, String(taskId))))
    .orderBy(asc(auditLogs.occurredAt));
}
