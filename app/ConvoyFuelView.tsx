"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- pré-visualização local (blob:) da foto tirada no celular */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkOnline, CONNECTIVITY_EVENT, isKnownOnline } from "../lib/connectivity";
import {
  CONVOY_QUEUE_EVENT, CONVOY_SENT_EVENT, discardConvoy, enqueueConvoy, listConvoyQueue, loadCatalog, loadMyRecords, requestPersistentStorage, retryConvoy,
  saveCatalog, saveMyRecords, syncConvoyQueue, type ConvoyQueueItem,
} from "../lib/convoy-offline";
import { currentPosition, stampLines, stampPhoto, type GpsPosition } from "../lib/convoy-photo";
import {
  CONVOY_STATUS_LABELS, convoyWarnings, formatNumber, fortalezaDay, matchesSearch, parseConvoyNumber, previousDay, validateConvoyPayload,
  type ConvoyStatus, type ConvoyUnit, type LitersStats, type NoPhotoReason,
} from "../lib/convoy-rules";

type CatalogEquipment = {
  id: number; prefix: string; code: string; plate: string | null; type: string; model: string; serviceFrontId: number | null; front: string; unit: ConvoyUnit;
  lastReading: number | null; lastReadingDate: string | null; lastOperator: { employeeId: number | null; name: string } | null; litersStats: LitersStats | null; avgPerDay: number | null;
};
type CatalogEmployee = { id: number; name: string; jobTitle: string; serviceFrontId: number; front: string };
type Catalog = {
  generatedAt: string; today: string; userId: number; convoy: { id: number; prefix: string } | null; settings: { pumpPhotoRequired: boolean };
  noPhotoReasons: Array<{ value: NoPhotoReason; label: string }>; equipment: CatalogEquipment[]; employees: CatalogEmployee[];
};
type MyRecord = {
  id: number; clientUuid: string; status: ConvoyStatus; equipment: string; operatorName: string; liters: number; reading: number | null; readingUnit: ConvoyUnit;
  recordedAt: string; recordDate: string; noPhoto: boolean; rejectionReason: string | null; correctionNote: string | null;
};
type Photo = { blob: Blob; url: string; takenAt: string; gps: GpsPosition | null };
type Operator = { employeeId: number | null; name: string };

const unitLabel = (unit: ConvoyUnit) => (unit === "KM" ? "KM" : "Horímetro");
const unitSuffix = (unit: ConvoyUnit) => (unit === "KM" ? "km" : "h");
const brDay = (value: string | null) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const brTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function ConvoyFuelView({ userId, flash }: { userId: number; flash: (message: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "missing">("loading");
  const [catalogError, setCatalogError] = useState("");
  const [online, setOnline] = useState(isKnownOnline());
  const [queue, setQueue] = useState<ConvoyQueueItem[]>([]);
  const [tab, setTab] = useState<"register" | "mine">("register");
  const [records, setRecords] = useState<MyRecord[] | null>(null);
  const [recordsSavedAt, setRecordsSavedAt] = useState<string | null>(null);

  const refreshQueue = useCallback(() => { listConvoyQueue(userId).then(setQueue).catch(() => setQueue([])); }, [userId]);
  const pending = queue.filter((item) => item.status !== "ENVIADO").length;

  // Cadastro: primeiro o guardado no celular; com internet, baixa de novo e guarda.
  const downloadCatalog = useCallback(async (manual = false) => {
    setCatalogError("");
    try {
      const response = await fetch("/api/fuel/convoy/field/catalog", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as Catalog & { error?: string };
      if (!response.ok || response.headers.get("X-Offline")) throw new Error(data.error ?? "Sem conexão.");
      await saveCatalog(data);
      setCatalog(data); setCatalogState("ready");
      if (manual) flash("Cadastro atualizado no celular.");
    } catch (problem) {
      if (manual) setCatalogError(problem instanceof Error ? problem.message : "Sem conexão.");
    }
  }, [flash]);
  const loadRecords = useCallback(async () => {
    try {
      const response = await fetch("/api/fuel/convoy/field/records", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { records?: MyRecord[] };
      if (!response.ok || response.headers.get("X-Offline") || !data.records) throw new Error("offline");
      await saveMyRecords(userId, data.records);
      setRecords(data.records); setRecordsSavedAt(new Date().toISOString());
    } catch {
      const saved = await loadMyRecords<MyRecord>(userId);
      if (saved) { setRecords(saved.records); setRecordsSavedAt(saved.savedAt); } else setRecords((current) => current ?? []);
    }
  }, [userId]);

  useEffect(() => {
    void requestPersistentStorage();
    loadCatalog<Catalog>(userId).then((saved) => { if (saved) { setCatalog(saved); setCatalogState("ready"); } }).finally(() => {
      void downloadCatalog().finally(() => setCatalogState((state) => (state === "loading" ? "missing" : state)));
    });
    void loadRecords();
    refreshQueue();
  }, [userId, downloadCatalog, loadRecords, refreshQueue]);

  // Envio automático: ao abrir, ao reconectar, ao voltar para o app e a cada 30 s.
  useEffect(() => {
    const sync = () => { void syncConvoyQueue(); };
    const onConnectivity = (event: Event) => { const value = Boolean((event as CustomEvent<boolean>).detail); setOnline(value); if (value) sync(); };
    const onVisible = () => { if (document.visibilityState === "visible") { void checkOnline().then((value) => { setOnline(value); if (value) sync(); }); } };
    const onSent = (event: Event) => { const sent = Number((event as CustomEvent<number>).detail); flash(`${sent} abastecimento(s) enviado(s) — aguardando aprovação.`); void loadRecords(); };
    window.addEventListener(CONVOY_QUEUE_EVENT, refreshQueue);
    window.addEventListener(CONNECTIVITY_EVENT, onConnectivity);
    window.addEventListener("online", sync);
    // Selo Offline na hora em que o sinal cai (o envio confere de novo com o servidor).
    const onOffline = () => setOnline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener(CONVOY_SENT_EVENT, onSent);
    document.addEventListener("visibilitychange", onVisible);
    void checkOnline().then((value) => { setOnline(value); if (value) sync(); });
    const timer = window.setInterval(() => { void checkOnline().then((value) => { setOnline(value); if (value) sync(); }); }, 30_000);
    return () => {
      window.removeEventListener(CONVOY_QUEUE_EVENT, refreshQueue); window.removeEventListener(CONNECTIVITY_EVENT, onConnectivity);
      window.removeEventListener("online", sync); window.removeEventListener("offline", onOffline); window.removeEventListener(CONVOY_SENT_EVENT, onSent);
      document.removeEventListener("visibilitychange", onVisible); window.clearInterval(timer);
    };
  }, [flash, loadRecords, refreshQueue]);

  // Aviso antes de sair do app com abastecimentos ainda não enviados.
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  return <section className="convoy-app">
    <header className="convoy-head">
      <div>
        <p className="eyebrow">COMBOIO{catalog?.convoy ? ` · ${catalog.convoy.prefix}` : ""}</p>
        <h1>Abastecimentos</h1>
        <span>{catalog ? `Cadastro do celular: ${brTime(catalog.generatedAt)}` : "Cadastro ainda não baixado"}</span>
      </div>
      <div className="convoy-status">
        <b className={`convoy-online ${online ? "on" : "off"}`}>{online ? "● Online" : "● Offline"}</b>
        {pending > 0 && <b className="convoy-pending">{pending} aguardando envio</b>}
        <button type="button" className="secondary" onClick={() => void downloadCatalog(true)} disabled={!online}>⟳ Atualizar cadastro</button>
      </div>
    </header>
    {catalogError && <p className="convoy-error">! {catalogError}</p>}
    <div className="convoy-tabs">
      <button type="button" className={tab === "register" ? "active" : ""} onClick={() => setTab("register")}>Registrar</button>
      <button type="button" className={tab === "mine" ? "active" : ""} onClick={() => { setTab("mine"); void loadRecords(); }}>Meus abastecimentos{records?.some((item) => item.status === "REJEITADO" || item.status === "CORRECAO") ? " ●" : ""}</button>
    </div>
    {catalogState === "loading" && !catalog ? <div className="page-loading"><span /><p>Carregando o cadastro...</p></div>
      : !catalog ? <div className="convoy-card"><strong>Cadastro não baixado neste celular.</strong><p>Conecte à internet uma vez e toque em &quot;Atualizar cadastro&quot; para poder registrar sem sinal.</p></div>
      : tab === "register" ? <ConvoyForm catalog={catalog} userId={userId} queue={queue} />
      : <MyRecords userId={userId} catalog={catalog} queue={queue} records={records} savedAt={recordsSavedAt} flash={flash} />}
  </section>;
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------
function PhotoButton({ label, photo, onPick, onClear, required }: { label: string; photo: Photo | null; onPick: (file: File) => void; onClear: () => void; required?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="convoy-photo">
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onPick(file); }} />
    {photo ? <div className="convoy-photo-preview"><img src={photo.url} alt={label} /><div><strong>✓ {label}</strong><small>{brTime(photo.takenAt)}{photo.gps ? " · com GPS" : " · sem GPS"}</small><button type="button" className="secondary" onClick={() => input.current?.click()}>Tirar de novo</button><button type="button" className="link-button" onClick={onClear}>Remover</button></div></div>
      : <button type="button" className={`convoy-camera ${required ? "required" : ""}`} onClick={() => input.current?.click()}>📷 {label}{required ? " *" : ""}</button>}
  </div>;
}

function ConvoyForm({ catalog, userId, queue }: { catalog: Catalog; userId: number; queue: ConvoyQueueItem[] }) {
  const [equipment, setEquipment] = useState<CatalogEquipment | null>(null);
  const [equipmentQuery, setEquipmentQuery] = useState("");
  const [operator, setOperator] = useState<Operator | null>(null);
  const [operatorQuery, setOperatorQuery] = useState("");
  const [liters, setLiters] = useState("");
  const [reading, setReading] = useState("");
  const [meterPhoto, setMeterPhoto] = useState<Photo | null>(null);
  const [pumpPhoto, setPumpPhoto] = useState<Photo | null>(null);
  const [noPhoto, setNoPhoto] = useState(false);
  const [noPhotoReason, setNoPhotoReason] = useState<NoPhotoReason | "">("");
  const [noPhotoNote, setNoPhotoNote] = useState("");
  const [notes, setNotes] = useState("");
  const [yesterday, setYesterday] = useState(false);
  const [justification, setJustification] = useState("");
  const [gps, setGps] = useState<GpsPosition | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { void currentPosition().then((position) => { if (position) setGps(position); }); const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);

  const today = fortalezaDay(now);
  const recordDate = yesterday ? previousDay(today) : today;
  const equipmentMatches = useMemo(() => equipmentQuery.trim() ? catalog.equipment.filter((item) => matchesSearch(equipmentQuery, item.prefix, item.code, item.plate, item.model, item.type)).slice(0, 8) : [], [catalog.equipment, equipmentQuery]);
  const operatorMatches = useMemo(() => operatorQuery.trim().length >= 2 ? catalog.employees.filter((item) => matchesSearch(operatorQuery, item.name)).slice(0, 8) : [], [catalog.employees, operatorQuery]);
  // Última leitura: a do cadastro ou a de um registro deste equipamento ainda guardado no celular (maior).
  const lastKnown = useMemo(() => {
    if (!equipment) return { value: null as number | null, date: null as string | null };
    let value = equipment.lastReading, date = equipment.lastReadingDate;
    for (const item of queue) {
      const payload = item.payload as { equipmentId?: number; reading?: number | null; recordDate?: string };
      if (item.kind === "NOVO" && payload.equipmentId === equipment.id && typeof payload.reading === "number" && (value === null || payload.reading > value)) { value = payload.reading; date = payload.recordDate ?? date; }
    }
    return { value, date };
  }, [equipment, queue]);
  const litersValue = parseConvoyNumber(liters);
  const readingValue = parseConvoyNumber(reading);
  const warnings = equipment && litersValue && litersValue > 0 ? convoyWarnings({
    liters: litersValue, reading: readingValue !== null && Number.isFinite(readingValue) ? readingValue : null, unit: equipment.unit,
    lastReading: lastKnown.value, lastReadingDate: lastKnown.date, recordDate, litersStats: equipment.litersStats, avgPerDay: equipment.avgPerDay,
  }) : [];

  function chooseEquipment(item: CatalogEquipment) {
    setEquipment(item); setEquipmentQuery("");
    // Sugere o último operador registrado no Controle Diário para este equipamento.
    if (item.lastOperator && !operator) {
      const person = item.lastOperator.employeeId ? catalog.employees.find((employee) => employee.id === item.lastOperator!.employeeId) : null;
      setOperator({ employeeId: person?.id ?? item.lastOperator.employeeId, name: person?.name ?? item.lastOperator.name });
    }
  }

  async function takePhoto(file: File, kind: "meter" | "pump") {
    setError("");
    try {
      const position = (await Promise.race([currentPosition(6000), new Promise<null>((resolve) => setTimeout(() => resolve(null), 6500))])) ?? gps;
      if (position) setGps(position);
      const takenAt = new Date();
      const lines = stampLines(takenAt, position, [equipment ? `Equip. ${equipment.prefix}` : "", catalog.convoy ? `Comboio ${catalog.convoy.prefix}` : ""]);
      const blob = await stampPhoto(file, lines);
      const photo = { blob, url: URL.createObjectURL(blob), takenAt: takenAt.toISOString(), gps: position };
      if (kind === "meter") { if (meterPhoto) URL.revokeObjectURL(meterPhoto.url); setMeterPhoto(photo); }
      else { if (pumpPhoto) URL.revokeObjectURL(pumpPhoto.url); setPumpPhoto(photo); }
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível usar a foto."); }
  }

  function clear() {
    if (meterPhoto) URL.revokeObjectURL(meterPhoto.url);
    if (pumpPhoto) URL.revokeObjectURL(pumpPhoto.url);
    setEquipment(null); setEquipmentQuery(""); setOperator(null); setOperatorQuery(""); setLiters(""); setReading(""); setMeterPhoto(null); setPumpPhoto(null);
    setNoPhoto(false); setNoPhotoReason(""); setNoPhotoNote(""); setNotes(""); setYesterday(false); setJustification("");
  }

  async function save() {
    setError(""); setSaved("");
    const clientUuid = crypto.randomUUID();
    const recordedAt = new Date().toISOString();
    const position = meterPhoto?.gps ?? pumpPhoto?.gps ?? gps;
    const payload = {
      clientUuid, equipmentId: equipment?.id ?? 0, operatorEmployeeId: operator?.employeeId ?? null, operatorName: operator?.name ?? "",
      liters: litersValue ?? NaN, reading: noPhoto && readingValue === null ? null : readingValue, recordedAt, recordDate,
      dateJustification: yesterday ? justification.trim() || null : null, noPhoto, noPhotoReason: noPhoto ? (noPhotoReason || null) as NoPhotoReason | null : null,
      noPhotoNote: noPhoto ? noPhotoNote.trim() || null : null, notes: notes.trim() || null,
      latitude: position?.latitude ?? null, longitude: position?.longitude ?? null, gpsAccuracy: position?.accuracy ?? null,
      photoTakenAt: meterPhoto?.takenAt ?? null, deviceLastReading: lastKnown.value, deviceWarnings: warnings.map((warning) => warning.code),
    };
    if (readingValue !== null && Number.isNaN(readingValue)) { setError("Leitura inválida: use só números."); return; }
    const problem = validateConvoyPayload(payload, { hasMeterPhoto: Boolean(meterPhoto) && !noPhoto, hasPumpPhoto: Boolean(pumpPhoto), pumpPhotoRequired: catalog.settings.pumpPhotoRequired, today });
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await enqueueConvoy({
        clientUuid, userId, kind: "NOVO", targetUuid: null, payload, meterPhoto: noPhoto ? null : meterPhoto?.blob ?? null, pumpPhoto: pumpPhoto?.blob ?? null,
        summary: { equipment: equipment!.prefix, liters: payload.liters, operator: payload.operatorName, reading: payload.reading, unit: equipment!.unit, noPhoto },
      });
      const prefix = equipment!.prefix;
      clear();
      setSaved(`Registrado — aguardando aprovação. ${prefix} · ${formatNumber(payload.liters, 2)} L${isKnownOnline() ? "" : " (será enviado quando houver sinal)"}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      void syncConvoyQueue();
    } catch {
      setError("Não foi possível guardar no celular. Libere espaço e tente de novo.");
    } finally { setBusy(false); }
  }

  return <div className="convoy-form">
    {saved && <div className="convoy-saved" role="status">✓ {saved}</div>}
    <div className="convoy-when">
      <span>{yesterday ? <>Data: <b>{brDay(recordDate)}</b> (dia anterior)</> : <>Hoje, <b>{now.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</b></>}</span>
      <button type="button" className="link-button" onClick={() => setYesterday(!yesterday)}>{yesterday ? "Voltar para hoje" : "Foi ontem?"}</button>
    </div>
    {yesterday && <label className="convoy-field">Justificativa (abastecimento de ontem) *<input value={justification} onChange={(event) => setJustification(event.target.value)} placeholder="Ex.: sem sinal e celular descarregado" /></label>}

    <div className="convoy-field">
      <span>Equipamento abastecido *</span>
      {equipment ? <div className="convoy-chosen"><div><strong>{equipment.prefix}</strong><small>{[equipment.model, equipment.plate, equipment.front].filter(Boolean).join(" · ")}</small></div><button type="button" className="secondary" onClick={() => { setEquipment(null); setReading(""); }}>Trocar</button></div>
        : <><input className="convoy-big" value={equipmentQuery} onChange={(event) => setEquipmentQuery(event.target.value)} placeholder="Código ou placa (ex.: PC20, CM-35)" autoComplete="off" />
          {equipmentQuery.trim() && <ul className="convoy-options">{equipmentMatches.map((item) => <li key={item.id}><button type="button" onClick={() => chooseEquipment(item)}><strong>{item.prefix}</strong><small>{[item.model, item.plate, item.front].filter(Boolean).join(" · ")}</small></button></li>)}
            {!equipmentMatches.length && <li className="convoy-empty">Nenhum equipamento encontrado no cadastro do celular.</li>}</ul>}</>}
    </div>

    <div className="convoy-field">
      <span>Motorista/operador do equipamento *</span>
      {operator ? <div className="convoy-chosen"><div><strong>{operator.name}</strong><small>{equipment?.lastOperator && equipment.lastOperator.name === operator.name ? "Último operador no Controle Diário" : operator.employeeId ? "Cadastro de funcionários" : ""}</small></div><button type="button" className="secondary" onClick={() => setOperator(null)}>Trocar</button></div>
        : <><input className="convoy-big" value={operatorQuery} onChange={(event) => setOperatorQuery(event.target.value)} placeholder="Nome do motorista/operador" autoComplete="off" />
          {equipment?.lastOperator && <button type="button" className="convoy-suggestion" onClick={() => { const person = equipment.lastOperator!.employeeId ? catalog.employees.find((item) => item.id === equipment.lastOperator!.employeeId) : null; setOperator({ employeeId: person?.id ?? null, name: person?.name ?? equipment.lastOperator!.name }); }}>Sugerido: {equipment.lastOperator.name}</button>}
          {operatorQuery.trim().length >= 2 && <ul className="convoy-options">{operatorMatches.map((item) => <li key={item.id}><button type="button" onClick={() => { setOperator({ employeeId: item.id, name: item.name }); setOperatorQuery(""); }}><strong>{item.name}</strong><small>{item.jobTitle} · {item.front}</small></button></li>)}
            {!operatorMatches.length && <li className="convoy-empty">Ninguém encontrado no cadastro do celular.</li>}</ul>}</>}
    </div>

    <div className="convoy-row">
      <label className="convoy-field">Litros *<input className="convoy-big" inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value.replace(/[^\d.,]/g, ""))} placeholder="0" /></label>
      <label className="convoy-field">{equipment ? unitLabel(equipment.unit) : "KM / Horímetro"}{noPhoto ? "" : " *"}
        <input className="convoy-big" inputMode="decimal" value={reading} onChange={(event) => setReading(event.target.value.replace(/[^\d.,]/g, ""))} placeholder={lastKnown.value !== null ? formatNumber(lastKnown.value) : "0"} />
        {equipment && <small>Última conhecida: {lastKnown.value !== null ? `${formatNumber(lastKnown.value)} ${unitSuffix(equipment.unit)}${lastKnown.date ? ` (${brDay(lastKnown.date)})` : ""}` : "—"}</small>}
      </label>
    </div>

    {!noPhoto && <PhotoButton label="Foto do KM/horímetro" photo={meterPhoto} required onPick={(file) => void takePhoto(file, "meter")} onClear={() => { if (meterPhoto) URL.revokeObjectURL(meterPhoto.url); setMeterPhoto(null); }} />}
    <label className="convoy-check"><input type="checkbox" checked={noPhoto} onChange={(event) => { setNoPhoto(event.target.checked); if (event.target.checked && meterPhoto) { URL.revokeObjectURL(meterPhoto.url); setMeterPhoto(null); } }} /><span>Sem foto do medidor</span></label>
    {noPhoto && <div className="convoy-reasons">
      {catalog.noPhotoReasons.map((reason) => <button key={reason.value} type="button" className={noPhotoReason === reason.value ? "active" : ""} onClick={() => setNoPhotoReason(reason.value)}>{reason.label}</button>)}
      {noPhotoReason === "OUTRO" && <input className="convoy-big" value={noPhotoNote} onChange={(event) => setNoPhotoNote(event.target.value)} placeholder="Qual o motivo?" />}
      <small>O registro vai com a etiqueta SEM FOTO. A leitura fica opcional.</small>
    </div>}
    <PhotoButton label={`Foto da bomba/totalizador${catalog.settings.pumpPhotoRequired ? "" : " (opcional)"}`} photo={pumpPhoto} required={catalog.settings.pumpPhotoRequired} onPick={(file) => void takePhoto(file, "pump")} onClear={() => { if (pumpPhoto) URL.revokeObjectURL(pumpPhoto.url); setPumpPhoto(null); }} />
    <label className="convoy-field">Observações<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} /></label>

    {warnings.length > 0 && <ul className="convoy-warnings">{warnings.map((warning) => <li key={warning.code}>⚠ {warning.message}</li>)}<li className="hint">Confira. Se estiver certo, pode salvar: vai com aviso para a aprovação.</li></ul>}
    {error && <p className="convoy-error">! {error}</p>}
    <button type="button" className="primary convoy-save" disabled={busy} onClick={() => void save()}>{busy ? "Guardando..." : "Salvar abastecimento"}</button>
    <p className="convoy-footnote">Fica guardado no celular e é enviado sozinho quando houver sinal. Só baixa o saldo de diesel da frente depois de aprovado.</p>
  </div>;
}

// ---------------------------------------------------------------------------
// Meus abastecimentos: fila do celular + status no servidor (rejeitado com motivo, correção pedida)
// ---------------------------------------------------------------------------
const QUEUE_LABEL: Record<ConvoyQueueItem["status"], string> = { PENDENTE_ENVIO: "Pendente de envio", ENVIADO: "Enviado", ERRO: "Com erro" };

function MyRecords({ userId, catalog, queue, records, savedAt, flash }: { userId: number; catalog: Catalog; queue: ConvoyQueueItem[]; records: MyRecord[] | null; savedAt: string | null; flash: (message: string) => void }) {
  const [correcting, setCorrecting] = useState<MyRecord | null>(null);
  const local = queue.filter((item) => item.status !== "ENVIADO" || !records?.some((record) => record.clientUuid === item.clientUuid));
  return <div className="convoy-list">
    {local.length > 0 && <><h3>No celular</h3>{local.map((item) => <article key={item.clientUuid} className={`convoy-item ${item.status === "ERRO" ? "error" : item.status === "ENVIADO" ? "ok" : "waiting"}`}>
      <header><strong>{item.kind === "CORRECAO" ? "Correção · " : ""}{item.summary.equipment} · {formatNumber(item.summary.liters, 2)} L</strong><span className="convoy-badge">{QUEUE_LABEL[item.status]}</span></header>
      <p>{item.summary.operator} · {item.summary.reading !== null ? `${formatNumber(item.summary.reading)} ${unitSuffix(item.summary.unit as ConvoyUnit)}` : "sem leitura"}{item.summary.noPhoto ? " · SEM FOTO" : ""} · {brTime(item.createdAt)}</p>
      {item.status === "ERRO" && <><p className="convoy-error">Não enviado: {item.error}</p><div className="convoy-actions"><button type="button" className="secondary" onClick={() => void retryConvoy(item.clientUuid).then(() => syncConvoyQueue())}>Tentar de novo</button><button type="button" className="danger-action" onClick={() => { if (window.confirm("Descartar este registro guardado no celular?")) void discardConvoy(item.clientUuid); }}>Descartar</button></div></>}
    </article>)}</>}
    <h3>Enviados{savedAt ? <small> · atualizado {brTime(savedAt)}</small> : null}</h3>
    {records === null ? <p>Carregando...</p> : !records.length ? <p className="convoy-empty">Nenhum abastecimento enviado nos últimos 45 dias.</p>
      : records.map((record) => <article key={record.id} className={`convoy-item ${record.status === "REJEITADO" ? "error" : record.status === "CORRECAO" ? "warning" : record.status === "APROVADO" ? "ok" : "waiting"}`}>
        <header><strong>{record.equipment} · {formatNumber(record.liters, 2)} L</strong><span className="convoy-badge">{CONVOY_STATUS_LABELS[record.status]}</span></header>
        <p>{record.operatorName} · {record.reading !== null ? `${formatNumber(record.reading)} ${unitSuffix(record.readingUnit)}` : "sem leitura"}{record.noPhoto ? " · SEM FOTO" : ""} · {brTime(record.recordedAt)}</p>
        {record.status === "REJEITADO" && <p className="convoy-error">Rejeitado: {record.rejectionReason}</p>}
        {record.status === "CORRECAO" && <><p className="convoy-warning">Correção pedida: {record.correctionNote}</p>
          {queue.some((item) => item.kind === "CORRECAO" && item.targetUuid === record.clientUuid && item.status !== "ENVIADO") ? <p>Correção guardada, aguardando envio.</p>
            : <button type="button" className="primary" onClick={() => setCorrecting(record)}>Corrigir</button>}</>}
      </article>)}
    {correcting && <CorrectionForm userId={userId} catalog={catalog} record={correcting} close={() => setCorrecting(null)} flash={flash} />}
  </div>;
}

function CorrectionForm({ userId, catalog, record, close, flash }: { userId: number; catalog: Catalog; record: MyRecord; close: () => void; flash: (message: string) => void }) {
  const [liters, setLiters] = useState(String(record.liters).replace(".", ","));
  const [reading, setReading] = useState(record.reading !== null ? String(record.reading).replace(".", ",") : "");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [error, setError] = useState("");
  async function pick(file: File) {
    const position = await currentPosition(6000);
    const takenAt = new Date();
    try {
      const blob = await stampPhoto(file, stampLines(takenAt, position, [`Equip. ${record.equipment}`, catalog.convoy ? `Comboio ${catalog.convoy.prefix}` : ""]));
      setPhoto({ blob, url: URL.createObjectURL(blob), takenAt: takenAt.toISOString(), gps: position });
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Foto inválida."); }
  }
  async function send() {
    const litersValue = parseConvoyNumber(liters), readingValue = parseConvoyNumber(reading);
    if (!litersValue || Number.isNaN(litersValue) || litersValue <= 0) { setError("Informe os litros."); return; }
    if (readingValue !== null && Number.isNaN(readingValue)) { setError("Leitura inválida."); return; }
    const clientUuid = crypto.randomUUID();
    await enqueueConvoy({
      clientUuid, userId, kind: "CORRECAO", targetUuid: record.clientUuid, payload: { liters: litersValue, reading: readingValue, note: note.trim(), answerId: clientUuid },
      meterPhoto: photo?.blob ?? null, pumpPhoto: null, summary: { equipment: record.equipment, liters: litersValue, operator: record.operatorName, reading: readingValue, unit: record.readingUnit, noPhoto: record.noPhoto && !photo },
    });
    flash("Correção guardada — será enviada para aprovação.");
    void syncConvoyQueue();
    close();
  }
  return <div className="convoy-card convoy-correction">
    <strong>Corrigir {record.equipment}</strong><p className="convoy-warning">{record.correctionNote}</p>
    <div className="convoy-row">
      <label className="convoy-field">Litros<input className="convoy-big" inputMode="decimal" value={liters} onChange={(event) => setLiters(event.target.value)} /></label>
      <label className="convoy-field">{unitLabel(record.readingUnit)}<input className="convoy-big" inputMode="decimal" value={reading} onChange={(event) => setReading(event.target.value)} /></label>
    </div>
    <PhotoButton label="Nova foto do KM/horímetro (opcional)" photo={photo} onPick={(file) => void pick(file)} onClear={() => setPhoto(null)} />
    <label className="convoy-field">Observação<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="O que foi corrigido" /></label>
    {error && <p className="convoy-error">! {error}</p>}
    <div className="convoy-actions"><button type="button" className="secondary" onClick={close}>Cancelar</button><button type="button" className="primary" onClick={() => void send()}>Enviar correção</button></div>
  </div>;
}
