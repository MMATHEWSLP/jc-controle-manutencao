import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../db";
import { materialRequestItems, materialRequests, serviceFronts, users } from "../../../db/schema";
import { assertSameOrigin, authorize, type SessionUser } from "../../../lib/auth";
import { logMaterialRequestAudit } from "../../../lib/material-request-audit";

type ItemStatus = "PENDING" | "SENT" | "NOT_AVAILABLE";
export type RequestStatus = "PENDING" | "IN_SEPARATION" | "SENT" | "PARTIALLY_SENT" | "NOT_FULFILLED" | "CANCELLED";

export const STATUS_LABELS: Record<RequestStatus, string> = { PENDING:"Pendente", IN_SEPARATION:"Em separação", SENT:"Enviado", PARTIALLY_SENT:"Enviado parcialmente", NOT_FULFILLED:"Não atendido", CANCELLED:"Cancelada" };
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = { PENDING:"Pendente", SENT:"Enviado", NOT_AVAILABLE:"Não disponível" };
// Ativas (seção 10): ainda exigem alguma ação — ficam nas telas Recebidas/Enviadas. Terminais:
// só aparecem no Histórico. A separação acontece aqui na consulta, não por CSS/filtro visual.
export const ACTIVE_STATUSES: RequestStatus[] = ["PENDING", "IN_SEPARATION", "PARTIALLY_SENT"];
export const TERMINAL_STATUSES: RequestStatus[] = ["SENT", "NOT_FULFILLED", "CANCELLED"];

export function requestNumber(id: number) { return `SOL-${String(id).padStart(6, "0")}`; }
export function canSeeAllRequests(user: SessionUser) { return user.permissions.includes("materials.manage") || user.permissions.includes("materials.ship"); }
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

type RequestRow = {
  id: number; requesterId: number; requesterName: string; serviceFrontId: number | null; serviceFrontName: string | null;
  requestedAt: string; status: string; notes: string | null;
  shippedBy: number | null; shippedByName: string | null; shippedAt: string | null; shipmentNotes: string | null;
  cancelledAt: string | null; cancelledBy: number | null; cancelledByName: string | null; cancelReason: string | null;
  reopenedAt: string | null; reopenedBy: number | null; reopenedByName: string | null;
};
type ItemRow = { id: number; requestId: number; description: string; reference: string | null; quantityRequested: number; itemStatus: string; quantitySent: number | null; notes: string | null };

export function serializeRequest(row: RequestRow, items: ItemRow[]) {
  const status = row.status as RequestStatus;
  const isActive = (ACTIVE_STATUSES as string[]).includes(status);
  return {
    id: row.id, requestNumber: requestNumber(row.id), requesterId: row.requesterId, requester: row.requesterName,
    serviceFrontId: row.serviceFrontId, serviceFront: row.serviceFrontName ?? "Sem frente definida",
    requestedAt: row.requestedAt, status, statusLabel: STATUS_LABELS[status] ?? status, notes: row.notes,
    shippedBy: row.shippedBy, shippedByName: row.shippedByName, shippedAt: row.shippedAt, shipmentNotes: row.shipmentNotes,
    cancelledAt: row.cancelledAt, cancelledBy: row.cancelledBy, cancelledByName: row.cancelledByName, cancelReason: row.cancelReason,
    reopenedAt: row.reopenedAt, reopenedBy: row.reopenedBy, reopenedByName: row.reopenedByName,
    isActive,
    items: items.map((item) => ({
      id: item.id, description: item.description, reference: item.reference, quantityRequested: item.quantityRequested,
      itemStatus: item.itemStatus as ItemStatus, itemStatusLabel: ITEM_STATUS_LABELS[item.itemStatus as ItemStatus] ?? item.itemStatus,
      quantitySent: item.quantitySent, notes: item.notes,
    })),
  };
}

export async function loadRequests(id?: number) {
  const db = await getDb();
  const shippedByUser = alias(users, "shipped_by_user");
  const cancelledByUser = alias(users, "cancelled_by_user");
  const reopenedByUser = alias(users, "reopened_by_user");
  const query = db.select({
    id: materialRequests.id, requesterId: materialRequests.requesterId, requesterName: users.name,
    serviceFrontId: materialRequests.serviceFrontId, serviceFrontName: serviceFronts.name,
    requestedAt: materialRequests.requestedAt, status: materialRequests.status, notes: materialRequests.notes,
    shippedBy: materialRequests.shippedBy, shippedByName: shippedByUser.name, shippedAt: materialRequests.shippedAt, shipmentNotes: materialRequests.shipmentNotes,
    cancelledAt: materialRequests.cancelledAt, cancelledBy: materialRequests.cancelledBy, cancelledByName: cancelledByUser.name, cancelReason: materialRequests.cancelReason,
    reopenedAt: materialRequests.reopenedAt, reopenedBy: materialRequests.reopenedBy, reopenedByName: reopenedByUser.name,
  }).from(materialRequests)
    .innerJoin(users, eq(materialRequests.requesterId, users.id))
    .leftJoin(serviceFronts, eq(materialRequests.serviceFrontId, serviceFronts.id))
    .leftJoin(shippedByUser, eq(materialRequests.shippedBy, shippedByUser.id))
    .leftJoin(cancelledByUser, eq(materialRequests.cancelledBy, cancelledByUser.id))
    .leftJoin(reopenedByUser, eq(materialRequests.reopenedBy, reopenedByUser.id))
    .orderBy(desc(materialRequests.requestedAt));
  const rows = id ? await query.where(eq(materialRequests.id, id)) : await query;
  const items = rows.length ? await db.select().from(materialRequestItems).where(inArray(materialRequestItems.requestId, rows.map((row) => row.id))) : [];
  const itemsByRequest = new Map<number, ItemRow[]>();
  for (const item of items) { const list = itemsByRequest.get(item.requestId) ?? []; list.push(item); itemsByRequest.set(item.requestId, list); }
  return rows.map((row) => serializeRequest(row, itemsByRequest.get(row.id) ?? []));
}

export async function GET(request: Request) {
  const auth = await authorize(request, "materials.view"); if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const historyScope = url.searchParams.get("scope") === "history";
    const all = await loadRequests();
    const seeAll = canSeeAllRequests(auth.user!);
    const authorized = seeAll ? all : all.filter((row) => row.requesterId === auth.user!.id);
    // A separação ativas/histórico acontece aqui na consulta (seção 10) — a lista principal nunca
    // devolve solicitações terminais, e a rota de Histórico nunca devolve as ativas.
    const scoped = authorized.filter((row) => (historyScope ? (TERMINAL_STATUSES as string[]) : (ACTIVE_STATUSES as string[])).includes(row.status));
    const visible = scoped.map((row) => ({
      ...row,
      isOwnRequest: row.requesterId === auth.user!.id,
      canCancel: row.isActive && (row.requesterId === auth.user!.id || seeAll),
      canReopen: !row.isActive && seeAll,
    }));
    return Response.json({ requests: visible, canRequest: auth.user!.permissions.includes("materials.request"), canShip: auth.user!.permissions.includes("materials.ship"), canManage: seeAll });
  } catch (error) {
    console.error("[material-requests.get]", error);
    return Response.json({ error: "Não foi possível carregar as solicitações de materiais." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "materials.request"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const serviceFrontId = Number(body.serviceFrontId);
    const notes = clean(body.notes);
    const rawItems = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    if (!Number.isInteger(serviceFrontId) || serviceFrontId <= 0) return Response.json({ error: "Selecione a frente de serviço / obra / setor." }, { status: 400 });
    if (rawItems.length === 0) return Response.json({ error: "Adicione ao menos um item à solicitação." }, { status: 400 });
    const items = rawItems.map((item) => {
      const description = clean(item.description);
      const quantityRequested = Number(item.quantityRequested);
      const reference = clean(item.reference);
      if (!description) throw new Error("ITEM_DESCRIPTION");
      if (!Number.isFinite(quantityRequested) || quantityRequested <= 0) throw new Error("ITEM_QUANTITY");
      return { description, quantityRequested, reference: reference || null };
    });

    const db = await getDb();
    const front = await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(eq(serviceFronts.id, serviceFrontId), eq(serviceFronts.active, true))).limit(1);
    if (!front[0]) return Response.json({ error: "A frente de serviço selecionada não existe." }, { status: 400 });

    const now = new Date().toISOString();
    const inserted = (await db.insert(materialRequests).values({ requesterId: auth.user!.id, serviceFrontId, requestedAt: now, status: "PENDING", notes: notes || null, updatedAt: now }).returning())[0];
    await db.insert(materialRequestItems).values(items.map((item) => ({ requestId: inserted.id, description: item.description, reference: item.reference, quantityRequested: item.quantityRequested, itemStatus: "PENDING" as const, updatedAt: now })));
    await logMaterialRequestAudit(auth.user!.id, inserted.id, "MATERIAL_REQUEST_CREATED", undefined, { serviceFrontId, itemCount: items.length, notes: notes || null });
    return Response.json({ message: `Solicitação ${requestNumber(inserted.id)} enviada ao almoxarifado.` }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ITEM_DESCRIPTION") return Response.json({ error: "Preencha a descrição de todos os itens." }, { status: 400 });
    if (error instanceof Error && error.message === "ITEM_QUANTITY") return Response.json({ error: "A quantidade solicitada deve ser maior que zero em todos os itens." }, { status: 400 });
    console.error("[material-requests.post]", error);
    return Response.json({ error: "Não foi possível registrar a solicitação." }, { status: 500 });
  }
}
