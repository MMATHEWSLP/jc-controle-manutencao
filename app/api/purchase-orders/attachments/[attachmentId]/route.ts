import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { purchaseOrderAttachments } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { orderActions, orderItemStatuses, requirePurchaseOrder } from "../../../../../lib/purchases";
import { purchaseFronts } from "../../../../../lib/purchase-scope";
import { opensInline, QUOTE_DIR } from "../../../../../lib/quote-files";
import { stockErrorResponse } from "../../../../../lib/stock";

type Context = { params: Promise<{ attachmentId: string }> };

async function findAttachment(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  const db = await getDb();
  return (await db.select().from(purchaseOrderAttachments).where(eq(purchaseOrderAttachments.id, id)).limit(1))[0] ?? null;
}

// Abre o anexo para quem enxerga o pedido (imagem e PDF no navegador; os demais são baixados).
export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  try {
    const attachment = await findAttachment((await params).attachmentId);
    if (!attachment) return Response.json({ error: "Anexo não encontrado." }, { status: 404 });
    await requirePurchaseOrder(await getDb(), auth.user!, purchaseFronts(auth.user!, request), attachment.orderId);
    const buffer = await readFile(path.join(QUOTE_DIR, attachment.storageKey)).catch(() => null);
    if (!buffer) return Response.json({ error: "Arquivo não encontrado no servidor." }, { status: 404 });
    return new Response(new Uint8Array(buffer), { headers: {
      "Content-Type": attachment.contentType, "Cache-Control": "private, max-age=600",
      "Content-Disposition": `${opensInline(attachment.contentType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.attachments.get]", error);
    return Response.json({ error: "Não foi possível abrir o anexo." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  try {
    const attachment = await findAttachment((await params).attachmentId);
    if (!attachment) return Response.json({ error: "Anexo não encontrado." }, { status: 404 });
    const db = await getDb();
    const user = auth.user!;
    const order = await requirePurchaseOrder(db, user, purchaseFronts(user, request), attachment.orderId);
    const actions = orderActions(user, order, await orderItemStatuses(db, order.id));
    const allowed = attachment.kind === "PHOTO" ? actions.PHOTO : actions.QUOTE;
    if (!allowed) return Response.json({ error: attachment.kind === "PHOTO" ? "Só quem pediu remove fotos, enquanto o pedido está em andamento." : "Só o comprador remove orçamentos, com itens em cotação." }, { status: 409 });
    await db.delete(purchaseOrderAttachments).where(eq(purchaseOrderAttachments.id, attachment.id));
    await unlink(path.join(QUOTE_DIR, attachment.storageKey)).catch(() => undefined);
    return Response.json({ message: "Anexo removido." });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.attachments.delete]", error);
    return Response.json({ error: "Não foi possível remover o anexo." }, { status: 500 });
  }
}
