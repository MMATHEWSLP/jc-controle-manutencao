// Histórico de Solicitações de Materiais (seção 11 da especificação) — reaproveita a mesma
// tabela genérica `audit_logs` já usada pelo histórico de Tarefas e de Usuários, em vez de criar
// uma tabela paralela. Fica imutável para usuários comuns porque não existe nenhuma rota de API
// que atualize ou apague linhas de audit_logs — só inserção.
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, users } from "../db/schema";

export async function logMaterialRequestAudit(actorId: number, requestId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  const db = await getDb();
  await db.insert(auditLogs).values({
    userId: actorId, entityType: "MATERIAL_REQUEST", entityId: String(requestId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

export type MaterialRequestHistoryEntry = { id: number; userId: number | null; userName: string | null; action: string; previousValue: string | null; newValue: string | null; occurredAt: string };

export async function loadMaterialRequestHistory(requestId: number): Promise<MaterialRequestHistoryEntry[]> {
  const db = await getDb();
  return db.select({
    id: auditLogs.id, userId: auditLogs.userId, userName: users.name, action: auditLogs.action,
    previousValue: auditLogs.previousValue, newValue: auditLogs.newValue, occurredAt: auditLogs.occurredAt,
  }).from(auditLogs).leftJoin(users, eq(auditLogs.userId, users.id))
    .where(and(eq(auditLogs.entityType, "MATERIAL_REQUEST"), eq(auditLogs.entityId, String(requestId))))
    .orderBy(asc(auditLogs.occurredAt));
}
