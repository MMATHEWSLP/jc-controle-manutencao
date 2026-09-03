import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../db";
import { materialRequestItems, materialRequests, serviceFronts, users } from "../../../db/schema";
import { assertSameOrigin, authorize, type SessionUser } from "../../../lib/auth";

type ItemStatus = "PENDING" | "SENT" | "NOT_AVAILABLE";
type RequestStatus = "PENDING" | "IN_SEPARATION" | "SENT" | "PARTIALLY_SENT" | "NOT_FULFILLED";

export const STATUS_LABELS: Record<RequestStatus, string> = { PENDING:"Pendente", IN_SEPARATION:"Em separação", SENT:"Enviado", PARTIALLY_SENT:"Enviado parcialmente", NOT_FULFILLED:"Não atendido" };
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = { PENDING:"Pendente", SENT:"Enviado", NOT_AVAILABLE:"Não disponível" };

export function requestNumber(id: number) { return `SOL-${String(id).padStart(6, "0")}`; }
export function canSeeAllRequests(user: SessionUser) { return user.permissions.includes("materials.manage") || user.permissions.includes("materials.ship"); }
function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

type RequestRow = {
  id: number; requesterId: number; requesterName: string; serviceFrontId: number | null; serviceFrontName: string | null;
  requestedAt: string; status: string; notes: string | null;
  shippedBy: number | null; shippedByName: string | null; shippedAt: string | null; shipmentNotes: string | null;
};
type ItemRow = { id: number; requestId: number; description: string; reference: string | null; quantityRequested: number; itemStatus: string; quantitySent: number | null; notes: string | null };

export function serializeRequest(row: RequestRow, items: ItemRow[]) {
  const status = row.status as RequestStatus;
  return {
    id: row.id, requestNumber: requestNumber(row.id), requesterId: row.requesterId, requester: row.requesterName,
    serviceFrontId: row.serviceFrontId, serviceFront: row.serviceFrontName ?? "Sem frente definida",
    requestedAt: row.requestedAt, status, statusLabel: STATUS_LABELS[status] ?? status, notes: row.notes,
    shippedBy: row.shippedBy, shippedByName: row.shippedByName, shippedAt: row.shippedAt, shipmentNotes: row.shipmentNotes,
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
  const query = db.select({
    id: materialRequests.id, requesterId: materialRequests.requesterId, requesterName: users.name,
    serviceFrontId: materialRequests.serviceFrontId, serviceFrontName: serviceFronts.name,
    requestedAt: materialRequests.requestedAt, status: materialRequests.status, notes: materialRequests.notes,
    shippedBy: materialRequests.shippedBy, shippedByName: shippedByUser.name, shippedAt: materialRequests.shippedAt, shipmentNotes: materialRequests.shipmentNotes,
  }).from(materialRequests)
    .innerJoin(users, eq(materialRequests.requesterId, users.id))
    .leftJoin(serviceFronts, eq(materialRequests.serviceFrontId, serviceFronts.id))
    .leftJoin(shippedByUser, eq(materialRequests.shippedBy, shippedByUser.id))
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
    const all = await loadRequests();
    const seeAll = canSeeAllRequests(auth.user!);
    const visible = seeAll ? all : all.filter((row) => row.requesterId === auth.user!.id);
    return Response.json({ requests: visible, canRequest: auth.user!.permissions.includes("materials.request"), canShip: auth.user!.permissions.includes("materials.ship") });
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
    return Response.json({ message: `Solicitação ${requestNumber(inserted.id)} enviada ao almoxarifado.` }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ITEM_DESCRIPTION") return Response.json({ error: "Preencha a descrição de todos os itens." }, { status: 400 });
    if (error instanceof Error && error.message === "ITEM_QUANTITY") return Response.json({ error: "A quantidade solicitada deve ser maior que zero em todos os itens." }, { status: 400 });
    console.error("[material-requests.post]", error);
    return Response.json({ error: "Não foi possível registrar a solicitação." }, { status: 500 });
  }
}
