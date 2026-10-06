"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- fotos servidas por rota própria com permissão (link temporário) */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { CONVOY_FLAG_LABELS, CONVOY_STATUS_LABELS, NO_PHOTO_LABELS, formatNumber, type ConvoyFlag, type ConvoyStatus, type NoPhotoReason } from "../lib/convoy-rules";

type Front = { id: number; name: string };
type FuelType = { id: number; name: string };
type Item = {
  id: number; status: ConvoyStatus; recordedAt: string; recordDate: string; receivedAt: string; dateJustification: string | null;
  convoy: string | null; registeredBy: string | null; equipmentId: number; equipment: string; equipmentPlate: string | null; equipmentModel: string | null;
  serviceFrontId: number | null; front: string | null; fuelTypeId: number | null; operatorEmployeeId: number | null; operatorName: string;
  liters: number; reading: number | null; unit: "HOURS" | "KM"; lastReading: number | null; lastReadingDate: string | null; difference: number | null;
  consumption: { value: number; unit: string } | null; noPhoto: boolean; noPhotoReason: NoPhotoReason | null; noPhotoNote: string | null;
  hasMeterPhoto: boolean; hasPumpPhoto: boolean; photoTakenAt: string | null; latitude: number | null; longitude: number | null; gpsAccuracy: number | null; notes: string | null;
  flags: ConvoyFlag[]; warnings: Array<{ code: string; message: string }>; deviceWarnings: string[]; aiReading: number | null; aiStatus: string | null; aiCheckedAt: string | null;
  corrections: Array<{ campo?: string; de?: unknown; para?: unknown; por?: string; em?: string; origem?: string }>; correctionNote: string | null; rejectionReason: string | null;
  approvedBy: string | null; approvedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; fuelMovementId: number | null; readingUpdateNote: string | null;
};
type ListResponse = { records: Item[]; settings: { pumpPhotoRequired: boolean; aiPhotoCheck: boolean }; canConfigure: boolean };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}
const post = <T,>(url: string, body: unknown) => api<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const unit = (value: "HOURS" | "KM") => (value === "KM" ? "km" : "h");
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const brDay = (value: string | null) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const mapsLink = (item: Item) => (item.latitude !== null && item.longitude !== null ? `https://www.google.com/maps?q=${item.latitude},${item.longitude}` : null);
const STATUS_FILTERS: Array<[string, string]> = [["ABERTOS", "Pendentes e correção"], ["PENDENTE", "Pendentes"], ["CORRECAO", "Correção pedida"], ["APROVADO", "Aprovados"], ["REJEITADO", "Rejeitados"], ["TODOS", "Todos"]];

// Setor ABASTECIMENTOS → Aprovação: abastecimentos lançados pelo motorista do comboio, pendentes até
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
          <th>Data/hora</th><th>Comboio · registrou</th><th>Equipamento</th><th>Motorista</th><th>Litros</th><th>Leitura × última</th><th>Foto</th><th>Etiquetas</th><th>Local</th><th>Situação</th><th></th>
        </tr></thead>
        <tbody>
          {records.map((item) => <tr key={item.id}>
            <td>{item.status === "PENDENTE" && item.flags.length === 0 && <input type="checkbox" aria-label={`Selecionar ${item.equipment}`} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />}</td>
            <td>{when(item.recordedAt)}{item.dateJustification && <small className="table-sub" title={item.dateJustification}>dia anterior</small>}</td>
            <td>{item.convoy ?? "—"}<small className="table-sub">{item.registeredBy}</small></td>
            <td><b>{item.equipment}</b>{item.equipmentPlate && <small className="table-sub">{item.equipmentPlate}</small>}<small className="table-sub">{item.front}</small></td>
            <td>{item.operatorName}</td>
            <td className="num"><b>{formatNumber(item.liters, 2)} L</b></td>
            <td>{item.reading !== null ? `${formatNumber(item.reading)} ${unit(item.unit)}` : "—"}<small className="table-sub">última {item.lastReading !== null ? formatNumber(item.lastReading) : "—"}{item.difference !== null ? ` · ${item.difference >= 0 ? "+" : ""}${formatNumber(item.difference)} ${unit(item.unit)}` : ""}</small>{item.consumption && <small className="table-sub">≈ {formatNumber(item.consumption.value, 2)} {item.consumption.unit}</small>}</td>
            <td>{item.hasMeterPhoto ? <img className="convoy-thumb" src={`/api/fuel/convoy/photo/${item.id}`} alt={`Medidor ${item.equipment}`} loading="lazy" onClick={() => setOpen(item)} /> : <span className="convoy-tag SEM_FOTO">SEM FOTO</span>}</td>
            <td>{item.flags.map((flag) => <span key={flag} className={`convoy-tag ${flag}`} title={item.warnings.find((warning) => warning.code === flag)?.message}>{CONVOY_FLAG_LABELS[flag]}</span>)}{!item.flags.length && "—"}</td>
            <td>{mapsLink(item) ? <a href={mapsLink(item)!} target="_blank" rel="noopener noreferrer">Mapa</a> : "—"}</td>
            <td><span className={`convoy-status-pill ${item.status}`}>{CONVOY_STATUS_LABELS[item.status]}</span></td>
            <td><button className="secondary" onClick={() => setOpen(item)}>Abrir</button></td>
          </tr>)}
          {!records.length && <tr><td colSpan={12} className="empty-state">{loading ? "Carregando..." : "Nenhum abastecimento do comboio para estes filtros."}</td></tr>}
        </tbody>
      </table></div>
      {open && <ReviewModal item={open} fuelTypes={fuelTypes} close={() => setOpen(null)} changed={changed} flash={flash} reload={load} />}
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

// Foto grande com zoom (roda do mouse, pinça/arrastar, botões).
function ZoomPhoto({ src, alt }: { src: string; alt: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const zoomAt = (next: number, px: number, py: number) => {
    const bounded = Math.min(6, Math.max(1, next));
    setOffset((current) => bounded === 1 ? { x: 0, y: 0 } : { x: px - (px - current.x) * (bounded / scale), y: py - (py - current.y) * (bounded / scale) });
    setScale(bounded);
  };
  const wheel = (event: ReactWheelEvent) => { const rect = box.current!.getBoundingClientRect(); zoomAt(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX - rect.left, event.clientY - rect.top); };
  const down = (event: ReactPointerEvent) => { drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; (event.target as Element).setPointerCapture?.(event.pointerId); };
  const move = (event: ReactPointerEvent) => { if (drag.current && scale > 1) setOffset({ x: drag.current.ox + event.clientX - drag.current.x, y: drag.current.oy + event.clientY - drag.current.y }); };
  const center = () => { const rect = box.current?.getBoundingClientRect(); return rect ? [rect.width / 2, rect.height / 2] as const : [0, 0] as const; };
  return <div>
    <div ref={box} className="convoy-zoom" onWheel={wheel} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
      <img src={src} alt={alt} draggable={false} style={{ width: "100%", transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
    </div>
    <div className="convoy-zoom-controls"><button type="button" className="secondary" onClick={() => zoomAt(scale * 1.5, ...center())}>＋ Zoom</button><button type="button" className="secondary" onClick={() => zoomAt(scale / 1.5, ...center())}>－</button><button type="button" className="secondary" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}>Ajustar</button><a className="secondary" href={src} target="_blank" rel="noopener noreferrer">Abrir em nova aba</a></div>
  </div>;
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

function ReviewModal({ item, fuelTypes, close, changed, flash, reload }: { item: Item; fuelTypes: FuelType[]; close: () => void; changed: (message: string) => Promise<void>; flash: (message: string) => void; reload: () => Promise<void> }) {
  const open = item.status === "PENDENTE" || item.status === "CORRECAO";
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
  async function act(body: Record<string, unknown>) {
    setBusy(true); setError("");
    try { const result = await post<{ message: string }>(`/api/fuel/convoy/${item.id}`, body); await changed(result.message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível concluir."); }
    finally { setBusy(false); }
  }
  const approve = () => act({
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
  const src = `/api/fuel/convoy/photo/${item.id}${photo === "pump" ? "?tipo=bomba" : ""}`;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal fuel-daily-modal" role="dialog" aria-label="Conferir abastecimento do comboio">
      <header><div><p className="eyebrow">COMBOIO{item.convoy ? ` · ${item.convoy}` : ""} · {CONVOY_STATUS_LABELS[item.status].toUpperCase()}</p><h2>{item.equipment} · {formatNumber(item.liters, 2)} L</h2><span>{when(item.recordedAt)} · registrado por {item.registeredBy}{item.dateJustification ? ` · dia anterior: ${item.dateJustification}` : ""}</span></div><button onClick={close} aria-label="Fechar">×</button></header>
      <div className="fuel-daily-body convoy-review">
        <div>
          {(item.hasMeterPhoto || item.hasPumpPhoto) ? <>
            {item.hasMeterPhoto && item.hasPumpPhoto && <div className="main-tabs secondary-module-nav"><button className={photo === "meter" ? "active" : ""} onClick={() => setPhoto("meter")}>KM/horímetro</button><button className={photo === "pump" ? "active" : ""} onClick={() => setPhoto("pump")}>Bomba/totalizador</button></div>}
            <ZoomPhoto key={src} src={src} alt={photo === "meter" ? "Foto do KM/horímetro" : "Foto da bomba"} />
          </> : <div className="convoy-typed">SEM FOTO<small>{item.noPhotoReason ? NO_PHOTO_LABELS[item.noPhotoReason] : "—"}{item.noPhotoNote ? ` · ${item.noPhotoNote}` : ""}</small></div>}
          {mapsLink(item) && <p><a href={mapsLink(item)!} target="_blank" rel="noopener noreferrer">📍 Ver localização no mapa</a>{item.gpsAccuracy !== null ? ` (±${Math.round(item.gpsAccuracy)} m)` : ""}</p>}
        </div>
        <div className="convoy-review-data">
          <div className="convoy-typed">{item.reading !== null ? `${formatNumber(item.reading)} ${unit(item.unit)}` : "sem leitura"}<small>Digitado pelo motorista · última conhecida {item.lastReading !== null ? `${formatNumber(item.lastReading)} ${unit(item.unit)}${item.lastReadingDate ? ` (${brDay(item.lastReadingDate)})` : ""}` : "—"}{item.difference !== null ? ` · diferença ${formatNumber(item.difference)} ${unit(item.unit)}` : ""}{item.consumption ? ` · consumo estimado ${formatNumber(item.consumption.value, 2)} ${item.consumption.unit}` : ""}</small>{item.aiStatus && <small>Assistente: {item.aiStatus === "CONFERE" ? "foto confere" : item.aiStatus === "DIVERGE" ? `foto mostra ${formatNumber(item.aiReading ?? 0)}` : item.aiStatus === "ILEGIVEL" ? "número ilegível na foto" : "conferência falhou"}</small>}</div>
          {item.warnings.length > 0 && <ul className="convoy-warnings">{item.warnings.map((warning) => <li key={warning.code}>⚠ {warning.message}</li>)}</ul>}
          <p className="table-sub">Motorista/operador: <b>{item.operatorName}</b> · Frente: <b>{item.front ?? "—"}</b>{item.notes ? ` · Obs.: ${item.notes}` : ""}</p>
          {item.correctionNote && <p className="convoy-warning">Correção pedida: {item.correctionNote}</p>}
          {item.rejectionReason && <p className="convoy-error">Rejeitado por {item.rejectedBy}: {item.rejectionReason}</p>}
          {item.approvedBy && <p className="table-sub">Aprovado por {item.approvedBy} em {item.approvedAt ? when(item.approvedAt) : "—"}. {item.readingUpdateNote}</p>}
          {open && <>
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
            {open && <button className="primary" disabled={busy} onClick={() => void approve()}>{busy ? "Gravando..." : "Aprovar"}</button>}
          </div>
        </div>
      </div>
    </section>
  </div>;
}

type Group = { key: string; label: string; records: number; liters: number; approvedLiters: number; pending: number; rejected: number; noPhoto: number };
type Report = {
  totals: { records: number; liters: number; approvedLiters: number; pendingLiters: number; approved: number; pending: number; rejected: number; noPhoto: number; noPhotoByReason: Record<string, number>; averageApprovalHours: number | null };
  byConvoy: Group[]; byDriver: Group[]; byEquipment: Group[];
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
      {table("Por comboio", report.byConvoy)}
      {table("Por motorista do comboio", report.byDriver)}
      {table("Por equipamento", report.byEquipment)}
    </>}
  </section>;
}
