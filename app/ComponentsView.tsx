"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BATTERY_POSITIONS, COMPONENT_STATUS_LABELS, EVENT_LABELS, TIRE_POSITIONS, unitLabel, type ComponentEventType, type ComponentKind, type ComponentStatus, type UsageUnit } from "../lib/component-rules";
import LoadWarning from "./LoadWarning";

type EquipmentOption = { id: number; prefix: string; type: string; front: string | null; unit: UsageUnit; currentReading: number };
type Item = {
  id: number; kind: ComponentKind; code: string; brand: string; model: string | null; size: string | null; purchaseDate: string | null; supplier: string | null; expectedLife: number | null;
  warrantyMonths: number | null; status: ComponentStatus; equipmentId: number | null; prefix: string | null; front: string | null; position: string | null; mountedAt: string | null;
  recapCount: number; lastTreadDepth: number | null; notes: string | null; usage: number; unit: UsageUnit; ageMonths: number | null; lifePercent: number | null;
  alert: { level: "red" | "orange"; text: string } | null; purchaseCost: number | null; totalCost: number | null; costPerUnit: number | null;
};
type Brand = { brand: string; model: string | null; unit: UsageUnit; count: number; discarded: number; usage: number; cost: number; costPerUnit: number | null; discardedCostPerUnit: number | null; averageLife: number | null };
type Data = { items: Item[]; equipment: EquipmentOption[]; canSeeCosts: boolean; canRegister: boolean; canManage: boolean; totals: { tires: number; batteries: number; mounted: number; stock: number; alerts: number }; brands: Brand[] };
type EventRow = { id: number; eventType: ComponentEventType; label: string; eventDate: string; prefix: string | null; position: string | null; fromPosition: string | null; reading: number | null; unit: UsageUnit | null; cost: number | null; treadDepth: number | null; notes: string | null; userName: string | null };

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
// Custo por km costuma ser centavos: 4 casas para dar para comparar marcas.
const perUnit = (value: number, unit: UsageUnit) => `${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)}/${unitLabel(unit)}`;
const num = (value: number | null, digits = 0) => value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const brDay = (day: string | null) => day ? day.split("-").reverse().join("/") : "—";
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
const STATUS_TONE: Record<ComponentStatus, string> = { STOCK: "blue", MOUNTED: "green", DISCARDED: "gray" };
const KIND_WORD: Record<ComponentKind, { one: string; many: string; code: string }> = { TIRE: { one: "pneu", many: "Pneus", code: "Nº de fogo" }, BATTERY: { one: "bateria", many: "Baterias", code: "Nº de série" } };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

// Equipamentos → Pneus e Baterias: cadastro, montagem/rodízio/recapagem/descarte e custo por km/hora.
export default function ComponentsView({ flash }: { flash: (message: string) => void }) {
  const [kind, setKind] = useState<ComponentKind | "BRANDS">("TIRE");
  const [status, setStatus] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [launching, setLaunching] = useState<Item | null>(null);
  const [history, setHistory] = useState<Item | null>(null);

  const load = useCallback(async () => {
    setError("");
    try { setData(await api<Data>("/api/components")); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => {
    if (!data || kind === "BRANDS") return [];
    const q = query.trim().toUpperCase();
    return data.items.filter((item) => item.kind === kind && (!status || (status === "ALERT" ? item.alert : item.status === status)) && (!equipmentId || item.equipmentId === Number(equipmentId))
      && (!q || `${item.code} ${item.brand} ${item.model ?? ""} ${item.size ?? ""} ${item.prefix ?? ""}`.toUpperCase().includes(q)));
  }, [data, kind, status, equipmentId, query]);
  const selectedEquipment = data?.equipment.find((item) => item.id === Number(equipmentId)) ?? null;
  const done = async (message: string) => { flash(message); setEditing(null); setLaunching(null); await load(); };

  function exportCsv() {
    if (!data) return;
    const cell = (value: unknown) => { const text = value === null || value === undefined ? "" : typeof value === "number" ? value.toLocaleString("pt-BR") : String(value); return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const header = ["Tipo", "Número", "Marca", "Modelo", "Medida", "Situação", "Equipamento", "Posição", "Uso", "Unidade", "Vida usada (%)", "Recapagens", "Último sulco (mm)", "Idade (meses)", ...(data.canSeeCosts ? ["Custo total", "Custo por km/h"] : [])];
    const lines = data.items.map((item) => [item.kind === "TIRE" ? "Pneu" : "Bateria", item.code, item.brand, item.model, item.size, COMPONENT_STATUS_LABELS[item.status], item.prefix, item.position, item.usage, unitLabel(item.unit), item.lifePercent, item.recapCount, item.lastTreadDepth, item.ageMonths,
      ...(data.canSeeCosts ? [item.totalCost, item.costPerUnit] : [])].map(cell).join(";"));
    const blob = new Blob([`﻿${[header.join(";"), ...lines].join("\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `pneus-baterias-${today()}.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">FROTA PRÓPRIA</p><h1>Pneus e baterias</h1><span>Cada pneu (número de fogo) e bateria com a sua linha do tempo: montagem, rodízio, recapagem, conserto e descarte — e quanto custa por km/hora.</span></div>
      <div className="heading-actions">
        <button className="secondary" onClick={exportCsv} disabled={!data?.items.length}>Exportar CSV</button>
        {data?.canRegister && <button className="primary" onClick={() => setEditing("new")}>+ Cadastrar</button>}
      </div>
    </div>
    <LoadWarning message={error} />
    {data && <div className="metric-grid components-metrics">
      <div className="metric-card"><div><strong>{data.totals.tires}</strong><span>Pneus</span><small>{data.items.filter((item) => item.kind === "TIRE" && item.status === "MOUNTED").length} montados</small></div></div>
      <div className="metric-card"><div><strong>{data.totals.batteries}</strong><span>Baterias</span><small>{data.items.filter((item) => item.kind === "BATTERY" && item.status === "MOUNTED").length} instaladas</small></div></div>
      <div className="metric-card"><div><strong>{data.totals.stock}</strong><span>Em estoque</span><small>prontos para montar</small></div></div>
      <div className={`metric-card ${data.totals.alerts ? "red" : "green"}`}><div><strong>{data.totals.alerts}</strong><span>Com alerta</span><small>vida no fim, sulco baixo ou garantia vencida</small></div></div>
    </div>}
    <div className="checklist-switch" role="tablist">
      <button type="button" className={kind === "TIRE" ? "active" : ""} onClick={() => setKind("TIRE")}>Pneus</button>
      <button type="button" className={kind === "BATTERY" ? "active" : ""} onClick={() => setKind("BATTERY")}>Baterias</button>
      {data?.canSeeCosts && <button type="button" className={kind === "BRANDS" ? "active" : ""} onClick={() => setKind("BRANDS")}>Custo por marca</button>}
    </div>
    {kind === "BRANDS" ? <BrandsPanel brands={data?.brands ?? []} /> : <>
      <article className="panel module-panel components-filters">
        <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option><option value="MOUNTED">Montados</option><option value="STOCK">Em estoque</option><option value="DISCARDED">Descartados</option><option value="ALERT">Com alerta</option></select></label>
        <label>Equipamento<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Todos</option>{data?.equipment.map((item) => <option key={item.id} value={item.id}>{item.prefix} · {item.type}</option>)}</select></label>
        <label className="grow">Buscar<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Número, marca, medida ou prefixo" /></label>
      </article>
      {selectedEquipment && <EquipmentPositions equipment={selectedEquipment} items={data!.items.filter((item) => item.kind === kind && item.status === "MOUNTED" && item.equipmentId === selectedEquipment.id)} kind={kind} />}
      <article className="panel module-panel"><div className="table-scroll"><table className="components-table">
        <thead><tr><th>{KIND_WORD[kind].code}</th><th>Marca / modelo</th><th>Situação</th><th>Equipamento</th><th>Uso</th><th>Vida</th><th>{kind === "TIRE" ? "Sulco / recap." : "Idade"}</th>{data?.canSeeCosts && <><th>Custo total</th><th>Custo por km/h</th></>}<th /></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td><b>{item.code}</b>{item.alert && <span className={`status-pill ${item.alert.level}`}>{item.alert.text}</span>}</td>
          <td>{item.brand}{item.model ? ` ${item.model}` : ""}<small className="table-sub">{item.size ?? ""}</small></td>
          <td><span className={`status-pill ${STATUS_TONE[item.status]}`}>{COMPONENT_STATUS_LABELS[item.status]}</span></td>
          <td>{item.prefix ? <><b>{item.prefix}</b><small className="table-sub">posição {item.position} · desde {brDay(item.mountedAt)}</small></> : "—"}</td>
          <td>{item.usage > 0 ? `${num(item.usage)} ${unitLabel(item.unit)}` : "—"}</td>
          <td>{item.lifePercent === null ? <span className="table-sub">sem vida esperada</span> : <div className="components-life"><i style={{ width: `${Math.min(100, item.lifePercent)}%` }} className={item.lifePercent >= 100 ? "red" : item.lifePercent >= 90 ? "orange" : ""} /><span>{num(item.lifePercent, 1)}%</span></div>}</td>
          <td>{kind === "TIRE" ? <>{item.lastTreadDepth === null ? "—" : `${num(item.lastTreadDepth, 1)} mm`}<small className="table-sub">{item.recapCount} recapagem(ns)</small></> : item.ageMonths === null ? "—" : `${item.ageMonths} mes(es)`}</td>
          {data?.canSeeCosts && <><td>{item.totalCost === null ? "—" : money.format(item.totalCost)}</td><td>{item.costPerUnit === null ? "—" : perUnit(item.costPerUnit, item.unit)}</td></>}
          <td className="components-actions">
            {data?.canRegister && item.status !== "DISCARDED" && <button type="button" className="link-button" onClick={() => setLaunching(item)}>Lançar</button>}
            <button type="button" className="link-button" onClick={() => setHistory(item)}>Histórico</button>
            {data?.canManage && <button type="button" className="link-button" onClick={() => setEditing(item)}>Editar</button>}
          </td>
        </tr>)}</tbody>
      </table></div>
      {data && items.length === 0 && <div className="empty-state">{data.items.some((item) => item.kind === kind) ? "Nenhum item com estes filtros." : `Nenhum(a) ${KIND_WORD[kind].one} cadastrado(a). Use "+ Cadastrar".`}</div>}
      <p className="table-sub">Uso = soma dos períodos montado (leitura da montagem até a desmontagem/rodízio; o período atual vai até a última leitura do equipamento). {data?.canSeeCosts ? "Custo total = compra + recapagens + consertos." : ""}</p>
      </article>
    </>}
    {editing && data && <ComponentModal item={editing === "new" ? null : editing} kind={kind === "BATTERY" ? "BATTERY" : "TIRE"} canSeeCosts={data.canSeeCosts} canManage={data.canManage} close={() => setEditing(null)} saved={done} />}
    {launching && data && <EventModal item={launching} equipment={data.equipment} canSeeCosts={data.canSeeCosts} close={() => setLaunching(null)} saved={done} />}
    {history && data && <HistoryModal item={history} canManage={data.canManage} canSeeCosts={data.canSeeCosts} close={() => setHistory(null)} changed={async (message) => { flash(message); await load(); }} />}
  </>;
}

function EquipmentPositions({ equipment, items, kind }: { equipment: EquipmentOption; items: Item[]; kind: ComponentKind }) {
  const suggestions = kind === "TIRE" ? TIRE_POSITIONS : BATTERY_POSITIONS;
  const byPosition = new Map(items.map((item) => [(item.position ?? "").toUpperCase(), item]));
  const extra = items.filter((item) => !suggestions.includes((item.position ?? "").toUpperCase()));
  const used = suggestions.filter((position) => byPosition.has(position.toUpperCase()));
  return <article className="panel module-panel components-positions">
    <strong>{equipment.prefix} — {kind === "TIRE" ? "pneus montados" : "baterias instaladas"} ({items.length})</strong>
    <div>{[...used.map((position) => byPosition.get(position.toUpperCase())!), ...extra].map((item) => <span key={item.id} className={item.alert ? `alert-${item.alert.level}` : ""}><b>{item.position}</b>{item.code}<small>{item.brand} · {num(item.usage)} {unitLabel(item.unit)}</small></span>)}
      {items.length === 0 && <em>Nenhum item montado neste equipamento.</em>}</div>
  </article>;
}

function BrandsPanel({ brands }: { brands: Brand[] }) {
  return <article className="panel module-panel"><div className="table-scroll"><table>
    <thead><tr><th>Marca / modelo</th><th>Pneus com uso</th><th>Descartados</th><th>Uso total</th><th>Custo total</th><th>Custo por km/h (todos)</th><th>Custo por km/h (vida completa)</th><th>Vida média</th></tr></thead>
    <tbody>{brands.map((brand) => <tr key={`${brand.brand}|${brand.model}|${brand.unit}`}>
      <td><b>{brand.brand}</b><small className="table-sub">{brand.model ?? ""}</small></td><td>{brand.count}</td><td>{brand.discarded}</td><td>{num(brand.usage)} {unitLabel(brand.unit)}</td>
      <td>{money.format(brand.cost)}</td><td>{brand.costPerUnit === null ? "—" : perUnit(brand.costPerUnit, brand.unit)}</td>
      <td>{brand.discardedCostPerUnit === null ? "—" : perUnit(brand.discardedCostPerUnit, brand.unit)}</td><td>{brand.averageLife === null ? "—" : `${num(brand.averageLife)} ${unitLabel(brand.unit)}`}</td>
    </tr>)}</tbody>
  </table></div>
  {brands.length === 0 && <div className="empty-state">Ainda não há pneus com uso e custo para comparar.</div>}
  <p className="table-sub">Ordenado do menor para o maior custo por km/hora. “Vida completa” considera só os pneus já descartados — é a comparação mais justa entre marcas.</p></article>;
}

function Modal({ eyebrow, title, subtitle, close, children }: { eyebrow: string; title: string; subtitle?: string; close: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal components-modal">
      <header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button onClick={close} aria-label="Fechar">×</button></header>
      {children}
    </section>
  </div>;
}

function ComponentModal({ item, kind: initialKind, canSeeCosts, canManage, close, saved }: { item: Item | null; kind: ComponentKind; canSeeCosts: boolean; canManage: boolean; close: () => void; saved: (message: string) => Promise<void> }) {
  const [kind, setKind] = useState<ComponentKind>(item?.kind ?? initialKind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await api<{ message: string }>(item ? `/api/components/${item.id}` : "/api/components", { method: item ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, kind }) });
      await saved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!item || !window.confirm(`Excluir ${KIND_WORD[item.kind].one} ${item.code}? Use só para cadastro feito por engano; para o fim da vida útil, lance "Descarte".`)) return;
    setBusy(true); setError("");
    try { await saved((await api<{ message: string }>(`/api/components/${item.id}`, { method: "DELETE" })).message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível excluir."); }
    finally { setBusy(false); }
  }
  return <Modal eyebrow="PNEUS E BATERIAS" title={item ? `Editar ${KIND_WORD[item.kind].one} ${item.code}` : "Cadastrar pneu ou bateria"} close={close}>
    <form className="modal-body components-form" onSubmit={submit}>
      {!item && <div className="checklist-switch full" role="tablist"><button type="button" className={kind === "TIRE" ? "active" : ""} onClick={() => setKind("TIRE")}>Pneu</button><button type="button" className={kind === "BATTERY" ? "active" : ""} onClick={() => setKind("BATTERY")}>Bateria</button></div>}
      <label>{KIND_WORD[kind].code} *<input name="code" defaultValue={item?.code ?? ""} required maxLength={40} placeholder={kind === "TIRE" ? "Ex.: 0153" : "Ex.: MB150-2291"} /></label>
      <label>Marca *<input name="brand" defaultValue={item?.brand ?? ""} required maxLength={60} placeholder={kind === "TIRE" ? "Ex.: MICHELIN" : "Ex.: MOURA"} /></label>
      <label>Modelo<input name="model" defaultValue={item?.model ?? ""} maxLength={60} placeholder={kind === "TIRE" ? "Ex.: X MULTI Z" : "Ex.: 12MF150"} /></label>
      <label>{kind === "TIRE" ? "Medida" : "Capacidade"}<input name="size" defaultValue={item?.size ?? ""} maxLength={40} placeholder={kind === "TIRE" ? "Ex.: 295/80 R22.5" : "Ex.: 150 Ah"} /></label>
      <label>Data da compra<input type="date" name="purchaseDate" defaultValue={item?.purchaseDate ?? ""} max={today()} /></label>
      {canSeeCosts && <label>Valor de compra (R$)<input name="purchaseCost" inputMode="decimal" defaultValue={item?.purchaseCost ?? ""} /></label>}
      <label>Fornecedor<input name="supplier" defaultValue={item?.supplier ?? ""} maxLength={120} /></label>
      <label>{kind === "TIRE" ? "Vida esperada (km ou horas)" : "Vida esperada (meses)"}<input name="expectedLife" inputMode="decimal" defaultValue={item?.expectedLife ?? ""} placeholder={kind === "TIRE" ? "Ex.: 80.000" : "Ex.: 24"} /></label>
      {kind === "BATTERY" && <label>Garantia (meses)<input name="warrantyMonths" inputMode="numeric" defaultValue={item?.warrantyMonths ?? ""} placeholder="Ex.: 12" /></label>}
      <label className="full">Observações<input name="notes" defaultValue={item?.notes ?? ""} maxLength={500} /></label>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full">
        {item && canManage && <button type="button" className="danger-action" onClick={remove} disabled={busy}>Excluir</button>}
        <button type="button" className="secondary" onClick={close}>Cancelar</button>
        <button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
      </div>
    </form>
  </Modal>;
}

function eventOptions(item: Item): ComponentEventType[] {
  const tire = item.kind === "TIRE";
  if (item.status === "MOUNTED") return [...(tire ? ["ROTATE" as const] : []), "UNMOUNT", "INSPECTION", "REPAIR", "DISCARD"];
  return ["MOUNT", ...(tire ? ["RECAP" as const] : []), "INSPECTION", "REPAIR", "DISCARD"];
}

function EventModal({ item, equipment, canSeeCosts, close, saved }: { item: Item; equipment: EquipmentOption[]; canSeeCosts: boolean; close: () => void; saved: (message: string) => Promise<void> }) {
  const options = eventOptions(item);
  const [eventType, setEventType] = useState<ComponentEventType>(options[0]);
  const [equipmentId, setEquipmentId] = useState("");
  const target = eventType === "MOUNT" ? equipment.find((entry) => entry.id === Number(equipmentId)) ?? null : equipment.find((entry) => entry.id === item.equipmentId) ?? null;
  const [reading, setReading] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setReading(target ? String(target.currentReading) : ""); }, [target?.id, eventType]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsReading = eventType === "MOUNT" || eventType === "ROTATE" || eventType === "UNMOUNT" || (eventType === "DISCARD" && item.status === "MOUNTED");
  const needsPosition = eventType === "MOUNT" || eventType === "ROTATE";
  const hasCost = eventType === "RECAP" || eventType === "REPAIR";
  const labels = EVENT_LABELS[item.kind];
  const unit = target?.unit ?? item.unit;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await api<{ message: string }>(`/api/components/${item.id}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, eventType, equipmentId: equipmentId || null, reading: needsReading ? reading : null }) });
      await saved(`${labels[eventType]} de ${KIND_WORD[item.kind].one} ${item.code}: ${result.message.toLowerCase()}`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível registrar."); }
    finally { setBusy(false); }
  }
  return <Modal eyebrow={`${item.kind === "TIRE" ? "PNEU" : "BATERIA"} ${item.code}`} title="Novo lançamento" subtitle={item.status === "MOUNTED" ? `Montado no ${item.prefix} (posição ${item.position}).` : COMPONENT_STATUS_LABELS[item.status]} close={close}>
    <form className="modal-body components-form" onSubmit={submit}>
      <div className="components-event-types full">{options.map((option) => <button key={option} type="button" className={eventType === option ? "active" : ""} onClick={() => setEventType(option)}>{labels[option]}</button>)}</div>
      <label>Data<input type="date" name="eventDate" defaultValue={today()} max={today()} required /></label>
      {eventType === "MOUNT" && <label>Equipamento *<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)} required><option value="">Escolha</option>{equipment.map((entry) => <option key={entry.id} value={entry.id}>{entry.prefix} · {entry.type}{entry.front ? ` · ${entry.front}` : ""}</option>)}</select></label>}
      {needsPosition && <label>{eventType === "ROTATE" ? "Nova posição *" : "Posição *"}<input name="position" list="component-positions" required maxLength={20} placeholder={item.kind === "TIRE" ? "Ex.: DE, TEI, ESTEPE" : "Ex.: BATERIA 1"} />
        <datalist id="component-positions">{(item.kind === "TIRE" ? TIRE_POSITIONS : BATTERY_POSITIONS).map((position) => <option key={position} value={position} />)}</datalist></label>}
      {needsReading && <label>{unit === "KM" ? "KM do equipamento *" : "Horímetro do equipamento *"}<input value={reading} onChange={(event) => setReading(event.target.value)} inputMode="decimal" required />{target && <small className="table-sub">Última leitura do {target.prefix}: {num(target.currentReading, 1)}</small>}</label>}
      {eventType === "INSPECTION" && item.kind === "TIRE" && <label>Sulco medido (mm) *<input name="treadDepth" inputMode="decimal" required placeholder="Ex.: 8,5" /></label>}
      {hasCost && canSeeCosts && <label>Custo (R$)<input name="cost" inputMode="decimal" /></label>}
      <label className="full">{eventType === "DISCARD" ? "Motivo do descarte *" : "Observações"}<input name="notes" maxLength={500} required={eventType === "DISCARD"} placeholder={eventType === "DISCARD" ? "Ex.: corte lateral, sem condições de recapagem" : ""} /></label>
      {item.kind === "TIRE" && eventType === "ROTATE" && <p className="table-sub full">A posição em que <b>{KIND_WORD[item.kind].one}</b> estava fica livre. Os abreviados: D = dianteiro, T = traseiro, E/D = esquerdo/direito, I/E = interno/externo (TEI = traseiro esquerdo interno).</p>}
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : `Registrar ${labels[eventType]?.toLowerCase()}`}</button></div>
    </form>
  </Modal>;
}

function HistoryModal({ item, canManage, canSeeCosts, close, changed }: { item: Item; canManage: boolean; canSeeCosts: boolean; close: () => void; changed: (message: string) => Promise<void> }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setEvents((await api<{ events: EventRow[] }>(`/api/components/${item.id}`)).events); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
  }, [item.id]);
  useEffect(() => { load(); }, [load]);
  async function undo(event: EventRow) {
    if (!window.confirm(`Desfazer "${event.label}" de ${brDay(event.eventDate)}?`)) return;
    try { await changed((await api<{ message: string }>(`/api/components/${item.id}/events/${event.id}`, { method: "DELETE" })).message); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível desfazer."); }
  }
  const last = events?.[events.length - 1];
  return <Modal eyebrow={`${item.kind === "TIRE" ? "PNEU" : "BATERIA"} · ${item.brand}${item.model ? ` ${item.model}` : ""}`} title={`Histórico de ${item.code}`} subtitle={`${COMPONENT_STATUS_LABELS[item.status]}${item.prefix ? ` no ${item.prefix} (${item.position})` : ""} · uso ${num(item.usage)} ${unitLabel(item.unit)}${item.purchaseDate ? ` · comprado em ${brDay(item.purchaseDate)}` : ""}`} close={close}>
    <div className="modal-body">
      <LoadWarning message={error} />
      {events && <ol className="components-timeline">{events.map((event) => <li key={event.id}>
        <span>{brDay(event.eventDate)}</span>
        <div><b>{event.label}</b>{event.prefix && <> · {event.prefix}</>}{event.fromPosition && <> · {event.fromPosition} → {event.position}</>}{!event.fromPosition && event.position && event.eventType === "MOUNT" && <> · posição {event.position}</>}
          <small className="table-sub">{[event.reading !== null ? `leitura ${num(event.reading, 1)} ${event.unit ? unitLabel(event.unit) : ""}` : null, event.treadDepth !== null ? `sulco ${num(event.treadDepth, 1)} mm` : null, canSeeCosts && event.cost ? money.format(event.cost) : null, event.notes, event.userName].filter(Boolean).join(" · ")}</small></div>
        {canManage && event === last && <button type="button" className="link-button" onClick={() => undo(event)}>Desfazer</button>}
      </li>)}</ol>}
      {events && events.length === 0 && <div className="empty-state">Nenhum lançamento ainda. Use &quot;Lançar&quot; para registrar a montagem.</div>}
    </div>
  </Modal>;
}
