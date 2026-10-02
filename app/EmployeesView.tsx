"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import EmployeeProfile from "./EmployeeProfile";
import RegistryFrontButtons, { frontParam } from "./RegistryFrontButtons";
import { CompaniesModal, EmployeeForm, StepModal, TransferModal } from "./EmployeeForms";
import { EmployeesHistory, RestrictedList } from "./EmployeesHistory";
import { JobFunctionsModal } from "./OperatorAccess";
import {
  AlertChip, api, brDay, dayCount, fold, initials, nextAction, phaseOf, problemText, SituationPills,
  type Alerts, type Company, type CycleStep, type Employee, type Front, type Phase, type User,
} from "./employees-client";

type ListResponse = { employees: Employee[]; fronts: Front[]; scopeFrontIds: number[]; companies: Company[]; alerts: Alerts; canManage: boolean; canSeeSalary: boolean; canManageCompanies: boolean; frontButtons?: boolean; changeFrontIds?: number[] | "ALL" };
type Tab = "painel" | "viagem" | "folga" | "retorno" | "historico" | "restritos";
const EMPTY: ListResponse = { employees: [], fronts: [], scopeFrontIds: [], companies: [], alerts: { offOverdue: 0, workExceeded: 0, approaching: 0 }, canManage: false, canSeeSalary: false, canManageCompanies: false };

// Aba → fases que ela mostra e a ação em lote disponível.
const TAB_PHASES: Partial<Record<Tab, Phase[]>> = { viagem: ["VIAGEM_IDA"], folga: ["FOLGA"], retorno: ["VIAGEM_VOLTA"] };
const TAB_BATCH: Partial<Record<Tab, { steps: CycleStep[]; label: string }>> = {
  viagem: { steps: ["homeArrival"], label: "Registrar chegada em casa" },
  folga: { steps: ["homeDeparture"], label: "Registrar saída de casa" },
  retorno: { steps: ["frontArrival"], label: "Registrar chegada na frente" },
};
const alertRank = (item: Employee) => {
  const alert = item.cycle?.summary.alert;
  if (!alert) return 9;
  return alert.kind === "OFF_OVERDUE" ? 0 : alert.kind === "WORK_EXCEEDED" ? 1 : 1 + alert.level;
};

export default function EmployeesView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [data, setData] = useState<ListResponse>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("painel");
  const [query, setQuery] = useState("");
  const [front, setFront] = useState("");
  const [company, setCompany] = useState("");
  const [situation, setSituation] = useState("");
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<Employee | null | "new">(null);
  const [transferring, setTransferring] = useState<Employee | null>(null);
  const [stepping, setStepping] = useState<{ employees: Employee[]; steps: CycleStep[]; label: string } | null>(null);
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const [functionsOpen, setFunctionsOpen] = useState(false);
  const [details, setDetails] = useState<number | null>(null);
  const [moduleFront, setModuleFront] = useState<number | "ALL">("ALL");
  const canManage = authUser.permissions.includes("employees.manage");
  // Todas as frentes aparecem para consulta e transferência; as demais alterações só nas frentes do login.
  const canChange = (item: { serviceFrontId: number }) => data.changeFrontIds === undefined || data.changeFrontIds === "ALL" || data.changeFrontIds.includes(item.serviceFrontId);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = [includeDismissed ? "includeDismissed=1" : "", frontParam(moduleFront)].filter(Boolean).join("&");
    try { setData(await api<ListResponse>(`/api/employees${params ? `?${params}` : ""}`)); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar os funcionários.")); }
    finally { setLoading(false); }
  }, [includeDismissed, moduleFront]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [tab, query, front, company, situation, onlyAlerts, includeDismissed]);

  const scopeFronts = data.fronts.filter((item) => data.scopeFrontIds.includes(item.id));
  const byPhase = useCallback((phases: Phase[]) => data.employees.filter((item) => item.status !== "DEMITIDO" && phases.includes(phaseOf(item))), [data.employees]);
  const counts = {
    working: byPhase(["SEM_CICLO", "TRABALHANDO"]).filter((item) => item.status !== "AFASTADO").length,
    viagem: byPhase(["VIAGEM_IDA"]).length, folga: byPhase(["FOLGA"]).length, retorno: byPhase(["VIAGEM_VOLTA"]).length,
    afastados: data.employees.filter((item) => item.status === "AFASTADO").length,
  };
  const items = useMemo(() => {
    const key = fold(query.trim());
    const phases = TAB_PHASES[tab];
    return data.employees.filter((item) => {
      if (phases && (item.status === "DEMITIDO" || !phases.includes(phaseOf(item)))) return false;
      if (key && !fold(`${item.name} ${item.jobTitle} ${item.company} ${item.registration ?? ""} ${item.city ?? ""}`).includes(key)) return false;
      if (front && item.serviceFrontId !== Number(front)) return false;
      if (company && item.company !== company) return false;
      if (tab === "painel" && situation && item.status !== situation) return false;
      if (onlyAlerts && !item.cycle?.summary.alert) return false;
      return true;
    }).sort((a, b) => (onlyAlerts || tab !== "painel" ? alertRank(a) - alertRank(b) : 0) || a.name.localeCompare(b.name, "pt-BR"));
  }, [data.employees, query, front, company, situation, onlyAlerts, tab]);

  // No Painel, o lote é "Iniciar folga" (e "Iniciar ciclo" para quem ainda não tem início): só
  // para quem está trabalhando na frente.
  const selectable = (item: Employee) => {
    if (!canManage || item.status === "DEMITIDO" || !canChange(item)) return false;
    if (tab === "painel") return item.status !== "AFASTADO" && (phaseOf(item) === "TRABALHANDO" || phaseOf(item) === "SEM_CICLO");
    return Boolean(TAB_PHASES[tab]);
  };
  const selectableItems = items.filter(selectable);
  const chosen = items.filter((item) => selected.has(item.id));
  const allChecked = selectableItems.length > 0 && selectableItems.every((item) => selected.has(item.id));
  const toggle = (id: number) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const refreshAfter = async (message: string) => { setEditing(null); setTransferring(null); setStepping(null); setSelected(new Set()); await load(); flash(message); };
  const alertTotal = data.alerts.offOverdue + data.alerts.workExceeded;
  const listTab = tab !== "historico" && tab !== "restritos";

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">CADASTRO DE PESSOAS</p><h1>Funcionários</h1><span>Cadastro por frente, transferências, ciclo de folga (trabalho → viagem → folga → retorno), afastamentos e demissões.</span></div>
        <div className="heading-actions">
          {data.canManageCompanies && <button className="secondary" onClick={() => setCompaniesOpen(true)}>Empresas</button>}
          <button className="secondary" onClick={() => setFunctionsOpen(true)}>Funções</button>
          {canManage && <button className="primary" onClick={() => setEditing("new")}>＋ Novo funcionário</button>}
        </div>
      </div>
      {data.frontButtons && <RegistryFrontButtons fronts={data.fronts} value={moduleFront} onChange={(value) => { setModuleFront(value); setFront(""); }} />}
      {alertTotal > 0 && (
        <div className="employee-alert-banner" role="alert">
          <span>!</span>
          <div><strong>{[data.alerts.offOverdue ? `${data.alerts.offOverdue} com folga estourada (ainda não saiu de casa)` : null, data.alerts.workExceeded ? `${data.alerts.workExceeded} com ciclo de trabalho vencido` : null].filter(Boolean).join(" · ")}</strong><p>{data.alerts.approaching ? `${data.alerts.approaching} com folga se aproximando (5 dias ou menos).` : "Confira e registre as etapas do ciclo."}</p></div>
          <button onClick={() => { setTab("painel"); setOnlyAlerts(true); }}>Ver funcionários</button>
        </div>
      )}
      <div className="fleet-front-cards employee-summary-cards">
        <article><span>♙</span><div><strong>{data.employees.filter((item) => item.status !== "DEMITIDO").length}</strong><small>Funcionários em exibição</small></div></article>
        <article><span>⚒</span><div><strong>{counts.working}</strong><small>Trabalhando na frente</small></div></article>
        <article><span>➜</span><div><strong>{counts.viagem + counts.retorno}</strong><small>Em viagem (ida + retorno)</small></div></article>
        <article><span>☾</span><div><strong>{counts.folga}</strong><small>De folga</small></div></article>
        <article><span>✚</span><div><strong>{counts.afastados}</strong><small>Afastados</small></div></article>
        <article className={alertTotal ? "danger" : ""}><span>⚠</span><div><strong>{alertTotal + data.alerts.approaching}</strong><small>Alertas do ciclo</small></div></article>
      </div>
      <div className="main-tabs secondary-module-nav employee-tabs" aria-label="Abas do módulo Funcionários">
        <button className={tab === "painel" ? "active" : ""} onClick={() => setTab("painel")}>Painel</button>
        <button className={tab === "viagem" ? "active" : ""} onClick={() => setTab("viagem")}>Em viagem <b className="nav-badge soft">{counts.viagem}</b></button>
        <button className={tab === "folga" ? "active" : ""} onClick={() => setTab("folga")}>De folga <b className={`nav-badge ${data.alerts.offOverdue ? "" : "soft"}`}>{counts.folga}</b></button>
        <button className={tab === "retorno" ? "active" : ""} onClick={() => setTab("retorno")}>Viagem de retorno <b className="nav-badge soft">{counts.retorno}</b></button>
        <button className={tab === "historico" ? "active" : ""} onClick={() => setTab("historico")}>Histórico</button>
        <button className={tab === "restritos" ? "active" : ""} onClick={() => setTab("restritos")}>Restritos</button>
      </div>
      {tab === "historico" && <EmployeesHistory companies={data.companies} open={setDetails} frontQuery={data.frontButtons ? frontParam(moduleFront) : ""} />}
      {tab === "restritos" && <RestrictedList open={setDetails} />}
      {listTab && (
        <article className="panel module-panel equipment-management-panel">
          <div className="equipment-management-filters employee-filters">
            <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar nome, matrícula, função, empresa ou cidade..." /></label>
            {scopeFronts.length > 1 && <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas</option>{scopeFronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            <label>Empresa<select value={company} onChange={(event) => setCompany(event.target.value)}><option value="">Todas</option>{data.companies.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
            {tab === "painel" && <label>Status<select value={situation} onChange={(event) => setSituation(event.target.value)}><option value="">Todos</option><option value="ATIVO">Ativo</option><option value="FOLGA">De folga</option><option value="AFASTADO">Afastado</option>{includeDismissed && <option value="DEMITIDO">Demitido</option>}</select></label>}
            <label className="products-review-toggle"><input type="checkbox" checked={onlyAlerts} onChange={(event) => setOnlyAlerts(event.target.checked)} /><strong>Só com alerta</strong></label>
            {tab === "painel" && <label className="products-review-toggle"><input type="checkbox" checked={includeDismissed} onChange={(event) => setIncludeDismissed(event.target.checked)} /><strong>Mostrar demitidos</strong></label>}
          </div>
          {canManage && chosen.length > 0 && (
            <div className="employee-batch-bar">
              <strong>{chosen.length} selecionado(s)</strong>
              {tab === "painel" && chosen.some((item) => phaseOf(item) === "SEM_CICLO") && <button className="secondary" onClick={() => setStepping({ employees: chosen.filter((item) => phaseOf(item) === "SEM_CICLO"), steps: ["workStart"], label: "Iniciar ciclo em lote" })}>Iniciar ciclo ({chosen.filter((item) => phaseOf(item) === "SEM_CICLO").length})</button>}
              {tab === "painel" && <button className="primary" onClick={() => setStepping({ employees: chosen, steps: ["frontDeparture", "homeArrival"], label: "Iniciar Folga em Lote" })}>Iniciar Folga em Lote</button>}
              {TAB_BATCH[tab] && <button className="primary" onClick={() => setStepping({ employees: chosen, ...TAB_BATCH[tab]! })}>{TAB_BATCH[tab]!.label}</button>}
              <button className="link-button" onClick={() => setSelected(new Set())}>Limpar seleção</button>
            </div>
          )}
          {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
          {loading ? <div className="page-loading"><span /><p>Carregando funcionários...</p></div> : (
            <div className="table-scroll">
              <table className="equipment-management-table employee-table">
                <thead><tr>
                  {canManage && <th className="employee-check"><input type="checkbox" aria-label="Selecionar todos" disabled={selectableItems.length === 0} checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(selectableItems.map((item) => item.id)))} /></th>}
                  <th>Funcionário</th><th>Empresa</th><th>Frente</th>
                  {tab === "painel" && <><th>Status</th><th>Ciclo</th><th>Dias trabalhados</th></>}
                  {tab === "viagem" && <><th>Saída da frente</th><th>Dias de viagem</th></>}
                  {tab === "folga" && <><th>Chegada em casa</th><th>Dias de folga</th><th>Alerta</th></>}
                  {tab === "retorno" && <><th>Saída de casa</th><th>Dias de viagem</th></>}
                  <th>Ações</th>
                </tr></thead>
                <tbody>
                  {items.map((item) => {
                    const cycle = item.cycle;
                    const summary = cycle?.summary;
                    const action = canManage && canChange(item) ? nextAction(item) : null;
                    const danger = summary?.alert?.kind === "OFF_OVERDUE" || summary?.alert?.kind === "WORK_EXCEEDED";
                    return (
                      <tr key={item.id} className={`${danger ? "employee-row-danger" : summary?.alert ? "employee-row-warning" : ""} ${selected.has(item.id) ? "employee-row-selected" : ""}`}>
                        {canManage && <td className="employee-check"><input type="checkbox" aria-label={`Selecionar ${item.name}`} disabled={!selectable(item)} checked={selected.has(item.id)} onChange={() => toggle(item.id)} /></td>}
                        <td><div className="machine-cell"><span>{initials(item.name)}</span><div><strong>{item.name}</strong><small>{item.jobTitle}{item.registration ? ` · Mat. ${item.registration}` : ""}</small></div></div></td>
                        <td>{item.company}</td>
                        <td><span className="front-pill">{item.frontName}</span><small className="table-sub">há {dayCount(item.daysInFront)}</small></td>
                        {tab === "painel" && <>
                          <td><SituationPills item={item} /></td>
                          <td>{cycle ? <><strong className="table-strong">{summary!.phaseLabel}</strong><small className="table-sub">Ciclo nº {cycle.cycleNumber}</small></> : <small className="table-sub">Ciclo não iniciado</small>}</td>
                          <td>{summary?.phase === "TRABALHANDO" ? <div className="employee-progress"><span><b style={{ width: `${Math.min(100, ((summary.workedDays ?? 0) / cycle!.workDaysTarget) * 100)}%` }} /></span><small>{summary.workedDays} / {cycle!.workDaysTarget}</small><AlertChip alert={summary.alert} /></div> : summary?.alert ? <AlertChip alert={summary.alert} /> : "—"}</td>
                        </>}
                        {tab === "viagem" && <><td>{brDay(cycle?.frontDeparture)}</td><td>{dayCount(summary?.travelOutDays)}</td></>}
                        {tab === "folga" && <><td>{brDay(cycle?.homeArrival)}</td><td><strong className="table-strong">{summary?.offDays ?? "—"}</strong> / {cycle?.offDaysTarget}</td><td><AlertChip alert={summary?.alert} />{!summary?.alert && "—"}</td></>}
                        {tab === "retorno" && <><td>{brDay(cycle?.homeDeparture)}</td><td>{dayCount(summary?.travelBackDays)}</td></>}
                        <td><div className="equipment-row-actions">
                          <button onClick={() => setDetails(item.id)}>Ver</button>
                          {action && item.status !== "AFASTADO" && <button className="primary-lite" onClick={() => setStepping({ employees: [item], ...action })}>{action.label}</button>}
                          {canManage && canChange(item) && tab === "painel" && item.status !== "DEMITIDO" && <button onClick={() => setEditing(item)}>Editar</button>}
                          {canManage && tab === "painel" && item.status !== "DEMITIDO" && <button className="transfer-action" onClick={() => setTransferring(item)}>Transferir</button>}
                        </div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {items.length === 0 && <div className="empty-state">{data.employees.length ? "Nenhum funcionário nesta aba com os filtros atuais." : "Nenhum funcionário cadastrado nas frentes em exibição."}</div>}
            </div>
          )}
        </article>
      )}
      {editing && <EmployeeForm item={editing === "new" ? null : editing} fronts={data.fronts.filter((front) => canChange({ serviceFrontId: front.id }))} companies={data.companies} canSeeSalary={data.canSeeSalary} close={() => setEditing(null)} saved={refreshAfter} />}
      {transferring && <TransferModal item={transferring} fronts={data.fronts} close={() => setTransferring(null)} saved={refreshAfter} />}
      {stepping && <StepModal employees={stepping.employees} steps={stepping.steps} title={stepping.label} close={() => setStepping(null)} saved={refreshAfter} />}
      {functionsOpen && <JobFunctionsModal close={() => setFunctionsOpen(false)} flash={flash} />}
      {companiesOpen && <CompaniesModal companies={data.companies} close={() => setCompaniesOpen(false)} changed={async (message) => { await load(); flash(message); }} />}
      {details !== null && <EmployeeProfile id={details} canManage={canManage} canSeeSalary={data.canSeeSalary} fronts={data.fronts} close={() => setDetails(null)} changed={load} flash={flash}
        edit={(item) => { setDetails(null); setEditing(item); }} />}
    </>
  );
}
