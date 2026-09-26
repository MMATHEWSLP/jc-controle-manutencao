import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getD1, getDb } from "../db";
import { auditLogs, equipment, serviceFrontChangeRequests, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { transferEquipment, TransferError } from "./equipment-transfer";

// Solicitações de mudança de frente vindas do Controle Diário. Quem aprova ("daily.front_requests",
// ADMIN/GESTOR) vê as das frentes que enxerga — a atual ou a pedida.
export class FrontRequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function scope(user: SessionUser): SQL | undefined {
  const fronts = frentesVisiveis(user);
  if (fronts === "ALL") return undefined;
  if (!fronts.length) return eq(serviceFrontChangeRequests.id, -1);
  return or(inArray(serviceFrontChangeRequests.currentServiceFrontId, fronts), inArray(serviceFrontChangeRequests.requestedServiceFrontId, fronts));
}

export async function countPendingFrontRequests(user: SessionUser) {
  const db = await getDb();
  const rows = await db.select({ id: serviceFrontChangeRequests.id }).from(serviceFrontChangeRequests)
    .where(and(eq(serviceFrontChangeRequests.status, "PENDING"), scope(user)));
  return rows.length;
}

export async function listFrontRequests(user: SessionUser, status: "PENDING" | "ALL") {
  const db = await getDb();
  const current = alias(serviceFronts, "current_front");
  const requested = alias(serviceFronts, "requested_front");
  const reviewer = alias(users, "reviewer");
  const rows = await db.select({
    id: serviceFrontChangeRequests.id, equipmentId: serviceFrontChangeRequests.equipmentId, prefix: equipment.prefix, equipmentType: equipment.type, model: equipment.model,
    currentServiceFrontId: serviceFrontChangeRequests.currentServiceFrontId, currentFront: current.name,
    requestedServiceFrontId: serviceFrontChangeRequests.requestedServiceFrontId, requestedFront: requested.name,
    equipmentFrontNow: equipment.serviceFrontId,
    reason: serviceFrontChangeRequests.reason, requestedBy: users.name, requestedAt: serviceFrontChangeRequests.requestedAt,
    status: serviceFrontChangeRequests.status, reviewedBy: reviewer.name, reviewedAt: serviceFrontChangeRequests.reviewedAt, reviewNote: serviceFrontChangeRequests.reviewNote,
  }).from(serviceFrontChangeRequests)
    .innerJoin(equipment, eq(equipment.id, serviceFrontChangeRequests.equipmentId))
    .innerJoin(users, eq(users.id, serviceFrontChangeRequests.requestedBy))
    .leftJoin(current, eq(current.id, serviceFrontChangeRequests.currentServiceFrontId))
    .leftJoin(requested, eq(requested.id, serviceFrontChangeRequests.requestedServiceFrontId))
    .leftJoin(reviewer, eq(reviewer.id, serviceFrontChangeRequests.reviewedBy))
    .where(and(status === "PENDING" ? eq(serviceFrontChangeRequests.status, "PENDING") : undefined, scope(user)))
    .orderBy(desc(serviceFrontChangeRequests.requestedAt)).limit(200);
  return rows.map((row) => ({ ...row, currentFront: row.currentFront ?? "Sem frente definida" }));
}

export async function reviewFrontRequest(user: SessionUser, id: number, action: "APPROVE" | "REJECT", note: string) {
  const request = (await listFrontRequests(user, "PENDING")).find((row) => row.id === id);
  if (!request) throw new FrontRequestError("Solicitação não encontrada ou já analisada.", 404);
  if (action === "REJECT" && note.trim().length < 5) throw new FrontRequestError("Informe o motivo da recusa.");
  const now = new Date().toISOString();
  let message: string;
  if (action === "APPROVE") {
    if (request.equipmentFrontNow === request.requestedServiceFrontId) {
      message = `${request.prefix} já estava na frente ${request.requestedFront}.`;
    } else {
      // Mesmo fluxo da tela de transferência: fica no histórico de transferências.
      try {
        const result = await transferEquipment(await getD1(), user.id, { equipmentId: request.equipmentId, newServiceFrontId: request.requestedServiceFrontId,
          expectedFrontId: request.equipmentFrontNow, note: `Solicitação de mudança de frente #${id} (Controle Diário)${note.trim() ? ` — ${note.trim()}` : ""}` });
        message = result.message;
      } catch (error) {
        if (error instanceof TransferError) throw new FrontRequestError(error.message, error.status);
        throw error;
      }
    }
  } else {
    message = `Solicitação do ${request.prefix} recusada. A frente continua ${request.currentFront}.`;
  }
  const db = await getDb();
  await db.update(serviceFrontChangeRequests).set({ status: action === "APPROVE" ? "APPROVED" : "REJECTED", reviewedBy: user.id, reviewedAt: now, reviewNote: note.trim() || null, updatedAt: now })
    .where(and(eq(serviceFrontChangeRequests.id, id), eq(serviceFrontChangeRequests.status, "PENDING")));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "FRONT_CHANGE_REQUEST", entityId: String(id), action: action === "APPROVE" ? "MUDANÇA DE FRENTE APROVADA" : "MUDANÇA DE FRENTE RECUSADA",
    previousValue: JSON.stringify({ equipment: request.prefix, from: request.currentFront, to: request.requestedFront }), newValue: JSON.stringify({ note: note.trim() || null }), occurredAt: now });
  return message;
}
