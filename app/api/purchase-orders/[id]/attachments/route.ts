import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "../../../../../db";
import { auditLogs, purchaseOrderAttachments } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { orderActions, orderItemStatuses, requirePurchaseOrder } from "../../../../../lib/purchases";
import { purchaseFronts } from "../../../../../lib/purchase-scope";
import { ATTACHMENT_FORMAT_HINT, detectAttachment, displayFileName, isAttachmentKind, QUOTE_DIR, QUOTE_MAX_BYTES } from "../../../../../lib/quote-files";
import { stockErrorResponse } from "../../../../../lib/stock";

type Context = { params: Promise<{ id: string }> };
const KIND_LABEL = { PHOTO: "FOTO DO PEDIDO ANEXADA", QUOTE_IMAGE: "ORÇAMENTO (IMAGEM) ANEXADO", QUOTE_DOCUMENT: "ORÇAMENTO (DOCUMENTO) ANEXADO" } as const;

// Anexos do pedido: fotos (quem pediu, na criação ou depois) e orçamentos por imagem ou por
// documento (comprador, com item em cotação). Vários arquivos por envio.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "purchases.view");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Pedido inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const user = auth.user!;
    const order = await requirePurchaseOrder(db, user, purchaseFronts(user, request), id);
    const form = await request.formData();
    const kind = form.get("kind");
    if (!isAttachmentKind(kind)) return Response.json({ error: "Tipo de anexo inválido." }, { status: 400 });
    const actions = orderActions(user, order, await orderItemStatuses(db, id));
    if (kind === "PHOTO" ? !actions.PHOTO : !actions.QUOTE) {
      return Response.json({ error: kind === "PHOTO" ? "Só quem pediu pode anexar fotos, enquanto o pedido está em andamento." : "Só o comprador anexa orçamentos, com itens em cotação." }, { status: 409 });
    }
    const files = form.getAll("files").filter((file): file is File => file instanceof File);
    if (files.length === 0) return Response.json({ error: "Envie ao menos um arquivo." }, { status: 400 });
    if (files.length > 20) return Response.json({ error: "Envie no máximo 20 arquivos por vez." }, { status: 400 });
    const prepared: Array<{ buffer: Buffer; name: string; contentType: string; extension: string }> = [];
    for (const file of files) {
      if (file.size === 0 || file.size > QUOTE_MAX_BYTES) return Response.json({ error: "Cada arquivo deve ter no máximo 10 MB." }, { status: 400 });
      const buffer = Buffer.from(await file.arrayBuffer());
      const name = displayFileName(file.name);
      const format = detectAttachment(kind, buffer, name);
      if (!format) return Response.json({ error: `${name}: ${ATTACHMENT_FORMAT_HINT[kind]}` }, { status: 400 });
      prepared.push({ buffer, name, ...format });
    }
    await mkdir(QUOTE_DIR, { recursive: true });
    for (const [index, item] of prepared.entries()) {
      const storageKey = `${id}-${Date.now()}-${index}-${crypto.randomUUID().slice(0, 8)}.${item.extension}`;
      await writeFile(path.join(QUOTE_DIR, storageKey), item.buffer);
      await db.insert(purchaseOrderAttachments).values({ orderId: id, kind, storageKey, fileName: item.name, contentType: item.contentType, size: item.buffer.length, uploadedBy: user.id });
    }
    await db.insert(auditLogs).values({ userId: user.id, entityType: "PURCHASE_ORDER", entityId: String(id), action: KIND_LABEL[kind], newValue: JSON.stringify({ files: prepared.map((item) => item.name) }) });
    return Response.json({ message: `${prepared.length} arquivo(s) anexado(s).` }, { status: 201 });
  } catch (error) {
    const known = stockErrorResponse(error); if (known) return known;
    console.error("[purchase-orders.attachments.post]", error);
    return Response.json({ error: "Não foi possível anexar agora." }, { status: 500 });
  }
}
