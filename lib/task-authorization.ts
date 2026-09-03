// Módulo central de autorização do módulo Tarefas.
//
// Todas as rotas de API de Tarefas (app/api/tasks/**) devem usar exclusivamente as funções
// daqui para decidir quem pode ver, editar, reatribuir, concluir, marcar como não realizada
// ou excluir uma tarefa — nunca reimplementar essa lógica em cada rota. Isso evita regras
// divergentes entre telas/endpoints (exigência explícita da especificação).
//
// A hierarquia usada aqui (`hierarchyLevel`) é um conceito NOVO, separado do `role` (perfil)
// que já existia no sistema e continua controlando as permissões de tela/ação em todo o
// restante do sistema (equipment.*, fleet.*, materials.*, tasks.view/create/edit, etc.).
// Ver o campo `hierarchyLevel` em db/schema.ts (tabela `users`) para mais contexto.

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, users } from "../db/schema";

export type HierarchyLevel = "ADMIN" | "GESTOR" | "SUB1" | "SUB2" | "SUB3" | "USUARIO";

// Ordem exata pedida: índice menor = autoridade maior.
export const HIERARCHY_LEVELS: HierarchyLevel[] = ["ADMIN", "GESTOR", "SUB1", "SUB2", "SUB3", "USUARIO"];
export const HIERARCHY_LABELS: Record<HierarchyLevel, string> = { ADMIN: "Admin", GESTOR: "Gestor", SUB1: "Sub 1", SUB2: "Sub 2", SUB3: "Sub 3", USUARIO: "Usuário" };
const HIERARCHY_RANK: Record<HierarchyLevel, number> = Object.fromEntries(HIERARCHY_LEVELS.map((level, index) => [level, index])) as Record<HierarchyLevel, number>;

export function isHierarchyLevel(value: unknown): value is HierarchyLevel {
  return typeof value === "string" && (HIERARCHY_LEVELS as string[]).includes(value);
}

// Estritamente superior — o mesmo nível NUNCA é superior a si mesmo.
export function isSuperiorLevel(viewerLevel: HierarchyLevel, targetLevel: HierarchyLevel) {
  return HIERARCHY_RANK[viewerLevel] < HIERARCHY_RANK[targetLevel];
}

export type TaskAuthRow = { id: number; createdBy: number | null; assigneeId: number | null; deletedAt: string | null };
export type TaskViewer = { id: number; hierarchyLevel: HierarchyLevel };

export function isTaskCreator(viewer: TaskViewer, task: TaskAuthRow) {
  return task.createdBy !== null && task.createdBy === viewer.id;
}
export function isTaskAssignee(viewer: TaskViewer, task: TaskAuthRow) {
  return task.assigneeId !== null && task.assigneeId === viewer.id;
}
// `assigneeLevel` é o nível hierárquico do responsável atual da tarefa — precisa ser resolvido
// por quem chama (a tarefa em si só guarda o `assigneeId`). Quando a tarefa não tem responsável
// válido (registro legado sem regularização), ninguém é considerado "superior do responsável".
export function isSuperiorOfAssignee(viewer: TaskViewer, assigneeLevel: HierarchyLevel | null) {
  if (assigneeLevel === null) return false;
  return isSuperiorLevel(viewer.hierarchyLevel, assigneeLevel);
}

export type TaskPermissions = { canView: boolean; canEdit: boolean; canReassign: boolean; canDelete: boolean; canComplete: boolean; canMarkNotDone: boolean };

// Todas as ações mutáveis (editar, reatribuir, excluir, concluir, marcar como não realizada)
// exigem, além da regra de hierarquia, que o usuário tenha a permissão de módulo "tasks.edit"
// — a mesma condição que a rota de API já verifica antes de aceitar qualquer PUT/DELETE.
// Aplicar o mesmo "E" aqui garante que os botões mostrados na tela nunca prometam uma ação
// que o servidor vai recusar.
export function applyModuleGate(permissions: TaskPermissions, hasEditPermission: boolean): TaskPermissions {
  if (hasEditPermission) return permissions;
  return { ...permissions, canEdit: false, canReassign: false, canDelete: false, canComplete: false, canMarkNotDone: false };
}

// Implementa a matriz de permissões da especificação, seção 6-8: união das permissões de
// todos os papéis que a mesma pessoa ocupar na tarefa (criador, responsável, superior).
export function computeTaskPermissions(viewer: TaskViewer, task: TaskAuthRow, assigneeLevel: HierarchyLevel | null): TaskPermissions {
  const creator = isTaskCreator(viewer, task);
  const assignee = isTaskAssignee(viewer, task);
  const superior = isSuperiorOfAssignee(viewer, assigneeLevel);
  const managerRole = creator || superior;
  return {
    canView: creator || assignee || superior,
    canEdit: managerRole,
    canReassign: managerRole,
    canDelete: managerRole,
    canComplete: assignee,
    canMarkNotDone: assignee,
  };
}

export type UserAuthInfo = { id: number; status: "ACTIVE" | "INACTIVE"; hierarchyLevel: HierarchyLevel };

export async function loadUserAuthInfo(userId: number): Promise<UserAuthInfo | null> {
  const db = await getDb();
  const row = (await db.select({ id: users.id, status: users.status, hierarchyLevel: users.hierarchyLevel }).from(users).where(eq(users.id, userId)).limit(1))[0];
  return row ? { id: row.id, status: row.status, hierarchyLevel: row.hierarchyLevel as HierarchyLevel } : null;
}

export async function loadUserAuthInfoMap(userIds: number[]): Promise<Map<number, UserAuthInfo>> {
  const uniqueIds = [...new Set(userIds)];
  const map = new Map<number, UserAuthInfo>();
  if (uniqueIds.length === 0) return map;
  const db = await getDb();
  const rows = await db.select({ id: users.id, status: users.status, hierarchyLevel: users.hierarchyLevel }).from(users);
  for (const row of rows) if (uniqueIds.includes(row.id)) map.set(row.id, { id: row.id, status: row.status, hierarchyLevel: row.hierarchyLevel as HierarchyLevel });
  return map;
}

// Só o ADMIN (role de perfil) pode definir/alterar o nível hierárquico de outro usuário,
// e ninguém — nem o próprio ADMIN — pode alterar o próprio nível.
export function canChangeHierarchyLevel(actor: { id: number; profile: string }, targetUserId: number) {
  if (actor.id === targetUserId) return false;
  return actor.profile === "ADMIN";
}

// Histórico de tarefas: reaproveita a tabela genérica `audit_logs` já existente no sistema
// (mesma usada para o histórico de usuários) em vez de criar uma tabela paralela.
// Fica imutável para usuários comuns porque não existe nenhuma rota de API que
// atualize ou apague linhas de audit_logs — só inserção.
export async function logTaskAudit(actorId: number, taskId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  const db = await getDb();
  await db.insert(auditLogs).values({
    userId: actorId, entityType: "TASK", entityId: String(taskId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
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
