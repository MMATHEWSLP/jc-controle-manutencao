"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import ConvoyApprovalView, { ConvoyHistoryView, ConvoyReport } from "./ConvoyApprovalView";
import { CodesResult, type AcessoCriado } from "./FieldOperatorsAdd";

// Comboio dentro do Combustível (antes era o menu ABASTECIMENTOS):
//  - Aprovação: Aprovar (o que o motorista do comboio lançou, pendente até alguém conferir e aprovar),
//    Histórico (os já tratados, com filtros e exportação) e Relatório (por período, comboio, motorista);
//  - Motorista comboio: quem lança (nome + PIN no "Sou operador"; entra direto em Abastecimentos).
export type ConvoyApprovalTab = "approve" | "history" | "report";
export type ConvoyApprovalStart = { tab: ConvoyApprovalTab; driver?: { id: number; name: string } | null };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(data.error ?? "A operação não pôde ser concluída.")), { data });
  return data as T;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const formatDateTime = (value: string | null, empty = "nunca entrou") => (value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : empty);
const norm = (value: string | null | undefined) => (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");

// Contador de pendentes do comboio (subaba Aprovação e aba interna Aprovar).
export function useConvoyPending(enabled: boolean) {
  const [pending, setPending] = useState(0);
  const refresh = useCallback(() => { if (enabled) api<{ pending: number }>("/api/fuel/convoy/count").then((result) => setPending(result.pending)).catch(() => undefined); }, [enabled]);
  useEffect(() => {
    refresh();
    window.addEventListener("jc:convoy-changed", refresh);
    return () => window.removeEventListener("jc:convoy-changed", refresh);
  }, [refresh]);
  return { pending, refresh };
}

// Combustível → Aprovação: abas internas Aprovar | Histórico | Relatório.
export function ConvoyApprovalPanel({ flash, pending, start }: { flash: (message: string) => void; pending: number; start?: ConvoyApprovalStart }) {
  const [tab, setTab] = useState<ConvoyApprovalTab>(start?.tab ?? "approve");
  const changed = () => window.dispatchEvent(new Event("jc:convoy-changed"));
  return <div className="convoy-approval-panel">
    <div className="main-tabs secondary-module-nav convoy-inner-tabs" aria-label="Aprovação do comboio">
      <button type="button" className={tab === "approve" ? "active" : ""} onClick={() => setTab("approve")}>Aprovar{pending > 0 && <b className="nav-badge" title="Abastecimentos do comboio pendentes de aprovação">{pending}</b>}</button>
      <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Histórico</button>
      <button type="button" className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>Relatório</button>
    </div>
    {tab === "approve" ? <ConvoyApprovalView flash={flash} onChanged={changed} />
      : tab === "history" ? <ConvoyHistoryView flash={flash} initialDriver={start?.tab === "history" ? start.driver ?? null : null} onChanged={changed} />
      : <ConvoyReport />}
  </div>;
}

type Front = { id: number; name: string };
type Driver = {
  id: number; name: string; jobTitle: string | null; active: boolean; serviceFrontIds: number[]; lastAccessAt: string | null; registration: string | null;
  convoyEquipmentId: number | null; convoyPrefix: string | null; dailyAccess: boolean; lastRecordAt: string | null; pending: number;
};
type DriversResponse = {
  fronts: Front[]; drivers: Driver[];
  accesses: Array<{ id: number; name: string; jobTitle: string | null; registration: string | null }>;
  employees: Array<{ id: number; name: string; jobTitle: string; registration: string | null; front: string; serviceFrontId: number }>;
  convoyOptions: Array<{ id: number; label: string; convoy: boolean }>;
};

// Combustível → Motorista comboio. openHistory: atalho para Aprovação → Histórico filtrado pelo motorista.
export function ConvoyDriversPanel({ flash, openHistory }: { flash: (message: string) => void; openHistory?: (driver: { id: number; name: string }) => void }) {
  const [data, setData] = useState<DriversResponse | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Driver | null>(null);
  const [codes, setCodes] = useState<AcessoCriado[] | null>(null);
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<DriversResponse>("/api/fuel/convoy/drivers")); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Falha ao carregar."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const frontName = (id: number) => data?.fronts.find((front) => front.id === id)?.name ?? `Frente ${id}`;
  async function remove(driver: Driver) {
    if (!window.confirm(`${driver.name} deixa de lançar abastecimentos do comboio. O acesso de campo continua, só com o Controle Diário. Confirma?`)) return;
    try { const result = await api<{ message: string }>(`/api/fuel/convoy/drivers/${driver.id}`, { method: "DELETE" }); flash(result.message); await load(); }
    catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível remover."); }
  }
  const drivers = data?.drivers ?? [];
  return <article className="panel module-panel convoy-approval">
    <div className="daily-operators-head">
      <div><strong>Motoristas do comboio</strong><span>Entram em &quot;Sou operador&quot; com o nome e o PIN e caem direto em Abastecimentos, para lançar todos os abastecimentos que fizeram no dia. Só veem o Controle Diário se você marcar.</span></div>
      <div className="daily-operators-actions"><button type="button" className="primary" onClick={() => setAdding(true)} disabled={!data}>＋ Adicionar motorista</button></div>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!data && !error ? <div className="page-loading"><span /><p>Carregando motoristas...</p></div> : <div className="daily-records">
      {drivers.map((driver) => <article key={driver.id} className={`daily-record ${driver.active ? "ok" : "off"}`}>
        <header><strong>{driver.name}</strong><span /><span className={`status-pill ${driver.active ? "green" : "gray"}`}>{driver.active ? "Ativo" : "Inativo"}</span></header>
        <dl>
          <div><dt>Comboio</dt><dd>{driver.convoyPrefix ?? "— (escolhe ao lançar)"}</dd></div>
          <div><dt>Função</dt><dd>{driver.jobTitle ?? "—"}{driver.registration ? ` · mat. ${driver.registration}` : ""}</dd></div>
          <div><dt>Controle Diário</dt><dd>{driver.dailyAccess ? "Também faz" : "Não (só Abastecimentos)"}</dd></div>
          <div><dt>Frentes</dt><dd>{driver.serviceFrontIds.map(frontName).join(", ") || "—"}</dd></div>
          <div><dt>Último lançamento</dt><dd>{formatDateTime(driver.lastRecordAt, "nenhum")}</dd></div>
          <div><dt>Pendentes</dt><dd>{driver.pending > 0 ? <b className="convoy-driver-pending">{driver.pending} aguardando</b> : "nenhum"}</dd></div>
          <div className="wide"><dt>Último acesso</dt><dd>{formatDateTime(driver.lastAccessAt)}</dd></div>
        </dl>
        <footer className="daily-record-actions">
          {openHistory && <button type="button" className="secondary" onClick={() => openHistory({ id: driver.id, name: driver.name })}>Ver histórico</button>}
          <button type="button" className="secondary" onClick={() => void remove(driver)}>Remover do comboio</button>
          <button type="button" className="secondary" onClick={() => setEditing(driver)}>Editar / inativar / PIN</button>
        </footer>
      </article>)}
      {data && !drivers.length && <div className="empty-state">Nenhum motorista do comboio cadastrado. Use &quot;＋ Adicionar motorista&quot;.</div>}
    </div>}
    {adding && data && <AddDriverModal data={data} close={() => setAdding(false)} done={async (message, access) => { setAdding(false); flash(message); if (access) setCodes([access]); await load(); }} />}
    {editing && data && <EditDriverModal driver={editing} options={data.convoyOptions} close={() => setEditing(null)} saved={async (message) => { setEditing(null); flash(message); await load(); }} />}
    {codes && <CodesResult criados={codes} close={() => setCodes(null)} />}
  </article>;
}

function ConvoySelect({ value, options, onChange }: { value: string; options: DriversResponse["convoyOptions"]; onChange: (value: string) => void }) {
  return <label className="daily-field">Comboio que dirige<select value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">— Escolhe ao lançar —</option>
    {options.some((item) => item.convoy) && <optgroup label="Comboios">{options.filter((item) => item.convoy).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>}
    <optgroup label="Outros equipamentos">{options.filter((item) => !item.convoy).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>
  </select></label>;
}

type Mode = "employee" | "access" | "manual";
type Similar = { funcionarios: Array<{ id: number; name: string; jobTitle: string; front: string; semelhancaRotulo: string }>; acessos: Array<{ id: number; name: string; jobTitle: string | null; semelhancaRotulo: string }> };

function AddDriverModal({ data, close, done }: { data: DriversResponse; close: () => void; done: (message: string, access: AcessoCriado | null) => Promise<void> }) {
  const [mode, setMode] = useState<Mode>(data.employees.length ? "employee" : data.accesses.length ? "access" : "manual");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("MOTORISTA DE COMBOIO");
  const [frontIds, setFrontIds] = useState<number[]>(data.fronts.length === 1 ? [data.fronts[0].id] : []);
  const [convoy, setConvoy] = useState("");
  const [dailyAccess, setDailyAccess] = useState(false);
  const [code, setCode] = useState("");
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [confirmSimilar, setConfirmSimilar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const term = norm(query.trim());
  const list = mode === "employee"
    ? data.employees.filter((row) => !term || norm(`${row.name} ${row.jobTitle} ${row.registration ?? ""}`).includes(term)).map((row) => ({ id: row.id, title: row.name, detail: `${row.jobTitle} · ${row.front}${row.registration ? ` · mat. ${row.registration}` : ""}` }))
    : data.accesses.filter((row) => !term || norm(`${row.name} ${row.jobTitle ?? ""} ${row.registration ?? ""}`).includes(term)).map((row) => ({ id: row.id, title: row.name, detail: `${row.jobTitle ?? "—"} · já tem acesso de campo (o PIN continua o mesmo)` }));
  const switchMode = (next: Mode) => { setMode(next); setPicked(null); setQuery(""); setError(""); setSimilar(null); setDailyAccess(next === "access"); };
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const base = { convoyEquipmentId: convoy ? Number(convoy) : null, dailyAccess, code: mode === "access" ? null : code };
    const body = mode === "employee" ? { ...base, mode, employeeId: picked }
      : mode === "access" ? { ...base, mode, userId: picked }
      : { ...base, mode, name, jobTitle, serviceFrontIds: frontIds, criarFuncionario: false, confirmarParecidos: confirmSimilar };
    try {
      const result = await api<{ message: string; access: AcessoCriado | null }>("/api/fuel/convoy/drivers", jsonInit("POST", body));
      await done(result.message, result.access);
    } catch (problem) {
      const extra = (problem as { data?: { parecidos?: Similar } }).data;
      if (extra?.parecidos) setSimilar(extra.parecidos);
      setError(problem instanceof Error ? problem.message : "Não foi possível cadastrar.");
    } finally { setBusy(false); }
  }
  const ready = mode === "manual" ? name.trim().includes(" ") && jobTitle.trim() && frontIds.length > 0 : picked !== null;
  return <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal daily-review" onSubmit={submit}>
    <header><div><p>COMBUSTÍVEL · MOTORISTA COMBOIO</p><h2>Adicionar motorista do comboio</h2><span>Login sem senha: nome + PIN. O PIN aparece uma única vez, para entregar pessoalmente.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="main-tabs secondary-module-nav">
        <button type="button" className={mode === "employee" ? "active" : ""} onClick={() => switchMode("employee")}>Da lista de funcionários</button>
        <button type="button" className={mode === "access" ? "active" : ""} onClick={() => switchMode("access")}>Já tem acesso de campo</button>
        <button type="button" className={mode === "manual" ? "active" : ""} onClick={() => switchMode("manual")}>Fora do cadastro</button>
      </div>
      {mode !== "manual" ? <>
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar por nome, função ou matrícula..." autoFocus /></label>
        <ul className="convoy-options convoy-driver-pick">{list.slice(0, 40).map((row) => <li key={row.id}><button type="button" className={picked === row.id ? "active" : ""} onClick={() => setPicked(row.id)}><strong>{picked === row.id ? "✓ " : ""}{row.title}</strong><small>{row.detail}</small></button></li>)}</ul>
        {!list.length && <p className="convoy-empty">{mode === "employee" ? "Nenhum funcionário sem acesso de campo encontrado." : "Nenhum acesso de campo encontrado."}</p>}
      </> : <div className="fleet-form-grid">
        <label className="daily-field span-2">Nome completo *<input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="Ex.: JOSÉ DA SILVA" autoCapitalize="characters" /></label>
        <label className="daily-field">Função *<input value={jobTitle} onChange={(event) => setJobTitle(event.target.value.toUpperCase())} /></label>
        <fieldset className="daily-front-checks span-2"><legend>Frentes em que trabalha *</legend>{data.fronts.map((front) => <label key={front.id}><input type="checkbox" checked={frontIds.includes(front.id)} onChange={() => setFrontIds((current) => current.includes(front.id) ? current.filter((id) => id !== front.id) : [...current, front.id])} />{front.name}</label>)}</fieldset>
        <p className="table-sub span-2">Para ficar também no cadastro de Funcionários, cadastre pelo menu FUNCIONÁRIOS e escolha em &quot;Da lista de funcionários&quot;.</p>
      </div>}
      <div className="fleet-form-grid">
        <ConvoySelect value={convoy} options={data.convoyOptions} onChange={setConvoy} />
        {mode !== "access" && <label className="daily-field">PIN (vazio = gerado pelo sistema)<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="4 a 8 números" /></label>}
        <label className="convoy-check span-2"><input type="checkbox" checked={dailyAccess} onChange={(event) => setDailyAccess(event.target.checked)} />Também faz o Controle Diário (do próprio caminhão)</label>
      </div>
      {similar && (similar.funcionarios.length > 0 || similar.acessos.length > 0) && <div className="convoy-warnings">
        <span>Nomes parecidos já cadastrados:</span>
        {similar.funcionarios.map((row) => <span key={`f${row.id}`}>• {row.name} — {row.jobTitle} · {row.front} ({row.semelhancaRotulo}) → use &quot;Da lista de funcionários&quot;</span>)}
        {similar.acessos.map((row) => <span key={`a${row.id}`}>• {row.name} — {row.jobTitle ?? "—"} ({row.semelhancaRotulo}) → use &quot;Já tem acesso de campo&quot;</span>)}
        <label className="convoy-check"><input type="checkbox" checked={confirmSimilar} onChange={(event) => setConfirmSimilar(event.target.checked)} />É outra pessoa: cadastrar mesmo assim</label>
      </div>}
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy || !ready}>{busy ? "SALVANDO..." : "CADASTRAR MOTORISTA"}</button></footer>
  </form></div>;
}

function EditDriverModal({ driver, options, close, saved }: { driver: Driver; options: DriversResponse["convoyOptions"]; close: () => void; saved: (message: string) => Promise<void> }) {
  const [convoy, setConvoy] = useState(driver.convoyEquipmentId ? String(driver.convoyEquipmentId) : "");
  const [dailyAccess, setDailyAccess] = useState(driver.dailyAccess);
  const [active, setActive] = useState(driver.active);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ message: string }>(`/api/fuel/convoy/drivers/${driver.id}`, jsonInit("PUT", { convoyEquipmentId: convoy ? Number(convoy) : null, dailyAccess, active, code })); await saved(result.message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  return <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal daily-review" onSubmit={submit}>
    <header><div><p>COMBUSTÍVEL · MOTORISTA COMBOIO</p><h2>{driver.name}</h2><span>Motorista do comboio. Trocar o PIN ou inativar desconecta quem estiver logado.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="fleet-form-grid">
        <ConvoySelect value={convoy} options={options} onChange={setConvoy} />
        <label className="daily-field"><span>Situação</span><select value={active ? "1" : "0"} onChange={(event) => setActive(event.target.value === "1")}><option value="1">Ativo (pode entrar)</option><option value="0">Inativo (acesso bloqueado)</option></select></label>
        <label className="daily-field">Novo PIN (deixe vazio para manter)<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="4 a 8 números" /></label>
        <label className="convoy-check span-2"><input type="checkbox" checked={dailyAccess} onChange={(event) => setDailyAccess(event.target.checked)} />Também faz o Controle Diário (do próprio caminhão)</label>
      </div>
      <p className="daily-security-note">⚠ Sem senha, quem souber o nome e o PIN entra no lugar do motorista. Não use datas de nascimento nem números óbvios (1234, 0000).</p>
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "SALVANDO..." : "SALVAR"}</button></footer>
  </form></div>;
}
