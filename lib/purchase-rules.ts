// Regras da Solicitação de Pedidos (Compras) sem banco nem React — usadas pela API, pela tela e
// pelos testes (tests/purchase-rules.test.mjs).
//
// Cada ITEM anda sozinho no fluxo:
//   AGUARDANDO_APROVACAO → EM_COTACAO (aprovado) → ANALISE_PAGAMENTO → PAGO → ENVIADO → RECEBIDO
//   com as saídas RECUSADO (aprovador), REMOVIDO (comprador cortou na cotação) e CANCELADO (pedido
//   cancelado). A situação GERAL do pedido é a combinação dos itens (orderStatusFromItems).

export type ItemStatus = "AGUARDANDO_APROVACAO" | "RECUSADO" | "EM_COTACAO" | "ANALISE_PAGAMENTO" | "PAGO" | "ENVIADO" | "RECEBIDO" | "REMOVIDO" | "CANCELADO";
export type OrderStatus = "AGUARDANDO_APROVACAO" | "RECUSADO" | "EM_COTACAO" | "ANALISE_PAGAMENTO" | "PAGO" | "ENVIADO" | "RECEBIDO" | "CANCELADO" | "EM_ANDAMENTO";
export type Urgency = "BAIXA" | "NORMAL" | "ALTA" | "URGENTE";

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  AGUARDANDO_APROVACAO: "Aguardando aprovação", RECUSADO: "Recusado", EM_COTACAO: "Aprovado / Em cotação", ANALISE_PAGAMENTO: "Análise de pagamento",
  PAGO: "Pago", ENVIADO: "Enviado", RECEBIDO: "Recebido", REMOVIDO: "Removido na cotação", CANCELADO: "Cancelado",
};
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  AGUARDANDO_APROVACAO: "Aguardando aprovação", RECUSADO: "Recusado", EM_COTACAO: "Aprovado / Em cotação", ANALISE_PAGAMENTO: "Análise de pagamento",
  PAGO: "Pago", ENVIADO: "Enviado", RECEBIDO: "Recebido", CANCELADO: "Cancelado", EM_ANDAMENTO: "Em andamento (itens em etapas diferentes)",
};
export const URGENCY_LABELS: Record<Urgency, string> = { BAIXA: "Baixa", NORMAL: "Normal", ALTA: "Alta", URGENTE: "Urgente" };
export const URGENCIES = Object.keys(URGENCY_LABELS) as Urgency[];

// Ordem das etapas "ativas" (o índice serve para "pago ou etapa posterior").
export const FLOW: ItemStatus[] = ["AGUARDANDO_APROVACAO", "EM_COTACAO", "ANALISE_PAGAMENTO", "PAGO", "ENVIADO", "RECEBIDO"];
const OUT_OF_FLOW: ItemStatus[] = ["RECUSADO", "REMOVIDO", "CANCELADO"];
export const isActiveItem = (status: string) => !OUT_OF_FLOW.includes(status as ItemStatus);
const stage = (status: string) => FLOW.indexOf(status as ItemStatus);

export function orderStatusFromItems(items: Array<{ status: string }>, cancelled = false): OrderStatus {
  if (cancelled) return "CANCELADO";
  const active = items.filter((item) => isActiveItem(item.status));
  if (active.length === 0) return items.some((item) => item.status === "RECUSADO") ? "RECUSADO" : "CANCELADO";
  const first = active[0].status;
  return active.every((item) => item.status === first) ? (first as OrderStatus) : "EM_ANDAMENTO";
}

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["RECEBIDO", "RECUSADO", "CANCELADO"];
export const isTerminalOrder = (status: string) => TERMINAL_ORDER_STATUSES.includes(status as OrderStatus);

// Filtros de situação (combináveis entre si e com texto/filial/período — sempre AND).
export type SituationFilter = "PAGOS" | "PARCIALMENTE_PAGOS" | "SEM_ORCAMENTO" | "EM_ANALISE" | "URGENTES";
export const SITUATION_FILTER_LABELS: Record<SituationFilter, string> = {
  PAGOS: "Pedidos pagos", PARCIALMENTE_PAGOS: "Parcialmente pagos", SEM_ORCAMENTO: "Sem orçamento", EM_ANALISE: "Em análise", URGENTES: "Urgentes",
};
export type FilterableOrder = { urgency: string; quoteCount: number; items: Array<{ status: string }> };

export function matchesSituation(order: FilterableOrder, filter: SituationFilter) {
  const active = order.items.filter((item) => isActiveItem(item.status));
  const paid = active.filter((item) => stage(item.status) >= stage("PAGO"));
  switch (filter) {
    // Todos os itens (que seguem no pedido) já pagos ou em etapa posterior.
    case "PAGOS": return active.length > 0 && paid.length === active.length;
    // Alguns pagos, outros ainda não.
    case "PARCIALMENTE_PAGOS": return paid.length > 0 && paid.length < active.length;
    // Aprovado (algum item já passou da aprovação) e nenhum orçamento anexado (nem imagem, nem documento).
    case "SEM_ORCAMENTO": return order.quoteCount === 0 && active.some((item) => stage(item.status) >= stage("EM_COTACAO"));
    // Pelo menos um item na etapa de análise (aprovação ou análise de pagamento).
    case "EM_ANALISE": return active.some((item) => item.status === "AGUARDANDO_APROVACAO" || item.status === "ANALISE_PAGAMENTO");
    case "URGENTES": return order.urgency === "URGENTE";
  }
}

// Ações em lote sobre itens (cada item tem que estar na etapa certa; os demais selecionados são ignorados).
export type ItemAction = "APPROVE" | "REJECT" | "SEND_TO_PAYMENT" | "CONFIRM_PAYMENT" | "DISPATCH" | "RECEIVE" | "REMOVE" | "QUOTE";
export const ACTION_FROM: Record<ItemAction, ItemStatus> = {
  APPROVE: "AGUARDANDO_APROVACAO", REJECT: "AGUARDANDO_APROVACAO", QUOTE: "EM_COTACAO", REMOVE: "EM_COTACAO", SEND_TO_PAYMENT: "EM_COTACAO",
  CONFIRM_PAYMENT: "ANALISE_PAGAMENTO", DISPATCH: "PAGO", RECEIVE: "ENVIADO",
};
export const ACTION_TO: Partial<Record<ItemAction, ItemStatus>> = {
  APPROVE: "EM_COTACAO", REJECT: "RECUSADO", REMOVE: "REMOVIDO", SEND_TO_PAYMENT: "ANALISE_PAGAMENTO", CONFIRM_PAYMENT: "PAGO", DISPATCH: "ENVIADO", RECEIVE: "RECEBIDO",
};

export type Capabilities = { approve: boolean; buy: boolean; pay: boolean; dispatch: boolean; manage: boolean; own: boolean };

export function canDo(action: ItemAction, caps: Capabilities) {
  switch (action) {
    case "APPROVE": case "REJECT": return caps.approve;
    case "QUOTE": case "REMOVE": case "SEND_TO_PAYMENT": return caps.buy;
    case "CONFIRM_PAYMENT": return caps.pay;
    case "DISPATCH": return caps.dispatch;
    case "RECEIVE": return caps.own || caps.manage;
  }
}

// Ações disponíveis para a pessoa neste pedido, pelas etapas em que os itens estão.
export function availableActions(items: Array<{ status: string }>, caps: Capabilities, orderCancelled = false) {
  const has = (status: ItemStatus) => !orderCancelled && items.some((item) => item.status === status);
  const result = {} as Record<ItemAction, boolean>;
  for (const action of Object.keys(ACTION_FROM) as ItemAction[]) result[action] = has(ACTION_FROM[action]) && canDo(action, caps);
  const started = items.some((item) => stage(item.status) >= stage("PAGO"));
  const cancel = !orderCancelled && items.some((item) => isActiveItem(item.status) && item.status !== "RECEBIDO") && (
    (caps.own && items.every((item) => item.status === "AGUARDANDO_APROVACAO")) || (caps.manage && !started));
  return { ...result, CANCEL: cancel };
}

// Quantidade na cotação: o comprador só reduz (nunca passa do que foi pedido).
export function quantityProblem(original: number, next: number) {
  if (!Number.isFinite(next) || next <= 0) return "A quantidade deve ser maior que zero (para cortar o item inteiro, use Remover).";
  if (next > original) return "Na cotação a quantidade só pode ser reduzida em relação ao pedido original.";
  return null;
}

export const ITEM_ACTION_LABELS: Record<ItemAction, string> = {
  APPROVE: "Aprovar", REJECT: "Recusar", QUOTE: "Cotar", REMOVE: "Remover da cotação", SEND_TO_PAYMENT: "Enviar para pagamento",
  CONFIRM_PAYMENT: "Confirmar pagamento", DISPATCH: "Marcar como enviado", RECEIVE: "Receber",
};

// Empresas do grupo que aparecem no cabeçalho e no card.
export const PURCHASE_COMPANIES = ["JC", "RCA"] as const;
