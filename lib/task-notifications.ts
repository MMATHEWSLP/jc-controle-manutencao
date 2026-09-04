// Notificações do módulo Tarefas (seção 18 da especificação).
//
// Geradas no exato momento de cada evento (recebimento, reatribuição, conclusão, não realização,
// cancelamento) — nunca por uma varredura periódica, que este projeto não tem. "Prazo próximo" e
// "prazo vencido" (os dois únicos gatilhos que não nascem de uma ação de usuário) não viram linha
// persistida: são calculados ao vivo a partir das tarefas que o próprio usuário já pode visualizar
// (loadDueSoonAndOverdueCounts), então nunca vazam tarefa que ele não teria acesso de ver.
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { taskNotifications } from "../db/schema";

export type NotificationType =
  | "TASK_RECEIVED" | "TASK_REASSIGNED_TO_YOU"
  | "TASK_COMPLETION_REQUESTED" | "TASK_COMPLETION_APPROVED" | "TASK_COMPLETION_REJECTED"
  | "TASK_NOT_DONE_REQUESTED" | "TASK_NOT_DONE_AUTHORIZED" | "TASK_NOT_DONE_DENIED"
  | "TASK_CANCELLED";

export async function notifyUser(userId: number, taskId: number, type: NotificationType, message: string) {
  const db = await getDb();
  await db.insert(taskNotifications).values({ userId, taskId, type, message });
}

export type TaskNotificationRow = {
  id: number; taskId: number; type: string; message: string; createdAt: string; readAt: string | null;
};

export async function listNotifications(userId: number, limit = 50): Promise<TaskNotificationRow[]> {
  const db = await getDb();
  return db.select({
    id: taskNotifications.id, taskId: taskNotifications.taskId, type: taskNotifications.type,
    message: taskNotifications.message, createdAt: taskNotifications.createdAt, readAt: taskNotifications.readAt,
  }).from(taskNotifications).where(eq(taskNotifications.userId, userId)).orderBy(desc(taskNotifications.createdAt)).limit(limit);
}

export async function countUnreadNotifications(userId: number): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ id: taskNotifications.id }).from(taskNotifications)
    .where(and(eq(taskNotifications.userId, userId), isNull(taskNotifications.readAt)));
  return rows.length;
}

export async function markNotificationRead(userId: number, notificationId: number) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.update(taskNotifications).set({ readAt: now })
    .where(and(eq(taskNotifications.id, notificationId), eq(taskNotifications.userId, userId)));
}

export async function markAllNotificationsRead(userId: number) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.update(taskNotifications).set({ readAt: now })
    .where(and(eq(taskNotifications.userId, userId), isNull(taskNotifications.readAt)));
}
