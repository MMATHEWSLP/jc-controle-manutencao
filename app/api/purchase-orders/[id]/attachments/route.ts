import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../../../../../db";
import { auditLogs, purchaseOrderAttachments } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { purchaseActions, requirePurchaseOrder } from "../../../../../lib/purchases";
import { purchaseFronts } from "../../../../../lib/purchase-scope";
import { detectQuoteFile, displayFileName, QUOTE_DIR, QUOTE_MAX_BYTES } from "../../../../../lib/quote-files";
import { stockErrorResponse } from "../../../../../lib/stock";

type Context = { params: Promise<{ id: string }> };

// Comprador anexa orçamento(s) ao pedido em cotação.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "purchases.buy");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Pedido inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const order = await requirePurchaseOrder(db, auth.user!, purchaseFronts(auth.user!, request), id);
    if (!purchaseActions(auth.user!, order).quote) return Response.json({ error: "Só é possível anexar orçamentos com o pedido em cotação." }, { status: 409 });
    const files = (await request.formData()).getAll("files").filter((file): file is File => file instanceof File);
    if (files.length === 0) return Response.json({ error: "Envie ao menos um arquivo." }, { status: 400 });
    const prepared: Array<{ buffer: Buffer; name: string; contentType: string; extension: string }> = [];
    for (const file of files) {
      if (file.size === 0 || file.size > QUOTE_MAX_BYTES) return Response.json({ error: "Cada arquivo deve ter no máximo 10 MB." }, { status: 400 });
      const buffer = Buffer.from(await file.arrayBuffer());
      const format = detectQuoteFile(buffer);
      if (!format) return Response.json({ error: "Envie o orçamento em PDF ou imagem (JPEG, PNG ou WebP)." }, { status: 400 });
      prepared.push({ buffer, name: displayFileName(file.name), ...format });
    }
    await mkdir(QUOTE_DIR, { recursive: true });
    for (const [index, item] of prepared.entries()) {
      const storageKey = `${id}-${Date.now()}-${index}-${crypto.randomUUID().slice(0, 8)}.${item.extension}`;
      await writeFile(path.join(QUOTE_DIR, storageKey), item.buffer);
      await db.insert(purchaseOrderAttachments).values({ orderId: id, storageKey, fileName: item.name, contentType: item.contentType, size: item.buffer.length, uploadedBy: auth.user!.id });
    }
    await db.insert(auditLogs).values({ userId: auth.user!.id, entityType: "PURCHASE_ORDER", entityId: String(id), action: "ORÇAMENTO ANEXADO", newValue: JSON.stringify({ files: prepared.map((item) => item.name) }) });
    return Response.json({ message: `${prepared.length} orçamento(s) anexado(s).` }, { status: 201 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.attachments.post]", error);
    return Response.json({ error: "Não foi possível anexar agora." }, { status: 500 });
  }
}
