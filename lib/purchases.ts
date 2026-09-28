import { and, asc, desc, eq, inArray, max, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { auditLogs, equipment, products, purchaseOrderAttachments, purchaseOrderItemEvents, purchaseOrderItems, purchaseOrders, serviceFronts, suppliers, users } from "../db/schema";
import type { Permission, SessionUser } from "./auth";
import { ensureBrand } from "./catalog";
import { requireDepartment } from "./departments";
import { purchaseOrderNumber } from "./document-numbers";
import { isFiscalUnit } from "./fiscal-units";
import {
  ACTION_FROM, ACTION_TO, availableActions, canDo, FLOW, isActiveItem, isTerminalOrder, ITEM_STATUS_LABELS, ORDER_STATUS_LABELS, orderStatusFromItems,
  PURCHASE_COMPANIES, quantityProblem, URGENCIES, type Capabilities, type ItemAction, type ItemStatus, type OrderStatus, type Urgency,
} from "./purchase-rules";
import { stockEntry, StockError } from "./stock";
import { equipmentOptions, isIsoDay, localToday, requestFronts } from "./stock-options";

// ---------------------------------------------------------------------------------------------
// Solicitação de Pedidos (Compras externas), PED-000123. Cada ITEM anda sozinho no fluxo
// (lib/purchase-rules.ts) e cada etapa é de uma função diferente:
//   solicitante cria → aprovador aprova/recusa (item a item ou todos) → comprador cota (anexos,
//   valores, reduz/remove itens) e envia para pagamento → pagamento confirma → despacho marca
//   enviado → solicitante confirma o recebimento item a item. Item vinculado a produto gera ENTRADA
//   no estoque da frente do pedido (lib/stock.ts); item manual só fica recebido.
// A situação GERAL do pedido é a combinação dos itens e fica gravada em purchase_orders.status.
// Todos da frente do pedido enxergam (só consulta); as ações seguem as permissões de cada função.
// ---------------------------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Order = typeof purchaseOrders.$inferSelect;
type ItemRow = typeof purchaseOrderItems.$inferSelect;
type Fronts = number[] | "ALL";

const ROLE_PERMISSIONS: Permission[] = ["purchases.approve", "purchases.buy", "purchases.pay", "purchases.dispatch", "purchases.manage"];
export const worksOnPurchases = (user: SessionUser) => ROLE_PERMISSIONS.some((permission) => user.permissions.includes(permission));

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const numberOrNull = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : NaN;
};
const fmtQty = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

async function audit(db: Tx, userId: number, id: number, action: string, value?: unknown) {
  await db.insert(auditLogs).values({ userId, entityType: "PURCHASE_ORDER", entityId: String(id), action, newValue: value === undefined ? null : JSON.stringify(value) });
}

type EventInput = { orderId: number; itemId: number; action: string; fromStatus?: string | null; toStatus?: string | null; details?: string | null; userId: number };
async function logEvents(db: Tx, events: EventInput[]) {
  if (events.length) await db.insert(purchaseOrderItemEvents).values(events.map((event) => ({ ...event, fromStatus: event.fromStatus ?? null, toStatus: event.toStatus ?? null, details: event.details ?? null })));
}

// Recalcula e grava a situação geral a partir dos itens.
async function syncOrderStatus(db: Tx, order: Pick<Order, "id" | "cancelledAt">, userId: number, now: string) {
  const items = await db.select({ status: purchaseOrderItems.status }).from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, order.id));
  const status = orderStatusFromItems(items, Boolean(order.cancelledAt));
  await db.update(purchaseOrders).set({ status, updatedAt: now, ...(status === "RECEBIDO" ? { receivedBy: userId, receivedAt: now } : {}) }).where(eq(purchaseOrders.id, order.id));
  return status;
}

export function capabilities(user: SessionUser, order: Pick<Order, "requesterId">): Capabilities {
  const has = (permission: Permission) => user.permissions.includes(permission);
  return { approve: has("purchases.approve"), buy: has("purchases.buy"), pay: has("purchases.pay"), dispatch: has("purchases.dispatch"), manage: has("purchases.manage"), own: order.requesterId === user.id };
}

// Ações que a pessoa pode fazer agora no pedido (a tela mostra só estes botões; a API confere de novo).
export function orderActions(user: SessionUser, order: Pick<Order, "requesterId" | "cancelledAt" | "status">, items: Array<{ status: string }>) {
  const caps = capabilities(user, order);
  const actions = availableActions(items, caps, Boolean(order.cancelledAt));
  return {
    ...actions,
    // Fotos dos itens: quem pediu (ou quem gerencia) enquanto o pedido não terminou.
    PHOTO: (caps.own || caps.manage) && !isTerminalOrder(order.status),
    // Comprovante de pagamento: quem confirma pagamentos, a partir da análise de pagamento.
    PAYMENT_PROOF: caps.pay && !order.cancelledAt && items.some((item) => FLOW.indexOf(item.status as ItemStatus) >= FLOW.indexOf("ANALISE_PAGAMENTO")),
  };
}
export type OrderActions = ReturnType<typeof orderActions>;
const needsMe = (actions: OrderActions) => (["APPROVE", "QUOTE", "CONFIRM_PAYMENT", "DISPATCH", "RECEIVE"] as ItemAction[]).some((action) => actions[action]);

// ------------------------------------------------------------------------------ visibilidade

// Quem pediu sempre vê o próprio pedido; os demais veem todos os pedidos das frentes que enxergam
// (seletor global ∩ frentes do login) — só consulta, as ações dependem das permissões.
function visibilityCondition(user: SessionUser, fronts: Fronts): SQL {
  if (fronts === "ALL") return sql`true`;
  return fronts.length ? or(eq(purchaseOrders.requesterId, user.id), inArray(purchaseOrders.serviceFrontId, fronts))! : eq(purchaseOrders.requesterId, user.id);
}
const canSeeOrder = (user: SessionUser, order: Pick<Order, "requesterId" | "serviceFrontId">, fronts: Fronts) =>
  order.requesterId === user.id || fronts === "ALL" || fronts.includes(order.serviceFrontId);

export async function requirePurchaseOrder(db: Db, user: SessionUser, fronts: Fronts, id: number) {
  const order = (await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1))[0];
  if (!order || !canSeeOrder(user, order, fronts)) throw new StockError("Pedido não encontrado.", 404);
  return order;
}

export async function orderItemStatuses(db: Db, orderId: number) {
  return db.select({ id: purchaseOrderItems.id, status: purchaseOrderItems.status }).from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, orderId));
}

// ------------------------------------------------------------------------------ consulta

export async function listPurchaseOrders(db: Db, user: SessionUser, fronts: Fronts) {
  const creator = alias(users, "po_creator");
  const rows = await db.select({
    id: purchaseOrders.id, requesterId: purchaseOrders.requesterId, createdBy: creator.name, requesterName: purchaseOrders.requesterName,
    serviceFrontId: purchaseOrders.serviceFrontId, front: serviceFronts.name, requestedAt: purchaseOrders.requestedAt, orderDate: purchaseOrders.orderDate,
    status: purchaseOrders.status, cancelledAt: purchaseOrders.cancelledAt, notes: purchaseOrders.notes, company: purchaseOrders.company,
    title: purchaseOrders.title, department: purchaseOrders.department, departmentId: purchaseOrders.departmentId, urgency: purchaseOrders.urgency, equipmentPrefix: equipment.prefix,
  }).from(purchaseOrders).innerJoin(creator, eq(purchaseOrders.requesterId, creator.id)).innerJoin(serviceFronts, eq(purchaseOrders.serviceFrontId, serviceFronts.id))
    .leftJoin(equipment, eq(purchaseOrders.equipmentId, equipment.id))
    .where(visibilityCondition(user, fronts)).orderBy(desc(purchaseOrders.requestedAt)).limit(1000);
  const ids = rows.map((row) => row.id);
  const [items, quotes] = ids.length ? await Promise.all([
    db.select({ orderId: purchaseOrderItems.orderId, description: purchaseOrderItems.description, reference: purchaseOrderItems.reference, quantity: purchaseOrderItems.quantity, unitPrice: purchaseOrderItems.unitPrice, status: purchaseOrderItems.status })
      .from(purchaseOrderItems).where(inArray(purchaseOrderItems.orderId, ids)).orderBy(asc(purchaseOrderItems.id)),
    db.select({ orderId: purchaseOrderAttachments.orderId, count: sql<number>`count(*)::int` }).from(purchaseOrderAttachments)
      .where(and(inArray(purchaseOrderAttachments.orderId, ids), inArray(purchaseOrderAttachments.kind, ["QUOTE_IMAGE", "QUOTE_DOCUMENT"]))).groupBy(purchaseOrderAttachments.orderId),
  ]) : [[], []];
  return rows.map((row) => {
    const own = items.filter((item) => item.orderId === row.id);
    const active = own.filter((item) => isActiveItem(item.status));
    const actions = orderActions(user, row, own);
    return {
      ...row, number: purchaseOrderNumber(row.id), statusLabel: ORDER_STATUS_LABELS[row.status as OrderStatus] ?? row.status,
      requesterName: row.requesterName || row.createdBy, orderDate: row.orderDate ?? row.requestedAt.slice(0, 10),
      items: own.map((item) => ({ status: item.status })), itemCount: own.length, activeItemCount: active.length,
      searchText: own.map((item) => `${item.description} ${item.reference ?? ""}`).join(" "),
      quoteCount: quotes.find((quote) => quote.orderId === row.id)?.count ?? 0,
      total: active.every((item) => item.unitPrice === null) ? null : active.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0),
      needsMe: needsMe(actions),
    };
  });
}

export async function nextPurchaseNumber(db: Db) {
  const [row] = await db.select({ value: max(purchaseOrders.id) }).from(purchaseOrders);
  return purchaseOrderNumber((row?.value ?? 0) + 1);
}

export async function purchaseOrderDetail(db: Db, user: SessionUser, fronts: Fronts, id: number) {
  const order = await requirePurchaseOrder(db, user, fronts, id);
  const quotedSupplier = alias(suppliers, "quoted_supplier");
  const receivedSupplier = alias(suppliers, "received_supplier");
  const productSupplier = alias(suppliers, "product_supplier");
  const [front, equipmentRow, items, attachments, events] = await Promise.all([
    db.select({ name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, order.serviceFrontId)),
    order.equipmentId ? db.select({ id: equipment.id, prefix: equipment.prefix, type: equipment.type, brand: equipment.brand, model: equipment.model, chassis: equipment.chassis, year: equipment.year }).from(equipment).where(eq(equipment.id, order.equipmentId)) : Promise.resolve([]),
    db.select({
      item: purchaseOrderItems, productTag: products.tag, productName: products.name, productPrice: products.price, productBrand: products.brand,
      productSupplierId: products.supplierId, productSupplier: productSupplier.name, supplierName: quotedSupplier.name, receivedSupplierName: receivedSupplier.name,
    }).from(purchaseOrderItems).leftJoin(products, eq(purchaseOrderItems.productId, products.id))
      .leftJoin(productSupplier, eq(products.supplierId, productSupplier.id))
      .leftJoin(quotedSupplier, eq(purchaseOrderItems.supplierId, quotedSupplier.id))
      .leftJoin(receivedSupplier, eq(purchaseOrderItems.receivedSupplierId, receivedSupplier.id))
      .where(eq(purchaseOrderItems.orderId, id)).orderBy(asc(purchaseOrderItems.id)),
    db.select({ id: purchaseOrderAttachments.id, kind: purchaseOrderAttachments.kind, itemId: purchaseOrderAttachments.itemId, fileName: purchaseOrderAttachments.fileName, contentType: purchaseOrderAttachments.contentType, size: purchaseOrderAttachments.size, createdAt: purchaseOrderAttachments.createdAt, uploadedBy: purchaseOrderAttachments.uploadedBy })
      .from(purchaseOrderAttachments).where(eq(purchaseOrderAttachments.orderId, id)).orderBy(asc(purchaseOrderAttachments.id)),
    db.select().from(purchaseOrderItemEvents).where(eq(purchaseOrderItemEvents.orderId, id)).orderBy(asc(purchaseOrderItemEvents.createdAt), asc(purchaseOrderItemEvents.id)),
  ]);
  const peopleIds = new Set<number>([order.requesterId]);
  if (order.cancelledBy) peopleIds.add(order.cancelledBy);
  for (const { item } of items) for (const value of [item.approvedBy, item.rejectedBy, item.paymentRequestedBy, item.paidBy, item.dispatchedBy, item.receivedBy, item.quantityChangedBy, item.removedBy]) if (value) peopleIds.add(value);
  for (const event of events) if (event.userId) peopleIds.add(event.userId);
  for (const file of attachments) if (file.uploadedBy) peopleIds.add(file.uploadedBy);
  const people = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...peopleIds]));
  const name = (userId: number | null) => people.find((person) => person.id === userId)?.name ?? null;

  const itemRows = items.map(({ item, ...row }) => ({
    ...item, statusLabel: ITEM_STATUS_LABELS[item.status as ItemStatus] ?? item.status,
    supplierName: row.supplierName, receivedSupplierName: row.receivedSupplierName,
    product: item.productId ? { id: item.productId, tag: row.productTag, name: row.productName, price: row.productPrice, brand: row.productBrand, supplierId: row.productSupplierId, supplier: row.productSupplier } : null,
    total: item.unitPrice === null || !isActiveItem(item.status) ? null : item.unitPrice * item.quantity,
    approvedByName: name(item.approvedBy), rejectedByName: name(item.rejectedBy), paymentRequestedByName: name(item.paymentRequestedBy), paidByName: name(item.paidBy),
    dispatchedByName: name(item.dispatchedBy), receivedByName: name(item.receivedBy), quantityChangedByName: name(item.quantityChangedBy), removedByName: name(item.removedBy),
    events: events.filter((event) => event.itemId === item.id).map((event) => ({
      id: event.id, action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, details: event.details, userName: name(event.userId), createdAt: event.createdAt,
    })),
  }));
  const actions = orderActions(user, order, itemRows);
  const equipmentInfo = equipmentRow[0] ? { ...equipmentRow[0], description: [equipmentRow[0].brand, equipmentRow[0].model].filter(Boolean).join(" ") || equipmentRow[0].type } : null;
  return {
    ...order, number: purchaseOrderNumber(order.id), statusLabel: ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status, front: front[0]?.name ?? "—",
    createdByName: name(order.requesterId), requesterName: order.requesterName || name(order.requesterId), orderDate: order.orderDate ?? order.requestedAt.slice(0, 10),
    cancelledByName: name(order.cancelledBy), equipment: equipmentInfo,
    items: itemRows, attachments: attachments.map((file) => ({ ...file, uploadedByName: name(file.uploadedBy) })),
    total: itemRows.every((item) => item.total === null) ? null : itemRows.reduce((sum, item) => sum + (item.total ?? 0), 0),
    actions,
  };
}

// ------------------------------------------------------------------------------ criação

export type NewPurchaseInput = {
  serviceFrontId: number; notes: string | null; company: string | null; title: string; departmentId: number | null;
  orderDate: string; requesterName: string; urgency: Urgency; equipmentId: number | null;
  items: Array<{ productId: number | null; description: string; reference: string | null; notes: string | null; quantity: number; fiscalUnit: string }>;
};

export function parseNewPurchase(body: Record<string, unknown>, user: SessionUser): NewPurchaseInput {
  const serviceFrontId = Number(body.serviceFrontId);
  if (!Number.isInteger(serviceFrontId) || serviceFrontId <= 0) throw new StockError("Selecione a frente do pedido.");
  const title = clean(body.title).toUpperCase().slice(0, 200);
  if (!title) throw new StockError("Informe a descrição do pedido.");
  const company = clean(body.company).toUpperCase();
  if (company && !(PURCHASE_COMPANIES as readonly string[]).includes(company)) throw new StockError("Empresa inválida.");
  const urgency = (clean(body.urgency).toUpperCase() || "NORMAL") as Urgency;
  if (!URGENCIES.includes(urgency)) throw new StockError("Urgência inválida.");
  const orderDate = clean(body.orderDate) || localToday();
  if (!isIsoDay(orderDate)) throw new StockError("Data do pedido inválida.");
  const equipmentId = Number(body.equipmentId) > 0 ? Number(body.equipmentId) : null;
  const departmentId = Number(body.departmentId) > 0 ? Number(body.departmentId) : null;
  const raw = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  if (raw.length === 0) throw new StockError("Adicione ao menos um item ao pedido.");
  const items = raw.map((item) => {
    const productId = Number(item.productId) > 0 ? Number(item.productId) : null;
    const description = clean(item.description).toUpperCase().slice(0, 300);
    const quantity = Number(String(item.quantity ?? "").replace(",", "."));
    const fiscalUnit = clean(item.fiscalUnit).toUpperCase();
    if (!productId && !description) throw new StockError("Descreva todos os itens digitados à mão.");
    if (!Number.isFinite(quantity) || quantity <= 0) throw new StockError("A quantidade de todos os itens deve ser maior que zero.");
    if (!isFiscalUnit(fiscalUnit)) throw new StockError("Escolha a unidade de todos os itens.");
    return { productId, description, reference: clean(item.reference).toUpperCase().slice(0, 120) || null, notes: clean(item.notes).slice(0, 1000) || null, quantity, fiscalUnit };
  });
  return {
    serviceFrontId, title, company: company || null, departmentId,
    orderDate, requesterName: clean(body.requesterName).slice(0, 160) || user.name, urgency, equipmentId, notes: clean(body.notes).slice(0, 2000) || null, items,
  };
}

export async function createPurchaseOrder(db: Db, user: SessionUser, input: NewPurchaseInput) {
  const allowed = await requestFronts(db, user);
  if (!allowed.some((front) => front.id === input.serviceFrontId)) throw new StockError("Escolha uma das frentes vinculadas ao seu login.");
  const department = input.departmentId ? await requireDepartment(db, input.departmentId) : null;
  if (input.equipmentId && !(await equipmentOptions(db, user)).some((row) => row.id === input.equipmentId)) throw new StockError("Equipamento não encontrado entre os que você enxerga.");
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
    const { items, ...header } = input;
    const [order] = await tx.insert(purchaseOrders).values({ ...header, department: department?.name ?? null, requesterId: user.id, requestedAt: now, status: "AGUARDANDO_APROVACAO" }).returning({ id: purchaseOrders.id });
    const created = await tx.insert(purchaseOrderItems).values(items.map((item) => ({ orderId: order.id, ...item, status: "AGUARDANDO_APROVACAO" as const }))).returning({ id: purchaseOrderItems.id });
    await logEvents(tx, created.map((item) => ({ orderId: order.id, itemId: item.id, action: "SOLICITADO", toStatus: "AGUARDANDO_APROVACAO", userId: user.id })));
    await audit(tx, user.id, order.id, "PEDIDO DE COMPRA CRIADO", input);
    // Ids dos itens na mesma ordem do envio: a tela usa para vincular as fotos a cada item.
    return { id: order.id, number: purchaseOrderNumber(order.id), itemIds: created.map((item) => item.id) };
  });
}

// ------------------------------------------------------------------------------ etapas

type ActionBody = Record<string, unknown>;
const EVENT_NAMES: Record<ItemAction, string> = {
  APPROVE: "APROVADO", REJECT: "RECUSADO", QUOTE: "COTAÇÃO", REMOVE: "REMOVIDO NA COTAÇÃO", SEND_TO_PAYMENT: "ENVIADO PARA PAGAMENTO",
  CONFIRM_PAYMENT: "PAGAMENTO CONFIRMADO", DISPATCH: "ENVIADO", RECEIVE: "RECEBIDO",
};
const BATCH_ACTIONS: ItemAction[] = ["APPROVE", "REJECT", "REMOVE", "SEND_TO_PAYMENT", "CONFIRM_PAYMENT", "DISPATCH"];

export async function applyPurchaseAction(db: Db, user: SessionUser, fronts: Fronts, id: number, body: ActionBody) {
  const order = await requirePurchaseOrder(db, user, fronts, id);
  const caps = capabilities(user, order);
  const number = purchaseOrderNumber(id);
  const now = new Date().toISOString();
  const action = clean(body.action);
  const deny = () => new StockError("Esta etapa não está disponível para você neste pedido (confira a situação dos itens e as suas permissões).", 409);
  if (order.cancelledAt) throw new StockError("Este pedido foi cancelado.", 409);
  const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.orderId, id)).orderBy(asc(purchaseOrderItems.id));

  if (action === "SAVE_QUOTE") {
    if (!canDo("QUOTE", caps) || !items.some((item) => item.status === "EM_COTACAO")) throw deny();
    await saveQuote(db, user, order, items, body, now);
    await audit(db, user.id, id, "COTAÇÃO SALVA", { items: body.items });
    return `Cotação do pedido ${number} salva.`;
  }

  if (action === "ADJUST_QUANTITY") {
    if (!canDo("QUOTE", caps)) throw deny();
    const item = items.find((row) => row.id === Number(body.itemId));
    if (!item) throw new StockError("Item não encontrado neste pedido.", 404);
    if (item.status !== "EM_COTACAO") throw new StockError("A quantidade só pode ser ajustada com o item em cotação.", 409);
    const original = item.originalQuantity ?? item.quantity;
    const next = numberOrNull(body.quantity) ?? NaN;
    const problem = quantityProblem(original, next);
    if (problem) throw new StockError(problem);
    if (next === item.quantity) return "A quantidade não mudou.";
    const reason = clean(body.reason).slice(0, 500) || null;
    await db.transaction(async (tx) => {
      await tx.update(purchaseOrderItems).set({ originalQuantity: original, quantity: next, quantityChangedBy: user.id, quantityChangedAt: now, updatedAt: now }).where(eq(purchaseOrderItems.id, item.id));
      await logEvents(tx, [{ orderId: id, itemId: item.id, action: "QUANTIDADE ALTERADA", details: `Pedido: ${fmtQty(original)} ${item.fiscalUnit} · antes: ${fmtQty(item.quantity)} · agora: ${fmtQty(next)} ${item.fiscalUnit}${reason ? ` · ${reason}` : ""}`, userId: user.id }]);
      await audit(tx, user.id, id, "QUANTIDADE ALTERADA NA COTAÇÃO", { itemId: item.id, original, from: item.quantity, to: next, reason });
    });
    return `Quantidade de ${item.description} ajustada para ${fmtQty(next)} ${item.fiscalUnit} (pedido original: ${fmtQty(original)}).`;
  }

  if (action === "CANCEL") {
    if (!orderActions(user, order, items).CANCEL) throw deny();
    const reason = clean(body.reason);
    if (!reason) throw new StockError("Informe o motivo do cancelamento.");
    const open = items.filter((item) => isActiveItem(item.status) && item.status !== "RECEBIDO");
    await db.transaction(async (tx) => {
      if (open.length) await tx.update(purchaseOrderItems).set({ status: "CANCELADO", updatedAt: now }).where(inArray(purchaseOrderItems.id, open.map((item) => item.id)));
      await logEvents(tx, open.map((item) => ({ orderId: id, itemId: item.id, action: "PEDIDO CANCELADO", fromStatus: item.status, toStatus: "CANCELADO", details: reason, userId: user.id })));
      await tx.update(purchaseOrders).set({ status: "CANCELADO", cancelledBy: user.id, cancelledAt: now, cancelReason: reason, updatedAt: now }).where(eq(purchaseOrders.id, id));
      await audit(tx, user.id, id, "PEDIDO CANCELADO", { reason });
    });
    return `Pedido ${number} cancelado.`;
  }

  if (action === "RECEIVE_ITEM") {
    if (!canDo("RECEIVE", caps)) throw deny();
    return receiveItem(db, user, order, items, body);
  }

  if (!BATCH_ACTIONS.includes(action as ItemAction)) throw new StockError("Ação inválida.");
  const itemAction = action as ItemAction;
  if (!canDo(itemAction, caps)) throw deny();
  // Itens escolhidos (checkbox, ou "Selecionar todos"): só os que estão na etapa certa mudam.
  const requested = Array.isArray(body.itemIds) ? new Set((body.itemIds as unknown[]).map(Number)) : null;
  const eligible = items.filter((item) => (!requested || requested.has(item.id)) && item.status === ACTION_FROM[itemAction]);
  if (eligible.length === 0) throw new StockError(`Nenhum dos itens selecionados está na etapa “${ITEM_STATUS_LABELS[ACTION_FROM[itemAction]]}”.`, 409);
  const reason = clean(body.reason).slice(0, 1000);
  const notes = clean(body.notes).slice(0, 1000) || null;
  if ((itemAction === "REJECT" || itemAction === "REMOVE") && !reason) throw new StockError(itemAction === "REJECT" ? "Informe o motivo da recusa." : "Informe por que o item foi removido.");

  if (itemAction === "SEND_TO_PAYMENT") {
    if (Array.isArray(body.items)) await saveQuote(db, user, order, items, body, now);
    const fresh = await db.select({ id: purchaseOrderItems.id, unitPrice: purchaseOrderItems.unitPrice, description: purchaseOrderItems.description }).from(purchaseOrderItems).where(inArray(purchaseOrderItems.id, eligible.map((item) => item.id)));
    const missing = fresh.find((item) => item.unitPrice === null);
    if (missing) throw new StockError(`Preencha o valor dos itens antes de enviar para pagamento (falta: ${missing.description}).`);
  }

  const to = ACTION_TO[itemAction]!;
  const stamp: Partial<typeof purchaseOrderItems.$inferInsert> =
    itemAction === "APPROVE" ? { approvedBy: user.id, approvedAt: now }
    : itemAction === "REJECT" ? { rejectedBy: user.id, rejectedAt: now, rejectReason: reason }
    : itemAction === "REMOVE" ? { removedBy: user.id, removedAt: now, removedReason: reason }
    : itemAction === "SEND_TO_PAYMENT" ? { paymentRequestedBy: user.id, paymentRequestedAt: now }
    : itemAction === "CONFIRM_PAYMENT" ? { paidBy: user.id, paidAt: now }
    : { dispatchedBy: user.id, dispatchedAt: now };
  const status = await db.transaction(async (tx) => {
    await tx.update(purchaseOrderItems).set({ status: to, ...stamp, updatedAt: now }).where(inArray(purchaseOrderItems.id, eligible.map((item) => item.id)));
    await logEvents(tx, eligible.map((item) => ({ orderId: id, itemId: item.id, action: EVENT_NAMES[itemAction], fromStatus: item.status, toStatus: to, details: reason || notes, userId: user.id })));
    // Observações de pagamento/envio também ficam no pedido (aparecem no detalhe).
    if (notes && (itemAction === "CONFIRM_PAYMENT" || itemAction === "DISPATCH")) {
      const field = itemAction === "CONFIRM_PAYMENT" ? "paymentNotes" : "dispatchNotes";
      const previous = order[field];
      await tx.update(purchaseOrders).set({ [field]: previous ? `${previous}\n${notes}` : notes }).where(eq(purchaseOrders.id, id));
    }
    await audit(tx, user.id, id, `ITENS: ${EVENT_NAMES[itemAction]}`, { itemIds: eligible.map((item) => item.id), reason: reason || null, notes });
    return syncOrderStatus(tx, order, user.id, now);
  });
  const skipped = requested ? requested.size - eligible.length : 0;
  return `${eligible.length} item(ns) do pedido ${number}: ${ITEM_STATUS_LABELS[to].toLowerCase()}.${skipped > 0 ? ` ${skipped} selecionado(s) em outra etapa ficaram como estavam.` : ""} Situação do pedido: ${ORDER_STATUS_LABELS[status]}.`;
}

// Valores, fornecedor e marca da cotação (só itens em cotação) + observações do comprador.
async function saveQuote(db: Db, user: SessionUser, order: Order, items: ItemRow[], body: ActionBody, now: string) {
  const updates = Array.isArray(body.items) ? (body.items as ActionBody[]) : [];
  await db.transaction(async (tx) => {
    for (const update of updates) {
      const item = items.find((row) => row.id === Number(update.id));
      if (!item || item.status !== "EM_COTACAO") continue;
      const unitPrice = numberOrNull(update.unitPrice);
      if (unitPrice !== null && (Number.isNaN(unitPrice) || unitPrice < 0)) throw new StockError(`Valor inválido no item ${item.description}.`);
      const supplierId = Number(update.supplierId) > 0 ? Number(update.supplierId) : null;
      const brand = await ensureBrand(tx, clean(update.brand), user.id);
      if (unitPrice === item.unitPrice && supplierId === item.supplierId && brand === item.brand) continue;
      await tx.update(purchaseOrderItems).set({ unitPrice, supplierId, brand, updatedAt: now }).where(eq(purchaseOrderItems.id, item.id));
      await logEvents(tx, [{ orderId: order.id, itemId: item.id, action: "COTAÇÃO", details: `Valor: ${unitPrice === null ? "—" : unitPrice.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}${brand ? ` · marca ${brand}` : ""}`, userId: user.id }]);
    }
    if (body.buyerNotes !== undefined) await tx.update(purchaseOrders).set({ buyerNotes: clean(body.buyerNotes) || null, updatedAt: now }).where(eq(purchaseOrders.id, order.id));
  });
}

// Conferência do recebimento de um item. Só a quantidade é obrigatória; fornecedor, marca e valor
// são complementares (preenchidos quando disponíveis). Item vinculado a produto: entrada no estoque
// da frente do pedido + atualização do cadastro do produto no que mudou. Item manual: só recebido.
async function receiveItem(db: Db, user: SessionUser, order: Order, items: ItemRow[], body: ActionBody) {
  const item = items.find((row) => row.id === Number(body.itemId));
  if (!item) throw new StockError("Item não encontrado neste pedido.", 404);
  if (item.status !== "ENVIADO") throw new StockError(item.status === "RECEBIDO" ? "Este item já foi recebido." : "O item só pode ser recebido depois de marcado como enviado.", 409);
  const number = purchaseOrderNumber(order.id);
  const now = new Date().toISOString();
  const fullQuantity = body.fullQuantity !== false;
  const quantity = fullQuantity ? item.quantity : numberOrNull(body.quantity);
  if (quantity === null || Number.isNaN(quantity) || quantity < 0) throw new StockError("Informe a quantidade que realmente chegou.");
  const product = item.productId ? (await db.select().from(products).where(eq(products.id, item.productId)).limit(1))[0] : null;

  const pickedSupplier = Number(body.supplierId) > 0 ? Number(body.supplierId) : null;
  if (pickedSupplier && !(await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, pickedSupplier)).limit(1))[0]) throw new StockError("Fornecedor não encontrado.", 404);
  const supplierChanged = body.supplierChanged === true && pickedSupplier !== null;
  const supplierId = supplierChanged ? pickedSupplier : (item.supplierId ?? product?.supplierId ?? null);
  const brandInput = clean(body.brand);
  const brandChanged = body.brandChanged === true && brandInput !== "";
  const newPrice = numberOrNull(body.unitPrice);
  if (body.priceChanged === true && newPrice !== null && (Number.isNaN(newPrice) || newPrice < 0)) throw new StockError("Valor unitário inválido.");
  const priceChanged = body.priceChanged === true && newPrice !== null;
  const unitPrice = priceChanged ? newPrice : (item.unitPrice ?? product?.price ?? null);

  await db.transaction(async (tx) => {
    const brand = brandChanged ? await ensureBrand(tx, brandInput, user.id) : (item.brand ?? product?.brand ?? null);
    await tx.update(purchaseOrderItems).set({
      status: "RECEBIDO", receivedAt: now, receivedBy: user.id, receivedQuantity: quantity, receivedUnitPrice: unitPrice, receivedSupplierId: supplierId, receivedBrand: brand,
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
    await logEvents(tx, [{ orderId: order.id, itemId: item.id, action: "RECEBIDO", fromStatus: item.status, toStatus: "RECEBIDO",
      details: `Chegou ${fmtQty(quantity)} de ${fmtQty(item.quantity)} ${item.fiscalUnit}${clean(body.notes) ? ` · ${clean(body.notes)}` : ""}`, userId: user.id }]);
    await audit(tx, user.id, order.id, "ITEM RECEBIDO", { itemId: item.id, quantity, unitPrice, supplierChanged, brandChanged, priceChanged });
    const status = await syncOrderStatus(tx, order, user.id, now);
    if (status === "RECEBIDO") await audit(tx, user.id, order.id, "PEDIDO RECEBIDO");
  });
  return product
    ? `Item recebido${quantity > 0 ? `: entrada de ${fmtQty(quantity)} no estoque` : " (nada chegou, sem entrada no estoque)"}.`
    : "Item recebido (item digitado à mão, sem movimentação de estoque).";
}
