"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- pré-visualização local (blob:) e fotos servidas por rota própria */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CHECKLIST_STATUS_LABELS, checklistStatus, validateChecklist, type ChecklistStatus } from "../lib/checklist-rules";
import { optimizePhoto } from "../lib/photo-client";
import { enqueueRequest } from "../lib/offline-queue";
import { reportNetworkFailure } from "../lib/connectivity";
import LoadWarning from "./LoadWarning";
import QueuedRequests from "./QueuedRequests";

type EquipmentOption = { id: number; prefix: string; type: string; model: string; front: string; readingUnit: "HOURS" | "KM" };
type Item = { id: number; label: string; blocking: boolean; photoRequired: boolean };
type Loaded = { equipmentId: number; prefix: string; readingUnit: "HOURS" | "KM"; template: { id: number; name: string; openWorkOrder: boolean; items: Item[] } | null; today: string; doneToday: Array<{ id: number; status: ChecklistStatus; operatorName: string | null; createdAt: string }> };
type Answer = { ok: boolean | null; comment: string; photo: { blob: Blob; url: string } | null };
type Props = { userId: number; equipment: EquipmentOption[]; assignedEquipmentId: number | null; manualOperator: boolean; canRegister: boolean; canViewAll: boolean; canManage: boolean; flash: (message: string) => void };

const TONE: Record<ChecklistStatus, string> = { OK: "green", PENDENCIA: "orange", BLOQUEADO: "red" };
const searchKey = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s.\-_/]+/g, "");

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(data.error ?? "A operação não pôde ser concluída.")), { data, status: response.status });
  return data as T;
}

// Controle Diário → Checklist pré-uso: preencher (operador), painel do dia (gestor) e modelos (admin).
export default function ChecklistView(props: Props) {
  const [view, setView] = useState<"fill" | "panel" | "templates">(props.canRegister ? "fill" : "panel");
  return <>
    {(props.canViewAll || props.canManage) && <div className="checklist-switch" role="tablist">
      {props.canRegister && <button type="button" className={view === "fill" ? "active" : ""} onClick={() => setView("fill")}>Preencher</button>}
      <button type="button" className={view === "panel" ? "active" : ""} onClick={() => setView("panel")}>Painel do dia</button>
      {props.canManage && <button type="button" className={view === "templates" ? "active" : ""} onClick={() => setView("templates")}>Modelos</button>}
    </div>}
    {props.canRegister && <QueuedRequests userId={props.userId} kind="CHECKLIST" title="Checklists guardados no celular" />}
    {view === "fill" && props.canRegister ? <ChecklistForm {...props} /> : view === "templates" && props.canManage ? <TemplatesPanel flash={props.flash} /> : <ChecklistPanel canSeeAll={props.canViewAll} />}
  </>;
}

function ChecklistForm({ userId, equipment, assignedEquipmentId, manualOperator, flash }: Props) {
  const [equipmentId, setEquipmentId] = useState<number | null>(assignedEquipmentId && equipment.some((item) => item.id === assignedEquipmentId) ? assignedEquipmentId : null);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [operatorName, setOperatorName] = useState("");
  const [reading, setReading] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: ChecklistStatus; message: string } | null>(null);
  const matches = useMemo(() => { const key = searchKey(query); return key ? equipment.filter((item) => searchKey(`${item.prefix} ${item.type} ${item.model}`).includes(key)).slice(0, 30) : []; }, [equipment, query]);
  const selected = equipment.find((item) => item.id === equipmentId) ?? null;

  useEffect(() => {
    setLoaded(null); setAnswers({}); setErrors({}); setError(""); setResult(null);
    if (!equipmentId) return;
    api<Loaded>(`/api/checklists?equipamento=${equipmentId}`).then(setLoaded).catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar o checklist."));
  }, [equipmentId]);

  const items = loaded?.template?.items ?? [];
  const answerList = items.map((item) => ({ itemId: item.id, ok: answers[item.id]?.ok ?? null, comment: answers[item.id]?.comment ?? "", hasPhoto: Boolean(answers[item.id]?.photo) }));
  const status = checklistStatus(items, answerList);
  const answered = answerList.filter((answer) => answer.ok !== null).length;
  const set = (itemId: number, change: Partial<Answer>) => setAnswers((current) => ({ ...current, [itemId]: { ...(current[itemId] ?? { ok: null, comment: "", photo: null }), ...change } }));
  const allOk = () => setAnswers((current) => Object.fromEntries(items.map((item) => { const previous = current[item.id] ?? { ok: null, comment: "", photo: null }; return [item.id, previous.ok === false ? previous : { ...previous, ok: true }]; })));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loaded?.template || !selected) return;
    const found = validateChecklist(items, answerList);
    setErrors(found);
    if (manualOperator && !operatorName.trim()) { setError("Informe o nome do operador."); return; }
    if (Object.keys(found).length) { setError("Confira os itens destacados."); return; }
    setBusy(true); setError("");
    const payload = JSON.stringify({ equipmentId: selected.id, checklistDate: loaded.today, operatorName: operatorName.trim() || null, meterReading: reading.trim() || null, notes: notes.trim() || null, clientRequestId: crypto.randomUUID(),
      answers: items.map((item) => ({ itemId: item.id, ok: answers[item.id]?.ok ?? null, comment: answers[item.id]?.comment ?? "" })) });
    const form = new FormData();
    form.set("payload", payload);
    for (const item of items) { const photo = answers[item.id]?.photo; if (photo && answers[item.id]?.ok === false) form.set(`photo_${item.id}`, photo.blob, `item-${item.id}.webp`); }
    try {
      const response = await api<{ status: ChecklistStatus; message: string }>("/api/checklists", { method: "POST", body: form });
      setResult(response); flash(response.message); setAnswers({}); setReading(""); setNotes("");
      setLoaded(await api<Loaded>(`/api/checklists?equipamento=${selected.id}`));
    } catch (problem) {
      const failure = problem as Error & { data?: { fields?: Record<number, string> }; status?: number };
      if (failure.data?.fields) setErrors(failure.data.fields);
      if (failure.status === undefined) {
        // Sem conexão: guarda no celular e envia sozinho quando o sinal voltar.
        reportNetworkFailure();
        const photos = items.filter((item) => answers[item.id]?.ok === false && answers[item.id]?.photo).map((item) => ({ field: `photo_${item.id}`, blob: answers[item.id]!.photo!.blob }));
        await enqueueRequest({ userId, kind: "CHECKLIST", url: "/api/checklists", method: "POST", body: payload, formField: "payload", photos, summary: `Checklist ${selected.prefix} · ${loaded.today.split("-").reverse().join("/")}` });
        setResult({ status, message: "Sem conexão: o checklist foi guardado no celular e será enviado quando o sinal voltar." });
        flash("Checklist guardado no celular para enviar depois."); setAnswers({});
      } else setError(failure.message);
    } finally { setBusy(false); }
  }

  return <form className="panel module-panel checklist-form" onSubmit={submit}>
    <div className="checklist-equipment">
      {selected ? <div className="checklist-selected"><b>{selected.prefix}</b><span>{selected.type} · {selected.model} · {selected.front}</span><button type="button" className="secondary" onClick={() => { setEquipmentId(null); setQuery(""); }}>Trocar</button></div>
        : <label className="checklist-search">Equipamento<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Digite o prefixo, tipo ou modelo (ex.: CM-19)" autoFocus />
          {matches.length > 0 && <ul>{matches.map((item) => <li key={item.id}><button type="button" onClick={() => setEquipmentId(item.id)}><b>{item.prefix}</b> {item.type} · {item.model}<small> · {item.front}</small></button></li>)}</ul>}</label>}
    </div>
    <LoadWarning message={error} />
    {loaded && !loaded.template && <div className="empty-state">Não há modelo de checklist cadastrado. Peça ao administrador para cadastrar os itens.</div>}
    {loaded?.doneToday.length ? <p className="table-sub">Hoje este equipamento já tem {loaded.doneToday.length} checklist(s): {loaded.doneToday.map((item) => `${item.operatorName ?? "—"} (${CHECKLIST_STATUS_LABELS[item.status]})`).join(", ")}.</p> : null}
    {result && <div className={`checklist-result ${TONE[result.status]}`}><b>{CHECKLIST_STATUS_LABELS[result.status]}</b><span>{result.message}</span></div>}
    {loaded?.template && items.length > 0 && <>
      <div className="checklist-head"><strong>{loaded.template.name}</strong><span>{answered}/{items.length} respondidos</span><button type="button" className="secondary" onClick={allOk}>Marcar os restantes como OK</button></div>
      <ol className="checklist-items">{items.map((item) => {
        const answer = answers[item.id];
        return <li key={item.id} className={`${answer?.ok === false ? "failed" : answer?.ok ? "ok" : ""} ${errors[item.id] ? "has-error" : ""}`}>
          <div className="checklist-item-head"><span>{item.label}{item.blocking && <em title="Se estiver Não OK, o equipamento não deve operar">bloqueia</em>}</span>
            <div className="daily-segmented" role="radiogroup" aria-label={item.label}>
              <button type="button" role="radio" aria-checked={answer?.ok === true} className={answer?.ok === true ? "active" : ""} onClick={() => set(item.id, { ok: true })}>OK</button>
              <button type="button" role="radio" aria-checked={answer?.ok === false} className={answer?.ok === false ? "active danger" : ""} onClick={() => set(item.id, { ok: false })}>Não OK</button>
            </div></div>
          {answer?.ok === false && <div className="checklist-item-fail">
            <input value={answer.comment} onChange={(event) => set(item.id, { comment: event.target.value })} placeholder="O que está errado?" maxLength={500} />
            <ChecklistPhoto photo={answer.photo} required={item.photoRequired} onChange={(photo) => set(item.id, { photo })} />
          </div>}
          {errors[item.id] && <small className="daily-error">{errors[item.id]}</small>}
        </li>;
      })}</ol>
      <div className="checklist-extra">
        {manualOperator && <label>Operador *<input value={operatorName} onChange={(event) => setOperatorName(event.target.value)} placeholder="Nome de quem vai operar" maxLength={120} /></label>}
        <label>{loaded.readingUnit === "KM" ? "KM atual" : "Horímetro atual"} (opcional)<input inputMode="decimal" value={reading} onChange={(event) => setReading(event.target.value)} /></label>
        <label className="full">Observações<input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} /></label>
      </div>
      <div className="modal-footer">
        {answered === items.length && <span className={`status-pill ${TONE[status]}`}>{CHECKLIST_STATUS_LABELS[status]}</span>}
        <button className="primary" disabled={busy || answered < items.length}>{busy ? "Enviando..." : "Enviar checklist"}</button>
      </div>
    </>}
  </form>;
}

function ChecklistPhoto({ photo, required, onChange }: { photo: Answer["photo"]; required: boolean; onChange: (photo: Answer["photo"]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function handle(file: File | undefined) {
    if (!file) return; setBusy(true);
    try { const blob = await optimizePhoto(file); onChange({ blob, url: URL.createObjectURL(blob) }); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  return <div className="checklist-photo">
    {photo ? <><img src={photo.url} alt="Foto do problema" /><button type="button" className="link-button" onClick={() => onChange(null)}>Remover</button></>
      : <button type="button" className="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Otimizando..." : `📷 Foto${required ? " *" : " (opcional)"}`}</button>}
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(event) => handle(event.target.files?.[0])} />
  </div>;
}

type PanelData = {
  date: string; canSeeAll: boolean; totals: { total: number; ok: number; pending: number; blocked: number; missing: number };
  rows: Array<{ id: number; prefix: string; type: string; front: string | null; status: ChecklistStatus; failedItems: number; operatorName: string | null; userName: string | null; workOrderNumber: string | null; notes: string | null; createdAt: string;
    failures: Array<{ id: number; label: string; blocking: boolean; comment: string | null; hasPhoto: boolean }> }>;
  missing: Array<{ id: number; prefix: string; type: string; front: string | null }>;
};

function ChecklistPanel({ canSeeAll }: { canSeeAll: boolean }) {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date()));
  const [status, setStatus] = useState("");
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<PanelData>(`/api/checklists?data=${date}${status ? `&situacao=${status}` : ""}${canSeeAll ? "" : "&meus=1"}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
  }, [date, status, canSeeAll]);
  useEffect(() => { load(); }, [load]);
  return <article className="panel module-panel checklist-panel">
    <div className="checklist-panel-filters"><label>Data<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option><option value="BLOQUEADO">Bloqueado</option><option value="PENDENCIA">Com pendência</option><option value="OK">Tudo OK</option></select></label></div>
    <LoadWarning message={error} />
    {data && <div className="checklist-totals"><span className="status-pill red">{data.totals.blocked} bloqueado(s)</span><span className="status-pill orange">{data.totals.pending} com pendência</span><span className="status-pill green">{data.totals.ok} OK</span>{data.canSeeAll && <span className="status-pill gray">{data.totals.missing} sem checklist</span>}</div>}
    {data?.rows.map((row) => <div key={row.id} className={`checklist-card ${TONE[row.status]}`}>
      <div className="checklist-card-head"><b>{row.prefix}</b><span>{row.type}{row.front ? ` · ${row.front}` : ""}</span><span className={`status-pill ${TONE[row.status]}`}>{CHECKLIST_STATUS_LABELS[row.status]}</span></div>
      <small className="table-sub">{row.operatorName ?? row.userName ?? "—"} · {new Date(row.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}{row.workOrderNumber ? ` · ${row.workOrderNumber}` : ""}{row.notes ? ` · ${row.notes}` : ""}</small>
      {row.failures.length > 0 && <ul>{row.failures.map((failure) => <li key={failure.id}><b>{failure.label}{failure.blocking ? " (bloqueia)" : ""}:</b> {failure.comment ?? "—"}{failure.hasPhoto && <a href={`/api/checklists/photo/${failure.id}`} target="_blank" rel="noreferrer"> ver foto</a>}</li>)}</ul>}
    </div>)}
    {data && data.rows.length === 0 && <div className="empty-state">Nenhum checklist nesta data.</div>}
    {data && data.missing.length > 0 && <div className="checklist-missing"><b>Trabalharam na última semana e estão sem checklist nesta data:</b> {data.missing.map((item) => item.prefix).join(", ")}</div>}
  </article>;
}

type Template = { id: number; name: string; equipmentType: string | null; openWorkOrder: boolean; active: boolean; items: Array<{ id: number; label: string; blocking: boolean; photoRequired: boolean }> };

function TemplatesPanel({ flash }: { flash: (message: string) => void }) {
  const [data, setData] = useState<{ templates: Template[]; equipmentTypes: string[] } | null>(null);
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setData(await api("/api/checklists/templates")); } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); } }, []);
  useEffect(() => { load(); }, [load]);
  if (editing) return <TemplateEditor template={editing === "new" ? null : editing} equipmentTypes={data?.equipmentTypes ?? []} cancel={() => setEditing(null)} saved={async (message) => { flash(message); setEditing(null); await load(); }} />;
  return <article className="panel module-panel checklist-panel">
    <LoadWarning message={error} />
    <p className="table-sub">O modelo padrão vale para todo tipo de equipamento sem modelo próprio. Crie um modelo por tipo (ex.: CAMINHÃO, ESCAVADEIRA) quando os itens forem diferentes.</p>
    {data?.templates.map((template) => <div key={template.id} className="checklist-card"><div className="checklist-card-head"><b>{template.name}</b><span>{template.equipmentType ?? "Padrão (todos os tipos)"}</span>{!template.active && <span className="status-pill gray">inativo</span>}<button type="button" className="link-button" onClick={() => setEditing(template)}>Editar</button></div>
      <small className="table-sub">{template.items.length} itens · {template.items.filter((item) => item.blocking).length} bloqueiam · {template.openWorkOrder ? "abre O.S. automaticamente" : "não abre O.S."}</small></div>)}
    <div className="modal-footer"><button type="button" className="primary" onClick={() => setEditing("new")}>+ Novo modelo</button></div>
  </article>;
}

function TemplateEditor({ template, equipmentTypes, cancel, saved }: { template: Template | null; equipmentTypes: string[]; cancel: () => void; saved: (message: string) => Promise<void> }) {
  const [name, setName] = useState(template?.name ?? "");
  const [equipmentType, setEquipmentType] = useState(template?.equipmentType ?? "");
  const [openWorkOrder, setOpenWorkOrder] = useState(template?.openWorkOrder ?? true);
  const [active, setActive] = useState(template?.active ?? true);
  const [items, setItems] = useState(template?.items.map((item) => ({ ...item, key: String(item.id) })) ?? [{ id: 0, key: "n1", label: "", blocking: false, photoRequired: true }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, change: Partial<(typeof items)[number]>) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item));
  const move = (index: number, delta: number) => setItems((current) => { const next = [...current]; const [item] = next.splice(index, 1); next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, item); return next; });
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ message: string }>(template ? `/api/checklists/templates/${template.id}` : "/api/checklists/templates", { method: template ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, equipmentType, openWorkOrder, active, items: items.map((item) => ({ id: item.id || null, label: item.label, blocking: item.blocking, photoRequired: item.photoRequired })) }) });
      await saved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  return <form className="panel module-panel checklist-panel checklist-editor" onSubmit={submit}>
    <div className="checklist-extra">
      <label>Nome<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <label>Tipo de equipamento<select value={equipmentType} onChange={(event) => setEquipmentType(event.target.value)}><option value="">Padrão (todos os tipos sem modelo próprio)</option>{equipmentTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
      <label className="checklist-check"><input type="checkbox" checked={openWorkOrder} onChange={(event) => setOpenWorkOrder(event.target.checked)} />Abrir O.S. automaticamente quando algum item estiver Não OK</label>
      <label className="checklist-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Modelo ativo</label>
    </div>
    <ol className="checklist-edit-items">{items.map((item, index) => <li key={item.key}>
      <input value={item.label} onChange={(event) => update(item.key, { label: event.target.value })} placeholder="Ex.: Nível do óleo do motor" maxLength={160} />
      <label className="checklist-check"><input type="checkbox" checked={item.blocking} onChange={(event) => update(item.key, { blocking: event.target.checked })} />Bloqueia</label>
      <label className="checklist-check"><input type="checkbox" checked={item.photoRequired} onChange={(event) => update(item.key, { photoRequired: event.target.checked })} />Foto obrigatória</label>
      <button type="button" className="link-button" onClick={() => move(index, -1)} aria-label="Subir">↑</button><button type="button" className="link-button" onClick={() => move(index, 1)} aria-label="Descer">↓</button>
      <button type="button" className="link-button" onClick={() => setItems((current) => current.filter((entry) => entry.key !== item.key))} aria-label="Remover item">Remover</button>
    </li>)}</ol>
    <button type="button" className="secondary" onClick={() => setItems((current) => [...current, { id: 0, key: `n${Date.now()}`, label: "", blocking: false, photoRequired: true }])}>+ Item</button>
    {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
    <div className="modal-footer"><button type="button" className="secondary" onClick={cancel}>Voltar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar modelo"}</button></div>
  </form>;
}
