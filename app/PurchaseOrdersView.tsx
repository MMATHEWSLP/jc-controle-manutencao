"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DEFAULT_FISCAL_UNIT, FISCAL_UNITS } from "../lib/fiscal-units";
import { DepartmentsModal, useDepartments, type Department } from "./DepartmentsManager";
import {
  isActiveItem, isTerminalOrder, ITEM_STATUS_LABELS, matchesSituation, ORDER_STATUS_LABELS, PURCHASE_COMPANIES, SITUATION_FILTER_LABELS, URGENCIES, URGENCY_LABELS,
  type ItemAction, type ItemStatus, type OrderStatus, type SituationFilter, type Urgency,
} from "../lib/purchase-rules";
import {
  api, brDateTime, brDay, CatalogPicker, EquipmentPicker, jsonBody, localToday, moneyFormat, parseQty, problemText, ProductPicker, qtyFormat,
  type CatalogOption, type EquipmentOption, type Front, type ProductOption,
} from "./stock-client";

type User = { id: number; name: string; permissions: string[] };
type BatchActions = Record<ItemAction, boolean>;
type Actions = BatchActions & { CANCEL: boolean; PHOTO: boolean; PAYMENT_PROOF: boolean };
type OrderRow = {
  id: number; number: string; requesterId: number; createdBy: string; requesterName: string; serviceFrontId: number; front: string; requestedAt: string; orderDate: string;
  status: OrderStatus; statusLabel: string; company: string | null; title: string | null; department: string | null; departmentId: number | null; urgency: Urgency;
  equipmentPrefix: string | null; items: Array<{ status: string }>; itemCount: number; activeItemCount: number; searchText: string; quoteCount: number; total: number | null; needsMe: boolean;
};
type ListResponse = {
  orders: OrderRow[]; requestFronts: Front[]; suppliers: CatalogOption[]; brands: string[]; nextNumber: string; equipment: EquipmentOption[];
  worksOnPurchases: boolean; canRequest: boolean; userName: string;
};
type ProductInfo = { id: number; tag: string | null; name: string | null; price: number | null; brand: string | null; supplierId: number | null; supplier: string | null };
type ItemEvent = { id: number; action: string; fromStatus: string | null; toStatus: string | null; details: string | null; userName: string | null; createdAt: string };
type Item = {
  id: number; productId: number | null; product: ProductInfo | null; description: string; reference: string | null; notes: string | null; quantity: number; fiscalUnit: string;
  status: ItemStatus; statusLabel: string; originalQuantity: number | null; quantityChangedAt: string | null; quantityChangedByName: string | null;
  removedAt: string | null; removedByName: string | null; removedReason: string | null; rejectedAt: string | null; rejectedByName: string | null; rejectReason: string | null;
  unitPrice: number | null; supplierId: number | null; supplierName: string | null; brand: string | null; total: number | null;
  receivedAt: string | null; receivedByName: string | null; receivedQuantity: number | null; receivedUnitPrice: number | null; receivedSupplierName: string | null; receivedBrand: string | null; receiptNotes: string | null;
  events: ItemEvent[];
};
type Attachment = { id: number; kind: "PHOTO" | "QUOTE_IMAGE" | "QUOTE_DOCUMENT" | "PAYMENT_PROOF"; itemId: number | null; fileName: string; contentType: string; size: number; createdAt: string; uploadedByName: string | null };
type Detail = {
  id: number; number: string; status: OrderStatus; statusLabel: string; front: string; requesterId: number; requesterName: string | null; createdByName: string | null; requestedAt: string; orderDate: string;
  company: string | null; title: string | null; department: string | null; urgency: Urgency; notes: string | null;
  equipment: { id: number; prefix: string; description: string; chassis: string | null; year: number | null } | null;
  buyerNotes: string | null; paymentNotes: string | null; dispatchNotes: string | null; cancelledAt: string | null; cancelledByName: string | null; cancelReason: string | null;
  items: Item[]; attachments: Attachment[]; total: number | null; actions: Actions;
};
type Tab = "ativas" | "acao" | "historico";
type Catalog = { suppliers: CatalogOption[]; brands: CatalogOption[]; createSupplier: (name: string) => Promise<CatalogOption>; createBrand: (name: string) => Promise<CatalogOption> };

const ORDER_TONE: Record<OrderStatus, string> = { AGUARDANDO_APROVACAO: "yellow", RECUSADO: "red", EM_COTACAO: "blue", ANALISE_PAGAMENTO: "orange", PAGO: "blue", ENVIADO: "blue", RECEBIDO: "green", CANCELADO: "gray", EM_ANDAMENTO: "orange" };
const ITEM_TONE: Record<ItemStatus, string> = { AGUARDANDO_APROVACAO: "yellow", RECUSADO: "red", EM_COTACAO: "blue", ANALISE_PAGAMENTO: "orange", PAGO: "blue", ENVIADO: "blue", RECEBIDO: "green", REMOVIDO: "gray", CANCELADO: "gray" };
const CARD_ACCENT: Record<OrderStatus, string> = { AGUARDANDO_APROVACAO: "orange", RECUSADO: "red", EM_COTACAO: "yellow", ANALISE_PAGAMENTO: "orange", PAGO: "yellow", ENVIADO: "yellow", RECEBIDO: "green", CANCELADO: "gray", EM_ANDAMENTO: "yellow" };
const ACTIVE_STATUSES: OrderStatus[] = ["EM_ANDAMENTO", "AGUARDANDO_APROVACAO", "EM_COTACAO", "ANALISE_PAGAMENTO", "PAGO", "ENVIADO"];
const HISTORY_STATUSES: OrderStatus[] = ["RECEBIDO", "RECUSADO", "CANCELADO"];
const SITUATIONS = Object.keys(SITUATION_FILTER_LABELS) as SituationFilter[];
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");

// Solicitação de Pedidos (Compras externas): cada item anda sozinho (aprovação → cotação →
// pagamento → envio → recebimento com entrada no estoque) e o pedido mostra a combinação.
// Todos da frente do pedido acompanham (só consulta); as ações seguem as permissões.
export default function PurchaseOrdersView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("ativas");
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [situations, setSituations] = useState<SituationFilter[]>([]);
  const [frontFilter, setFrontFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [suppliers, setSuppliers] = useState<CatalogOption[]>([]);
  const [brands, setBrands] = useState<CatalogOption[]>([]);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<ListResponse>("/api/purchase-orders");
      setData(result);
      setSuppliers(result.suppliers);
      setBrands(result.brands.map((name) => ({ name })));
    } catch (problem) { setError(problemText(problem, "Não foi possível carregar os pedidos.")); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Base única de fornecedores e marcas (a mesma do cadastro de Produtos).
  const catalog = useMemo<Catalog>(() => ({
    suppliers, brands,
    createSupplier: async (name) => {
      const result = await api<{ option: CatalogOption }>("/api/catalog", jsonBody("POST", { kind: "SUPPLIER", name }));
      setSuppliers((current) => current.some((row) => row.id === result.option.id) ? current : [...current, result.option].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
      return result.option;
    },
    createBrand: async (name) => {
      const result = await api<{ option: CatalogOption }>("/api/catalog", jsonBody("POST", { kind: "BRAND", name }));
      setBrands((current) => current.some((row) => row.name === result.option.name) ? current : [...current, result.option].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
      return result.option;
    },
  }), [suppliers, brands]);

  const inTab = useCallback((order: OrderRow, value: Tab) => value === "acao" ? order.needsMe : value === "ativas" ? !isTerminalOrder(order.status) : isTerminalOrder(order.status), []);
  const fronts = useMemo(() => [...new Map((data?.orders ?? []).map((order) => [order.serviceFrontId, order.front])).entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR")), [data]);
  const departments = useDepartments();
  const [managingDepartments, setManagingDepartments] = useState(false);
  // Filtros combináveis (AND): texto, situação geral, situações especiais, frente, filial e período.
  const orders = useMemo(() => {
    const key = normalize(query.trim());
    return (data?.orders ?? []).filter((order) => {
      if (!inTab(order, tab)) return false;
      if (key && !normalize([order.number, order.title ?? "", order.company ?? "", order.front, order.requesterName, order.createdBy, order.department ?? "", order.equipmentPrefix ?? "", order.searchText].join(" ")).includes(key)) return false;
      if (status && order.status !== status) return false;
      if (situations.some((situation) => !matchesSituation(order, situation))) return false;
      if (frontFilter && String(order.serviceFrontId) !== frontFilter) return false;
      if (departmentFilter && String(order.departmentId) !== departmentFilter) return false;
      if (from && order.orderDate < from) return false;
      if (to && order.orderDate > to) return false;
      return true;
    });
  }, [data, tab, query, status, situations, frontFilter, departmentFilter, from, to, inTab]);
  const count = (value: Tab) => (data?.orders ?? []).filter((order) => inTab(order, value)).length;
  const hasFilters = Boolean(query || status || situations.length || frontFilter || departmentFilter || from || to);
  const clearFilters = () => { setQuery(""); setStatus(""); setSituations([]); setFrontFilter(""); setDepartmentFilter(""); setFrom(""); setTo(""); };
  const toggleSituation = (value: SituationFilter) => setSituations((current) => current.includes(value) ? current.filter((row) => row !== value) : [...current, value]);
  const statusOptions = tab === "historico" ? HISTORY_STATUSES : tab === "ativas" ? ACTIVE_STATUSES : [...ACTIVE_STATUSES, ...HISTORY_STATUSES];

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">COMPRAS</p><h1>Solicitação de Pedidos</h1><span>Pedido de compra externa: aprovação e cotação item a item, pagamento, envio e recebimento com entrada no estoque.</span></div>
        {(data?.canRequest || departments.canManage) && <div className="heading-actions">
          {departments.canManage && <button className="secondary" onClick={() => setManagingDepartments(true)}>Departamentos</button>}
          {data?.canRequest && <button className="primary" onClick={() => setCreating(true)}>＋ Novo pedido</button>}
        </div>}
      </div>
      <div className="main-tabs secondary-module-nav" role="tablist">
        <button type="button" className={tab === "ativas" ? "active" : ""} onClick={() => { setTab("ativas"); setStatus(""); }}>Ativas <b className="nav-badge soft">{count("ativas")}</b></button>
        <button type="button" className={tab === "acao" ? "active" : ""} onClick={() => { setTab("acao"); setStatus(""); }}>Precisam da minha ação <b className="nav-badge soft">{count("acao")}</b></button>
        <button type="button" className={tab === "historico" ? "active" : ""} onClick={() => { setTab("historico"); setStatus(""); }}>Histórico <b className="nav-badge soft">{count("historico")}</b></button>
      </div>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
      <article className="panel module-panel">
        <div className="module-filters-grid">
          <label className="page-search span-wide"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar nº, título, solicitante, departamento, equipamento ou item..." /></label>
          <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos os status</option>{statusOptions.map((value) => <option key={value} value={value}>{ORDER_STATUS_LABELS[value]}</option>)}</select></label>
          {fronts.length > 1 && <label>Frente<select value={frontFilter} onChange={(event) => setFrontFilter(event.target.value)}><option value="">Todas</option>{fronts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
          {departments.departments.length > 0 && <label>Departamento<select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="">Todos</option>{departments.departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
          <div className="date-range"><label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
          {hasFilters && <button type="button" className="secondary clear-filters" onClick={clearFilters}>Limpar filtros</button>}
          <div className="po-situation-chips" role="group" aria-label="Situação do pedido">
            {SITUATIONS.map((value) => <button key={value} type="button" className={situations.includes(value) ? "selected" : ""} aria-pressed={situations.includes(value)} onClick={() => toggleSituation(value)}>{SITUATION_FILTER_LABELS[value]}</button>)}
          </div>
        </div>
        {!data && !error ? <div className="page-loading"><span /><p>Carregando pedidos...</p></div> : (
          <>
            <div className="material-card-grid">{orders.map((order) => <PurchaseCard key={order.id} order={order} open={() => setViewing(order.id)} />)}</div>
            {orders.length === 0 && <div className="empty-state">Nenhum pedido {tab === "historico" ? "no histórico" : "nesta aba"}{hasFilters ? " com estes filtros" : ""}.{hasFilters && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div>}
          </>
        )}
      </article>
      {creating && data && <CreatePurchaseModal data={data} departments={departments.departments} createDepartment={departments.canManage ? departments.create : undefined} close={() => setCreating(false)} saved={async (message, id) => { setCreating(false); await load(); flash(message); setViewing(id); }} />}
      {managingDepartments && <DepartmentsModal close={() => setManagingDepartments(false)} changed={departments.reload} flash={flash} />}
      {viewing !== null && data && <PurchaseDetailModal id={viewing} catalog={catalog} close={() => setViewing(null)} changed={load} flash={flash} authUserId={authUser.id} />}
    </>
  );
}

function PurchaseCard({ order, open }: { order: OrderRow; open: () => void }) {
  return (
    <article className={`material-card po-card accent-${CARD_ACCENT[order.status]}`}>
      <header className="task-card-head">
        <span className="task-card-id">{order.number}</span>
        {order.company && <span className="po-company">{order.company}</span>}
        <h3><button type="button" className="task-title-link" onClick={open}>{order.title || `Pedido ${order.number}`}</button></h3>
        <div className="task-card-badges">
          <span className={`status-pill ${ORDER_TONE[order.status]}`}>{order.statusLabel}</span>
          {order.urgency === "URGENTE" && <span className="status-pill red po-urgent">Urgente</span>}
          {order.urgency === "ALTA" && <span className="status-pill orange">Urgência alta</span>}
          {order.needsMe && <span className="status-pill blue">Aguarda você</span>}
        </div>
      </header>
      <div className="task-card-body">
        <p className="material-card-route"><strong>{order.front}</strong>{order.equipmentPrefix ? ` · ${order.equipmentPrefix}` : ""}</p>
        <dl>
          <div><dt>Data de criação</dt><dd>{brDay(order.orderDate)}</dd></div>
          <div><dt>Itens</dt><dd>{order.itemCount} item(ns){order.activeItemCount !== order.itemCount ? ` · ${order.activeItemCount} seguem` : ""}</dd></div>
          <div><dt>Solicitante</dt><dd title={order.requesterName}>{order.requesterName}</dd></div>
          <div><dt>Criado por</dt><dd title={order.createdBy}>{order.createdBy}</dd></div>
          <div><dt>Departamento</dt><dd>{order.department ?? "—"}</dd></div>
          <div><dt>Total</dt><dd>{order.total === null ? "—" : moneyFormat.format(order.total)}</dd></div>
        </dl>
      </div>
      <footer className="task-card-footer"><button onClick={open}>Ver detalhes</button></footer>
    </article>
  );
}

// ------------------------------------------------------------------------------ criação

type DraftPhoto = { file: File; url: string };
type DraftItem = { key: string; mode: "PRODUCT" | "MANUAL"; product: ProductOption | null; description: string; reference: string; notes: string; quantity: string; fiscalUnit: string; photos: DraftPhoto[] };
const newDraft = (): DraftItem => ({ key: crypto.randomUUID(), mode: "PRODUCT", product: null, description: "", reference: "", notes: "", quantity: "", fiscalUnit: DEFAULT_FISCAL_UNIT, photos: [] });

async function uploadFiles(orderId: number, kind: Attachment["kind"], files: File[], itemId?: number) {
  const form = new FormData();
  form.append("kind", kind);
  if (itemId) form.append("itemId", String(itemId));
  files.forEach((file) => form.append("files", file));
  return api<{ message: string }>(`/api/purchase-orders/${orderId}/attachments`, { method: "POST", body: form });
}

function CreatePurchaseModal({ data, departments, createDepartment, close, saved }: {
  data: ListResponse; departments: Department[]; createDepartment?: (name: string) => Promise<Department>; close: () => void; saved: (message: string, id: number) => Promise<void>;
}) {
  const fronts = data.requestFronts;
  const [frontId, setFrontId] = useState(fronts.length === 1 ? String(fronts[0].id) : "");
  const [company, setCompany] = useState<string>(PURCHASE_COMPANIES[0]);
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState<CatalogOption | null>(null);
  const [orderDate, setOrderDate] = useState(localToday());
  const [requesterName, setRequesterName] = useState(data.userName);
  const [urgency, setUrgency] = useState<Urgency>("NORMAL");
  const [equipment, setEquipment] = useState<EquipmentOption | null>(null);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftItem[]>([newDraft()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const photoUrls = useRef<string[]>([]);
  useEffect(() => () => photoUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  const patch = (key: string, value: Partial<DraftItem>) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...value } : item)));
  // Fotos ficam dentro do item a que se referem (a peça quebrada daquele item, por exemplo).
  const addPhotos = (key: string, files: FileList | null) => {
    if (!files?.length) return;
    const added = [...files].map((file) => ({ file, url: URL.createObjectURL(file) }));
    photoUrls.current.push(...added.map((photo) => photo.url));
    setItems((current) => current.map((item) => (item.key === key ? { ...item, photos: [...item.photos, ...added] } : item)));
  };
  const removePhoto = (key: string, url: string) => { URL.revokeObjectURL(url); setItems((current) => current.map((item) => (item.key === key ? { ...item, photos: item.photos.filter((photo) => photo.url !== url) } : item))); };
  const photoCount = items.reduce((sum, item) => sum + item.photos.length, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (items.some((item) => item.mode === "PRODUCT" && !item.product)) { setError("Escolha o produto de cada item (ou mude para “Item manual”)."); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ id: number; message: string; itemIds: number[] }>("/api/purchase-orders", jsonBody("POST", {
        serviceFrontId: Number(frontId), company, title, departmentId: department?.id ?? null, orderDate, requesterName, urgency, equipmentId: equipment?.id ?? null, notes,
        items: items.map((item) => item.mode === "PRODUCT"
          ? { productId: item.product!.id, description: item.product!.name, reference: item.product!.references[0] ?? item.product!.reference ?? "", notes: item.notes, quantity: parseQty(item.quantity), fiscalUnit: item.fiscalUnit }
          : { description: item.description, reference: item.reference, notes: item.notes, quantity: parseQty(item.quantity), fiscalUnit: item.fiscalUnit }),
      }));
      let message = result.message;
      if (photoCount) {
        const failed: string[] = [];
        for (const [index, item] of items.entries()) {
          if (!item.photos.length) continue;
          try { await uploadFiles(result.id, "PHOTO", item.photos.map((photo) => photo.file), result.itemIds[index]); }
          catch (problem) { failed.push(`item ${index + 1}: ${problemText(problem, "falha no envio")}`); }
        }
        message += failed.length ? ` Atenção: fotos não anexadas (${failed.join("; ")}) — anexe pelo detalhe do pedido.` : ` ${photoCount} foto(s) anexada(s) aos itens.`;
      }
      await saved(message, result.id);
    } catch (problem) { setError(problemText(problem, "Não foi possível registrar o pedido.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal po-create" onSubmit={submit}>
      <header><div><p>SOLICITAÇÃO DE PEDIDOS</p><h2>Novo pedido de compra</h2><span>Depois de enviado, cada item aguarda aprovação.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        <section className="fleet-form-section">
          <div className="fleet-section-title"><h3>Cabeçalho do pedido</h3></div>
          <div className="fleet-form-grid po-header-grid">
            <label>Pedido Nº<input readOnly value={data.nextNumber} title="Gerado automaticamente ao salvar (número previsto)" /></label>
            <label>Empresa *<select required value={company} onChange={(event) => setCompany(event.target.value)}>{PURCHASE_COMPANIES.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Data *<input type="date" required value={orderDate} onChange={(event) => setOrderDate(event.target.value)} /></label>
            <label className="span-2">Descrição do pedido *<input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Peças para revisão da escavadeira" /></label>
            <label>Departamento<CatalogPicker options={departments.map((row) => ({ id: row.id, name: row.name }))} value={department} onPick={setDepartment} onCreate={createDepartment} placeholder="Buscar departamento..." createLabel="Cadastrar novo departamento" /></label>
            <label>Urgência *<select required value={urgency} onChange={(event) => setUrgency(event.target.value as Urgency)}>{URGENCIES.map((value) => <option key={value} value={value}>{URGENCY_LABELS[value]}</option>)}</select></label>
            <label>Solicitante *<input required value={requesterName} onChange={(event) => setRequesterName(event.target.value)} /></label>
            {fronts.length === 1
              ? <label>Frente de serviço / Obra / Setor<input readOnly value={fronts[0].name} /></label>
              : <label>Frente de serviço / Obra / Setor *<select required value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="" disabled>Selecione a frente</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
            <label className="span-2">Equipamento (opcional)<EquipmentPicker options={data.equipment} value={equipment} onPick={setEquipment} /></label>
            {equipment && <><label>Chassi<input readOnly value={equipment.chassis ?? "—"} /></label><label>Ano<input readOnly value={equipment.year ?? "—"} /></label></>}
          </div>
        </section>
        <section className="fleet-form-section">
          <div className="fleet-section-title"><h3>Itens <small>({items.length})</small></h3></div>
          {items.map((item, index) => (
            <div className="fleet-order-editor" key={item.key}>
              <header><b>Item {index + 1}</b><div className="material-item-mode" role="group" aria-label="Tipo do item"><button type="button" className={item.mode === "PRODUCT" ? "active" : ""} onClick={() => patch(item.key, { mode: "PRODUCT" })}>Produto do estoque</button><button type="button" className={item.mode === "MANUAL" ? "active" : ""} onClick={() => patch(item.key, { mode: "MANUAL", product: null })}>Item manual (compra)</button></div>{items.length > 1 && <button type="button" onClick={() => setItems(items.filter((row) => row.key !== item.key))}>Remover</button>}</header>
              <div className="fleet-form-grid">
                {item.mode === "PRODUCT" ? <label className="span-2">Produto *<ProductPicker value={item.product} frontId={Number(frontId) || null} onPick={(product) => patch(item.key, { product })} /></label> : <>
                  <label className="span-2">Descrição do item *<input required value={item.description} onChange={(event) => patch(item.key, { description: event.target.value })} /></label>
                  <label>Referência<input value={item.reference} onChange={(event) => patch(item.key, { reference: event.target.value })} /></label>
                </>}
                <label>Quantidade *<input required inputMode="decimal" value={item.quantity} onChange={(event) => patch(item.key, { quantity: event.target.value })} /></label>
                <label>Unidade *<select required value={item.fiscalUnit} onChange={(event) => patch(item.key, { fiscalUnit: event.target.value })}>{FISCAL_UNITS.map(([code, label]) => <option key={code} value={code}>{code} — {label}</option>)}</select></label>
                <label className="span-2">Observações<input value={item.notes} onChange={(event) => patch(item.key, { notes: event.target.value })} placeholder="Opcional (aplicação, medida, cor...)" /></label>
              </div>
              {item.mode === "MANUAL" && <small className="material-item-hint">Item manual (não cadastrado) só é marcado como recebido, sem entrada no estoque.</small>}
              <div className="po-item-photos">
                <label className="po-photo-add">📷 Foto(s) deste item<input type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => { addPhotos(item.key, event.target.files); event.target.value = ""; }} /></label>
                {item.photos.map((photo) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <figure key={photo.url}><img src={photo.url} alt={photo.file.name} /><figcaption>{photo.file.name}<button type="button" className="link-button" onClick={() => removePhoto(item.key, photo.url)}>remover</button></figcaption></figure>
                ))}
              </div>
            </div>
          ))}
          <button type="button" className="secondary po-add-item" onClick={() => setItems([...items, newDraft()])}>＋ Adicionar item</button>
        </section>
        <label className="fleet-notes">Observações / justificativa<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "ENVIANDO..." : "ENVIAR PARA APROVAÇÃO"}</button></footer>
    </form></div>
  );
}

// ------------------------------------------------------------------------------ detalhe

type BatchButton = { action: ItemAction; label: string; from: ItemStatus; prompt?: string; optionalPrompt?: string; primary?: boolean };
const BATCH_BUTTONS: BatchButton[] = [
  { action: "REJECT", label: "Recusar", from: "AGUARDANDO_APROVACAO", prompt: "Motivo da recusa:" },
  { action: "APPROVE", label: "Aprovar", from: "AGUARDANDO_APROVACAO", primary: true },
  { action: "REMOVE", label: "Remover da cotação", from: "EM_COTACAO", prompt: "Por que o item foi removido (orçamento não atendeu)?" },
  { action: "SEND_TO_PAYMENT", label: "Enviar para pagamento", from: "EM_COTACAO", primary: true },
  { action: "CONFIRM_PAYMENT", label: "Confirmar pagamento", from: "ANALISE_PAGAMENTO", optionalPrompt: "Observação do pagamento (opcional):", primary: true },
  { action: "DISPATCH", label: "Marcar como enviado", from: "PAGO", optionalPrompt: "Observação do envio (transportadora, previsão...) — opcional:", primary: true },
];

function QuantityCell({ item }: { item: Item }) {
  const changed = item.originalQuantity !== null && item.originalQuantity !== item.quantity;
  if (item.status === "REMOVIDO") return (
    <><s>{qtyFormat.format(item.quantity)} {item.fiscalUnit}</s> <span className="status-pill gray">Removido</span>
      <small className="table-sub">{item.removedByName ?? "—"} · {brDateTime(item.removedAt)}{item.removedReason ? ` · ${item.removedReason}` : ""}</small></>
  );
  if (!changed) return <>{qtyFormat.format(item.quantity)} {item.fiscalUnit}</>;
  return (
    <span className="po-qty-changed" title="Quantidade alterada pelo comprador na cotação">
      <small>Pedido: <s>{qtyFormat.format(item.originalQuantity!)}</s></small><strong>Cotação: {qtyFormat.format(item.quantity)} {item.fiscalUnit}</strong>
      <small className="table-sub">{item.quantityChangedByName ?? "—"} · {brDateTime(item.quantityChangedAt)}</small>
    </span>
  );
}

type QuoteDraft = { unitPrice: string; supplier: CatalogOption | null; brand: CatalogOption | null };

function PurchaseDetailModal({ id, catalog, close, changed, flash, authUserId }: { id: number; catalog: Catalog; close: () => void; changed: () => Promise<void>; flash: (message: string) => void; authUserId: number }) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [quote, setQuote] = useState<Record<number, QuoteDraft>>({});
  const [buyerNotes, setBuyerNotes] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [receiving, setReceiving] = useState<Item | null>(null);
  const [historyOf, setHistoryOf] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await api<{ order: Detail }>(`/api/purchase-orders/${id}`);
      const detail = result.order;
      setOrder(detail);
      setBuyerNotes(detail.buyerNotes ?? "");
      setSelected((current) => current.filter((itemId) => detail.items.some((item) => item.id === itemId && isActiveItem(item.status) && item.status !== "RECEBIDO")));
      setQuote(Object.fromEntries(detail.items.map((item) => {
        const supplierId = item.supplierId ?? item.product?.supplierId ?? null;
        const supplierName = item.supplierName ?? item.product?.supplier ?? null;
        const brand = item.brand ?? item.product?.brand ?? null;
        return [item.id, { unitPrice: item.unitPrice === null ? "" : String(item.unitPrice).replace(".", ","), supplier: supplierId && supplierName ? { id: supplierId, name: supplierName } : null, brand: brand ? { name: brand } : null }];
      })));
    } catch (problem) { setError(problemText(problem, "Não foi possível carregar o pedido.")); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { flash((await api<{ message: string }>(`/api/purchase-orders/${id}`, jsonBody("PUT", body))).message); await Promise.all([load(), changed()]); return true; }
    catch (problem) { setError(problemText(problem, "Não foi possível atualizar o pedido.")); return false; }
    finally { setBusy(false); }
  }
  const patchQuote = (itemId: number, value: Partial<QuoteDraft>) => setQuote((current) => ({ ...current, [itemId]: { ...current[itemId], ...value } }));
  const quoteItems = () => (order?.items ?? []).filter((item) => item.status === "EM_COTACAO").map((item) => ({ id: item.id, unitPrice: quote[item.id]?.unitPrice ?? "", supplierId: quote[item.id]?.supplier?.id ?? null, brand: quote[item.id]?.brand?.name ?? "" }));
  async function upload(kind: Attachment["kind"], files: FileList | null, itemId?: number) {
    if (!files?.length) return;
    setBusy(true); setError("");
    try { flash((await uploadFiles(id, kind, [...files], itemId)).message); await load(); }
    catch (problem) { setError(problemText(problem, "Não foi possível anexar.")); }
    finally { setBusy(false); }
  }
  async function removeAttachment(attachmentId: number) {
    if (!window.confirm("Remover este anexo?")) return;
    try { await api(`/api/purchase-orders/attachments/${attachmentId}`, { method: "DELETE" }); await load(); }
    catch (problem) { setError(problemText(problem, "Não foi possível remover.")); }
  }
  async function runBatch(button: BatchButton, itemIds: number[]) {
    const body: Record<string, unknown> = { action: button.action, itemIds };
    if (button.prompt) { const value = window.prompt(button.prompt); if (value === null || !value.trim()) return; body.reason = value; }
    if (button.optionalPrompt) { const value = window.prompt(button.optionalPrompt); if (value === null) return; body.notes = value; }
    if (button.action === "SEND_TO_PAYMENT") { body.items = quoteItems(); body.buyerNotes = buyerNotes; }
    if (await act(body)) setSelected([]);
  }
  async function adjustQuantity(item: Item) {
    const original = item.originalQuantity ?? item.quantity;
    const value = window.prompt(`Nova quantidade de ${item.description} (pedido original: ${qtyFormat.format(original)} ${item.fiscalUnit}; só pode reduzir):`, qtyFormat.format(item.quantity));
    if (value === null) return;
    const reason = window.prompt("Motivo (opcional, ex.: fornecedor só tinha 6):") ?? "";
    await act({ action: "ADJUST_QUANTITY", itemId: item.id, quantity: value, reason });
  }

  const stageCounts = useMemo(() => {
    const counts = new Map<ItemStatus, number>();
    for (const item of order?.items ?? []) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    return [...counts.entries()];
  }, [order]);
  const actions = order?.actions;
  const canSelect = Boolean(actions && BATCH_BUTTONS.some((button) => actions[button.action]));
  const selectable = (order?.items ?? []).filter((item) => isActiveItem(item.status) && item.status !== "RECEBIDO");
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.includes(item.id));
  const quoting = Boolean(actions?.QUOTE);
  // Fotos antigas (antes do vínculo com item) aparecem à parte.
  const looseFiles = (order?.attachments ?? []).filter((file) => file.kind === "PHOTO" && !file.itemId);
  const photosOf = (itemId: number) => (order?.attachments ?? []).filter((file) => file.kind === "PHOTO" && file.itemId === itemId);
  const proofs = (order?.attachments ?? []).filter((file) => file.kind === "PAYMENT_PROOF");
  const quoteImages = (order?.attachments ?? []).filter((file) => file.kind === "QUOTE_IMAGE");
  const quoteDocs = (order?.attachments ?? []).filter((file) => file.kind === "QUOTE_DOCUMENT");

  return (
    <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal po-detail">
      <header><div><p>SOLICITAÇÃO DE PEDIDOS{order?.company ? ` · ${order.company}` : ""}</p><h2>{order ? `${order.number} · ${order.title ?? ""}` : "Carregando..."}</h2><span>{order ? `${order.requesterName ?? "—"} · ${order.front} · ${brDay(order.orderDate)}` : ""}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        {!order && !error && <div className="page-loading"><span /><p>Carregando...</p></div>}
        {order && <>
          <div className="po-status-line">
            <span className={`status-pill ${ORDER_TONE[order.status]}`}>{order.statusLabel}</span>
            {order.urgency !== "NORMAL" && <span className={`status-pill ${order.urgency === "URGENTE" ? "red" : order.urgency === "ALTA" ? "orange" : "gray"}`}>Urgência {URGENCY_LABELS[order.urgency].toLowerCase()}</span>}
            {stageCounts.map(([itemStatus, total]) => <span key={itemStatus} className="po-stage-count">{ITEM_STATUS_LABELS[itemStatus]}: <b>{total}</b></span>)}
          </div>
          {order.cancelledAt && <p className="po-cancelled">Cancelado por {order.cancelledByName ?? "—"} em {brDateTime(order.cancelledAt)}: {order.cancelReason}</p>}
          <dl className="po-header-info">
            <div><dt>Pedido Nº</dt><dd>{order.number}</dd></div>
            <div><dt>Empresa</dt><dd>{order.company ?? "—"}</dd></div>
            <div><dt>Frente de serviço</dt><dd>{order.front}</dd></div>
            <div><dt>Data</dt><dd>{brDay(order.orderDate)}</dd></div>
            <div><dt>Departamento</dt><dd>{order.department ?? "—"}</dd></div>
            <div><dt>Solicitante</dt><dd>{order.requesterName ?? "—"}</dd></div>
            <div><dt>Criado por</dt><dd>{order.createdByName ?? "—"} · {brDateTime(order.requestedAt)}</dd></div>
            <div><dt>Equipamento</dt><dd>{order.equipment ? `${order.equipment.prefix} · ${order.equipment.description}` : "—"}</dd></div>
            {order.equipment && <><div><dt>Chassi</dt><dd>{order.equipment.chassis ?? "—"}</dd></div><div><dt>Ano</dt><dd>{order.equipment.year ?? "—"}</dd></div></>}
          </dl>
          {order.notes && <p className="stock-summary">Observações do solicitante: {order.notes}</p>}

          {canSelect && (
            <div className="po-bulk-bar">
              <label><input type="checkbox" checked={allSelected} disabled={selectable.length === 0} onChange={(event) => setSelected(event.target.checked ? selectable.map((item) => item.id) : [])} /> Selecionar todos</label>
              <span>{selected.length ? `${selected.length} selecionado(s)` : "Marque os itens e escolha a ação"}</span>
              <div>{BATCH_BUTTONS.filter((button) => actions![button.action]).map((button) => {
                const eligible = order.items.filter((item) => selected.includes(item.id) && item.status === button.from).map((item) => item.id);
                return <button key={button.action} type="button" className={button.primary ? "primary" : "secondary"} disabled={busy || eligible.length === 0} title={`Aplica aos itens selecionados em “${ITEM_STATUS_LABELS[button.from]}”`} onClick={() => runBatch(button, eligible)}>{button.label}{eligible.length ? ` (${eligible.length})` : ""}</button>;
              })}</div>
            </div>
          )}
          <div className="table-scroll">
            <table className="purchase-items-table">
              <thead><tr>{canSelect && <th aria-label="Selecionar" />}<th>Item</th><th>Qtd.</th><th>Situação</th><th title="Fornecedor · marca (cotação)">Fornecedor / marca</th><th title="Valor unitário · total">Valor</th><th>Recebimento</th></tr></thead>
              <tbody>{order.items.map((item) => {
                const editable = quoting && item.status === "EM_COTACAO";
                const row = quote[item.id];
                return [
                  <tr key={item.id} className={!isActiveItem(item.status) ? "po-item-out" : ""}>
                    {canSelect && <td><input type="checkbox" aria-label={`Selecionar ${item.description}`} disabled={!selectable.includes(item)} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((value) => value !== item.id))} /></td>}
                    <td><strong>{item.product?.tag ? `${item.product.tag} · ` : ""}{item.description}</strong><small className="table-sub">{item.product ? "Produto do estoque" : "Item manual"}{item.reference ? ` · Ref. ${item.reference}` : ""}</small>{item.notes && <small className="table-sub">Obs.: {item.notes}</small>}
                      <ItemPhotos files={photosOf(item.id)} canEdit={Boolean(actions?.PHOTO)} busy={busy} upload={(files) => upload("PHOTO", files, item.id)} remove={removeAttachment} />
                      <button type="button" className="link-button" onClick={() => setHistoryOf(historyOf === item.id ? null : item.id)}>{historyOf === item.id ? "ocultar histórico" : `histórico (${item.events.length})`}</button></td>
                    <td><QuantityCell item={item} />{editable && <button type="button" className="link-button" disabled={busy} onClick={() => adjustQuantity(item)}>ajustar qtd.</button>}</td>
                    <td><span className={`status-pill ${ITEM_TONE[item.status]}`}>{item.statusLabel}</span>{item.status === "RECUSADO" && <small className="table-sub">{item.rejectedByName ?? "—"}: {item.rejectReason}</small>}</td>
                    <td>{editable ? (
                      <div className="po-quote-cell">
                        <CatalogPicker options={catalog.suppliers} value={row?.supplier ?? null} onPick={(supplier) => patchQuote(item.id, { supplier })} onCreate={catalog.createSupplier} placeholder="Fornecedor..." createLabel="Cadastrar novo fornecedor" />
                        <CatalogPicker options={catalog.brands} value={row?.brand ?? null} onPick={(brand) => patchQuote(item.id, { brand })} onCreate={catalog.createBrand} placeholder="Marca..." createLabel="Cadastrar nova marca" />
                      </div>
                    ) : <>{item.supplierName ?? "—"}<small className="table-sub">{item.brand ?? "—"}</small></>}</td>
                    <td>{editable
                      ? <input inputMode="decimal" value={row?.unitPrice ?? ""} placeholder="R$ unitário" onChange={(event) => patchQuote(item.id, { unitPrice: event.target.value })} />
                      : <>{item.unitPrice === null ? "—" : moneyFormat.format(item.unitPrice)}{item.total !== null && <small className="table-sub">Total {moneyFormat.format(item.total)}</small>}</>}</td>
                    <td>{item.receivedAt
                      ? <><span className="status-pill green">Recebido</span><small className="table-sub">{qtyFormat.format(item.receivedQuantity ?? 0)} {item.fiscalUnit}{item.receivedUnitPrice !== null ? ` · ${moneyFormat.format(item.receivedUnitPrice)}` : ""}{item.receivedSupplierName ? ` · ${item.receivedSupplierName}` : ""}{item.receivedBrand ? ` · ${item.receivedBrand}` : ""}</small><small className="table-sub">{item.receivedByName ?? "—"} · {brDateTime(item.receivedAt)}</small></>
                      : item.status === "ENVIADO" && actions?.RECEIVE ? <button type="button" className="secondary" onClick={() => setReceiving(item)}>Confirmar recebimento</button> : "—"}</td>
                  </tr>,
                  historyOf === item.id && <tr key={`${item.id}-history`} className="po-item-history-row"><td colSpan={canSelect ? 7 : 6}>
                    <ol className="po-item-history">{item.events.length === 0 ? <li>Sem registros.</li> : item.events.map((event) => (
                      <li key={event.id}><time>{brDateTime(event.createdAt)}</time> <b>{event.action}</b>{event.toStatus && event.fromStatus && event.fromStatus !== event.toStatus ? ` (${ITEM_STATUS_LABELS[event.fromStatus as ItemStatus] ?? event.fromStatus} → ${ITEM_STATUS_LABELS[event.toStatus as ItemStatus] ?? event.toStatus})` : ""} · {event.userName ?? "—"}{event.details ? <span> — {event.details}</span> : null}</li>
                    ))}</ol>
                  </td></tr>,
                ];
              })}</tbody>
            </table>
          </div>
          <p className="stock-summary">Total (itens que seguem): <strong>{order.total === null ? "—" : moneyFormat.format(order.total)}</strong>{order.buyerNotes && !quoting ? ` · Comprador: ${order.buyerNotes}` : ""}{order.paymentNotes ? ` · Pagamento: ${order.paymentNotes}` : ""}{order.dispatchNotes ? ` · Envio: ${order.dispatchNotes}` : ""}</p>
          {quoting && <>
            <label className="fleet-notes">Observações do comprador<textarea value={buyerNotes} onChange={(event) => setBuyerNotes(event.target.value)} /></label>
            <div className="equipment-row-actions"><button type="button" className="secondary" disabled={busy} onClick={() => act({ action: "SAVE_QUOTE", items: quoteItems(), buyerNotes })}>Salvar cotação</button></div>
          </>}

          {looseFiles.length > 0 && <AttachmentSection title="Fotos sem item vinculado" empty="" files={looseFiles} canEdit={false} accept="" addLabel="" busy={busy} upload={async () => undefined} remove={removeAttachment} />}
          <AttachmentSection title="Orçamento por imagem" empty="Nenhum orçamento por imagem (foto/print)." files={quoteImages} canEdit={quoting} accept="image/jpeg,image/png,image/webp" addLabel="＋ ANEXAR IMAGEM" busy={busy} upload={(files) => upload("QUOTE_IMAGE", files)} remove={removeAttachment} />
          <AttachmentSection title="Orçamento por documento" empty="Nenhum orçamento em documento (PDF, Word, Excel...)." files={quoteDocs} canEdit={quoting}
            accept={DOCUMENT_ACCEPT} addLabel="＋ ANEXAR DOCUMENTO" busy={busy} upload={(files) => upload("QUOTE_DOCUMENT", files)} remove={removeAttachment} />
          <AttachmentSection title="Comprovante de pagamento" empty="Nenhum comprovante de pagamento (imagem ou documento)." files={proofs} canEdit={Boolean(actions?.PAYMENT_PROOF)}
            accept={`image/jpeg,image/png,image/webp,${DOCUMENT_ACCEPT}`} addLabel="＋ ANEXAR COMPROVANTE" busy={busy} upload={(files) => upload("PAYMENT_PROOF", files)} remove={removeAttachment} />
          {receiving && <ReceiptCard item={receiving} catalog={catalog} busy={busy} cancel={() => setReceiving(null)} confirm={async (body) => { if (await act({ action: "RECEIVE_ITEM", itemId: receiving.id, ...body })) setReceiving(null); }} />}
          {!canSelect && !actions?.RECEIVE && order.requesterId !== authUserId && <p className="stock-summary">Você acompanha este pedido por ser da mesma frente (somente consulta).</p>}
        </>}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer>
        <button type="button" onClick={close}>Fechar janela</button>
        {actions?.CANCEL && <button type="button" disabled={busy} onClick={() => { const reason = window.prompt("Motivo do cancelamento do pedido inteiro:"); if (reason?.trim()) act({ action: "CANCEL", reason }); }}>Cancelar pedido</button>}
      </footer>
    </section></div>
  );
}

const DOCUMENT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.csv,.txt,application/pdf";

// Fotos vinculadas a um item: miniaturas dentro da linha do item, com "＋ foto" para quem pode anexar.
function ItemPhotos({ files, canEdit, busy, upload, remove }: { files: Attachment[]; canEdit: boolean; busy: boolean; upload: (files: FileList | null) => Promise<void>; remove: (id: number) => void }) {
  if (!files.length && !canEdit) return null;
  return (
    <div className="po-item-thumbs">
      {files.map((file) => (
        <span key={file.id}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a href={`/api/purchase-orders/attachments/${file.id}`} target="_blank" rel="noreferrer" title={`${file.fileName} · ${file.uploadedByName ?? "—"}`}><img src={`/api/purchase-orders/attachments/${file.id}`} alt={file.fileName} loading="lazy" /></a>
          {canEdit && <button type="button" className="link-button" aria-label={`Remover ${file.fileName}`} onClick={() => remove(file.id)}>×</button>}
        </span>
      ))}
      {canEdit && <label className="po-photo-add small">＋ foto<input type="file" hidden multiple disabled={busy} accept="image/jpeg,image/png,image/webp" onChange={async (event) => { const input = event.currentTarget; await upload(input.files); input.value = ""; }} /></label>}
    </div>
  );
}

function AttachmentSection({ title, empty, files, canEdit, accept, addLabel, busy, upload, remove }: {
  title: string; empty: string; files: Attachment[]; canEdit: boolean; accept: string; addLabel: string; busy: boolean; upload: (files: FileList | null) => Promise<void>; remove: (id: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="fleet-form-section">
      <div className="fleet-section-title"><h3>{title} <small>({files.length})</small></h3>{canEdit && <><button type="button" onClick={() => input.current?.click()} disabled={busy}>{addLabel}</button><input ref={input} type="file" hidden multiple accept={accept} onChange={async (event) => { await upload(event.target.files); if (input.current) input.current.value = ""; }} /></>}</div>
      {files.length === 0 ? <p className="stock-summary">{empty}</p> : (
        <div className="po-attachments">{files.map((file) => (
          <span key={file.id} title={`${file.uploadedByName ?? "—"} · ${brDateTime(file.createdAt)}`}>
            <a href={`/api/purchase-orders/attachments/${file.id}`} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {file.contentType.startsWith("image/") ? <img src={`/api/purchase-orders/attachments/${file.id}`} alt="" loading="lazy" /> : "📄"} {file.fileName}
            </a>
            {canEdit && <button type="button" className="link-button" onClick={() => remove(file.id)}>remover</button>}
          </span>
        ))}</div>
      )}
    </section>
  );
}

function YesNo({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <span className="po-yesno"><button type="button" className={value ? "active" : ""} onClick={() => onChange(true)}>Sim</button><button type="button" className={!value ? "active" : ""} onClick={() => onChange(false)}>Não</button></span>;
}

// Card de conferência do recebimento. Só a quantidade é obrigatória; fornecedor, marca e valor são
// complementares. Fornecedor e marca usam a mesma base do cadastro de Produtos, com cadastro na hora.
function ReceiptCard({ item, catalog, busy, cancel, confirm }: { item: Item; catalog: Catalog; busy: boolean; cancel: () => void; confirm: (body: Record<string, unknown>) => void }) {
  const product = item.product;
  const referencePrice = item.unitPrice ?? product?.price ?? null;
  const [supplierChanged, setSupplierChanged] = useState(false);
  const [supplier, setSupplier] = useState<CatalogOption | null>(null);
  const [brandChanged, setBrandChanged] = useState(false);
  const [brand, setBrand] = useState<CatalogOption | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);
  const [unitPrice, setUnitPrice] = useState(referencePrice === null ? "" : String(referencePrice).replace(".", ","));
  const [fullQuantity, setFullQuantity] = useState(true);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [notes, setNotes] = useState("");
  const currentSupplier = item.supplierName ?? product?.supplier ?? null;
  const currentBrand = item.brand ?? product?.brand ?? null;
  return (
    <div className="po-receipt">
      <strong>Conferência do recebimento — {item.description}</strong>
      <fieldset><legend>Mudou o fornecedor? <small>(atual: {currentSupplier ?? "—"})</small></legend><YesNo value={supplierChanged} onChange={setSupplierChanged} />
        {supplierChanged && <CatalogPicker options={catalog.suppliers} value={supplier} onPick={setSupplier} onCreate={catalog.createSupplier} placeholder="Buscar fornecedor..." createLabel="Cadastrar novo fornecedor" />}</fieldset>
      <fieldset><legend>Mudou a marca? <small>(atual: {currentBrand ?? "—"})</small></legend><YesNo value={brandChanged} onChange={setBrandChanged} />
        {brandChanged && <CatalogPicker options={catalog.brands} value={brand} onPick={setBrand} onCreate={catalog.createBrand} placeholder="Buscar marca..." createLabel="Cadastrar nova marca" />}</fieldset>
      <fieldset><legend>Mudou o valor? <small>({product ? `cadastro: ${product.price === null ? "—" : moneyFormat.format(product.price)}` : "item manual"}{item.unitPrice !== null ? ` · cotado: ${moneyFormat.format(item.unitPrice)}` : ""})</small></legend><YesNo value={priceChanged} onChange={setPriceChanged} />
        {priceChanged && <input inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder="Novo valor unitário (R$) — opcional" />}</fieldset>
      <fieldset><legend>Veio a quantidade pedida? * <small>({qtyFormat.format(item.quantity)} {item.fiscalUnit})</small></legend><YesNo value={fullQuantity} onChange={setFullQuantity} />
        {!fullQuantity && <input inputMode="decimal" required value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Quantidade que chegou" />}</fieldset>
      <label>Observação<input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <p className="stock-summary">{product ? "Ao confirmar, a quantidade recebida entra no estoque da frente do pedido e o cadastro do produto é atualizado no que mudou (fornecedor, marca e valor são opcionais)." : "Item manual: só fica marcado como recebido (sem estoque)."}</p>
      <div className="equipment-row-actions"><button type="button" onClick={cancel}>Voltar</button><button type="button" className="primary" disabled={busy} onClick={() => confirm({
        supplierChanged, supplierId: supplier?.id ?? null, brandChanged, brand: brand?.name ?? "", priceChanged, unitPrice, fullQuantity, quantity: parseQty(quantity), notes,
      })}>Confirmar recebimento</button></div>
    </div>
  );
}
