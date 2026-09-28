"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api, ApiError, brDateTime, brDay, EquipmentPicker, jsonBody, localToday, moneyFormat, parseQty, problemText, ProductPicker, qtyFormat, ShortageNotice,
  type EmployeeOption, type EquipmentOption, type ProductOption, type Shortage, type StockOptions,
} from "./stock-client";

type User = { name: string; permissions: string[] };
type OrderCard = {
  id: number; number: string; equipmentId: number; prefix: string; equipmentDescription: string; front: string; openedAt: string;
  meterReading: number | null; meterUnit: "HOURS" | "KM"; description: string; status: "OPEN" | "CLOSED"; closedAt: string | null;
  mechanics: string[]; itemCount: number; partsTotal: number; oilChanges: number;
};
type ListResponse = { orders: OrderCard[]; mechanics: string[]; canManage: boolean; canClose: boolean };
type OrderItem = { id: number; tag: string; name: string; quantity: number; launchDate: string; withdrawnBy: string; application: string | null; unitPrice: number | null; total: number | null; removedAt: string | null; launchedBy: string | null };
type OrderDetail = {
  id: number; number: string; status: "OPEN" | "CLOSED"; openedAt: string; meterReading: number | null; meterUnit: "HOURS" | "KM"; description: string;
  closedAt: string | null; closedByName: string | null; closingNotes: string | null; openedBy: string | null; front: string; serviceFrontId: number;
  equipment: { id: number; prefix: string; description: string }; mechanics: string[]; items: OrderItem[]; partsTotal: number;
  oilChanges: Array<{ id: number; performedAt: string; mechanic: string | null; service: string; hours: number | null; km: number | null }>;
};

const unitLabel = (unit: "HOURS" | "KM") => (unit === "KM" ? "km" : "h");

// Ordem de Serviço: abertura por equipamento, peças do estoque (data e quem retirou, peça por peça),
// mecânicos, trocas de óleo vinculadas pelo QR Code e fechamento rápido na listagem.
export default function WorkOrdersView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [status, setStatus] = useState<"OPEN" | "CLOSED" | "">("OPEN");
  const [equipmentFilter, setEquipmentFilter] = useState<EquipmentOption | null>(null);
  const [options, setOptions] = useState<StockOptions>({ fronts: [], defaultFrontId: null, equipment: [] });
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => { api<StockOptions>("/api/stock/options").then(setOptions).catch(() => undefined); }, []);
  const load = useCallback(async () => {
    setError("");
    const params = new URLSearchParams(Object.entries({ status, equipamento: equipmentFilter ? String(equipmentFilter.id) : "" }).filter(([, value]) => value)).toString();
    try { setData(await api<ListResponse>(`/api/work-orders${params ? `?${params}` : ""}`)); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar as O.S.")); }
  }, [status, equipmentFilter]);
  useEffect(() => { load(); }, [load]);

  async function quickClose(order: OrderCard) {
    if (!window.confirm(`Fechar a ${order.number} (${order.prefix})?`)) return;
    try { flash((await api<{ message: string }>(`/api/work-orders/${order.id}`, jsonBody("PUT", { action: "CLOSE" }))).message); await load(); }
    catch (problem) { window.alert(problemText(problem, "Não foi possível fechar a O.S.")); }
  }

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">OFICINA · MANUTENÇÃO</p><h1>Ordem de Serviço</h1><span>O.S. por equipamento com peças do estoque (baixadas na hora), mecânicos responsáveis e as trocas de óleo registradas pelo QR Code.</span></div>
        {data?.canManage && <div className="heading-actions"><button className="primary" onClick={() => setOpening(true)}>＋ Abrir O.S.</button></div>}
      </div>
      <article className="panel module-panel equipment-management-panel">
        <div className="main-tabs secondary-module-nav" role="tablist">
          {([["OPEN", "Abertas"], ["CLOSED", "Fechadas"], ["", "Todas"]] as const).map(([value, label]) => <button key={label} type="button" className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{label}</button>)}
        </div>
        <div className="equipment-management-filters stock-filters">
          <label className="stock-filter-wide">Equipamento<EquipmentPicker options={options.equipment} value={equipmentFilter} onPick={setEquipmentFilter} placeholder="Filtrar por equipamento..." /></label>
        </div>
        {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
        {!data && !error ? <div className="page-loading"><span /><p>Carregando O.S....</p></div> : data && (
          <div className="wo-cards">
            {data.orders.map((order) => (
              <article className="wo-card" key={order.id}>
                <header>
                  <div><strong>{order.number}</strong><p>{order.prefix} · {order.equipmentDescription} · {order.front}</p></div>
                  <span className={`status-pill ${order.status === "OPEN" ? "blue" : "green"}`}>{order.status === "OPEN" ? "Aberta" : "Fechada"}</span>
                </header>
                <p><b>{order.description}</b></p>
                <p>Aberta em {brDay(order.openedAt)}{order.meterReading !== null ? ` · ${qtyFormat.format(order.meterReading)} ${unitLabel(order.meterUnit)}` : ""}{order.closedAt ? ` · fechada em ${brDateTime(order.closedAt)}` : ""}</p>
                <p>Mecânicos: {order.mechanics.length ? order.mechanics.join(", ") : "—"}</p>
                <p>{order.itemCount} peça(s) · {moneyFormat.format(order.partsTotal)}{order.oilChanges ? ` · ${order.oilChanges} troca(s) de óleo` : ""}</p>
                <footer>
                  <button className="secondary" onClick={() => setViewing(order.id)}>Abrir O.S.</button>
                  {data.canClose && order.status === "OPEN" && <button className="primary" onClick={() => quickClose(order)}>Fechar</button>}
                </footer>
              </article>
            ))}
            {data.orders.length === 0 && <div className="empty-state">Nenhuma O.S. {status === "OPEN" ? "aberta" : status === "CLOSED" ? "fechada" : ""} para os filtros.</div>}
          </div>
        )}
      </article>
      {opening && data && <OpenWorkOrderModal options={options} close={() => setOpening(false)} saved={async (message, id) => { setOpening(false); await load(); flash(message); setViewing(id); }} />}
      {viewing !== null && data && <WorkOrderDetailModal id={viewing} canManage={data.canManage} canClose={data.canClose} close={() => setViewing(null)} changed={load} flash={flash} currentUser={authUser.name} />}
    </>
  );
}

// Mecânicos da O.S.: busca na lista de Funcionários (a mesma do Combustível e dos outros módulos) e
// "adiciona" quantos forem necessários; cada um pode ser removido se entrou por engano.
function MechanicsSelect({ value, onChange, frontId }: { value: string[]; onChange: (value: string[]) => void; frontId?: number | null }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EmployeeOption[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<{ employees: EmployeeOption[] }>(`/api/employees/lookup?q=${encodeURIComponent(query.trim())}${frontId ? `&serviceFrontId=${frontId}` : ""}`)
        .then((result) => { setOptions(result.employees); setOpen(true); }).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId]);
  const add = (name: string) => { const clean = name.trim().toUpperCase(); if (clean && !value.includes(clean)) onChange([...value, clean]); setQuery(""); setOpen(false); };
  return (
    <div className="wo-section">
      {value.length > 0 && <div className="wo-mechanics">{value.map((name) => <span className="wo-mechanic-chip" key={name}>{name}<button type="button" aria-label={`Remover ${name}`} onClick={() => onChange(value.filter((item) => item !== name))}>×</button></span>)}</div>}
      <div className="material-product-picker">
        <input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} placeholder="Buscar mecânico pelo nome e clicar para adicionar..." />
        {open && options.length > 0 && <ul>{options.map((option) => <li key={option.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => add(option.name)} disabled={value.includes(option.name.toUpperCase())}><b>＋ {option.name}</b><small> · {option.jobTitle} · {option.frontName}</small></button></li>)}</ul>}
        {open && query.trim().length >= 2 && options.length === 0 && <p className="material-product-empty">Nenhum funcionário encontrado com esse nome.</p>}
      </div>
    </div>
  );
}

function OpenWorkOrderModal({ options, close, saved }: { options: StockOptions; close: () => void; saved: (message: string, id: number) => Promise<void> }) {
  const [equipmentItem, setEquipmentItem] = useState<EquipmentOption | null>(null);
  const [openedAt, setOpenedAt] = useState(localToday());
  const [meterReading, setMeterReading] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function pick(item: EquipmentOption | null) {
    setEquipmentItem(item);
    // KM/horímetro vem da última leitura registrada do equipamento (pode ser alterado).
    setMeterReading(item ? String(item.currentReading) : "");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!equipmentItem) { setError("Selecione o equipamento."); return; }
    setBusy(true); setError("");
    try {
      const result = await api<{ id: number; message: string }>("/api/work-orders", jsonBody("POST", { equipmentId: equipmentItem.id, openedAt, meterReading, description, mechanics: chosen }));
      await saved(result.message, result.id);
    } catch (problem) { setError(problemText(problem, "Não foi possível abrir a O.S.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal" onSubmit={submit}>
      <header><div><p>ORDEM DE SERVIÇO</p><h2>Abrir O.S.</h2><span>As peças lançadas depois saem do estoque da frente do equipamento.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        <div className="fleet-form-grid">
          <label className="span-2">Equipamento *<EquipmentPicker options={options.equipment} value={equipmentItem} onPick={pick} /></label>
          <label>Data de abertura *<input type="date" required max={localToday()} value={openedAt} onChange={(event) => setOpenedAt(event.target.value)} /></label>
          <label>{equipmentItem?.meterUnit === "KM" ? "KM" : "Horímetro"} {equipmentItem && <small>(última leitura: {qtyFormat.format(equipmentItem.currentReading)} {unitLabel(equipmentItem.meterUnit)})</small>}<input inputMode="decimal" value={meterReading} onChange={(event) => setMeterReading(event.target.value)} /></label>
          <label className="span-2">O que está sendo feito / diagnóstico *<textarea required value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="wo-full"><span className="stock-label">Mecânicos responsáveis</span><MechanicsSelect value={chosen} onChange={setChosen} frontId={equipmentItem?.serviceFrontId ?? null} /></div>
        </div>
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "ABRINDO..." : "ABRIR O.S."}</button></footer>
    </form></div>
  );
}

function WorkOrderDetailModal({ id, canManage, canClose, close, changed, flash, currentUser }: { id: number; canManage: boolean; canClose: boolean; close: () => void; changed: () => Promise<void>; flash: (message: string) => void; currentUser: string }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [description, setDescription] = useState("");
  const [meterReading, setMeterReading] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api<{ order: OrderDetail }>(`/api/work-orders/${id}`);
      setOrder(result.order); setDescription(result.order.description); setMeterReading(result.order.meterReading === null ? "" : String(result.order.meterReading)); setChosen(result.order.mechanics);
    } catch (problem) { setError(problemText(problem, "Não foi possível carregar a O.S.")); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const editable = Boolean(order && order.status === "OPEN" && canManage);
  async function act(body: Record<string, unknown>, message?: string) {
    setBusy(true); setError("");
    try { const result = await api<{ message: string }>(`/api/work-orders/${id}`, jsonBody("PUT", body)); flash(message ?? result.message); await Promise.all([load(), changed()]); }
    catch (problem) { setError(problemText(problem, "Não foi possível atualizar a O.S.")); }
    finally { setBusy(false); }
  }
  async function removeItem(item: OrderItem) {
    if (!window.confirm(`Retirar ${item.tag} ${item.name} da O.S.? O estoque volta para a frente.`)) return;
    try { flash((await api<{ message: string }>(`/api/work-orders/${id}/items/${item.id}`, { method: "DELETE" })).message); await Promise.all([load(), changed()]); }
    catch (problem) { setError(problemText(problem, "Não foi possível retirar a peça.")); }
  }
  return (
    <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal wo-detail">
      <header><div><p>ORDEM DE SERVIÇO</p><h2>{order ? `${order.number} · ${order.equipment.prefix}` : "Carregando..."}</h2><span>{order ? `${order.equipment.description} · ${order.front} · aberta em ${brDay(order.openedAt)} por ${order.openedBy ?? "—"}${order.closedAt ? ` · fechada em ${brDateTime(order.closedAt)} por ${order.closedByName ?? "—"}` : ""}` : ""}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        {!order && !error && <div className="page-loading"><span /><p>Carregando...</p></div>}
        {order && <>
          <div className="fleet-form-grid">
            <label className="span-2">O que está sendo feito / diagnóstico<textarea value={description} disabled={!editable} onChange={(event) => setDescription(event.target.value)} /></label>
            <label>{order.meterUnit === "KM" ? "KM" : "Horímetro"} na abertura<input inputMode="decimal" value={meterReading} disabled={!editable} onChange={(event) => setMeterReading(event.target.value)} /><small>Situação: <b>{order.status === "OPEN" ? "Aberta" : "Fechada"}</b></small></label>
            <div className="wo-full"><span className="stock-label">Mecânicos responsáveis</span>{editable ? <MechanicsSelect value={chosen} onChange={setChosen} frontId={order.serviceFrontId} /> : <p>{order.mechanics.join(", ") || "—"}</p>}</div>
          </div>
          {editable && <div className="wo-actions"><button type="button" className="secondary" disabled={busy} onClick={() => act({ action: "UPDATE", description, meterReading, mechanics: chosen }, "O.S. atualizada.")}>Salvar alterações</button></div>}

          <section className="fleet-form-section">
            <div className="fleet-section-title"><h3>Peças e produtos ({moneyFormat.format(order.partsTotal)})</h3></div>
            <div className="table-scroll">
              <table className="wo-items-table">
                <thead><tr><th title="Data de lançamento desta peça">Data</th><th>Produto</th><th>Qtd.</th><th title="Quem retirou a peça · onde foi aplicada">Retirado por</th><th>Valor</th>{editable && <th>Ações</th>}</tr></thead>
                <tbody>{order.items.map((item) => (
                  <tr key={item.id} className={item.removedAt ? "stock-row-reversed" : ""}>
                    <td>{brDay(item.launchDate)}<small className="table-sub">lançado por {item.launchedBy ?? "—"}</small></td>
                    <td><strong>{item.tag}</strong><small className="table-sub">{item.name}</small></td>
                    <td>{qtyFormat.format(item.quantity)}{item.removedAt && <small className="table-sub">retirada</small>}</td>
                    <td>{item.withdrawnBy}{item.application && <small className="table-sub">Aplicação: {item.application}</small>}</td>
                    <td>{item.total === null ? "—" : moneyFormat.format(item.total)}{item.unitPrice !== null && <small className="table-sub">{moneyFormat.format(item.unitPrice)} un.</small>}</td>
                    {editable && <td>{!item.removedAt && <div className="equipment-row-actions"><button onClick={() => removeItem(item)}>Retirar</button></div>}</td>}
                  </tr>
                ))}</tbody>
              </table>
              {order.items.length === 0 && <div className="empty-state">Nenhuma peça lançada.</div>}
            </div>
            {editable && <AddItemForm order={order} currentUser={currentUser} added={async (message) => { flash(message); await Promise.all([load(), changed()]); }} />}
          </section>

          <section className="fleet-form-section">
            <div className="fleet-section-title"><h3>Trocas de óleo vinculadas</h3></div>
            {order.oilChanges.length === 0 ? <p className="stock-summary">Nenhuma troca de óleo vinculada. Pelo QR Code do equipamento, a troca vem vinculada à última O.S. automaticamente.</p> : (
              <div className="table-scroll"><table className="wo-oil-table"><thead><tr><th>Data</th><th>Troca</th><th>Quem fez</th><th>Leitura</th></tr></thead>
                <tbody>{order.oilChanges.map((item) => <tr key={item.id}><td>{brDateTime(item.performedAt)}</td><td>{item.service}</td><td>{item.mechanic ?? "—"}</td><td>{item.km !== null ? `${qtyFormat.format(item.km)} km` : item.hours !== null ? `${qtyFormat.format(item.hours)} h` : "—"}</td></tr>)}</tbody>
              </table></div>
            )}
          </section>
          {order.closingNotes && <p className="stock-summary">Observação do fechamento: {order.closingNotes}</p>}
        </>}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer>
        <button type="button" onClick={close}>Fechar janela</button>
        {order && canClose && order.status === "OPEN" && <button className="primary" disabled={busy} onClick={() => { const notes = window.prompt("Observação do fechamento (opcional):") ?? undefined; if (notes !== undefined) act({ action: "CLOSE", notes }); }}>FECHAR O.S.</button>}
        {order && canClose && order.status === "CLOSED" && <button className="secondary" disabled={busy} onClick={() => act({ action: "REOPEN" })}>Reabrir O.S.</button>}
      </footer>
    </section></div>
  );
}

function AddItemForm({ order, currentUser, added }: { order: OrderDetail; currentUser: string; added: (message: string) => Promise<void> }) {
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [quantity, setQuantity] = useState("");
  const [launchDate, setLaunchDate] = useState(localToday());
  const [withdrawn, setWithdrawn] = useState<{ name: string; employeeId: number | null }>({ name: "", employeeId: null });
  const [application, setApplication] = useState("");
  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(allowNegative = false) {
    setError("");
    if (!product) { setError("Escolha o produto."); return; }
    const withdrawnBy = withdrawn.name.trim();
    if (!withdrawnBy) { setError("Informe quem retirou a peça."); return; }
    setBusy(true);
    try {
      const result = await api<{ message: string }>(`/api/work-orders/${order.id}/items`, jsonBody("POST", {
        productId: product.id, quantity: parseQty(quantity), launchDate, withdrawnBy, withdrawnByEmployeeId: withdrawn.employeeId, application, allowNegative,
      }));
      setProduct(null); setQuantity(""); setApplication(""); setShortages([]);
      await added(result.message);
    } catch (problem) {
      if (problem instanceof ApiError && Array.isArray(problem.data.shortages)) setShortages(problem.data.shortages as Shortage[]);
      setError(problemText(problem, "Não foi possível lançar a peça."));
    } finally { setBusy(false); }
  }
  return (
    <div className="fleet-order-editor">
      <header><b>Lançar peça (sai do estoque de {order.front})</b></header>
      <div className="wo-add-item">
        <label>Produto *<ProductPicker value={product} frontId={order.serviceFrontId} onPick={setProduct} /></label>
        <label>Qtd. *<input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>Data *<input type="date" min={order.openedAt} max={localToday()} value={launchDate} onChange={(event) => setLaunchDate(event.target.value)} /></label>
        <label>Quem retirou *<PersonInput value={withdrawn} frontId={order.serviceFrontId} onChange={setWithdrawn} placeholder={`Funcionário ou nome (ex.: ${currentUser})`} /></label>
        <label>Aplicação<input value={application} onChange={(event) => setApplication(event.target.value)} placeholder="Motor, freio, hidráulico..." /></label>
        <button type="button" className="primary" disabled={busy} onClick={() => submit()}>{busy ? "..." : "Lançar"}</button>
      </div>
      {shortages.length > 0 && <ShortageNotice shortages={shortages} busy={busy} confirm={() => submit(true)} />}
      {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
    </div>
  );
}

// Nome de quem retirou: busca no cadastro de funcionários, mas aceita nome digitado (terceiro, visitante).
function PersonInput({ value, frontId, onChange, placeholder }: { value: { name: string; employeeId: number | null }; frontId: number; onChange: (value: { name: string; employeeId: number | null }) => void; placeholder: string }) {
  const [options, setOptions] = useState<EmployeeOption[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (value.employeeId || value.name.trim().length < 2) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<{ employees: EmployeeOption[] }>(`/api/employees/lookup?q=${encodeURIComponent(value.name.trim())}&serviceFrontId=${frontId}`).then((result) => setOptions(result.employees)).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [value, frontId]);
  return (
    <div className="material-product-picker">
      <input value={value.name} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} onChange={(event) => { onChange({ name: event.target.value, employeeId: null }); setOpen(true); }} />
      {open && options.length > 0 && <ul>{options.map((option) => <li key={option.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange({ name: option.name, employeeId: option.id }); setOpen(false); }}><b>{option.name}</b><small> · {option.jobTitle}</small></button></li>)}</ul>}
    </div>
  );
}
