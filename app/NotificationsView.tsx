"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventDef, EventSetting, NotificationLink } from "../lib/notification-events";
import { currentDeviceToken, disablePush, enablePush, pushSupport, PUSH_CHANGED_EVENT, syncPush, type PushSupport } from "../lib/push-client";
import { NOTIFICATIONS_CHANGED, notificationApi, PUSH_HINT, timeAgo, type NotificationEntry } from "./NotificationBell";

// ---------------------------------------------------------------------------
// Tela Notificações: todas as minhas, preferências (silenciar eventos) e aparelhos; para o ADMIN,
// Configurar (eventos e quem recebe), Enviar (avulsa) e Registro de envios (com as falhas).
// ---------------------------------------------------------------------------
type User = { profile: string; permissions: string[] };
type Tab = "minhas" | "preferencias" | "configurar" | "enviar" | "registro";
type Person = { id: number; name: string; profile: string; fronts: number[] | "ALL" };
type Front = { id: number; name: string };
type EventRow = EventDef & { setting: EventSetting };
type SettingsData = { events: EventRow[]; people: Person[]; fronts: Front[]; lastDaily: string | null; canConfigure: boolean };

const PROFILE_LABELS: Record<string, string> = { ADMIN: "Administrador", GESTOR: "Gestor", OFICINA: "Oficina", OPERADOR: "Operador", ALMOXARIFADO: "Almoxarifado", CAMPO: "Campo" };
const SCREENS = ["", "Combustível", "Controle Diário", "Tarefas", "Central de alertas", "Status da Frota", "Produtos", "Ordem de Serviço", "Relatórios", "Funcionários"];

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Não foi possível concluir.");
  return data;
}
const when = (value: string) => new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function NotificationsView({ authUser, flash, onNavigate, initialTab = "minhas" }: { authUser: User; flash: (message: string) => void; onNavigate: (link: NotificationLink) => void; initialTab?: Tab }) {
  const canConfigure = authUser.permissions.includes("notifications.configure");
  const canSend = authUser.permissions.includes("notifications.send");
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Array<[Tab, string]> = [["minhas", "Minhas notificações"], ["preferencias", "Preferências e aparelhos"], ...(canConfigure ? [["configurar", "Configurar"] as [Tab, string]] : []), ...(canSend ? [["enviar", "Enviar"] as [Tab, string]] : []), ...(canConfigure ? [["registro", "Registro de envios"] as [Tab, string]] : [])];
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">AVISOS DO SISTEMA</p><h1>Notificações</h1><span>O que acontece no sistema e precisa da sua atenção, no sino e no celular.</span></div></div>
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação de Notificações">
      {tabs.map(([key, label]) => <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {tab === "minhas" && <MyNotifications onNavigate={onNavigate} />}
    {tab === "preferencias" && <Preferences flash={flash} />}
    {tab === "configurar" && canConfigure && <Configure flash={flash} />}
    {tab === "enviar" && canSend && <SendManual flash={flash} />}
    {tab === "registro" && canConfigure && <DispatchLog />}
  </>;
}

function MyNotifications({ onNavigate }: { onNavigate: (link: NotificationLink) => void }) {
  const [items, setItems] = useState<NotificationEntry[] | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setItems((await notificationApi.list()).items); } catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); } }, []);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)); await load(); };
  const shown = (items ?? []).filter((item) => !onlyUnread || !item.readAt);
  return <article className="panel module-panel notify-page">
    <div className="notify-toolbar">
      <label className="report-check"><input type="checkbox" checked={onlyUnread} onChange={(event) => setOnlyUnread(event.target.checked)} />Só as não lidas</label>
      <button type="button" className="secondary" onClick={() => void notificationApi.readAll().then(changed)}>Marcar todas como lidas</button>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {items === null && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="notify-list wide">
      {shown.map((item) => <div key={item.id} className={`notify-item ${item.readAt ? "" : "unread"}`}>
        <span className="notify-dot" aria-hidden="true" />
        <span className="notify-text"><strong>{item.title}</strong><span>{item.body}</span><small>{timeAgo(item.updatedAt)}{item.count > 1 && !item.title.includes(String(item.count)) ? ` · ${item.count} avisos` : ""}</small></span>
        <span className="notify-item-actions">
          {item.link && <button type="button" className="secondary" onClick={() => void notificationApi.open(item.id).then((result) => { window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)); if (result.link) onNavigate(result.link); })}>Abrir</button>}
          {item.readAt ? <button type="button" className="link-button" onClick={() => void notificationApi.unread(item.id).then(changed)}>Marcar como não lida</button>
            : <button type="button" className="link-button" onClick={() => void notificationApi.open(item.id).then(changed)}>Marcar como lida</button>}
        </span>
      </div>)}
      {shown.length === 0 && <div className="empty-state">{onlyUnread ? "Nenhuma notificação não lida." : "Nenhuma notificação por enquanto."}</div>}
    </div>}
    <p className="table-sub">Mostra as 50 mais recentes.</p>
  </article>;
}

type Device = { id: number; kind: "WEB" | "ANDROID"; label: string | null; endpoint: string; createdAt: string; lastSeenAt: string | null; lastSuccessAt: string | null; lastError: string | null };
type Preference = { event: string; area: string; label: string; description: string; muted: boolean };

function Preferences({ flash }: { flash: (message: string) => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [prefs, setPrefs] = useState<Preference[] | null>(null);
  const [support, setSupport] = useState<PushSupport>("UNSUPPORTED");
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const [deviceData, prefData] = await Promise.all([request<{ devices: Device[] }>("/api/notifications/devices"), request<{ events: Preference[] }>("/api/notifications/preferences")]);
      setDevices(deviceData.devices); setPrefs(prefData.events);
      const value = pushSupport(); setSupport(value);
      if (value === "OK") { await syncPush(); setHere(await currentDeviceToken()); }
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
  }, []);
  useEffect(() => { void load(); window.addEventListener(PUSH_CHANGED_EVENT, load); return () => window.removeEventListener(PUSH_CHANGED_EVENT, load); }, [load]);
  const activeHere = Boolean(here && devices.some((device) => device.endpoint === here));
  async function run(job: () => Promise<unknown>, done?: string) {
    setBusy(true); setError("");
    try { const result = await job(); flash(done ?? (result as { message?: string })?.message ?? "Pronto."); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
    finally { setBusy(false); }
  }
  const areas = [...new Set((prefs ?? []).map((item) => item.area))];
  return <div className="notify-columns">
    <article className="panel module-panel notify-page">
      <h2 className="notify-section-title">Este aparelho</h2>
      {error && <div className="fleet-form-error">! {error}</div>}
      {support === "OK" ? <div className="notify-device-here">
        <span className={`status-pill ${activeHere ? "green" : "gray"}`}>{activeHere ? "Recebendo avisos" : "Avisos desligados"}</span>
        {activeHere ? <>
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => request("/api/notifications/test", "POST", {}))}>Enviar teste</button>
          <button type="button" className="link-button" disabled={busy} onClick={() => void run(() => disablePush("USUARIO"), "Avisos desligados neste aparelho.")}>Desligar neste aparelho</button>
        </> : <button type="button" className="primary" disabled={busy} onClick={() => void run(enablePush, "Pronto! Este aparelho vai receber os avisos.")}>{busy ? "Ativando..." : "Ativar notificações neste aparelho"}</button>}
      </div> : <p className="notify-push-hint">{PUSH_HINT[support]}</p>}
      <h2 className="notify-section-title">Meus aparelhos</h2>
      <div className="notify-devices">
        {devices.map((device) => <div key={device.id} className="notify-device">
          <span><strong>{device.label ?? (device.kind === "ANDROID" ? "App Android" : "Navegador")}{device.endpoint === here ? " (este)" : ""}</strong>
            <small>Ativado em {when(device.createdAt)}{device.lastSuccessAt ? ` · último aviso entregue ${timeAgo(device.lastSuccessAt)}` : ""}</small>
            {device.lastError && <small className="notify-error">Última falha: {device.lastError}</small>}</span>
          <button type="button" className="link-button" disabled={busy} onClick={() => void run(() => request("/api/notifications/devices", "DELETE", { id: device.id }), "Aparelho removido.")}>Remover</button>
        </div>)}
        {devices.length === 0 && <div className="empty-state">Nenhum aparelho recebendo avisos. Os avisos continuam no sino.</div>}
      </div>
    </article>
    <article className="panel module-panel notify-page">
      <h2 className="notify-section-title">O que eu recebo</h2>
      <p className="table-sub">Desmarque o que não quer receber (some do sino e do celular). Avisos do administrador sempre chegam.</p>
      {prefs === null ? <div className="page-loading"><span /><p>Carregando...</p></div> : areas.map((area) => <fieldset key={area} className="notify-prefs"><legend>{area}</legend>
        {prefs.filter((item) => item.area === area).map((item) => <label key={item.event} className="notify-pref">
          <input type="checkbox" checked={!item.muted} disabled={busy} onChange={(event) => { const muted = !event.target.checked; setPrefs((current) => current?.map((entry) => entry.event === item.event ? { ...entry, muted } : entry) ?? current); void run(() => request("/api/notifications/preferences", "PUT", { event: item.event, muted })); }} />
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
        </label>)}
      </fieldset>)}
      {prefs?.length === 0 && <div className="empty-state">Nenhum aviso automático para o seu acesso.</div>}
    </article>
  </div>;
}

function PeoplePicker({ people, value, onChange, fronts }: { people: Person[]; value: number[]; onChange: (ids: number[]) => void; fronts?: Front[] }) {
  const [search, setSearch] = useState("");
  const plain = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const matches = search.trim() ? people.filter((person) => plain(person.name).includes(plain(search.trim())) && !value.includes(person.id)).slice(0, 8) : [];
  const frontName = (person: Person) => person.fronts === "ALL" ? "todas as frentes" : person.fronts.map((id) => fronts?.find((front) => front.id === id)?.name).filter(Boolean).join(", ") || "sem frente";
  return <div className="notify-people">
    <div className="notify-chips">{value.map((id) => { const person = people.find((item) => item.id === id); return <span key={id} className="notify-chip">{person?.name ?? `#${id}`}<button type="button" aria-label={`Tirar ${person?.name ?? id}`} onClick={() => onChange(value.filter((item) => item !== id))}>×</button></span>; })}</div>
    <input value={search} placeholder="Buscar pessoa pelo nome..." aria-label="Buscar pessoa" onChange={(event) => setSearch(event.target.value)} />
    {matches.length > 0 && <div className="notify-people-results">{matches.map((person) => <button type="button" key={person.id} onClick={() => { onChange([...value, person.id]); setSearch(""); }}>{person.name}<small>{PROFILE_LABELS[person.profile] ?? person.profile} · {frontName(person)}</small></button>)}</div>}
  </div>;
}

function Configure({ flash }: { flash: (message: string) => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EventSetting>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { const result = await request<SettingsData>("/api/notifications/settings"); setData(result); setDrafts(Object.fromEntries(result.events.map((item) => [item.key, item.setting]))); } catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return error ? <div className="fleet-form-error">! {error}</div> : <div className="page-loading"><span /><p>Carregando configuração...</p></div>;
  const edit = (key: string, patch: Partial<EventSetting>) => setDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  const dirty = (row: EventRow) => JSON.stringify(drafts[row.key]) !== JSON.stringify(row.setting);
  async function save(row: EventRow) {
    setBusy(row.key); setError("");
    try { const result = await request<{ message: string }>("/api/notifications/settings", "PUT", drafts[row.key]); flash(`${row.label}: ${result.message}`); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
    finally { setBusy(""); }
  }
  async function runDaily() {
    setBusy("daily"); setError("");
    try { const result = await request<{ message: string }>("/api/notifications/settings", "POST", { action: "run_daily" }); flash(result.message); window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
    finally { setBusy(""); }
  }
  const areas = [...new Set(data.events.filter((row) => row.audience !== "AVULSO").map((row) => row.area))];
  return <article className="panel module-panel notify-page">
    <div className="notify-daily">
      <span><strong>Verificação diária</strong><small>Trocas vencidas, estoque baixo, consumo fora da média e tarefas vencendo: roda sozinha no primeiro acesso depois das 6h. Última: {data.lastDaily ? data.lastDaily.split("-").reverse().join("/") : "ainda não rodou"}.</small></span>
      <button type="button" className="secondary" disabled={busy !== ""} onClick={() => void runDaily()}>{busy === "daily" ? "Verificando..." : "Verificar agora"}</button>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {areas.map((area) => <fieldset key={area} className="notify-config-area"><legend>{area}</legend>
      {data.events.filter((row) => row.area === area).map((row) => { const draft = drafts[row.key]; return <div key={row.key} className={`notify-config ${draft.enabled ? "" : "off"}`}>
        <div className="notify-config-head">
          <span><strong>{row.label}</strong><small>{row.description}{row.audience === "DIRETO" ? " Vai para a pessoa envolvida." : ""}</small></span>
          <label className="report-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => edit(row.key, { enabled: event.target.checked })} />Ligado</label>
          <label className="report-check"><input type="checkbox" checked={draft.push} disabled={!draft.enabled} onChange={(event) => edit(row.key, { push: event.target.checked })} />Celular</label>
        </div>
        {row.audience === "GRUPO" && draft.enabled && <div className="notify-recipients">
          <span className="notify-recipients-label">Quem recebe</span>
          {row.permission && <label className="report-check"><input type="checkbox" checked={draft.includePermission} onChange={(event) => edit(row.key, { includePermission: event.target.checked })} />Todos que têm a permissão ({row.permissionLabel ?? row.permission})</label>}
          <div className="notify-profiles">{["ADMIN", "GESTOR", "OFICINA", "ALMOXARIFADO", "OPERADOR"].map((profile) => <label key={profile} className="report-check"><input type="checkbox" checked={draft.profiles.includes(profile as EventSetting["profiles"][number])} onChange={(event) => edit(row.key, { profiles: event.target.checked ? [...draft.profiles, profile as EventSetting["profiles"][number]] : draft.profiles.filter((item) => item !== profile) })} />{PROFILE_LABELS[profile]}</label>)}</div>
          <PeoplePicker people={data.people} fronts={data.fronts} value={draft.userIds} onChange={(userIds) => edit(row.key, { userIds })} />
          <label className="report-check"><input type="checkbox" checked={draft.onlyFront} onChange={(event) => edit(row.key, { onlyFront: event.target.checked })} />Só quem enxerga a frente do aviso</label>
        </div>}
        {dirty(row) && <div className="notify-config-save"><button type="button" className="link-button" onClick={() => edit(row.key, row.setting)}>Desfazer</button><button type="button" className="primary" disabled={busy !== ""} onClick={() => void save(row)}>{busy === row.key ? "Salvando..." : "Salvar"}</button></div>}
      </div>; })}
    </fieldset>)}
  </article>;
}

function SendManual({ flash }: { flash: (message: string) => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [screen, setScreen] = useState("");
  const [push, setPush] = useState(true);
  const [all, setAll] = useState(false);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [frontIds, setFrontIds] = useState<number[]>([]);
  const [userIds, setUserIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { request<SettingsData>("/api/notifications/settings").then(setData).catch((problem) => setError(problem instanceof Error ? problem.message : "Falhou.")); }, []);
  // Prévia de quantas pessoas recebem (mesma regra do servidor: lib/notification-events.ts manualRecipients).
  const count = useMemo(() => (data?.people ?? []).filter((person) => (all || profiles.includes(person.profile) || userIds.includes(person.id)) && (!frontIds.length || userIds.includes(person.id) || person.fronts === "ALL" || frontIds.some((id) => (person.fronts as number[]).includes(id)))).length, [data, all, profiles, userIds, frontIds]);
  async function send() {
    setBusy(true); setError("");
    try {
      const result = await request<{ message: string }>("/api/notifications/send", "POST", { title, body, push, link: screen ? { secao: screen } : null, target: { all, profiles, frontIds, userIds } });
      flash(result.message); setTitle(""); setBody(""); window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
    finally { setBusy(false); }
  }
  if (!data) return error ? <div className="fleet-form-error">! {error}</div> : <div className="page-loading"><span /><p>Carregando...</p></div>;
  return <article className="panel module-panel notify-page notify-send">
    <label>Título<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Parada para manutenção da balsa" /></label>
    <label>Mensagem<textarea rows={4} value={body} maxLength={600} onChange={(event) => setBody(event.target.value)} placeholder="O que as pessoas precisam saber" /></label>
    <label>Ao tocar, abrir a tela<select value={screen} onChange={(event) => setScreen(event.target.value)}>{SCREENS.map((item) => <option key={item} value={item}>{item || "Nenhuma (só o aviso)"}</option>)}</select></label>
    <fieldset className="notify-prefs"><legend>Quem recebe</legend>
      <label className="report-check"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />Todos os usuários ativos</label>
      {!all && <div className="notify-profiles">{Object.keys(PROFILE_LABELS).map((profile) => <label key={profile} className="report-check"><input type="checkbox" checked={profiles.includes(profile)} onChange={(event) => setProfiles(event.target.checked ? [...profiles, profile] : profiles.filter((item) => item !== profile))} />{PROFILE_LABELS[profile]}</label>)}</div>}
      {!all && <PeoplePicker people={data.people} fronts={data.fronts} value={userIds} onChange={setUserIds} />}
      <span className="notify-recipients-label">Só de algumas frentes (opcional)</span>
      <div className="notify-profiles">{data.fronts.map((front) => <label key={front.id} className="report-check"><input type="checkbox" checked={frontIds.includes(front.id)} onChange={(event) => setFrontIds(event.target.checked ? [...frontIds, front.id] : frontIds.filter((item) => item !== front.id))} />{front.name}</label>)}</div>
    </fieldset>
    <label className="report-check"><input type="checkbox" checked={push} onChange={(event) => setPush(event.target.checked)} />Enviar também para o celular de quem ativou</label>
    {error && <div className="fleet-form-error">! {error}</div>}
    <div className="notify-config-save"><span className="table-sub">{count} pessoa(s) recebem.</span><button type="button" className="primary" disabled={busy || count === 0 || title.trim().length < 3 || body.trim().length < 3} onClick={() => void send()}>{busy ? "Enviando..." : "Enviar notificação"}</button></div>
  </article>;
}

type LogRow = { id: number; event: string; label: string; title: string; body: string; createdAt: string; recipients: number; sent: number; failed: number; read: number; front: string | null; createdBy: string | null };
type Detail = { userId: number; name: string; readAt: string | null; deliveries: Array<{ channel: string; status: string; error: string | null; device: string; at: string }> };

const localDay = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date(Date.now() + offsetDays * 86_400_000));

function DispatchLog() {
  const [from, setFrom] = useState(() => localDay(-6));
  const [to, setTo] = useState(() => localDay());
  const [event, setEvent] = useState("");
  const [failures, setFailures] = useState(false);
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [detail, setDetail] = useState<{ row: LogRow; recipients: Detail[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { request<SettingsData>("/api/notifications/settings").then((data) => setEvents(data.events)).catch(() => undefined); }, []);
  useEffect(() => {
    setError("");
    const params = new URLSearchParams({ de: from, ate: to, ...(event ? { evento: event } : {}), ...(failures ? { falhas: "1" } : {}) });
    request<{ rows: LogRow[] }>(`/api/notifications/log?${params}`).then((data) => setRows(data.rows)).catch((problem) => setError(problem instanceof Error ? problem.message : "Falhou."));
  }, [from, to, event, failures]);
  async function open(row: LogRow) {
    try { setDetail({ row, recipients: (await request<{ recipients: Detail[] }>(`/api/notifications/log?id=${row.id}`)).recipients }); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); }
  }
  return <article className="panel module-panel notify-page">
    <div className="products-filters">
      <label>De<input type="date" value={from} onChange={(item) => setFrom(item.target.value)} /></label>
      <label>Até<input type="date" value={to} onChange={(item) => setTo(item.target.value)} /></label>
      <label>Evento<select value={event} onChange={(item) => setEvent(item.target.value)}><option value="">Todos</option>{events.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label className="report-check"><input type="checkbox" checked={failures} onChange={(item) => setFailures(item.target.checked)} />Só com falha no celular</label>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {rows === null && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="table-scroll"><table className="products-table">
      <thead><tr><th>Quando</th><th>Evento</th><th>Aviso</th><th>Frente</th><th>Enviado por</th><th className="num">Pessoas</th><th className="num">Lidas</th><th className="num">Celular ok</th><th className="num">Falhas</th><th /></tr></thead>
      <tbody>{(rows ?? []).map((row) => <tr key={row.id}>
        <td>{when(row.createdAt)}</td><td>{row.label}</td><td><strong>{row.title}</strong><small className="table-sub">{row.body}</small></td><td>{row.front ?? "—"}</td><td>{row.createdBy ?? "Sistema"}</td>
        <td className="num">{row.recipients}</td><td className="num">{row.read}</td><td className="num">{row.sent}</td><td className="num">{row.failed > 0 ? <span className="status-pill red">{row.failed}</span> : 0}</td>
        <td><button type="button" className="link-button" onClick={() => void open(row)}>Detalhes</button></td>
      </tr>)}</tbody>
    </table>{rows?.length === 0 && <div className="empty-state">Nenhum envio no período.</div>}</div>}
    <p className="table-sub">Celular ok = entregue ao serviço de avisos do aparelho (Apple/Google). Falha com &ldquo;aparelho desativado&rdquo; tira o aparelho da lista automaticamente.</p>
    {detail && <div className="fleet-modal-backdrop" role="presentation" onClick={(item) => { if (item.target === item.currentTarget) setDetail(null); }}><div className="fleet-modal notify-detail" role="dialog" aria-label="Detalhes do envio">
      <header><div><p>{detail.row.label}</p><h2>{detail.row.title}</h2><span>{when(detail.row.createdAt)}</span></div><button type="button" onClick={() => setDetail(null)} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body"><div className="table-scroll"><table className="products-table">
        <thead><tr><th>Pessoa</th><th>Leu</th><th>Celular</th></tr></thead>
        <tbody>{detail.recipients.map((person) => <tr key={person.userId}><td>{person.name}</td><td>{person.readAt ? when(person.readAt) : "—"}</td>
          <td>{person.deliveries.length ? person.deliveries.map((item, index) => <small key={index} className={`table-sub ${item.status === "SENT" ? "" : "notify-error"}`}>{item.device}: {item.status === "SENT" ? "entregue" : item.status === "INVALID" ? "aparelho desativado" : "falhou"}{item.error ? ` (${item.error})` : ""}</small>) : <small className="table-sub">sem aparelho ativado (só no sino)</small>}</td></tr>)}</tbody>
      </table></div></div>
    </div></div>}
  </article>;
}
