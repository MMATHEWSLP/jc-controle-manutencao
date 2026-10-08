"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- fotos servidas por rota própria com permissão (link temporário) */
import { useCallback, useEffect, useState } from "react";
import { CONVOY_FLAG_LABELS, CONVOY_STATUS_LABELS, NO_PHOTO_LABELS, formatNumber, type ConvoyExitKind, type ConvoyFlag, type ConvoyStatus, type NoPhotoReason } from "../lib/convoy-rules";
import { FUEL_PURPOSES, FUEL_PURPOSE_LABELS, type FuelPurpose } from "../lib/third-party-rules";
import { PhotoLightbox, PhotoZoom, type PhotoItem } from "./PhotoViewer";
import { KIND_LABELS, ThirdPartyFormModal, ThirdPartyPicker, ThirdPartyVehiclePicker, ThirdPartyWorkerPicker, VehicleFormModal, WorkerFormModal, type ThirdPartyOption } from "./ThirdPartiesView";

type Front = { id: number; name: string };
type FuelType = { id: number; name: string };
type Item = {
  id: number; status: ConvoyStatus; recordedAt: string; recordDate: string; receivedAt: string; dateJustification: string | null;
  convoy: string | null; registeredBy: string | null; equipmentId: number | null; equipment: string; equipmentPlate: string | null; equipmentModel: string | null;
  serviceFrontId: number | null; front: string | null; fuelTypeId: number | null; operatorEmployeeId: number | null; operatorName: string;
  liters: number; reading: number | null; unit: "HOURS" | "KM" | null; lastReading: number | null; lastReadingDate: string | null; difference: number | null;
  // Saída para terceiros / Prestadores (nulos na Frota).
  exitKind: ConvoyExitKind; exitLabel: string; thirdPartyId: number | null; company: string | null; companyKind: keyof typeof KIND_LABELS | null; destination: "VEICULO" | "FUNCIONARIO" | null;
  thirdPartyVehicleId: number | null; vehiclePlate: string | null; vehicleDescription: string | null; tankCapacity: number | null; thirdPartyEmployeeId: number | null; workerName: string | null;
  purpose: FuelPurpose | null; purposeNote: string | null; purposeLabel: string | null; fullTank: boolean; pendingCompany: string | null; pendingVehicle: string | null; pendingEmployee: string | null;
  // Terceiro/Doações manual (sem cadastro): destino/descrição digitado pelo motorista.
  manual: boolean; description: string | null;
  consumption: { value: number; unit: string } | null; noPhoto: boolean; noPhotoReason: NoPhotoReason | null; noPhotoNote: string | null;
  hasMeterPhoto: boolean; hasPumpPhoto: boolean; photoTakenAt: string | null; latitude: number | null; longitude: number | null; gpsAccuracy: number | null; notes: string | null;
  flags: ConvoyFlag[]; warnings: Array<{ code: string; message: string }>; deviceWarnings: string[]; aiReading: number | null; aiStatus: string | null; aiCheckedAt: string | null;
  corrections: Array<{ campo?: string; de?: unknown; para?: unknown; por?: string; em?: string; origem?: string }>; correctionNote: string | null; rejectionReason: string | null;
  approvedBy: string | null; approvedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; fuelMovementId: number | null; readingUpdateNote: string | null;
};
type ListResponse = { records: Item[]; settings: { pumpPhotoRequired: boolean; aiPhotoCheck: boolean }; canConfigure: boolean; limit?: number };

// O erro leva os dados da resposta (ex.: confirm "TANK"/"OUTLIER" ou exception na leitura menor).
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(data.error ?? "A operação não pôde ser concluída.")), { data });
  return data as T;
}
const post = <T,>(url: string, body: unknown) => api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const unit = (value: "HOURS" | "KM" | null) => (value === "KM" ? "km" : value === "HOURS" ? "h" : "");
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const brDay = (value: string | null) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const mapsLink = (item: Item) => (item.latitude !== null && item.longitude !== null ? `https://www.google.com/maps?q=${item.latitude},${item.longitude}` : null);
const STATUS_FILTERS: Array<[string, string]> = [["ABERTOS", "Pendentes e correção"], ["PENDENTE", "Pendentes"], ["CORRECAO", "Correção pedida"], ["APROVADO", "Aprovados"], ["REJEITADO", "Rejeitados"], ["TODOS", "Todos"]];

// Combustível → Aprovação → Aprovar: abastecimentos lançados pelo motorista do comboio, pendentes até
// alguém conferir a foto e aprovar (só então viram saída de combustível e baixam o saldo).
export default function ConvoyApprovalView({ flash, onChanged }: { flash: (message: string) => void; onChanged: () => void }) {
  const [context, setContext] = useState<{ fronts: Front[]; fuelTypes: FuelType[] }>({ fronts: [], fuelTypes: [] });
  useEffect(() => { api<{ fronts: Front[]; fuelTypes: FuelType[] }>("/api/fuel/convoy/context").then(setContext).catch(() => undefined); }, []);
  const { fronts, fuelTypes } = context;
  const [status, setStatus] = useState("ABERTOS");
  const [frontId, setFrontId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ status });
      if (frontId) params.set("frontId", frontId); if (from) params.set("from", from); if (to) params.set("to", to);
      const result = await api<ListResponse>(`/api/fuel/convoy?${params.toString()}`);
      setData(result); setSelected([]);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao carregar."); }
    finally { setLoading(false); }
  }, [status, frontId, from, to]);
  useEffect(() => { void load(); }, [load]);
  const records = data?.records ?? [];
  const batchable = records.filter((item) => item.status === "PENDENTE" && item.flags.length === 0);
  const changed = async (message: string) => { flash(message); setOpen(null); await load(); onChanged(); };

  async function approveBatch() {
    if (!selected.length || !window.confirm(`Aprovar ${selected.length} abastecimento(s) sem etiqueta de alerta? Cada um baixa o saldo da frente do equipamento (origem Frente).`)) return;
    setBusy(true);
    try { const result = await post<{ message: string; skipped: Array<{ id: number; reason: string }> }>("/api/fuel/convoy", { action: "approve_batch", ids: selected }); await changed(result.message + (result.skipped.length ? ` ${result.skipped.map((item) => `#${item.id}: ${item.reason}`).join("; ")}` : "")); }
    catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível aprovar."); }
    finally { setBusy(false); }
  }

  return <section className="panel convoy-approval">
      <div className="convoy-approval-toolbar">
        <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}>{STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {fronts.length > 1 && <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
        <label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? "Carregando..." : "Atualizar"}</button>
        {batchable.length > 0 && <button className="primary" disabled={busy || !selected.length} onClick={() => void approveBatch()}>Aprovar selecionados ({selected.length})</button>}
      </div>
      {data?.canConfigure && <ConvoySettingsBox settings={data.settings} flash={flash} saved={load} />}
      {error && <div className="fleet-form-error">! {error}</div>}
      <div className="table-scroll"><table className="products-table convoy-approval-table">
        <thead><tr>
          <th>{batchable.length > 0 && <input type="checkbox" aria-label="Selecionar todos sem etiqueta" checked={selected.length > 0 && selected.length === batchable.length} onChange={(event) => setSelected(event.target.checked ? batchable.map((item) => item.id) : [])} />}</th>
          <th>Data/hora</th><th>Comboio · registrou</th><th>Equipamento / terceiro</th><th>Motorista / recebeu</th><th>Litros</th><th>Leitura × última</th><th>Foto</th><th>Etiquetas</th><th>Local</th><th>Situação</th><th></th>
        </tr></thead>
        <tbody>
          {records.map((item) => <tr key={item.id}>
            <td>{item.status === "PENDENTE" && item.flags.length === 0 && <input type="checkbox" aria-label={`Selecionar ${item.equipment}`} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />}</td>
            <td>{when(item.recordedAt)}{item.dateJustification && <small className="table-sub" title={item.dateJustification}>dia anterior</small>}</td>
            <td>{item.convoy ?? "—"}<small className="table-sub">{item.registeredBy}</small></td>
            <td>{item.exitKind !== "FROTA" && <span className={`fuel-type-pill ${item.exitKind === "PRESTADOR" ? "prestador" : "terceiros"}`}>{item.exitLabel}</span>}<b>{item.equipment}</b>{item.equipmentPlate && <small className="table-sub">{item.equipmentPlate}</small>}{item.purposeLabel && <small className="table-sub">Finalidade: {item.purposeLabel}</small>}<small className="table-sub">{item.front}</small></td>
            <td>{item.operatorName}</td>
            <td className="num"><b>{formatNumber(item.liters, 2)} L</b></td>
            <td>{item.reading !== null ? `${formatNumber(item.reading)} ${unit(item.unit)}` : "—"}<small className="table-sub">última {item.lastReading !== null ? formatNumber(item.lastReading) : "—"}{item.difference !== null ? ` · ${item.difference >= 0 ? "+" : ""}${formatNumber(item.difference)} ${unit(item.unit)}` : ""}</small>{item.consumption && <small className="table-sub">≈ {formatNumber(item.consumption.value, 2)} {item.consumption.unit}</small>}</td>
            <td>{item.hasMeterPhoto ? <img className="convoy-thumb" src={`/api/fuel/convoy/photo/${item.id}`} alt={`Medidor ${item.equipment}`} loading="lazy" onClick={() => setOpen(item)} /> : item.noPhoto ? <span className="convoy-tag SEM_FOTO">SEM FOTO</span> : <small className="table-sub">sem medidor</small>}</td>
            <td>{item.flags.map((flag) => <span key={flag} className={`convoy-tag ${flag}`} title={item.warnings.find((warning) => warning.code === flag)?.message}>{CONVOY_FLAG_LABELS[flag]}</span>)}{!item.flags.length && "—"}</td>
            <td>{mapsLink(item) ? <a href={mapsLink(item)!} target="_blank" rel="noopener noreferrer">Mapa</a> : "—"}</td>
            <td><span className={`convoy-status-pill ${item.status}`}>{CONVOY_STATUS_LABELS[item.status]}</span></td>
            <td><button className="secondary" onClick={() => setOpen(item)}>Abrir</button></td>
          </tr>)}
          {!records.length && <tr><td colSpan={12} className="empty-state">{loading ? "Carregando..." : "Nenhum abastecimento do comboio para estes filtros."}</td></tr>}
        </tbody>
      </table></div>
      {open && <ReviewModal item={open} fuelTypes={fuelTypes} fronts={fronts} close={() => setOpen(null)} changed={changed} flash={flash} reload={load} />}
  </section>;
}

const HISTORY_STATUS: Array<[string, string]> = [["TRATADOS", "Aprovados e rejeitados"], ["APROVADO", "Aprovados"], ["REJEITADO", "Rejeitados"], ["CORRECAO", "Correção pedida"], ["TODOS", "Todos"]];
type FilterOptions = { drivers: Array<{ id: number; label: string }>; convoys: Array<{ id: number; label: string }>; equipment: Array<{ id: number; label: string }> };
const todayFortaleza = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const photosOf = (item: Item): PhotoItem[] => [
  ...(item.hasMeterPhoto ? [{ src: `/api/fuel/convoy/photo/${item.id}`, label: `${item.equipment} · KM/horímetro` }] : []),
  ...(item.hasPumpPhoto ? [{ src: `/api/fuel/convoy/photo/${item.id}?tipo=bomba`, label: `${item.equipment} · bomba/totalizador` }] : []),
];

// Combustível → Aprovação → Histórico: os já tratados (aprovados e rejeitados; também correção pedida),
// com foto, quem registrou e quem aprovou/rejeitou, as correções feitas e exportação Excel/PDF.
// initialDriver: atalho "Ver histórico" do Motorista comboio (abre já filtrado, todo o período).
export function ConvoyHistoryView({ flash, initialDriver, onChanged }: { flash: (message: string) => void; initialDriver?: { id: number; name: string } | null; onChanged: () => void }) {
  const [context, setContext] = useState<{ fronts: Front[]; fuelTypes: FuelType[] }>({ fronts: [], fuelTypes: [] });
  const [options, setOptions] = useState<FilterOptions>({ drivers: [], convoys: [], equipment: [] });
  useEffect(() => {
    api<{ fronts: Front[]; fuelTypes: FuelType[] }>("/api/fuel/convoy/context").then(setContext).catch(() => undefined);
    api<FilterOptions>("/api/fuel/convoy/filters").then(setOptions).catch(() => undefined);
  }, []);
  const today = todayFortaleza();
  const [filters, setFilters] = useState({ from: initialDriver ? "" : `${today.slice(0, 7)}-01`, to: initialDriver ? "" : today, frontId: "", driver: initialDriver ? String(initialDriver.id) : "", convoy: "", equipment: "", status: "TRATADOS" });
  // O motorista escolhido pelo atalho aparece no filtro mesmo sem lançamento (ou antes da lista de opções chegar).
  const drivers = initialDriver && !options.drivers.some((item) => item.id === initialDriver.id) ? [{ id: initialDriver.id, label: initialDriver.name }, ...options.drivers] : options.drivers;
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Item | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[] | null>(null);
  const query = new URLSearchParams(Object.entries({ ...filters, order: "desc" }).filter(([, value]) => value)).toString();
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api<ListResponse>(`/api/fuel/convoy?${query}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao carregar."); }
    finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);
  const set = (key: keyof typeof filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const records = data?.records ?? [];
  const total = (status?: ConvoyStatus) => records.filter((item) => !status || item.status === status).reduce((sum, item) => sum + item.liters, 0);
  const changed = async (message: string) => { flash(message); setOpen(null); await load(); onChanged(); };
  const treated = (item: Item) => item.approvedBy ? <>{item.approvedBy}<small className="table-sub">aprovou {item.approvedAt ? when(item.approvedAt) : ""}</small></>
    : item.rejectedBy ? <>{item.rejectedBy}<small className="table-sub">rejeitou {item.rejectedAt ? when(item.rejectedAt) : ""}</small>{item.rejectionReason && <small className="table-sub" title={item.rejectionReason}>motivo: {item.rejectionReason}</small>}</>
    : item.correctionNote ? <small className="table-sub" title={item.correctionNote}>correção pedida: {item.correctionNote}</small> : "—";
  return <section className="panel convoy-approval">
    <div className="convoy-approval-toolbar">
      <label>De<input type="date" value={filters.from} onChange={(event) => set("from")(event.target.value)} /></label>
      <label>Até<input type="date" value={filters.to} onChange={(event) => set("to")(event.target.value)} /></label>
      {context.fronts.length > 1 && <label>Frente<select value={filters.frontId} onChange={(event) => set("frontId")(event.target.value)}><option value="">Todas</option>{context.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
      <label>Motorista do comboio<select value={filters.driver} onChange={(event) => set("driver")(event.target.value)}><option value="">Todos</option>{drivers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Comboio<select value={filters.convoy} onChange={(event) => set("convoy")(event.target.value)}><option value="">Todos</option>{options.convoys.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Equipamento<select value={filters.equipment} onChange={(event) => set("equipment")(event.target.value)}><option value="">Todos</option>{options.equipment.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Situação<select value={filters.status} onChange={(event) => set("status")(event.target.value)}>{HISTORY_STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="button" className="secondary" onClick={() => void load()} disabled={loading}>{loading ? "Carregando..." : "Atualizar"}</button>
      <a className="secondary convoy-export" href={`/api/fuel/convoy/export?formato=xlsx&${query}`}>⇩ Excel</a>
      <a className="secondary convoy-export" href={`/api/fuel/convoy/export?formato=pdf&${query}`}>⇩ PDF</a>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {data && <div className="fuel-daily-cards">
      <article className="gray"><span>Registros</span><strong>{records.length}</strong><small>{formatNumber(total(), 2)} L</small></article>
      <article className="green"><span>Aprovados</span><strong>{formatNumber(total("APROVADO"), 2)} L</strong><small>{records.filter((item) => item.status === "APROVADO").length} registro(s)</small></article>
      <article className="red"><span>Rejeitados</span><strong>{formatNumber(total("REJEITADO"), 2)} L</strong><small>{records.filter((item) => item.status === "REJEITADO").length} registro(s)</small></article>
      <article className="blue"><span>Com correção</span><strong>{records.filter((item) => item.corrections.length > 0).length}</strong><small>litros, leitura ou equipamento corrigidos</small></article>
    </div>}
    {data && records.length >= (data.limit ?? 500) && <p className="convoy-warning">Mostrando os {records.length} mais recentes. Refine os filtros ou exporte (até 5.000 linhas).</p>}
    <div className="table-scroll"><table className="products-table convoy-approval-table convoy-history-table">
      <thead><tr><th>Data/hora</th><th>Comboio · registrou</th><th>Equipamento / terceiro</th><th>Motorista / recebeu</th><th>Litros</th><th>Leitura</th><th>Foto</th><th>Situação</th><th>Aprovou / rejeitou</th><th>Correções</th><th></th></tr></thead>
      <tbody>
        {records.map((item) => <tr key={item.id}>
          <td>{when(item.recordedAt)}</td>
          <td>{item.convoy ?? "—"}<small className="table-sub">{item.registeredBy}</small></td>
          <td>{item.exitKind !== "FROTA" && <span className={`fuel-type-pill ${item.exitKind === "PRESTADOR" ? "prestador" : "terceiros"}`}>{item.exitLabel}</span>}<b>{item.equipment}</b><small className="table-sub">{item.front}</small></td>
          <td>{item.operatorName}</td>
          <td className="num"><b>{formatNumber(item.liters, 2)} L</b></td>
          <td>{item.reading !== null ? `${formatNumber(item.reading)} ${unit(item.unit)}` : "—"}</td>
          <td className="convoy-thumbs">{photosOf(item).length ? photosOf(item).map((photo, index) => <img key={photo.src} className="convoy-thumb" src={photo.src} alt={photo.label} loading="lazy" onClick={() => setPhotos([...photosOf(item).slice(index), ...photosOf(item).slice(0, index)])} />)
            : item.noPhoto ? <span className="convoy-tag SEM_FOTO">SEM FOTO</span> : <small className="table-sub">sem medidor</small>}</td>
          <td><span className={`convoy-status-pill ${item.status}`}>{CONVOY_STATUS_LABELS[item.status]}</span></td>
          <td>{treated(item)}</td>
          <td>{item.corrections.length ? <details className="convoy-history-corrections"><summary>{item.corrections.length} correção(ões)</summary><ul className="convoy-corrections">{item.corrections.map((change, index) => <li key={index}>{change.campo}: {String(change.de ?? "—")} → {String(change.para ?? "—")} · {change.por}{change.origem === "MOTORISTA" ? " (motorista)" : ""}</li>)}</ul></details> : "—"}</td>
          <td><button type="button" className="secondary" onClick={() => setOpen(item)}>Abrir</button></td>
        </tr>)}
        {!records.length && <tr><td colSpan={11} className="empty-state">{loading ? "Carregando..." : "Nenhum abastecimento do comboio para estes filtros."}</td></tr>}
      </tbody>
    </table></div>
    {open && <ReviewModal item={open} fuelTypes={context.fuelTypes} fronts={context.fronts} close={() => setOpen(null)} changed={changed} flash={flash} reload={load} />}
    {photos && <PhotoLightbox photos={photos} start={0} onClose={() => setPhotos(null)} />}
  </section>;
}

function ConvoySettingsBox({ settings, flash, saved }: { settings: ListResponse["settings"]; flash: (message: string) => void; saved: () => Promise<void> }) {
  const [info, setInfo] = useState<{ storage: string; assistantConfigured: boolean } | null>(null);
  useEffect(() => { api<{ storage: string; assistantConfigured: boolean }>("/api/fuel/convoy/settings").then(setInfo).catch(() => setInfo(null)); }, []);
  async function toggle(key: "pumpPhotoRequired" | "aiPhotoCheck", value: boolean) {
    try { const result = await api<{ message: string }>("/api/fuel/convoy/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) }); flash(result.message); await saved(); }
    catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
  }
  return <details className="fuel-import-note"><summary><b>Configuração do comboio</b> (administrador)</summary>
    <label><input type="checkbox" checked={settings.pumpPhotoRequired} onChange={(event) => void toggle("pumpPhotoRequired", event.target.checked)} /> Foto da bomba/totalizador obrigatória</label>
    <label><input type="checkbox" checked={settings.aiPhotoCheck} disabled={info ? !info.assistantConfigured : false} onChange={(event) => void toggle("aiPhotoCheck", event.target.checked)} /> Conferência automática da foto (Assistente JC lê o número e marca &quot;Foto diverge&quot;; nunca aprova sozinho){info && !info.assistantConfigured ? " — falta a chave do Assistente no servidor" : ""}</label>
    {info && <p>Fotos guardadas em: <b>{info.storage === "SUPABASE" ? "Supabase Storage (bucket privado, link temporário)" : "pasta privada do servidor (configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para usar o Supabase Storage)"}</b></p>}
  </details>;
}

type SearchOption = { id: number; label: string; detail: string };
function SearchPick({ label, value, kind, onPick }: { label: string; value: string; kind: "equipment" | "employees"; onPick: (option: SearchOption | null) => void }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOption[]>([]);
  useEffect(() => {
    if (query.trim().length < 2) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<{ equipment: Array<{ id: number; prefix: string; plate: string | null; model: string; front: string | null }>; employees: Array<{ id: number; name: string; jobTitle: string; front: string }> }>(`/api/fuel/convoy/options?q=${encodeURIComponent(query)}`)
        .then((result) => setOptions(kind === "equipment" ? result.equipment.map((item) => ({ id: item.id, label: item.prefix, detail: [item.model, item.plate, item.front].filter(Boolean).join(" · ") })) : result.employees.map((item) => ({ id: item.id, label: item.name, detail: `${item.jobTitle} · ${item.front}` }))))
        .catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, kind]);
  return <label>{label}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`${value} — digite para trocar`} />
    {options.length > 0 && <span className="daily-picker"><ul>{options.map((option) => <li key={option.id}><button type="button" onClick={() => { onPick(option); setQuery(option.label); setOptions([]); }}><b>{option.label}</b> <small>{option.detail}</small></button></li>)}</ul></span>}
  </label>;
}

type QuickCreate = { kind: "party" } | { kind: "vehicle" } | { kind: "worker" } | null;

function ReviewModal({ item, fuelTypes, fronts, close, changed, flash, reload }: { item: Item; fuelTypes: FuelType[]; fronts: Front[]; close: () => void; changed: (message: string) => Promise<void>; flash: (message: string) => void; reload: () => Promise<void> }) {
  const open = item.status === "PENDENTE" || item.status === "CORRECAO";
  const third = item.exitKind !== "FROTA";
  const manualItem = third && item.manual;
  const toWorker = third && !manualItem && item.destination === "FUNCIONARIO";
  const [descriptionText, setDescriptionText] = useState(item.description ?? "");
  const [photo, setPhoto] = useState<"meter" | "pump">(item.hasMeterPhoto ? "meter" : "pump");
  const [liters, setLiters] = useState(String(item.liters).replace(".", ","));
  const [reading, setReading] = useState(item.reading !== null ? String(item.reading).replace(".", ",") : "");
  const [equipment, setEquipment] = useState<SearchOption | null>(null);
  const [operator, setOperator] = useState<SearchOption | null>(null);
  const [stockLocation, setStockLocation] = useState<"FRENTE" | "PORTO">("FRENTE");
  const [fuelTypeId, setFuelTypeId] = useState(String(item.fuelTypeId ?? fuelTypes[0]?.id ?? ""));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Terceiros: vincular/cadastrar (CADASTRO PENDENTE), frente, tanque cheio, responsável e confirmações.
  const [parties, setParties] = useState<ThirdPartyOption[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [partyId, setPartyId] = useState<number | null>(item.thirdPartyId);
  const [vehicleId, setVehicleId] = useState<number | null>(item.thirdPartyVehicleId);
  const [workerId, setWorkerId] = useState<number | null>(item.thirdPartyEmployeeId);
  const [frontId, setFrontId] = useState(String(item.serviceFrontId ?? ""));
  const [fullTank, setFullTank] = useState(item.fullTank);
  const [receiver, setReceiver] = useState(item.operatorName);
  const [purpose, setPurpose] = useState<FuelPurpose | "">(item.purpose ?? "");
  const [purposeNote, setPurposeNote] = useState(item.purposeNote ?? "");
  const [askException, setAskException] = useState(false);
  const [readingException, setReadingException] = useState(false);
  const [creating, setCreating] = useState<QuickCreate>(null);
  const loadParties = useCallback(async () => {
    const result = await api<{ parties: ThirdPartyOption[]; canManage: boolean }>("/api/fuel/convoy/third-parties");
    setParties(result.parties); setCanManage(result.canManage);
    return result.parties;
  }, []);
  useEffect(() => { if (third && open && !manualItem) loadParties().catch(() => setError("Não foi possível carregar o cadastro de terceiros.")); }, [third, open, manualItem, loadParties]);
  const party = parties.find((entry) => entry.id === partyId) ?? null;
  const vehicle = party?.vehicles.find((entry) => entry.id === vehicleId) ?? null;
  const worker = party?.employees.find((entry) => entry.id === workerId) ?? null;
  const missing = third && !manualItem ? [
    !partyId ? `a empresa${item.pendingCompany ? ` "${item.pendingCompany}"` : ""}` : null,
    !toWorker && !vehicleId && item.pendingVehicle ? `o veículo "${item.pendingVehicle}"` : null,
    toWorker && !workerId ? `o funcionário${item.pendingEmployee ? ` "${item.pendingEmployee}"` : ""}` : null,
  ].filter(Boolean) : [];

  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { const result = await post<{ message: string }>(`/api/fuel/convoy/${item.id}`, body); await changed(result.message); }
    catch (problem) {
      const data = (problem as { data?: { confirm?: "TANK" | "OUTLIER"; exception?: boolean } }).data ?? {};
      const message = problem instanceof Error ? problem.message : "Não foi possível concluir.";
      // Mesmas confirmações do computador: passa do tanque / consumo fora da média.
      if (data.confirm && window.confirm(`${message}\n\nConfirmar e aprovar?`)) { setBusy(false); return act({ ...body, [data.confirm === "TANK" ? "confirmTank" : "confirmOutlier"]: true }); }
      if (data.exception) setAskException(true);
      setError(message);
    }
    finally { setBusy(false); }
  }
  const approve = () => act(manualItem ? {
    action: "approve", liters, stockLocation, fuelTypeId: Number(fuelTypeId) || undefined, note, serviceFrontId: Number(frontId) || undefined, operatorName: receiver, description: descriptionText,
  } : third ? {
    action: "approve", liters, ...(toWorker ? {} : { reading: reading === "" ? null : reading, fullTank }), stockLocation, fuelTypeId: Number(fuelTypeId) || undefined, note,
    serviceFrontId: Number(frontId) || undefined, thirdPartyId: partyId ?? undefined, thirdPartyVehicleId: toWorker ? undefined : vehicleId, thirdPartyEmployeeId: toWorker ? workerId ?? undefined : undefined,
    operatorName: receiver, ...(toWorker ? { purpose: purpose || undefined, purposeNote } : {}), readingException,
  } : {
    action: "approve", liters, reading: reading === "" ? null : reading, ...(equipment ? { equipmentId: equipment.id } : {}),
    ...(operator ? { operatorEmployeeId: operator.id } : {}), stockLocation, fuelTypeId: Number(fuelTypeId) || undefined, note,
  });
  const reject = () => { const reason = window.prompt("Motivo da rejeição (o motorista vai ver):"); if (reason?.trim()) void act({ action: "reject", reason }); };
  const askCorrection = () => { const text = window.prompt("O que o motorista precisa corrigir?"); if (text?.trim()) void act({ action: "request_correction", note: text }); };
  async function aiCheck() {
    setBusy(true);
    try { const result = await post<{ message: string }>(`/api/fuel/convoy/${item.id}`, { action: "ai_check" }); flash(result.message); await reload(); close(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Conferência indisponível."); }
    finally { setBusy(false); }
  }
  async function created(kind: "party" | "vehicle" | "worker", id: number, message: string) {
    setCreating(null); flash(message);
    await loadParties().catch(() => undefined);
    if (kind === "party") { setPartyId(id); setVehicleId(null); setWorkerId(null); }
    else if (kind === "vehicle") setVehicleId(id);
    else { setWorkerId(id); }
  }
  const photos: Array<PhotoItem & { key: "meter" | "pump" }> = [
    ...(item.hasMeterPhoto ? [{ key: "meter" as const, src: `/api/fuel/convoy/photo/${item.id}`, label: "Foto do KM/horímetro" }] : []),
    ...(item.hasPumpPhoto ? [{ key: "pump" as const, src: `/api/fuel/convoy/photo/${item.id}?tipo=bomba`, label: "Foto da bomba/totalizador" }] : []),
  ];
  const shown = photos.find((entry) => entry.key === photo) ?? photos[0];
  const [fullscreen, setFullscreen] = useState<number | null>(null);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal fuel-daily-modal" role="dialog" aria-label="Conferir abastecimento do comboio">
      <header><div><p className="eyebrow">COMBOIO{item.convoy ? ` · ${item.convoy}` : ""} · {third ? `${item.exitLabel.toUpperCase()} · ` : ""}{CONVOY_STATUS_LABELS[item.status].toUpperCase()}</p><h2>{item.equipment} · {formatNumber(item.liters, 2)} L</h2><span>{when(item.recordedAt)} · registrado por {item.registeredBy}{item.dateJustification ? ` · dia anterior: ${item.dateJustification}` : ""}</span></div><button onClick={close} aria-label="Fechar">×</button></header>
      <div className="fuel-daily-body convoy-review">
        <div>
          {(item.hasMeterPhoto || item.hasPumpPhoto) ? <>
            {item.hasMeterPhoto && item.hasPumpPhoto && <div className="main-tabs secondary-module-nav"><button className={photo === "meter" ? "active" : ""} onClick={() => setPhoto("meter")}>KM/horímetro</button><button className={photo === "pump" ? "active" : ""} onClick={() => setPhoto("pump")}>Bomba/totalizador</button></div>}
            {shown && <PhotoZoom key={shown.src} src={shown.src} alt={shown.label} onExpand={() => setFullscreen(photos.indexOf(shown))} />}
          </> : item.noPhoto ? <div className="convoy-typed">SEM FOTO<small>{item.noPhotoReason ? NO_PHOTO_LABELS[item.noPhotoReason] : "—"}{item.noPhotoNote ? ` · ${item.noPhotoNote}` : ""}</small></div>
            : <div className="convoy-typed">Sem medidor<small>{manualItem ? "Terceiro/Doações manual: sem leitura e sem foto do medidor." : toWorker ? "Destino funcionário: sem leitura e sem foto do medidor." : "Sem veículo: sem leitura."}</small></div>}
          {mapsLink(item) && <p><a href={mapsLink(item)!} target="_blank" rel="noopener noreferrer">📍 Ver localização no mapa</a>{item.gpsAccuracy !== null ? ` (±${Math.round(item.gpsAccuracy)} m)` : ""}</p>}
        </div>
        <div className="convoy-review-data">
          {!toWorker && !manualItem && <div className="convoy-typed">{item.reading !== null ? `${formatNumber(item.reading)} ${unit(item.unit)}` : "sem leitura"}<small>Digitado pelo motorista · última conhecida {item.lastReading !== null ? `${formatNumber(item.lastReading)} ${unit(item.unit)}${item.lastReadingDate ? ` (${brDay(item.lastReadingDate)})` : ""}` : "—"}{item.difference !== null ? ` · diferença ${formatNumber(item.difference)} ${unit(item.unit)}` : ""}{item.consumption ? ` · consumo estimado ${formatNumber(item.consumption.value, 2)} ${item.consumption.unit}` : ""}{third && item.tankCapacity ? ` · tanque ${formatNumber(item.tankCapacity)} L` : ""}</small>{item.aiStatus && <small>Assistente: {item.aiStatus === "CONFERE" ? "foto confere" : item.aiStatus === "DIVERGE" ? `foto mostra ${formatNumber(item.aiReading ?? 0)}` : item.aiStatus === "ILEGIVEL" ? "número ilegível na foto" : "conferência falhou"}</small>}</div>}
          {item.flags.length > 0 && <p>{item.flags.map((flag) => <span key={flag} className={`convoy-tag ${flag}`}>{CONVOY_FLAG_LABELS[flag]}</span>)}</p>}
          {/* Em aberto, o CADASTRO PENDENTE aparece no quadro de vincular/cadastrar logo abaixo. */}
          {item.warnings.some((warning) => !(open && warning.code === "CADASTRO_PENDENTE")) && <ul className="convoy-warnings">{item.warnings.filter((warning) => !(open && warning.code === "CADASTRO_PENDENTE")).map((warning) => <li key={warning.code}>⚠ {warning.message}</li>)}</ul>}
          {manualItem ? <p className="table-sub">Tipo: <b>{item.exitLabel}</b> (manual) · Destino/descrição: <b>{item.description}</b> · Responsável que recebeu: <b>{item.operatorName}</b> · Frente: <b>{item.front ?? "—"}</b>{item.notes ? ` · Obs.: ${item.notes}` : ""}</p>
            : third ? <p className="table-sub">Tipo: <b>{item.exitLabel}</b> · Empresa: <b>{item.company ?? `${item.pendingCompany ?? "—"} (não cadastrada)`}</b>{item.companyKind ? ` (${KIND_LABELS[item.companyKind]})` : ""} · Destino: <b>{toWorker ? `Funcionário: ${item.workerName ?? `${item.pendingEmployee ?? "—"} (não cadastrado)`}` : `Veículo: ${item.vehiclePlate ?? (item.pendingVehicle ? `${item.pendingVehicle} (não cadastrado)` : "sem veículo")}`}</b>{item.purposeLabel ? ` · Finalidade: ${item.purposeLabel}` : ""}{!toWorker ? ` · ${item.fullTank ? "tanque cheio" : "tanque parcial"}` : ""} · Responsável que recebeu: <b>{item.operatorName}</b> · Frente: <b>{item.front ?? "—"}</b>{item.notes ? ` · Obs.: ${item.notes}` : ""}</p>
            : <p className="table-sub">Motorista/operador: <b>{item.operatorName}</b> · Frente: <b>{item.front ?? "—"}</b>{item.notes ? ` · Obs.: ${item.notes}` : ""}</p>}
          {item.correctionNote && <p className="convoy-warning">Correção pedida: {item.correctionNote}</p>}
          {item.rejectionReason && <p className="convoy-error">Rejeitado por {item.rejectedBy}: {item.rejectionReason}</p>}
          {item.approvedBy && <p className="table-sub">Aprovado por {item.approvedBy} em {item.approvedAt ? when(item.approvedAt) : "—"}. {item.readingUpdateNote}</p>}
          {open && manualItem && <>
            <label>Destino / descrição<input value={descriptionText} onChange={(event) => setDescriptionText(event.target.value)} /></label>
            <div className="convoy-row">
              <label>Litros<input inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} /></label>
              <label>Responsável que recebeu<input value={receiver} onChange={(event) => setReceiver(event.target.value)} /></label>
            </div>
            <div className="convoy-row">
              <label>Frente (saldo baixado)<select value={frontId} onChange={(event) => setFrontId(event.target.value)}>{!fronts.some((front) => String(front.id) === frontId) && <option value={frontId}>{item.front ?? "—"}</option>}{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
              <label>Origem<select value={stockLocation} onChange={(event) => setStockLocation(event.target.value as "FRENTE" | "PORTO")}><option value="FRENTE">Frente</option><option value="PORTO">Porto</option></select></label>
              <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            </div>
            <label>Observação da aprovação<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <small className="table-sub">Gravado como Combustível → Saída → Terceiro/Doações (manual, sem cadastro): baixa o saldo da frente e fica fora da média de consumo.</small>
          </>}
          {open && third && !manualItem && <>
            {missing.length > 0 && <div className="convoy-pending-box"><b>CADASTRO PENDENTE</b><span>Antes de aprovar, vincule a um cadastro existente{canManage ? " ou cadastre" : " (cadastrar exige a permissão de Terceiros)"}: {missing.join(", ")}.</span></div>}
            <label>Empresa{item.exitKind === "PRESTADOR" ? " (prestadora ou terceirizada)" : ""}
              <ThirdPartyPicker options={parties} kinds={item.exitKind === "PRESTADOR" ? ["PRESTADOR", "TERCEIRIZADA"] : undefined} value={party} onPick={(option) => { setPartyId(option?.id ?? null); setVehicleId(null); setWorkerId(null); }} placeholder={item.pendingCompany ? `Digitado: ${item.pendingCompany} — buscar no cadastro` : undefined} />
              {canManage && !party && <button type="button" className="link-button" onClick={() => setCreating({ kind: "party" })}>+ Cadastrar empresa{item.pendingCompany ? ` "${item.pendingCompany}"` : ""}</button>}
            </label>
            {toWorker ? <>
              <label>Funcionário da empresa<ThirdPartyWorkerPicker workers={party?.employees ?? []} value={worker} onPick={(option) => setWorkerId(option?.id ?? null)} disabled={!party} />
                {canManage && party && !worker && <button type="button" className="link-button" onClick={() => setCreating({ kind: "worker" })}>+ Cadastrar funcionário{item.pendingEmployee ? ` "${item.pendingEmployee}"` : ""}</button>}
              </label>
              <div className="convoy-row">
                <label>Finalidade<select value={purpose} onChange={(event) => setPurpose(event.target.value as FuelPurpose | "")}><option value="">Escolha...</option>{FUEL_PURPOSES.map((value) => <option key={value} value={value}>{FUEL_PURPOSE_LABELS[value]}</option>)}</select></label>
                {purpose === "OUTROS" && <label>Descrição<input value={purposeNote} onChange={(event) => setPurposeNote(event.target.value)} /></label>}
              </div>
            </> : <label>Veículo/máquina{party?.kind === "PESSOA_FISICA" ? " (opcional para pessoa física)" : ""}<ThirdPartyVehiclePicker vehicles={party?.vehicles ?? []} value={vehicle} onPick={(option) => setVehicleId(option?.id ?? null)} disabled={!party} />
              {canManage && party && !vehicle && <button type="button" className="link-button" onClick={() => setCreating({ kind: "vehicle" })}>+ Cadastrar veículo{item.pendingVehicle ? ` "${item.pendingVehicle}"` : ""}</button>}
            </label>}
            <div className="convoy-row">
              <label>Litros<input inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} /></label>
              {!toWorker && <label>Leitura{vehicle ? ` (${vehicle.meterType === "KM" ? "km" : "h"})` : ""}<input inputMode="decimal" value={reading} onChange={(event) => setReading(event.target.value)} /></label>}
            </div>
            {!toWorker && <label className="convoy-check"><input type="checkbox" checked={fullTank} onChange={(event) => setFullTank(event.target.checked)} /> Tanque cheio</label>}
            <label>Responsável que recebeu<input value={receiver} list="convoy-receiver-options" onChange={(event) => setReceiver(event.target.value)} /><datalist id="convoy-receiver-options">{party?.employees.map((entry) => <option key={entry.id} value={entry.name} />)}</datalist></label>
            <div className="convoy-row">
              <label>Frente (saldo baixado)<select value={frontId} onChange={(event) => setFrontId(event.target.value)}>{!fronts.some((front) => String(front.id) === frontId) && <option value={frontId}>{item.front ?? "—"}</option>}{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
              <label>Origem<select value={stockLocation} onChange={(event) => setStockLocation(event.target.value as "FRENTE" | "PORTO")}><option value="FRENTE">Frente</option><option value="PORTO">Porto</option></select></label>
              <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            </div>
            {(askException || item.flags.includes("LEITURA_MENOR")) && !toWorker && <label className="convoy-check"><input type="checkbox" checked={readingException} onChange={(event) => setReadingException(event.target.checked)} /> Aceitar leitura menor que a última (exceção — escreva a justificativa na observação; só quem gerencia Terceiros)</label>}
            <label>Observação da aprovação<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <small className="table-sub">A saída é gravada como Combustível → Saída → {item.exitLabel}, com as mesmas regras do computador: baixa o saldo da frente e{toWorker ? " fica fora da média de consumo (destino funcionário)." : " atualiza a leitura e a média de consumo do veículo do terceiro."}</small>
          </>}
          {open && !third && <>
            <div className="convoy-row">
              <label>Litros<input inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} /></label>
              <label>Leitura ({unit(item.unit)})<input inputMode="decimal" value={reading} onChange={(event) => setReading(event.target.value)} /></label>
            </div>
            <SearchPick label="Equipamento" value={equipment?.label ?? item.equipment} kind="equipment" onPick={setEquipment} />
            <SearchPick label="Motorista/operador" value={operator?.label ?? item.operatorName} kind="employees" onPick={setOperator} />
            <div className="convoy-row">
              <label>Origem<select value={stockLocation} onChange={(event) => setStockLocation(event.target.value as "FRENTE" | "PORTO")}><option value="FRENTE">Frente {item.front ?? ""}</option><option value="PORTO">Porto {item.front ?? ""}</option></select></label>
              <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            </div>
            <label>Observação da aprovação<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <small className="table-sub">Corrigir litros, leitura, equipamento ou motorista fica registrado (valor original, novo, quem e quando). A saída é gravada como Combustível → Saída → Frota e só então baixa o saldo e atualiza a leitura.</small>
          </>}
          {item.corrections.length > 0 && <div><b>Correções</b><ul className="convoy-corrections">{item.corrections.map((change, index) => <li key={index}>{change.campo}: {String(change.de ?? "—")} → {String(change.para ?? "—")} · {change.por} · {change.em ? when(change.em) : ""}{change.origem === "MOTORISTA" ? " (motorista)" : ""}</li>)}</ul></div>}
          {error && <div className="fleet-form-error">! {error}</div>}
          <div className="convoy-actions">
            {item.hasMeterPhoto && item.reading !== null && <button className="secondary" disabled={busy} onClick={() => void aiCheck()}>Conferir foto (Assistente)</button>}
            {item.status === "PENDENTE" && <button className="secondary" disabled={busy} onClick={askCorrection}>Pedir correção</button>}
            {open && <button className="danger-action" disabled={busy} onClick={reject}>Rejeitar</button>}
            {open && <button className="primary" disabled={busy || missing.length > 0} title={missing.length ? `CADASTRO PENDENTE: ${missing.join(", ")}` : undefined} onClick={() => void approve()}>{busy ? "Gravando..." : "Aprovar"}</button>}
          </div>
        </div>
      </div>
    </section>
    {fullscreen !== null && <PhotoLightbox photos={photos} start={fullscreen} onClose={() => setFullscreen(null)} />}
    {creating?.kind === "party" && <ThirdPartyFormModal item={null} fronts={fronts} defaultKind={item.exitKind === "PRESTADOR" ? "PRESTADOR" : "PESSOA_FISICA"} initialName={item.pendingCompany ?? undefined} close={() => setCreating(null)} saved={(id, message) => created("party", id, message)} />}
    {creating?.kind === "vehicle" && party && <VehicleFormModal thirdParty={party} item={null} fuelTypes={fuelTypes} initialPlate={item.pendingVehicle ?? undefined} close={() => setCreating(null)} saved={(id, message) => created("vehicle", id, message)} />}
    {creating?.kind === "worker" && party && <WorkerFormModal thirdParty={party} item={null} initialName={item.pendingEmployee ?? undefined} close={() => setCreating(null)} saved={(id, message) => created("worker", id, message)} />}
  </div>;
}

type Group = { key: string; label: string; records: number; liters: number; approvedLiters: number; pending: number; rejected: number; noPhoto: number };
type Report = {
  totals: { records: number; liters: number; approvedLiters: number; pendingLiters: number; approved: number; pending: number; rejected: number; noPhoto: number; noPhotoByReason: Record<string, number>; averageApprovalHours: number | null };
  byConvoy: Group[]; byDriver: Group[]; byEquipment: Group[]; byKind?: Group[]; byCompany?: Group[];
  options: { convoys: Array<{ id: number; label: string }>; drivers: Array<{ id: number; label: string }>; equipment: Array<{ id: number; label: string }> };
};

export function ConvoyReport() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [filters, setFilters] = useState({ from: `${today.slice(0, 7)}-01`, to: today, convoy: "", driver: "", equipment: "" });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    api<Report>(`/api/fuel/convoy/report?${params.toString()}`).then((result) => { setReport(result); setError(""); }).catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao gerar."));
  }, [filters]);
  const set = (key: keyof typeof filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const table = (title: string, rows: Group[]) => <div><h3>{title}</h3><div className="table-scroll"><table className="products-table"><thead><tr><th>{title.replace("Por ", "")}</th><th className="num">Registros</th><th className="num">Litros</th><th className="num">Aprovados (L)</th><th className="num">Pendentes</th><th className="num">Rejeitados</th><th className="num">Sem foto</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.key}><td><b>{row.label}</b></td><td className="num">{row.records}</td><td className="num">{formatNumber(row.liters, 2)}</td><td className="num">{formatNumber(row.approvedLiters, 2)}</td><td className="num">{row.pending}</td><td className="num">{row.rejected}</td><td className="num">{row.noPhoto}</td></tr>)}{!rows.length && <tr><td colSpan={7} className="empty-state">Sem registros.</td></tr>}</tbody></table></div></div>;
  return <section className="panel convoy-approval">
    <div className="convoy-approval-toolbar">
      <label>De<input type="date" value={filters.from} onChange={(event) => set("from")(event.target.value)} /></label>
      <label>Até<input type="date" value={filters.to} onChange={(event) => set("to")(event.target.value)} /></label>
      <label>Comboio<select value={filters.convoy} onChange={(event) => set("convoy")(event.target.value)}><option value="">Todos</option>{report?.options.convoys.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Motorista do comboio<select value={filters.driver} onChange={(event) => set("driver")(event.target.value)}><option value="">Todos</option>{report?.options.drivers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Equipamento<select value={filters.equipment} onChange={(event) => set("equipment")(event.target.value)}><option value="">Todos</option>{report?.options.equipment.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {report && <>
      <div className="fuel-daily-cards">
        <article className="gray"><span>Registros</span><strong>{report.totals.records}</strong></article>
        <article className="green"><span>Aprovados</span><strong>{formatNumber(report.totals.approvedLiters, 2)} L</strong><small>{report.totals.approved} registro(s)</small></article>
        <article className="blue"><span>Pendentes</span><strong>{formatNumber(report.totals.pendingLiters, 2)} L</strong><small>{report.totals.pending} registro(s)</small></article>
        <article className="red"><span>Rejeitados</span><strong>{report.totals.rejected}</strong></article>
        <article className="gray"><span>Sem foto</span><strong>{report.totals.noPhoto}</strong><small>{Object.entries(report.totals.noPhotoByReason).map(([reason, count]) => `${reason}: ${count}`).join(" · ") || "—"}</small></article>
        <article className="gray"><span>Tempo médio até aprovar</span><strong>{report.totals.averageApprovalHours !== null ? `${formatNumber(report.totals.averageApprovalHours, 1)} h` : "—"}</strong></article>
      </div>
      {table("Por tipo de saída", report.byKind ?? [])}
      {table("Por comboio", report.byConvoy)}
      {table("Por motorista do comboio", report.byDriver)}
      {table("Por equipamento / veículo de terceiro", report.byEquipment)}
      {(report.byCompany?.length ?? 0) > 0 && table("Por empresa (terceiros e prestadores)", report.byCompany!)}
    </>}
  </section>;
}
