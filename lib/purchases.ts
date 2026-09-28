import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { auditLogs, products, purchaseOrderAttachments, purchaseOrderItems, purchaseOrders, serviceFronts, suppliers, users } from "../db/schema";
import type { Permission, SessionUser } from "./auth";
import { purchaseOrderNumber } from "./document-numbers";
import { isFiscalUnit } from "./fiscal-units";
import { stockEntry, StockError } from "./stock";
import { requestFronts } from "./stock-options";

// ---------------------------------------------------------------------------------------------
// Solicitação de Pedidos (Compras externas), PED-000123. Cada etapa é de uma função diferente:
//   solicitante cria → aprovador aprova/recusa → comprador cota (anexos + valores) e envia para
//   pagamento → pagamento confirma → despacho marca enviado → solicitante confirma o recebimento
//   item a item. Item vinculado a produto gera ENTRADA no estoque da frente do pedido (lib/stock.ts)
//   e atualiza fornecedor/marca/valor do produto quando mudou; item manual só fica recebido.
// ---------------------------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof getDb>>;

export type PurchaseStatus = "AGUARDANDO_APROVACAO" | "RECUSADO" | "EM_COTACAO" | "ANALISE_PAGAMENTO" | "PAGO" | "ENVIADO" | "RECEBIDO" | "CANCELADO";
export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  AGUARDANDO_APROVACAO: "Aguardando aprovação", RECUSADO: "Recusado", EM_COTACAO: "Aprovado / Em cotação", ANALISE_PAGAMENTO: "Análise de pagamento",
  PAGO: "Pago", ENVIADO: "Enviado", RECEBIDO: "Recebido", CANCELADO: "Cancelado",
};
// Linha do tempo exibida (Solicitado é sempre a primeira etapa, feita na criação).
export const PURCHASE_FLOW: PurchaseStatus[] = ["AGUARDANDO_APROVACAO", "EM_COTACAO", "ANALISE_PAGAMENTO", "PAGO", "ENVIADO", "RECEBIDO"];

// Quem trabalha no fluxo (não só o solicitante) enxerga os pedidos das frentes em exibição.
const ROLE_PERMISSIONS: Permission[] = ["purchases.approve", "purchases.buy", "purchases.pay", "purchases.dispatch", "purchases.manage"];
export const worksOnPurchases = (user: SessionUser) => ROLE_PERMISSIONS.some((permission) => user.permissions.includes(permission));

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const numberOrNull = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : NaN;
};

async function audit(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], userId: number, id: number, action: string, value?: unknown) {
  await db.insert(auditLogs).values({ userId, entityType: "PURCHASE_ORDER", entityId: String(id), action, newValue: value === undefined ? null : JSON.stringify(value) });
}

// Ações que a pessoa pode fazer no pedido agora (a tela mostra só estes botões; a API confere de novo).
export function purchaseActions(user: SessionUser, order: { status: string; requesterId: number }) {
  const has = (permission: Permission) => user.permissions.includes(permission);
  const own = order.requesterId === user.id;
  const status = order.status as PurchaseStatus;
  return {
    approve: status === "AGUARDANDO_APROVACAO" && has("purchases.approve"),
    quote: status === "EM_COTACAO" && has("purchases.buy"),
    confirmPayment: status === "ANALISE_PAGAMENTO" && has("purchases.pay"),
    dispatch: status === "PAGO" && has("purchases.dispatch"),
    receive: status === "ENVIADO" && (own || has("purchases.manage")),
    cancel: (status === "AGUARDANDO_APROVACAO" && own) || (has("purchases.manage") && ["AGUARDANDO_APROVACAO", "EM_COTACAO", "ANALISE_PAGAMENTO"].includes(status)),
  };
}

// ------------------------------------------------------------------------------ consulta

export async function listPurchaseOrders(db: Db, user: SessionUser, fronts: number[] | "ALL") {
  const requester = alias(users, "po_requester");
  const visibility: SQL[] = [eq(purchaseOrders.requesterId, user.id)];
  if (worksOnPurchases(user) && (fronts === "ALL" || fronts.length)) visibility.push(fronts === "ALL" ? sql`true` : inArray(purchaseOrders.serviceFrontId, fronts));
  const rows = await db.select({
    id: purchaseOrders.id, requesterId: purchaseOrders.requesterId, requester: requester.name, serviceFrontId: purchaseOrders.serviceFrontId, front: serviceFronts.name,
    requestedAt: purchaseOrders.requestedAt, status: purchaseOrders.status, notes: purchaseOrders.notes,
  }).from(purchaseOrders).innerJoin(requester, eq(purchaseOrders.requesterId, requester.id)).innerJoin(serviceFronts, eq(purchaseOrders.serviceFrontId, serviceFronts.id))
    .where(or(...visibility)).orderBy(desc(purchaseOrders.requestedAt)).limit(500);
  const ids = rows.map((row) => row.id);
  const items = ids.length ? await db.select({ orderId: purchaseOrderItems.orderId, description: purchaseOrderItems.description, quantity: purchaseOrderItems.quantity, fiscalUnit: purchaseOrderItems.fiscalUnit, unitPrice: purchaseOrderItems.unitPrice, receivedAt: purchaseOrderItems.receivedAt })
    .from(purchaseOrderItems).where(inArray(purchaseOrderItems.orderId, ids)).orderBy(asc(purchaseOrderItems.id)) : [];
  return rows.map((row) => {
    const own = items.filter((item) => item.orderId === row.id);
    return {
      ...row, number: purchaseOrderNumber(row.id), statusLabel: PURCHASE_STATUS_LABELS[row.status as PurchaseStatus] ?? row.status,
      itemCount: own.length, itemsPreview: own.slice(0, 3).map((item) => item.description),
      total: own.every((item) => item.unitPrice === null) ? null : own.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0),
      actions: purchaseActions(user, row),
    };
  });
}

function canSeeOrder(user: SessionUser, order: { requesterId: number; serviceFrontId: number }, fronts: number[] | "ALL") {
  return order.requesterId === user.id || (worksOnPurchases(user) && (fronts === "ALL" || fronts.includes(order.serviceFrontId)));
}

export async function requirePurchaseOrder(db: Db, user: SessionUser, fronts: number[] | "ALL", id: number) {
  const order = (await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1))[0];
  if (!order || !canSeeOrder(user, order, fronts)) throw new StockError("Pedido não encontrado.", 404);
  return order;
}

export async function purchaseOrderDetail(db: Db, user: SessionUser, fronts: number[] | "ALL", id: number) {
  const order = await requirePurchaseOrder(db, user, fronts, id);
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [order.requesterId, order.approvedBy, order.rejectedBy, order.paymentRequestedBy, order.paidBy, order.dispatchedBy, order.receivedBy, order.cancelledBy].filter((value): value is number => typeof value === "number")));
  const name = (userId: number | null) => people.find((person) => person.id === userId)?.name ?? null;
  const quotedSupplier = alias(suppliers, "quoted_supplier");
  const receivedSupplier = alias(suppliers, "received_supplier");
  const productSupplier = alias(suppliers, "product_supplier");
  const [front, items, attachments] = await Promise.all([
    db.select({ name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, order.serviceFrontId)),
    db.select({
      item: purchaseOrderItems, productTag: products.tag, productName: products.name, productPrice: products.price, productBrand: products.brand,
      productSupplierId: products.supplierId, productSupplier: productSupplier.name, supplierName: quotedSupplier.name, receivedSupplierName: receivedSupplier.name,
    }).from(purchaseOrderItems).leftJoin(products, eq(purchaseOrderItems.productId, products.id))
      .leftJoin(productSupplier, eq(products.supplierId, productSupplier.id))
      .leftJoin(quotedSupplier, eq(purchaseOrderItems.supplierId, quotedSupplier.id))
      .leftJoin(receivedSupplier, eq(purchaseOrderItems.receivedSupplierId, receivedSupplier.id))
      .where(eq(purchaseOrderItems.orderId, id)).orderBy(asc(purchaseOrderItems.id)),
    db.select({ id: purchaseOrderAttachments.id, fileName: purchaseOrderAttachments.fileName, contentType: purchaseOrderAttachments.contentType, size: purchaseOrderAttachments.size, createdAt: purchaseOrderAttachments.createdAt })
      .from(purchaseOrderAttachments).where(eq(purchaseOrderAttachments.orderId, id)).orderBy(asc(purchaseOrderAttachments.id)),
  ]);
  const itemRows = items.map((row) => ({
    ...row.item, supplierName: row.supplierName, receivedSupplierName: row.receivedSupplierName,
    product: row.item.productId ? { id: row.item.productId, tag: row.productTag, name: row.productName, price: row.productPrice, brand: row.productBrand, supplierId: row.productSupplierId, supplier: row.productSupplier } : null,
    total: row.item.unitPrice === null ? null : row.item.unitPrice * row.item.quantity,
  }));
  return {
    ...order, number: purchaseOrderNumber(order.id), statusLabel: PURCHASE_STATUS_LABELS[order.status as PurchaseStatus], front: front[0]?.name ?? "—",
    requester: name(order.requesterId), approvedByName: name(order.approvedBy), rejectedByName: name(order.rejectedBy), paymentRequestedByName: name(order.paymentRequestedBy),
    paidByName: name(order.paidBy), dispatchedByName: name(order.dispatchedBy), receivedByName: name(order.receivedBy), cancelledByName: name(order.cancelledBy),
    items: itemRows, attachments, total: itemRows.every((item) => item.unitPrice === null) ? null : itemRows.reduce((sum, item) => sum + (item.total ?? 0), 0),
    actions: purchaseActions(user, order),
  };
}

// ------------------------------------------------------------------------------ criação

export type NewPurchaseInput = { serviceFrontId: number; notes: string | null; items: Array<{ productId: number | null; description: string; reference: string | null; quantity: number; fiscalUnit: string }> };

export function parseNewPurchase(body: Record<string, unknown>): NewPurchaseInput {
  const serviceFrontId = Number(body.serviceFrontId);
  if (!Number.isInteger(serviceFrontId) || serviceFrontId <= 0) throw new StockError("Selecione a frente do pedido.");
  const raw = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  if (raw.length === 0) throw new StockError("Adicione ao menos um item ao pedido.");
  const items = raw.map((item) => {
    const productId = Number(item.productId) > 0 ? Number(item.productId) : null;
    const description = clean(item.description).toUpperCase().slice(0, 300);
    const quantity = Number(String(item.quantity ?? "").replace(",", "."));
    const fiscalUnit = clean(item.fiscalUnit).toUpperCase();
    if (!productId && !description) throw new StockError("Descreva todos os itens digitados à mão.");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new StockError("A quantidade de todos os itens deve ser maior que zero.");
    if (!isFiscalUnit(fiscalUnit)) throw new StockError("Escolha a unidade fiscal de todos os itens.");
    return { productId, description, reference: clean(item.reference).toUpperCase().slice(0, 120) || null, quantity, fiscalUnit };
  });
  return { serviceFrontId, notes: clean(body.notes).slice(0, 2000) || null, items };
}

export async function createPurchaseOrder(db: Db, user: SessionUser, input: NewPurchaseInput) {
  const allowed = await requestFronts(db, user);
  if (!allowed.some((front) => front.id === input.serviceFrontId)) throw new StockError("Escolha uma das frentes vinculadas ao seu login.");
  const linkedIds = [...new Set(input.items.flatMap((item) => (item.productId ? [item.productId] : [])))];
  const linked = linkedIds.length ? await db.select({ id: products.id, name: products.name, reference: products.reference, active: products.active }).from(products).where(inArray(products.id, linkedIds)) : [];
  if (linked.filter((row) => row.active).length !== linkedIds.length) throw new StockError("Um dos produtos escolhidos não existe mais ou foi desativado.");
  for (const item of input.items) {
    const product = linked.find((row) => row.id === item.productId);
    if (!product) continue;
    item.description ||= product.name;
    item.reference ||= product.reference;
  }
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const [order] = await tx.insert(purchaseOrders).values({ requesterId: user.id, serviceFrontId: input.serviceFrontId, requestedAt: now, status: "AGUARDANDO_APROVACAO", notes: input.notes }).returning({ id: purchaseOrders.id });
    await tx.insert(purchaseOrderItems).values(input.items.map((item) => ({ orderId: order.id, ...item })));
    await audit(tx, user.id, order.id, "PEDIDO DE COMPRA CRIADO", input);
    return { id: order.id, number: purchaseOrderNumber(order.id) };
  });
}

// ------------------------------------------------------------------------------ etapas

type ActionBody = Record<string, unknown>;

export async function applyPurchaseAction(db: Db, user: SessionUser, fronts: number[] | "ALL", id: number, body: ActionBody) {
  const order = await requirePurchaseOrder(db, user, fronts, id);
  const actions = purchaseActions(user, order);
  const number = purchaseOrderNumber(id);
  const now = new Date().toISOString();
  const action = clean(body.action);
  const deny = () => new StockError("Esta etapa não está disponível para você neste pedido (confira a situação e as suas permissões).", 409);

  if (action === "APPROVE" || action === "REJECT") {
    if (!actions.approve) throw deny();
    if (action === "REJECT") {
      const reason = clean(body.reason);
      if (!reason) throw new StockError("Informe o motivo da recusa.");
      await db.update(purchaseOrders).set({ status: "RECUSADO", rejectedBy: user.id, rejectedAt: now, rejectReason: reason, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await audit(db, user.id, id, "PEDIDO RECUSADO", { reason });
      return `Pedido ${number} recusado.`;
    }
    await db.update(purchaseOrders).set({ status: "EM_COTACAO", approvedBy: user.id, approvedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(db, user.id, id, "PEDIDO APROVADO");
    return `Pedido ${number} aprovado e enviado para cotação.`;
  }

  if (action === "SAVE_QUOTE" || action === "SEND_TO_PAYMENT") {
    if (!actions.quote) throw deny();
    const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, id));
    const updates = Array.isArray(body.items) ? (body.items as ActionBody[]) : [];
    await db.transaction(async (tx) => {
      for (const update of updates) {
        const item = items.find((row) => row.id === Number(update.id));
        if (!item) continue;
        const unitPrice = numberOrNull(update.unitPrice);
        if (unitPrice !== null && (Number.isNaN(unitPrice) || unitPrice < 0)) throw new StockError(`Valor inválido no item ${item.description}.`);
        const supplierId = Number(update.supplierId) > 0 ? Number(update.supplierId) : null;
        await tx.update(purchaseOrderItems).set({ unitPrice, supplierId, brand: clean(update.brand).toUpperCase() || null, updatedAt: now }).where(eq(purchaseOrderItems.id, item.id));
      }
      await tx.update(purchaseOrders).set({ buyerNotes: body.buyerNotes === undefined ? order.buyerNotes : clean(body.buyerNotes) || null, updatedAt: now }).where(eq(purchaseOrders.id, id));
    });
    if (action === "SAVE_QUOTE") { await audit(db, user.id, id, "COTAÇÃO SALVA", { items: updates }); return `Cotação do pedido ${number} salva.`; }
    const fresh = await db.select({ unitPrice: purchaseOrderItems.unitPrice, description: purchaseOrderItems.description }).from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, id));
    const missing = fresh.find((item) => item.unitPrice === null);
    if (missing) throw new StockError(`Preencha o valor de todos os itens antes de enviar para pagamento (falta: ${missing.description}).`);
    await db.update(purchaseOrders).set({ status: "ANALISE_PAGAMENTO", paymentRequestedBy: user.id, paymentRequestedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(db, user.id, id, "PEDIDO ENVIADO PARA PAGAMENTO");
    return `Pedido ${number} enviado para análise de pagamento.`;
  }

  if (action === "CONFIRM_PAYMENT") {
    if (!actions.confirmPayment) throw deny();
    await db.update(purchaseOrders).set({ status: "PAGO", paidBy: user.id, paidAt: now, paymentNotes: clean(body.notes) || null, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(db, user.id, id, "PAGAMENTO CONFIRMADO", { notes: clean(body.notes) || null });
    return `Pagamento do pedido ${number} confirmado.`;
  }

  if (action === "DISPATCH") {
    if (!actions.dispatch) throw deny();
    await db.update(purchaseOrders).set({ status: "ENVIADO", dispatchedBy: user.id, dispatchedAt: now, dispatchNotes: clean(body.notes) || null, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(db, user.id, id, "PEDIDO ENVIADO", { notes: clean(body.notes) || null });
    return `Pedido ${number} marcado como enviado.`;
  }

  if (action === "CANCEL") {
    if (!actions.cancel) throw deny();
    const reason = clean(body.reason);
    if (!reason) throw new StockError("Informe o motivo do cancelamento.");
    await db.update(purchaseOrders).set({ status: "CANCELADO", cancelledBy: user.id, cancelledAt: now, cancelReason: reason, updatedAt: now }).where(eq(purchaseOrders.id, id));
    await audit(db, user.id, id, "PEDIDO CANCELADO", { reason });
    return `Pedido ${number} cancelado.`;
  }

  if (action === "RECEIVE_ITEM") {
    if (!actions.receive) throw deny();
    return receiveItem(db, user, order, body);
  }
  throw new StockError("Ação inválida.");
}

// Conferência do recebimento de um item ("Mudou o fornecedor? a marca? o valor? Veio a quantidade
// pedida?"). Item vinculado a produto: entrada no estoque da frente do pedido + atualização do
// cadastro do produto no que mudou. Item manual: só marca recebido.
async function receiveItem(db: Db, user: SessionUser, order: typeof purchaseOrders.$inferSelect, body: ActionBody) {
  const item = (await db.select().from(purchaseOrderItems).where(and(eq(purchaseOrderItems.id, Number(body.itemId)), eq(purchaseOrderItems.orderId, order.id))).limit(1))[0];
  if (!item) throw new StockError("Item não encontrado neste pedido.", 404);
  if (item.receivedAt) throw new StockError("Este item já foi recebido.", 409);
  const number = purchaseOrderNumber(order.id);
  const now = new Date().toISOString();
  const fullQuantity = body.fullQuantity !== false;
  const quantity = fullQuantity ? item.quantity : numberOrNull(body.quantity);
  if (quantity === null || Number.isNaN(quantity) || quantity < 0) throw new StockError("Informe a quantidade que realmente chegou.");
  const product = item.productId ? (await db.select().from(products).where(eq(products.id, item.productId)).limit(1))[0] : null;

  const supplierChanged = body.supplierChanged === true;
  const brandChanged = body.brandChanged === true;
  const priceChanged = body.priceChanged === true;
  const supplierId = supplierChanged ? (Number(body.supplierId) > 0 ? Number(body.supplierId) : null) : (product?.supplierId ?? item.supplierId ?? null);
  if (supplierChanged && !supplierId) throw new StockError("Escolha o novo fornecedor.");
  if (supplierChanged && !(await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId!)).limit(1))[0]) throw new StockError("Fornecedor não encontrado.", 404);
  const brand = brandChanged ? clean(body.brand).toUpperCase() || null : (product?.brand ?? item.brand ?? null);
  if (brandChanged && !brand) throw new StockError("Informe a nova marca.");
  const newPrice = priceChanged ? numberOrNull(body.unitPrice) : null;
  if (priceChanged && (newPrice === null || Number.isNaN(newPrice) || newPrice < 0)) throw new StockError("Informe o novo valor unitário.");
  const unitPrice = priceChanged ? newPrice! : (item.unitPrice ?? product?.price ?? null);

  await db.transaction(async (tx) => {
    await tx.update(purchaseOrderItems).set({
      receivedAt: now, receivedBy: user.id, receivedQuantity: quantity, receivedUnitPrice: unitPrice, receivedSupplierId: supplierId, receivedBrand: brand,
      receiptNotes: clean(body.notes) || null, updatedAt: now,
    }).where(eq(purchaseOrderItems.id, item.id));
    if (product) {
      if (quantity > 0) {
        await stockEntry(tx, {
          productId: product.id, serviceFrontId: order.serviceFrontId, quantity, source: "PURCHASE", reason: `Recebimento do pedido ${number}`,
          userId: user.id, unitPrice, refs: { purchaseOrderId: order.id, purchaseOrderItemId: item.id },
        });
      }
      const changes: Partial<typeof products.$inferInsert> = {};
      if (supplierChanged && supplierId !== product.supplierId) changes.supplierId = supplierId;
      if (brandChanged && brand !== product.brand) changes.brand = brand;
      if (priceChanged && unitPrice !== null && unitPrice !== product.price) changes.price = unitPrice;
      if (Object.keys(changes).length) {
        await tx.update(products).set({ ...changes, updatedAt: now }).where(eq(products.id, product.id));
        await tx.insert(auditLogs).values({ userId: user.id, entityType: "PRODUCT", entityId: String(product.id), action: "PRODUTO ATUALIZADO NO RECEBIMENTO",
          previousValue: JSON.stringify({ supplierId: product.supplierId, brand: product.brand, price: product.price }), newValue: JSON.stringify({ ...changes, pedido: number }) });
      }
    }
    await audit(tx, user.id, order.id, "ITEM RECEBIDO", { itemId: item.id, quantity, unitPrice, supplierChanged, brandChanged, priceChanged });
    const remaining = (await tx.select({ receivedAt: purchaseOrderItems.receivedAt }).from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, order.id))).filter((row) => !row.receivedAt);
    if (remaining.length === 0) {
      await tx.update(purchaseOrders).set({ status: "RECEBIDO", receivedBy: user.id, receivedAt: now, updatedAt: now }).where(eq(purchaseOrders.id, order.id));
      await audit(tx, user.id, order.id, "PEDIDO RECEBIDO");
    }
  });
  return product
    ? `Item recebido${quantity > 0 ? `: entrada de ${quantity.toLocaleString("pt-BR")} no estoque` : " (nada chegou, sem entrada no estoque)"}.`
    : "Item recebido (item digitado à mão, sem movimentação de estoque).";
}
