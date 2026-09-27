"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Status = "ATIVO" | "AFASTADO" | "DESLIGADO";
type AbsenceKind = "FOLGA" | "FERIAS" | "ATESTADO" | "AFASTAMENTO" | "OUTRO";
type Front = { id: number; name: string };
type CurrentAbsence = { id: number; kind: AbsenceKind; kindLabel: string; startDate: string; endDate: string | null; badge: { label: string; returnDate: string | null } | null };
type Employee = {
  id: number; name: string; jobTitle: string; company: string; admissionDate: string; serviceFrontId: number; frontName: string;
  status: Status; statusLabel: string; notes: string | null; currentAbsence: CurrentAbsence | null;
};
type Detail = Employee & {
  transfers: Array<{ id: number; transferDate: string; previousFront: string | null; newFront: string; note: string | null; by: string | null }>;
  absences: Array<{ id: number; kind: AbsenceKind; kindLabel: string; startDate: string; endDate: string | null; notes: string | null; by: string | null }>;
};
type ListResponse = { employees: Employee[]; fronts: Front[]; scopeFrontIds: number[]; canManage: boolean };
type User = { permissions: string[] };

const STATUS_OPTIONS: Array<[Status, string]> = [["ATIVO", "Ativo"], ["AFASTADO", "Afastado"], ["DESLIGADO", "Desligado"]];
const ABSENCE_OPTIONS: Array<[AbsenceKind, string]> = [["FOLGA", "Folga"], ["FERIAS", "Férias"], ["ATESTADO", "Atestado médico"], ["AFASTAMENTO", "Afastamento"], ["OUTRO", "Outro"]];
const brDay = (value: string | null) => (value ? value.split("-").reverse().join("/") : "—");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("");

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}
const post = (url: string, body: unknown, method = "POST") => api<{ message: string; id?: number }>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export default function EmployeesView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [data, setData] = useState<ListResponse>({ employees: [], fronts: [], scopeFrontIds: [], canManage: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [front, setFront] = useState("");
  const [company, setCompany] = useState("");
  const [situation, setSituation] = useState("");
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [editing, setEditing] = useState<Employee | null | "new">(null);
  const [transferring, setTransferring] = useState<Employee | null>(null);
  const [details, setDetails] = useState<number | null>(null);
  const canManage = authUser.permissions.includes("employees.manage");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setData(await api<ListResponse>(`/api/employees${includeDismissed ? "?includeDismissed=1" : ""}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar os funcionários."); }
    finally { setLoading(false); }
  }, [includeDismissed]);
  useEffect(() => { load(); }, [load]);

  const companies = useMemo(() => [...new Set(data.employees.map((item) => item.company))].sort((a, b) => a.localeCompare(b, "pt-BR")), [data.employees]);
  const scopeFronts = data.fronts.filter((item) => data.scopeFrontIds.includes(item.id));
  const items = useMemo(() => {
    const key = query.trim().toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "");
    return data.employees.filter((item) => {
      const haystack = `${item.name} ${item.jobTitle} ${item.company}`.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (key && !haystack.includes(key)) return false;
      if (front && item.serviceFrontId !== Number(front)) return false;
      if (company && item.company !== company) return false;
      if (situation === "AUSENTE" && !item.currentAbsence) return false;
      if (situation && situation !== "AUSENTE" && item.status !== situation) return false;
      return true;
    });
  }, [data.employees, query, front, company, situation]);
  const absentCount = data.employees.filter((item) => item.currentAbsence).length;
  const refreshAfter = async (message: string) => { setEditing(null); setTransferring(null); await load(); flash(message); };

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">CADASTRO DE PESSOAS</p><h1>Funcionários</h1><span>Funcionários próprios e terceirizados por frente, com transferências e controle de folgas e afastamentos.</span></div>
        {canManage && <div className="heading-actions"><button className="primary" onClick={() => setEditing("new")}>＋ Novo funcionário</button></div>}
      </div>
      <div className="fleet-front-cards">
        <article><span>♙</span><div><strong>{data.employees.length}</strong><small>Funcionários em exibição</small></div></article>
        <article><span>☾</span><div><strong>{absentCount}</strong><small>De folga / afastados hoje</small></div></article>
        {scopeFronts.map((item) => <article key={item.id}><span>⌖</span><div><strong>{data.employees.filter((employee) => employee.serviceFrontId === item.id).length}</strong><small>{item.name}</small></div></article>)}
      </div>
      <article className="panel module-panel equipment-management-panel">
        <div className="equipment-management-filters">
          <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar nome, função ou empresa..." /></label>
          {scopeFronts.length > 1 && <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas</option>{scopeFronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label>Empresa<select value={company} onChange={(event) => setCompany(event.target.value)}><option value="">Todas</option>{companies.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>Situação<select value={situation} onChange={(event) => setSituation(event.target.value)}><option value="">Todas</option><option value="AUSENTE">De folga / afastado hoje</option>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="products-review-toggle"><input type="checkbox" checked={includeDismissed} onChange={(event) => setIncludeDismissed(event.target.checked)} /><strong>Mostrar desligados</strong></label>
        </div>
        {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
        {loading ? <div className="page-loading"><span /><p>Carregando funcionários...</p></div> : (
          <div className="table-scroll">
            <table className="equipment-management-table">
              <thead><tr><th>Funcionário</th><th>Função</th><th>Empresa</th><th>Frente atual</th><th>Admissão</th><th>Situação</th><th>Ações</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><div className="machine-cell"><span>{initials(item.name)}</span><div><strong>{item.name}</strong></div></div></td>
                    <td>{item.jobTitle}</td>
                    <td>{item.company}</td>
                    <td><span className="front-pill">{item.frontName}</span></td>
                    <td>{brDay(item.admissionDate)}</td>
                    <td><SituationPills item={item} /></td>
                    <td><div className="equipment-row-actions">
                      <button onClick={() => setDetails(item.id)}>Ver</button>
                      {canManage && <button onClick={() => setEditing(item)}>Editar</button>}
                      {canManage && <button className="transfer-action" onClick={() => setTransferring(item)}>Transferir</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && <div className="empty-state">{data.employees.length ? "Nenhum funcionário corresponde aos filtros." : "Nenhum funcionário cadastrado nas frentes em exibição."}</div>}
          </div>
        )}
      </article>
      {editing && <EmployeeForm item={editing === "new" ? null : editing} fronts={data.fronts} close={() => setEditing(null)} saved={refreshAfter} />}
      {transferring && <TransferModal item={transferring} fronts={data.fronts} close={() => setTransferring(null)} saved={refreshAfter} />}
      {details !== null && <EmployeeSheet id={details} canManage={canManage} close={() => setDetails(null)} changed={load} flash={flash}
        transfer={(item) => { setDetails(null); setTransferring(item); }} edit={(item) => { setDetails(null); setEditing(item); }} />}
    </>
  );
}

function SituationPills({ item }: { item: Employee }) {
  const tone = item.status === "ATIVO" ? "green" : item.status === "AFASTADO" ? "orange" : "gray";
  return (
    <div className="employee-situation">
      <span className={`status-pill ${tone}`}>{item.statusLabel}</span>
      {item.currentAbsence?.badge && (
        <span className="employee-absence-badge" title={`${item.currentAbsence.kindLabel} desde ${brDay(item.currentAbsence.startDate)}`}>
          {item.currentAbsence.badge.label}{item.currentAbsence.badge.returnDate ? ` · volta ${brDay(item.currentAbsence.badge.returnDate)}` : " · sem data de retorno"}
        </span>
      )}
    </div>
  );
}

function EmployeeForm({ item, fronts, close, saved }: { item: Employee | null; fronts: Front[]; close: () => void; saved: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await post(item ? `/api/employees/${item.id}` : "/api/employees", payload, item ? "PUT" : "POST");
      await saved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal equipment-modal">
        <header><div><p className="eyebrow">FUNCIONÁRIOS</p><h2>{item ? "Editar funcionário" : "Cadastrar funcionário"}</h2><span>{item ? "A frente atual muda só pela transferência (fica no histórico)." : "Todos os campos marcados com * são obrigatórios."}</span></div><button onClick={close}>×</button></header>
        <form className="modal-form" onSubmit={submit}>
          <label className="full">Nome completo *<input name="name" required defaultValue={item?.name} style={{ textTransform: "uppercase" }} autoComplete="off" /></label>
          <label>Função / Cargo *<input name="jobTitle" required defaultValue={item?.jobTitle} placeholder="Ex.: Operador de Baldeio" /></label>
          <label>Empresa *<input name="company" required defaultValue={item?.company ?? "JC SERVIÇOS FLORESTAIS"} style={{ textTransform: "uppercase" }} /></label>
          <label>Data de admissão *<input name="admissionDate" type="date" required defaultValue={item?.admissionDate} max={today()} /></label>
          {item ? <label>Frente de serviço atual<input value={item.frontName} disabled /></label> : (
            <label>Frente de serviço *<select name="serviceFrontId" required defaultValue={fronts.length === 1 ? String(fronts[0].id) : ""}><option value="">Selecione a frente</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
          )}
          <label>Situação *<select name="status" required defaultValue={item?.status ?? "ATIVO"}>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="full">Observações<textarea name="notes" rows={2} defaultValue={item?.notes ?? ""} /></label>
          {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
          <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar funcionário"}</button></div>
        </form>
      </section>
    </div>
  );
}

function TransferModal({ item, fronts, close, saved }: { item: Employee; fronts: Front[]; close: () => void; saved: (message: string) => Promise<void> }) {
  const [destination, setDestination] = useState("");
  const [transferDate, setTransferDate] = useState(today());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${item.id}/transfer`, { newServiceFrontId: Number(destination), transferDate, note })).message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível transferir."); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop">
      <section className="modal transfer-modal">
        <header><div><p className="eyebrow">TRANSFERÊNCIA ENTRE FRENTES</p><h2>Transferir {item.name}</h2><span>O cadastro, as folgas e o histórico de frentes são mantidos.</span></div><button onClick={close}>×</button></header>
        <div className="transfer-route">
          <div><small>Frente atual</small><strong>{item.frontName}</strong></div><span>→</span>
          <label>Transferir para<select value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">Selecione a frente</option>{fronts.filter((front) => front.id !== item.serviceFrontId).map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
        </div>
        <label className="transfer-note">Data da transferência<input type="date" value={transferDate} max={today()} onChange={(event) => setTransferDate(event.target.value)} /></label>
        <label className="transfer-note">Observação (opcional)<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Motivo ou contexto da transferência" /></label>
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
        <footer><button className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !destination || !transferDate} onClick={confirm}>{busy ? "Salvando..." : "Confirmar transferência"}</button></footer>
      </section>
    </div>
  );
}

function EmployeeSheet({ id, canManage, close, changed, flash, transfer, edit }: {
  id: number; canManage: boolean; close: () => void; changed: () => Promise<void>; flash: (message: string) => void;
  transfer: (item: Employee) => void; edit: (item: Employee) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [absenceOpen, setAbsenceOpen] = useState(false);
  const load = useCallback(async () => {
    try { setDetail((await api<{ employee: Detail }>(`/api/employees/${id}`)).employee); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  async function afterChange(message: string) { setAbsenceOpen(false); await Promise.all([load(), changed()]); flash(message); }
  async function closeAbsence(absence: Detail["absences"][number]) {
    const endDate = window.prompt("Data de término/retorno (AAAA-MM-DD):", today());
    if (!endDate) return;
    try { await afterChange((await post(`/api/employees/absences/${absence.id}`, { kind: absence.kind, startDate: absence.startDate, endDate }, "PUT")).message); }
    catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível atualizar."); }
  }
  async function removeAbsence(absence: Detail["absences"][number]) {
    if (!window.confirm(`Excluir o registro de ${absence.kindLabel.toLowerCase()} de ${brDay(absence.startDate)}?`)) return;
    try { await afterChange((await api<{ message: string }>(`/api/employees/absences/${absence.id}`, { method: "DELETE" })).message); }
    catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível excluir."); }
  }
  return (
    <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="equipment-sheet equipment-management-sheet">
        {!detail ? <div className="page-loading"><span /><p>{error || "Carregando ficha..."}</p></div> : <>
          <header className="sheet-header">
            <div className="sheet-identity"><span className="equipment-avatar sheet-avatar">{initials(detail.name)}</span><div><p>{detail.jobTitle.toUpperCase()}</p><h2>{detail.name}</h2><span>{detail.company} · {detail.frontName}</span></div></div>
            <button className="sheet-close" onClick={close}>×</button>
          </header>
          <div className="sheet-content">
            <div className="sheet-summary-grid">
              <article className="sheet-card equipment-data">
                <div className="sheet-card-head"><h3>Dados do funcionário</h3><span>♙</span></div>
                <dl>
                  <div><dt>Função</dt><dd>{detail.jobTitle}</dd></div>
                  <div><dt>Empresa</dt><dd>{detail.company}</dd></div>
                  <div><dt>Admissão</dt><dd>{brDay(detail.admissionDate)}</dd></div>
                  <div><dt>Frente atual</dt><dd>{detail.frontName}</dd></div>
                  <div className="wide"><dt>Situação</dt><dd><SituationPills item={detail} /></dd></div>
                  {detail.notes && <div className="wide"><dt>Observações</dt><dd>{detail.notes}</dd></div>}
                </dl>
                {canManage && <div className="employee-sheet-actions"><button className="secondary transfer-from-details" onClick={() => edit(detail)}>Editar cadastro</button><button className="primary transfer-from-details" onClick={() => transfer(detail)}>Transferir de frente</button></div>}
              </article>
              <article className="sheet-card">
                <div className="sheet-card-head"><div><h3>Histórico de frentes</h3><p>Por onde o funcionário já passou.</p></div></div>
                <div className="transfer-history">
                  {detail.transfers.map((record) => <div key={record.id}><span>↔</span><p><strong>{record.previousFront ? `${record.previousFront} → ${record.newFront}` : record.newFront}</strong><small>{brDay(record.transferDate)}{record.by ? ` · ${record.by}` : ""}{record.note ? ` · ${record.note}` : ""}</small></p></div>)}
                  {detail.transfers.length === 0 && <div className="empty-state">Sem transferências registradas.</div>}
                </div>
              </article>
            </div>
            <article className="sheet-card">
              <div className="sheet-card-head"><div><h3>Folgas e afastamentos</h3><p>Folga, férias, atestado médico, afastamento ou outra ausência.</p></div>{canManage && !absenceOpen && <button onClick={() => setAbsenceOpen(true)}>＋ Registrar ausência</button>}</div>
              {absenceOpen && <AbsenceForm employeeId={detail.id} cancel={() => setAbsenceOpen(false)} saved={afterChange} />}
              <div className="table-scroll">
                <table className="equipment-management-table employee-absences-table">
                  <thead><tr><th>Tipo</th><th>Início</th><th>Término</th><th>Observações</th><th>Registrado por</th>{canManage && <th>Ações</th>}</tr></thead>
                  <tbody>
                    {detail.absences.map((absence) => (
                      <tr key={absence.id} className={detail.currentAbsence?.id === absence.id ? "employee-absence-current" : ""}>
                        <td>{absence.kindLabel}{detail.currentAbsence?.id === absence.id && <span className="employee-absence-badge">vigente</span>}</td>
                        <td>{brDay(absence.startDate)}</td>
                        <td>{absence.endDate ? brDay(absence.endDate) : <em>em aberto</em>}</td>
                        <td>{absence.notes ?? "—"}</td>
                        <td>{absence.by ?? "—"}</td>
                        {canManage && <td><div className="equipment-row-actions">{!absence.endDate && <button onClick={() => closeAbsence(absence)}>Informar retorno</button>}<button onClick={() => removeAbsence(absence)}>Excluir</button></div></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.absences.length === 0 && <div className="empty-state">Nenhuma folga ou afastamento registrado.</div>}
              </div>
            </article>
          </div>
        </>}
      </section>
    </div>
  );
}

function AbsenceForm({ employeeId, cancel, saved }: { employeeId: number; cancel: () => void; saved: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await saved((await post(`/api/employees/${employeeId}/absences`, Object.fromEntries(new FormData(event.currentTarget).entries()))).message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível registrar."); }
    finally { setBusy(false); }
  }
  return (
    <form className="modal-form employee-absence-form" onSubmit={submit}>
      <label>Tipo *<select name="kind" required defaultValue="FOLGA">{ABSENCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Início *<input name="startDate" type="date" required defaultValue={today()} /></label>
      <label>Término<input name="endDate" type="date" /><small>Em branco = em aberto</small></label>
      <label className="full">Observações<input name="notes" placeholder="Ex.: CID, motivo, combinado com a supervisão..." /></label>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full"><button type="button" className="secondary" onClick={cancel}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Registrar"}</button></div>
    </form>
  );
}
