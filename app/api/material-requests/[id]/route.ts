import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { materialRequestItems, materialRequests } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { loadMaterialRequestHistory, logMaterialRequestAudit } from "../../../../lib/material-request-audit";
import { ACTIVE_STATUSES, canSeeAllRequests, loadRequests, requestNumber } from "../route";

function clean(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

type Context = { params: Promise<{ id: string }> };
type ItemUpdate = { id: number; itemStatus: "PENDING" | "SENT" | "NOT_AVAILABLE"; quantitySent: number | null; notes: string | null };

function normalizeItemUpdate(raw: Record<string, unknown>): ItemUpdate {
  const id = Number(raw.id);
  const itemStatus = String(raw.itemStatus);
  if (!Number.isInteger(id) || id <= 0) throw new Error("ITEM_ID");
  if (!(["PENDING", "SENT", "NOT_AVAILABLE"] as string[]).includes(itemStatus)) throw new Error("ITEM_STATUS");
  let quantitySent: number | null = null;
  if (itemStatus === "SENT") {
    quantitySent = Number(raw.quantitySent);
    if (!Number.isFinite(quantitySent) || quantitySent <= 0) throw new Error("ITEM_QUANTITY_SENT");
  }
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  return { id, itemStatus: itemStatus as ItemUpdate["itemStatus"], quantitySent, notes: notes || null };
}

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "materials.view"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Solicitação inválida." }, { status: 400 });
    const found = (await loadRequests(id))[0];
    if (!found) return Response.json({ error: "Solicitação não encontrada." }, { status: 404 });
    if (found.requesterId !== auth.user!.id && !canSeeAllRequests(auth.user!)) return Response.json({ error: "Você não possui acesso a esta solicitação." }, { status: 403 });
    const history = await loadMaterialRequestHistory(id);
    return Response.json({ request: found, history });
  } catch (error) {
    console.error("[material-requests.id.get]", error);
    return Response.json({ error: "Não foi possível carregar a solicitação." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  // Autorização fina por ação abaixo — CANCEL também é permitido ao próprio solicitante (que pode
  // não ter "materials.ship"); as demais ações (separar/enviar, reabrir) exigem gerenciar/enviar.
  const auth = await authorize(request, "materials.view"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Solicitação inválida." }, { status: 400 });
    const found = (await loadRequests(id))[0];
    if (!found) return Response.json({ error: "Solicitação não encontrada." }, { status: 404 });
    if (found.requesterId !== auth.user!.id && !canSeeAllRequests(auth.user!)) return Response.json({ error: "Você não possui acesso a esta solicitação." }, { status: 403 });

    const db = await getDb();
    const now = new Date().toISOString();
    const body = await request.json() as Record<string, unknown>;
    const action = clean(body.action);

    if (action === "CANCEL") {
      const isOwnRequest = found.requesterId === auth.user!.id;
      if (!isOwnRequest && !canSeeAllRequests(auth.user!)) return Response.json({ error: "Você não possui permissão para cancelar esta solicitação." }, { status: 403 });
      if (!(ACTIVE_STATUSES as string[]).includes(found.status)) return Response.json({ error: "Esta solicitação já foi encerrada e não pode mais ser cancelada." }, { status: 400 });
      const cancelReason = clean(body.cancelReason);
      if (!cancelReason) return Response.json({ error: "Informe o motivo do cancelamento." }, { status: 400 });
      await db.update(materialRequests).set({ status: "CANCELLED", cancelledAt: now, cancelledBy: auth.user!.id, cancelReason, updatedAt: now }).where(eq(materialRequests.id, id));
      await logMaterialRequestAudit(auth.user!.id, id, "MATERIAL_REQUEST_CANCELLED", { status: found.status }, { status: "CANCELLED", cancelReason });
      return Response.json({ message: `Solicitação ${requestNumber(id)} cancelada.` });
    }

    if (action === "REOPEN") {
      if (!canSeeAllRequests(auth.user!)) return Response.json({ error: "Você não possui permissão para reabrir solicitações." }, { status: 403 });
      if ((ACTIVE_STATUSES as string[]).includes(found.status)) return Response.json({ error: "Esta solicitação já está ativa." }, { status: 400 });
      await db.update(materialRequests).set({ status: "PENDING", reopenedAt: now, reopenedBy: auth.user!.id, updatedAt: now }).where(eq(materialRequests.id, id));
      await logMaterialRequestAudit(auth.user!.id, id, "MATERIAL_REQUEST_REOPENED", { status: found.status }, { status: "PENDING" });
      return Response.json({ message: `Solicitação ${requestNumber(id)} reaberta e movida para as solicitações ativas.` });
    }

    if (!auth.user!.permissions.includes("materials.ship")) return Response.json({ error: "Você não possui permissão para separar/enviar materiais." }, { status: 403 });
    if (found.status === "SENT" || found.status === "NOT_FULFILLED") return Response.json({ error: "Esta solicitação já foi concluída e não pode mais ser alterada." }, { status: 409 });
    if (found.status === "CANCELLED") return Response.json({ error: "Esta solicitação foi cancelada e não pode mais ser alterada." }, { status: 409 });

    const confirm = body.confirm === true;
    const shipmentNotes = typeof body.shipmentNotes === "string" ? body.shipmentNotes.trim() : "";
    const rawItems = Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : [];
    const validIds = new Set(found.items.map((item) => item.id));
    const updates = rawItems.map(normalizeItemUpdate).filter((update) => validIds.has(update.id));
    if (updates.length === 0) return Response.json({ error: "Informe ao menos um item para atualizar." }, { status: 400 });

    for (const update of updates) {
      await db.update(materialRequestItems).set({ itemStatus: update.itemStatus, quantitySent: update.quantitySent, notes: update.notes, updatedAt: now }).where(eq(materialRequestItems.id, update.id));
    }

    const updatedById = new Map(updates.map((update) => [update.id, update]));
    const finalItems = found.items.map((item) => updatedById.get(item.id) ?? { itemStatus: item.itemStatus, quantitySent: item.quantitySent });

    if (!confirm) {
      await db.update(materialRequests).set({ status: "IN_SEPARATION", updatedAt: now }).where(eq(materialRequests.id, id));
      await logMaterialRequestAudit(auth.user!.id, id, "MATERIAL_REQUEST_ITEMS_UPDATED", { status: found.status }, { status: "IN_SEPARATION", items: updates });
      return Response.json({ message: `Progresso da solicitação ${requestNumber(id)} salvo.` });
    }

    if (finalItems.some((item) => item.itemStatus === "PENDING")) return Response.json({ error: "Marque todos os itens (enviado ou não disponível) antes de confirmar o envio." }, { status: 400 });
    const sentCount = finalItems.filter((item) => item.itemStatus === "SENT").length;
    const finalStatus = sentCount === 0 ? "NOT_FULFILLED" : sentCount === finalItems.length ? "SENT" : "PARTIALLY_SENT";
    await db.update(materialRequests).set({ status: finalStatus, shippedBy: auth.user!.id, shippedAt: now, shipmentNotes: shipmentNotes || null, updatedAt: now }).where(eq(materialRequests.id, id));
    await logMaterialRequestAudit(auth.user!.id, id, "MATERIAL_REQUEST_SHIPPED", { status: found.status }, { status: finalStatus, shipmentNotes: shipmentNotes || null });
    return Response.json({ message: `Envio da solicitação ${requestNumber(id)} confirmado.` });
  } catch (error) {
    if (error instanceof Error && error.message === "ITEM_ID") return Response.json({ error: "Item inválido." }, { status: 400 });
    if (error instanceof Error && error.message === "ITEM_STATUS") return Response.json({ error: "Marcação de item inválida." }, { status: 400 });
    if (error instanceof Error && error.message === "ITEM_QUANTITY_SENT") return Response.json({ error: "Informe a quantidade enviada (maior que zero) para os itens marcados como enviados." }, { status: 400 });
    console.error("[material-requests.id.put]", error);
    return Response.json({ error: "Não foi possível salvar a atualização do envio." }, { status: 500 });
  }
}
