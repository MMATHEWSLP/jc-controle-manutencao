"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DEFAULT_FISCAL_UNIT, FISCAL_UNITS } from "../lib/fiscal-units";
import { api, brDateTime, jsonBody, moneyFormat, parseQty, problemText, ProductPicker, qtyFormat, type Front, type ProductOption } from "./stock-client";

type User = { id: number; name: string; permissions: string[] };
type Status = "AGUARDANDO_APROVACAO" | "RECUSADO" | "EM_COTACAO" | "ANALISE_PAGAMENTO" | "PAGO" | "ENVIADO" | "RECEBIDO" | "CANCELADO";
type Actions = { approve: boolean; quote: boolean; confirmPayment: boolean; dispatch: boolean; receive: boolean; cancel: boolean };
type OrderRow = { id: number; number: string; requesterId: number; requester: string; front: string; requestedAt: string; status: Status; statusLabel: string; notes: string | null; itemCount: number; itemsPreview: string[]; total: number | null; actions: Actions };
type Supplier = { id: number; name: string };
type ListResponse = { orders: OrderRow[]; requestFronts: Front[]; suppliers: Supplier[]; worksOnPurchases: boolean; canRequest: boolean };
type ProductInfo = { id: number; tag: string | null; name: string | null; price: number | null; brand: string | null; supplierId: number | null; supplier: string | null };
type Item = {
  id: number; productId: number | null; product: ProductInfo | null; description: string; reference: string | null; quantity: number; fiscalUnit: string;
  unitPrice: number | null; supplierId: number | null; supplierName: string | null; brand: string | null; total: number | null;
  receivedAt: string | null; receivedQuantity: number | null; receivedUnitPrice: number | null; receivedSupplierName: string | null; receivedBrand: string | null; receiptNotes: string | null;
};
type Detail = {
  id: number; number: string; status: Status; statusLabel: string; front: string; requester: string | null; requestedAt: string; notes: string | null;
  approvedAt: string | null; approvedByName: string | null; rejectedAt: string | null; rejectedByName: string | null; rejectReason: string | null;
  paymentRequestedAt: string | null; paymentRequestedByName: string | null; buyerNotes: string | null; paidAt: string | null; paidByName: string | null; paymentNotes: string | null;
  dispatchedAt: string | null; dispatchedByName: string | null; dispatchNotes: string | null; receivedAt: string | null; receivedByName: string | null;
  cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null;
  items: Item[]; attachments: Array<{ id: number; fileName: string; contentType: string; size: number; createdAt: string }>; total: number | null; actions: Actions;
};
type Tab = "acao" | "minhas" | "andamento" | "historico";

const TERMINAL: Status[] = ["RECEBIDO", "RECUSADO", "CANCELADO"];
const STATUS_TONE: Record<Status, string> = { AGUARDANDO_APROVACAO: "yellow", RECUSADO: "red", EM_COTACAO: "blue", ANALISE_PAGAMENTO: "orange", PAGO: "blue", ENVIADO: "blue", RECEBIDO: "green", CANCELADO: "gray" };
const needsMe = (actions: Actions) => actions.approve || actions.quote || actions.confirmPayment || actions.dispatch || actions.receive;

// Solicitação de Pedidos (Compras externas): solicitante → aprovação → cotação → pagamento → envio →
// recebimento (entrada no estoque dos itens vinculados a produto).
export default function PurchaseOrdersView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("acao");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const initialized = useRef(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<ListResponse>("/api/purchase-orders");
      setData(result);
      if (!initialized.current) { initialized.current = true; if (!result.orders.some((order) => needsMe(order.actions))) setTab(result.worksOnPurchases ? "andamento" : "minhas"); }
    } catch (problem) { setError(problemText(problem, "Não foi possível carregar os pedidos.")); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const orders = useMemo(() => (data?.orders ?? []).filter((order) => tab === "acao" ? needsMe(order.actions) : tab === "minhas" ? order.requesterId === authUser.id : tab === "andamento" ? !TERMINAL.includes(order.status) : TERMINAL.includes(order.status)), [data, tab, authUser.id]);
  const count = (value: Tab) => (data?.orders ?? []).filter((order) => value === "acao" ? needsMe(order.actions) : value === "minhas" ? order.requesterId === authUser.id : value === "andamento" ? !TERMINAL.includes(order.status) : TERMINAL.includes(order.status)).length;

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">COMPRAS</p><h1>Solicitação de Pedidos</h1><span>Pedido de compra externa: aprovação, cotação com orçamentos, pagamento, envio e recebimento com entrada no estoque.</span></div>
        {data?.canRequest && <div className="heading-actions"><button className="primary" onClick={() => setCreating(true)}>＋ Novo pedido</button></div>}
      </div>
      <article className="panel module-panel equipment-management-panel">
        <div className="main-tabs secondary-module-nav" role="tablist">
          <button type="button" className={tab === "acao" ? "active" : ""} onClick={() => setTab("acao")}>Precisam da minha ação <b className="nav-badge soft">{count("acao")}</b></button>
          <button type="button" className={tab === "minhas" ? "active" : ""} onClick={() => setTab("minhas")}>Minhas solicitações <b className="nav-badge soft">{count("minhas")}</b></button>
          {data?.worksOnPurchases && <button type="button" className={tab === "andamento" ? "active" : ""} onClick={() => setTab("andamento")}>Em andamento <b className="nav-badge soft">{count("andamento")}</b></button>}
          <button type="button" className={tab === "historico" ? "active" : ""} onClick={() => setTab("historico")}>Histórico</button>
        </div>
        {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
        {!data && !error ? <div className="page-loading"><span /><p>Carregando pedidos...</p></div> : (
          <div className="table-scroll">
            <table className="purchase-table">
              <thead><tr><th>Pedido</th><th title="Solicitante · frente">Solicitante</th><th>Itens</th><th>Total</th><th>Situação</th><th /></tr></thead>
              <tbody>{orders.map((order) => (
                <tr key={order.id}>
                  <td><strong>{order.number}</strong><small className="table-sub">{brDateTime(order.requestedAt)}</small></td>
                  <td>{order.requester}<small className="table-sub">{order.front}</small></td>
                  <td>{order.itemCount} item(ns)<small className="table-sub">{order.itemsPreview.join(" · ")}{order.itemCount > 3 ? " …" : ""}</small></td>
                  <td>{order.total === null ? "—" : moneyFormat.format(order.total)}</td>
                  <td><span className={`status-pill ${STATUS_TONE[order.status]}`}>{order.statusLabel}</span>{needsMe(order.actions) && <small className="table-sub">aguarda você</small>}</td>
                  <td><div className="equipment-row-actions"><button onClick={() => setViewing(order.id)}>Abrir</button></div></td>
                </tr>
              ))}</tbody>
            </table>
            {orders.length === 0 && <div className="empty-state">Nenhum pedido nesta aba.</div>}
          </div>
        )}
      </article>
      {creating && data && <CreatePurchaseModal fronts={data.requestFronts} close={() => setCreating(false)} saved={async (message) => { setCreating(false); await load(); flash(message); }} />}
      {viewing !== null && data && <PurchaseDetailModal id={viewing} suppliers={data.suppliers} close={() => setViewing(null)} changed={load} flash={flash} />}
    </>
  );
}

type DraftItem = { key: string; mode: "PRODUCT" | "MANUAL"; product: ProductOption | null; description: string; reference: string; quantity: string; fiscalUnit: string };
const newDraft = (): DraftItem => ({ key: crypto.randomUUID(), mode: "PRODUCT", product: null, description: "", reference: "", quantity: "", fiscalUnit: DEFAULT_FISCAL_UNIT });

function CreatePurchaseModal({ fronts, close, saved }: { fronts: Front[]; close: () => void; saved: (message: string) => Promise<void> }) {
  const [frontId, setFrontId] = useState(fronts.length === 1 ? String(fronts[0].id) : "");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftItem[]>([newDraft()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (key: string, value: Partial<DraftItem>) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...value } : item)));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (items.some((item) => item.mode === "PRODUCT" && !item.product)) { setError("Escolha o produto de cada item (ou mude para “Item manual”)."); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ message: string }>("/api/purchase-orders", jsonBody("POST", {
        serviceFrontId: Number(frontId), notes,
        items: items.map((item) => item.mode === "PRODUCT"
          ? { productId: item.product!.id, description: item.product!.name, reference: item.product!.references[0] ?? item.product!.reference ?? "", quantity: parseQty(item.quantity), fiscalUnit: item.fiscalUnit }
          : { description: item.description, reference: item.reference, quantity: parseQty(item.quantity), fiscalUnit: item.fiscalUnit }),
      }));
      await saved(result.message);
    } catch (problem) { setError(problemText(problem, "Não foi possível registrar o pedido.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal" onSubmit={submit}>
      <header><div><p>SOLICITAÇÃO DE PEDIDOS</p><h2>Novo pedido de compra</h2><span>Depois de enviado, o pedido aguarda aprovação.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        <div className="fleet-form-grid">
          {fronts.length === 1
            ? <label className="span-2">Frente de serviço / Obra / Setor<input readOnly value={fronts[0].name} /></label>
            : <label className="span-2">Frente de serviço / Obra / Setor *<select required value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="" disabled>Selecione para qual frente é este pedido</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
        </div>
        <section className="fleet-form-section">
          <div className="fleet-section-title"><h3>Itens</h3><button type="button" onClick={() => setItems([...items, newDraft()])}>＋ ADICIONAR ITEM</button></div>
          {items.map((item, index) => (
            <div className="fleet-order-editor" key={item.key}>
              <header><b>Item {index + 1}</b><div className="material-item-mode" role="group" aria-label="Tipo do item"><button type="button" className={item.mode === "PRODUCT" ? "active" : ""} onClick={() => patch(item.key, { mode: "PRODUCT" })}>Produto do estoque</button><button type="button" className={item.mode === "MANUAL" ? "active" : ""} onClick={() => patch(item.key, { mode: "MANUAL", product: null })}>Item manual</button></div>{items.length > 1 && <button type="button" onClick={() => setItems(items.filter((row) => row.key !== item.key))}>Remover</button>}</header>
              <div className="fleet-form-grid">
                {item.mode === "PRODUCT" ? <label className="span-2">Produto *<ProductPicker value={item.product} frontId={Number(frontId) || null} onPick={(product) => patch(item.key, { product })} /></label> : <>
                  <label className="span-2">Descrição do item *<input required value={item.description} onChange={(event) => patch(item.key, { description: event.target.value })} /></label>
                  <label>Referência<input value={item.reference} onChange={(event) => patch(item.key, { reference: event.target.value })} /></label>
                </>}
                <label>Quantidade *<input required inputMode="decimal" value={item.quantity} onChange={(event) => patch(item.key, { quantity: event.target.value })} /></label>
                <label>Unidade fiscal *<select required value={item.fiscalUnit} onChange={(event) => patch(item.key, { fiscalUnit: event.target.value })}>{FISCAL_UNITS.map(([code, label]) => <option key={code} value={code}>{code} — {label}</option>)}</select></label>
              </div>
              {item.mode === "MANUAL" && <small className="material-item-hint">Item manual (não cadastrado) só é marcado como recebido, sem entrada no estoque.</small>}
            </div>
          ))}
        </section>
        <label className="fleet-notes">Observações / justificativa<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "ENVIANDO..." : "ENVIAR PARA APROVAÇÃO"}</button></footer>
    </form></div>
  );
}

function Steps({ order }: { order: Detail }) {
  const steps: Array<{ label: string; done: string | null; who: string | null }> = [
    { label: "Solicitado", done: order.requestedAt, who: order.requester },
    { label: "Aprovado / Em cotação", done: order.approvedAt, who: order.approvedByName },
    { label: "Análise de pagamento", done: order.paymentRequestedAt, who: order.paymentRequestedByName },
    { label: "Pago", done: order.paidAt, who: order.paidByName },
    { label: "Enviado", done: order.dispatchedAt, who: order.dispatchedByName },
    { label: "Recebido", done: order.receivedAt, who: order.receivedByName },
  ];
  const current = steps.findIndex((step) => !step.done);
  return (
    <ol className="po-steps">
      {steps.map((step, index) => (
        <li key={step.label} className={step.done ? "done" : index === current && !["RECUSADO", "CANCELADO"].includes(order.status) ? "current" : ""} title={step.done ? `${brDateTime(step.done)} · ${step.who ?? "—"}` : undefined}>
          {step.done ? "✓" : index + 1}. {index === 1 && !step.done && order.status === "AGUARDANDO_APROVACAO" ? "Aguardando aprovação" : step.label}
        </li>
      ))}
      {order.status === "RECUSADO" && <li className="rejected">Recusado por {order.rejectedByName ?? "—"}: {order.rejectReason}</li>}
      {order.status === "CANCELADO" && <li className="rejected">Cancelado por {order.cancelledByName ?? "—"}: {order.cancelReason}</li>}
    </ol>
  );
}

function PurchaseDetailModal({ id, suppliers, close, changed, flash }: { id: number; suppliers: Supplier[]; close: () => void; changed: () => Promise<void>; flash: (message: string) => void }) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [quote, setQuote] = useState<Record<number, { unitPrice: string; supplierId: string; brand: string }>>({});
  const [buyerNotes, setBuyerNotes] = useState("");
  const [receiving, setReceiving] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      const result = await api<{ order: Detail }>(`/api/purchase-orders/${id}`);
      setOrder(result.order);
      setBuyerNotes(result.order.buyerNotes ?? "");
      setQuote(Object.fromEntries(result.order.items.map((item) => [item.id, { unitPrice: item.unitPrice === null ? "" : String(item.unitPrice), supplierId: item.supplierId ? String(item.supplierId) : item.product?.supplierId ? String(item.product.supplierId) : "", brand: item.brand ?? item.product?.brand ?? "" }])));
    } catch (problem) { setError(problemText(problem, "Não foi possível carregar o pedido.")); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { flash((await api<{ message: string }>(`/api/purchase-orders/${id}`, jsonBody("PUT", body))).message); await Promise.all([load(), changed()]); return true; }
    catch (problem) { setError(problemText(problem, "Não foi possível atualizar o pedido.")); return false; }
    finally { setBusy(false); }
  }
  const quoteItems = () => Object.entries(quote).map(([itemId, value]) => ({ id: Number(itemId), unitPrice: value.unitPrice, supplierId: value.supplierId, brand: value.brand }));
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file));
    setBusy(true); setError("");
    try { flash((await api<{ message: string }>(`/api/purchase-orders/${id}/attachments`, { method: "POST", body: form })).message); await load(); }
    catch (problem) { setError(problemText(problem, "Não foi possível anexar.")); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function removeAttachment(attachmentId: number) {
    if (!window.confirm("Remover este orçamento?")) return;
    try { await api(`/api/purchase-orders/attachments/${attachmentId}`, { method: "DELETE" }); await load(); }
    catch (problem) { setError(problemText(problem, "Não foi possível remover.")); }
  }
  const withPrompt = (message: string, key: string, action: string, required = true) => {
    const value = window.prompt(message);
    if (value === null || (required && !value.trim())) return;
    act({ action, [key]: value });
  };

  return (
    <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal po-detail">
      <header><div><p>SOLICITAÇÃO DE PEDIDOS</p><h2>{order ? `${order.number} · ${order.statusLabel}` : "Carregando..."}</h2><span>{order ? `${order.requester ?? "—"} · ${order.front} · ${brDateTime(order.requestedAt)}` : ""}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        {!order && !error && <div className="page-loading"><span /><p>Carregando...</p></div>}
        {order && <>
          <Steps order={order} />
          {order.notes && <p className="stock-summary">Observações do solicitante: {order.notes}</p>}
          <div className="table-scroll">
            <table className="purchase-items-table">
              <thead><tr><th>Item</th><th>Qtd.</th><th title="Fornecedor · marca (cotação)">Fornecedor / marca</th><th title="Valor unitário · total">Valor</th><th>Recebimento</th></tr></thead>
              <tbody>{order.items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.product?.tag ? `${item.product.tag} · ` : ""}{item.description}</strong><small className="table-sub">{item.product ? "Produto do estoque" : "Item manual"}{item.reference ? ` · Ref. ${item.reference}` : ""}</small></td>
                  <td>{qtyFormat.format(item.quantity)} {item.fiscalUnit}</td>
                  <td>{order.actions.quote ? (
                    <div className="po-quote-cell">
                      <select value={quote[item.id]?.supplierId ?? ""} onChange={(event) => setQuote({ ...quote, [item.id]: { ...quote[item.id], supplierId: event.target.value } })}><option value="">Fornecedor...</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>
                      <input value={quote[item.id]?.brand ?? ""} placeholder="Marca" onChange={(event) => setQuote({ ...quote, [item.id]: { ...quote[item.id], brand: event.target.value } })} />
                    </div>
                  ) : <>{item.supplierName ?? "—"}<small className="table-sub">{item.brand ?? "—"}</small></>}</td>
                  <td>{order.actions.quote
                    ? <input inputMode="decimal" value={quote[item.id]?.unitPrice ?? ""} placeholder="R$ unitário" onChange={(event) => setQuote({ ...quote, [item.id]: { ...quote[item.id], unitPrice: event.target.value } })} />
                    : <>{item.unitPrice === null ? "—" : moneyFormat.format(item.unitPrice)}{item.total !== null && <small className="table-sub">Total {moneyFormat.format(item.total)}</small>}</>}</td>
                  <td>{item.receivedAt
                    ? <><span className="status-pill green">Recebido</span><small className="table-sub">{qtyFormat.format(item.receivedQuantity ?? 0)} {item.fiscalUnit}{item.receivedUnitPrice !== null ? ` · ${moneyFormat.format(item.receivedUnitPrice)}` : ""}{item.receivedSupplierName ? ` · ${item.receivedSupplierName}` : ""}</small></>
                    : order.actions.receive ? <button type="button" className="secondary" onClick={() => setReceiving(item)}>Confirmar recebimento</button> : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="stock-summary">Total: <strong>{order.total === null ? "—" : moneyFormat.format(order.total)}</strong>{order.buyerNotes && !order.actions.quote ? ` · Comprador: ${order.buyerNotes}` : ""}{order.paymentNotes ? ` · Pagamento: ${order.paymentNotes}` : ""}{order.dispatchNotes ? ` · Envio: ${order.dispatchNotes}` : ""}</p>

          <section className="fleet-form-section">
            <div className="fleet-section-title"><h3>Orçamentos</h3>{order.actions.quote && <><button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>＋ ANEXAR ORÇAMENTO</button><input ref={fileInput} type="file" hidden multiple accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => upload(event.target.files)} /></>}</div>
            {order.attachments.length === 0 ? <p className="stock-summary">Nenhum orçamento anexado.</p> : (
              <div className="po-attachments">{order.attachments.map((file) => (
                <span key={file.id}><a href={`/api/purchase-orders/attachments/${file.id}`} target="_blank" rel="noreferrer">{file.contentType === "application/pdf" ? "📄" : "🖼"} {file.fileName}</a>{order.actions.quote && <button type="button" className="link-button" onClick={() => removeAttachment(file.id)}>remover</button>}</span>
              ))}</div>
            )}
            {order.actions.quote && <label className="fleet-notes">Observações do comprador<textarea value={buyerNotes} onChange={(event) => setBuyerNotes(event.target.value)} /></label>}
          </section>
          {receiving && <ReceiptCard item={receiving} suppliers={suppliers} busy={busy} cancel={() => setReceiving(null)} confirm={async (body) => { if (await act({ action: "RECEIVE_ITEM", itemId: receiving.id, ...body })) setReceiving(null); }} />}
        </>}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer>
        <button type="button" onClick={close}>Fechar janela</button>
        {order?.actions.cancel && <button type="button" disabled={busy} onClick={() => withPrompt("Motivo do cancelamento:", "reason", "CANCEL")}>Cancelar pedido</button>}
        {order?.actions.approve && <><button type="button" disabled={busy} onClick={() => withPrompt("Motivo da recusa:", "reason", "REJECT")}>Recusar</button><button type="button" className="primary" disabled={busy} onClick={() => act({ action: "APPROVE" })}>APROVAR</button></>}
        {order?.actions.quote && <><button type="button" disabled={busy} onClick={() => act({ action: "SAVE_QUOTE", items: quoteItems(), buyerNotes })}>Salvar cotação</button><button type="button" className="primary" disabled={busy} onClick={() => act({ action: "SEND_TO_PAYMENT", items: quoteItems(), buyerNotes })}>ENVIAR PARA PAGAMENTO</button></>}
        {order?.actions.confirmPayment && <button type="button" className="primary" disabled={busy} onClick={() => withPrompt("Observação do pagamento (opcional):", "notes", "CONFIRM_PAYMENT", false)}>CONFIRMAR PAGAMENTO</button>}
        {order?.actions.dispatch && <button type="button" className="primary" disabled={busy} onClick={() => withPrompt("Observação do envio (transportadora, previsão...) — opcional:", "notes", "DISPATCH", false)}>MARCAR COMO ENVIADO</button>}
      </footer>
    </section></div>
  );
}

function YesNo({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <span className="po-yesno"><button type="button" className={value ? "active" : ""} onClick={() => onChange(true)}>Sim</button><button type="button" className={!value ? "active" : ""} onClick={() => onChange(false)}>Não</button></span>;
}

// Card de conferência do recebimento. Item do estoque: "Mudou o fornecedor? a marca? o valor? Veio
// a quantidade pedida?" → entrada no estoque e atualização do produto. Item manual: só a quantidade.
function ReceiptCard({ item, suppliers, busy, cancel, confirm }: { item: Item; suppliers: Supplier[]; busy: boolean; cancel: () => void; confirm: (body: Record<string, unknown>) => void }) {
  const product = item.product;
  const referencePrice = item.unitPrice ?? product?.price ?? null;
  const [supplierChanged, setSupplierChanged] = useState(Boolean(product && item.supplierId && item.supplierId !== product.supplierId));
  const [supplierId, setSupplierId] = useState(item.supplierId ? String(item.supplierId) : "");
  const [brandChanged, setBrandChanged] = useState(Boolean(product && item.brand && item.brand !== product.brand));
  const [brand, setBrand] = useState(item.brand ?? "");
  const [priceChanged, setPriceChanged] = useState(Boolean(product && item.unitPrice !== null && item.unitPrice !== product.price));
  const [unitPrice, setUnitPrice] = useState(referencePrice === null ? "" : String(referencePrice));
  const [fullQuantity, setFullQuantity] = useState(true);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [notes, setNotes] = useState("");
  return (
    <div className="po-receipt">
      <strong>Conferência do recebimento — {item.description}</strong>
      {product && <>
        <fieldset><legend>Mudou o fornecedor? <small>(cadastro: {product.supplier ?? "—"})</small></legend><YesNo value={supplierChanged} onChange={setSupplierChanged} />
          {supplierChanged && <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}><option value="">Escolha o fornecedor</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>}</fieldset>
        <fieldset><legend>Mudou a marca? <small>(cadastro: {product.brand ?? "—"})</small></legend><YesNo value={brandChanged} onChange={setBrandChanged} />
          {brandChanged && <input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Nova marca" />}</fieldset>
        <fieldset><legend>Mudou o valor? <small>(cadastro: {product.price === null ? "—" : moneyFormat.format(product.price)}{item.unitPrice !== null ? ` · cotado: ${moneyFormat.format(item.unitPrice)}` : ""})</small></legend><YesNo value={priceChanged} onChange={setPriceChanged} />
          {priceChanged && <input inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder="Novo valor unitário (R$)" />}</fieldset>
      </>}
      <fieldset><legend>Veio a quantidade pedida? <small>({qtyFormat.format(item.quantity)} {item.fiscalUnit})</small></legend><YesNo value={fullQuantity} onChange={setFullQuantity} />
        {!fullQuantity && <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Quantidade que chegou" />}</fieldset>
      <label>Observação<input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <p className="stock-summary">{product ? "Ao confirmar, a quantidade recebida entra no estoque da frente do pedido e o cadastro do produto é atualizado no que mudou." : "Item manual: só fica marcado como recebido (sem estoque)."}</p>
      <div className="equipment-row-actions"><button type="button" onClick={cancel}>Voltar</button><button type="button" className="primary" disabled={busy} onClick={() => confirm({ supplierChanged, supplierId, brandChanged, brand, priceChanged, unitPrice, fullQuantity, quantity: parseQty(quantity), notes })}>Confirmar recebimento</button></div>
    </div>
  );
}
