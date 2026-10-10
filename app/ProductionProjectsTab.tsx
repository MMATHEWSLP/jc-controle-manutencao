"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, brDay, jsonBody, problemText } from "./stock-client";
import { frontsQuery, localToday, money, ProductionEmployeePicker, StageBadge, type ProductionContext, type ProductionEmployee, type ProductionFront, type ProductionReason } from "./production-client";
import { PRODUCTION_STAGES, type StageStatus } from "../lib/production-rules";

// PRODUÇÃO → Projetos: Projetos | Equipes | Preços por frente | Motivos. Cadastrar e editar exige
// producao.gerenciar; os preços só aparecem para quem vê os custos (producao.custos); motivos, só o ADMIN edita.

type Props = { context: ProductionContext; selectedFronts: number[]; sub: string | null; setSub: (sub: string | null) => void; flash: (message: string) => void };
type StageEvent = { action: string; userName: string | null; occurredAt: string } | null;
type Project = {
  id: number; serviceFrontId: number; frontName: string; name: string; camp: string | null; active: boolean;
  fellingStatus: StageStatus; skiddingStatus: StageStatus; measurementStatus: StageStatus; haulingStatus: StageStatus; stageEvents: Record<string, StageEvent>;
};
type Team = { id: number; serviceFrontId: number; frontName: string; name: string; active: boolean; leaderEmployeeId: number | null; leaderName: string | null; leaderJobTitle: string | null; activeMembers: number };
type Member = { id: number; employeeId: number; name: string; jobTitle: string; company: string; employeeStatus: string; joinedAt: string; leftAt: string | null };
type PriceProduct = { id: number; tag: string; name: string; price: number; active: boolean; frontPrices: Record<string, number> };
type Candidate = { id: number; tag: string; name: string; price: number };

const SUBS = [
  { key: "projetos", label: "Projetos" },
  { key: "equipes", label: "Equipes" },
  { key: "precos", label: "Preços por frente" },
  { key: "motivos", label: "Motivos" },
] as const;

const failure = (problem: unknown, fallback: string) => window.alert(problemText(problem, fallback));

export default function ProductionProjectsTab({ context, selectedFronts, sub, setSub, flash }: Props) {
  const subs = SUBS.filter((item) => item.key !== "precos" || context.access.costs);
  const active = subs.some((item) => item.key === sub) ? sub! : "projetos";
  const scopeFronts = useMemo(() => (selectedFronts.length ? context.fronts.filter((front) => selectedFronts.includes(front.id)) : context.fronts), [context.fronts, selectedFronts]);
  const query = frontsQuery(selectedFronts);
  return <>
    <div className="filter-chips production-subtabs" role="tablist" aria-label="Subabas de Projetos">
      {subs.map((item) => <button key={item.key} type="button" role="tab" aria-selected={active === item.key} className={active === item.key ? "selected" : ""} onClick={() => setSub(item.key === "projetos" ? null : item.key)}>{item.label}</button>)}
    </div>
    {active === "projetos" && <ProjectsPanel context={context} fronts={scopeFronts} query={query} flash={flash} />}
    {active === "equipes" && <TeamsPanel context={context} fronts={scopeFronts} query={query} flash={flash} />}
    {active === "precos" && <PricesPanel context={context} query={query} flash={flash} />}
    {active === "motivos" && <ReasonsPanel context={context} flash={flash} />}
  </>;
}

function FrontSelect({ fronts, value, onChange }: { fronts: ProductionFront[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} required onChange={(event) => onChange(event.target.value)}>
    {fronts.length > 1 && <option value="">Escolha</option>}
    {fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
  </select>;
}

function SituationChips({ value, onChange, labels }: { value: "ativos" | "inativos"; onChange: (value: "ativos" | "inativos") => void; labels: [string, string] }) {
  return <div className="filter-chips">
    <button type="button" className={value === "ativos" ? "selected" : ""} onClick={() => onChange("ativos")}>{labels[0]}</button>
    <button type="button" className={value === "inativos" ? "selected" : ""} onClick={() => onChange("inativos")}>{labels[1]}</button>
  </div>;
}

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------
function ProjectsPanel({ context, fronts, query, flash }: { context: ProductionContext; fronts: ProductionFront[]; query: string; flash: (message: string) => void }) {
  const [situation, setSituation] = useState<"ativos" | "inativos">("ativos");
  const [rows, setRows] = useState<Project[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Project | null>(null);
  const url = `/api/producao/projetos?${[query, `situacao=${situation}`].filter(Boolean).join("&")}`;
  const load = useCallback(() => { setError(""); api<{ projects: Project[] }>(url).then((result) => setRows(result.projects)).catch((problem) => setError(problemText(problem, "Não foi possível carregar os projetos."))); }, [url]);
  useEffect(() => { load(); }, [load]);
  const manage = context.access.manage;

  async function toggle(project: Project) {
    const verb = project.active ? "Inativar" : "Reativar";
    if (!window.confirm(`${verb} o projeto ${project.name}?${project.active ? " Ele sai das listas de lançamento, mas o histórico fica guardado." : ""}`)) return;
    try { flash((await api<{ message: string }>(`/api/producao/projetos/${project.id}`, jsonBody("PATCH", { acao: project.active ? "inativar" : "reativar" }))).message); load(); }
    catch (problem) { failure(problem, `Não foi possível ${verb.toLowerCase()} o projeto.`); }
  }

  return <article className="panel module-panel production-panel">
    {manage && <NewProjectForm fronts={fronts} saved={(message) => { flash(message); load(); }} />}
    <div className="production-list-head"><h2>Projetos</h2><SituationChips value={situation} onChange={setSituation} labels={["Ativos", "Inativos"]} /></div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!rows && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : rows && <div className="table-scroll"><table className="products-table production-table">
      <thead><tr><th>Projeto</th><th>Frente</th><th>Alojamento</th>{PRODUCTION_STAGES.map((stage) => <th key={stage.key}>{stage.label}</th>)}{manage && <th />}</tr></thead>
      <tbody>{rows.map((project) => <tr key={project.id}>
        <td data-label="Projeto"><strong>{project.name}</strong></td>
        <td data-label="Frente">{project.frontName}</td>
        <td data-label="Alojamento">{project.camp ?? "—"}</td>
        {PRODUCTION_STAGES.map((stage) => {
          const event = project.stageEvents[stage.key];
          return <td key={stage.key} data-label={stage.label} title={event ? `${event.action === "FINALIZOU" ? "Finalizada" : "Reaberta"} por ${event.userName ?? "—"} em ${brDay(event.occurredAt)}` : undefined}><StageBadge status={project[stage.status]} /></td>;
        })}
        {manage && <td><div className="equipment-row-actions"><button type="button" onClick={() => setEditing(project)}>Editar</button><button type="button" onClick={() => toggle(project)}>{project.active ? "Inativar" : "Reativar"}</button></div></td>}
      </tr>)}</tbody>
    </table>{rows.length === 0 && <div className="empty-state">{situation === "ativos" ? "Nenhum projeto ativo nas frentes em exibição." : "Nenhum projeto inativo."}</div>}</div>}
    {editing && <ProjectModal project={editing} close={() => setEditing(null)} saved={(message) => { setEditing(null); flash(message); load(); }} />}
  </article>;
}

function NewProjectForm({ fronts, saved }: { fronts: ProductionFront[]; saved: (message: string) => void }) {
  const [frontId, setFrontId] = useState(fronts.length === 1 ? String(fronts[0].id) : "");
  const [name, setName] = useState("");
  const [camp, setCamp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (fronts.length === 1) setFrontId(String(fronts[0].id)); else if (!fronts.some((front) => String(front.id) === frontId)) setFrontId(""); }, [fronts, frontId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { saved((await api<{ message: string }>("/api/producao/projetos", jsonBody("POST", { serviceFrontId: Number(frontId), name, camp }))).message); setName(""); setCamp(""); }
    catch (problem) { setError(problemText(problem, "Não foi possível cadastrar o projeto.")); }
    finally { setBusy(false); }
  }
  return <form className="production-form" onSubmit={submit}>
    <h3>Novo projeto</h3>
    <label>Frente<FrontSelect fronts={fronts} value={frontId} onChange={setFrontId} /></label>
    <label>Nome do projeto<input value={name} required maxLength={120} placeholder="Fazenda / UPA" onChange={(event) => setName(event.target.value)} /></label>
    <label>Alojamento (opcional)<input value={camp} maxLength={120} onChange={(event) => setCamp(event.target.value)} /></label>
    <button className="primary" disabled={busy}>{busy ? "Salvando..." : "Cadastrar projeto"}</button>
    {error && <p className="fleet-form-error full">! {error}</p>}
  </form>;
}

function ProjectModal({ project, close, saved }: { project: Project; close: () => void; saved: (message: string) => void }) {
  const [name, setName] = useState(project.name);
  const [camp, setCamp] = useState(project.camp ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { saved((await api<{ message: string }>(`/api/producao/projetos/${project.id}`, jsonBody("PATCH", { acao: "editar", name, camp }))).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }
  return <Modal title="Editar projeto" subtitle={`Frente ${project.frontName}. A frente não muda depois do cadastro: projeto na frente errada, inative e cadastre de novo.`} close={close} busy={busy}>
    <form className="modal-form" onSubmit={submit}>
      <label className="full">Nome do projeto<input value={name} required maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <label className="full">Alojamento (opcional)<input value={camp} maxLength={120} onChange={(event) => setCamp(event.target.value)} /></label>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button></div>
    </form>
  </Modal>;
}

function Modal({ title, subtitle, close, busy, children, wide }: { title: string; subtitle?: string; close: () => void; busy?: boolean; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className={`modal production-modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
      <header><div><p className="eyebrow">PRODUÇÃO</p><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      {children}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Equipes
// ---------------------------------------------------------------------------
function TeamsPanel({ context, fronts, query, flash }: { context: ProductionContext; fronts: ProductionFront[]; query: string; flash: (message: string) => void }) {
  const [situation, setSituation] = useState<"ativos" | "inativos">("ativos");
  const [rows, setRows] = useState<Team[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Team | null>(null);
  const [members, setMembers] = useState<Team | null>(null);
  const url = `/api/producao/equipes?${[query, `situacao=${situation === "ativos" ? "ativas" : "inativas"}`].filter(Boolean).join("&")}`;
  const load = useCallback(() => { setError(""); api<{ teams: Team[] }>(url).then((result) => setRows(result.teams)).catch((problem) => setError(problemText(problem, "Não foi possível carregar as equipes."))); }, [url]);
  useEffect(() => { load(); }, [load]);
  const manage = context.access.manage;

  async function toggle(team: Team) {
    const verb = team.active ? "Inativar" : "Reativar";
    if (!window.confirm(`${verb} a equipe ${team.name}?`)) return;
    try { flash((await api<{ message: string }>(`/api/producao/equipes/${team.id}`, jsonBody("PATCH", { acao: team.active ? "inativar" : "reativar" }))).message); load(); }
    catch (problem) { failure(problem, `Não foi possível ${verb.toLowerCase()} a equipe.`); }
  }

  return <article className="panel module-panel production-panel">
    {manage && <TeamForm fronts={fronts} saved={(message) => { flash(message); load(); }} />}
    <div className="production-list-head"><h2>Equipes</h2><SituationChips value={situation} onChange={setSituation} labels={["Ativas", "Inativas"]} /></div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!rows && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : rows && <div className="table-scroll"><table className="products-table production-table">
      <thead><tr><th>Equipe</th><th>Frente</th><th>Responsável</th><th className="num">Integrantes ativos</th><th>Situação</th><th /></tr></thead>
      <tbody>{rows.map((team) => <tr key={team.id}>
        <td data-label="Equipe"><strong>{team.name}</strong></td>
        <td data-label="Frente">{team.frontName}</td>
        <td data-label="Responsável">{team.leaderName ? <>{team.leaderName}<small className="production-sub"> {team.leaderJobTitle}</small></> : "—"}</td>
        <td data-label="Integrantes ativos" className="num">{team.activeMembers}</td>
        <td data-label="Situação"><span className={`production-badge ${team.active ? "done" : "none"}`}>{team.active ? "Ativa" : "Inativa"}</span></td>
        <td><div className="equipment-row-actions">
          <button type="button" onClick={() => setMembers(team)}>{manage ? "Gerenciar integrantes" : "Integrantes"}</button>
          {manage && <><button type="button" onClick={() => setEditing(team)}>Editar</button><button type="button" onClick={() => toggle(team)}>{team.active ? "Inativar" : "Reativar"}</button></>}
        </div></td>
      </tr>)}</tbody>
    </table>{rows.length === 0 && <div className="empty-state">{situation === "ativos" ? "Nenhuma equipe ativa nas frentes em exibição." : "Nenhuma equipe inativa."}</div>}</div>}
    {editing && <Modal title="Editar equipe" subtitle={`Frente ${editing.frontName}.`} close={() => setEditing(null)}>
      <TeamForm fronts={fronts} team={editing} saved={(message) => { setEditing(null); flash(message); load(); }} />
    </Modal>}
    {members && <TeamMembersModal team={members} manage={manage} close={() => { setMembers(null); load(); }} flash={flash} />}
  </article>;
}

function TeamForm({ fronts, team, saved }: { fronts: ProductionFront[]; team?: Team; saved: (message: string) => void }) {
  const [frontId, setFrontId] = useState(team ? String(team.serviceFrontId) : fronts.length === 1 ? String(fronts[0].id) : "");
  const [name, setName] = useState(team?.name ?? "");
  const [leader, setLeader] = useState<ProductionEmployee | null>(team?.leaderEmployeeId ? { id: team.leaderEmployeeId, name: team.leaderName ?? "", jobTitle: team.leaderJobTitle ?? "", company: "", frontName: team.frontName } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = { serviceFrontId: Number(frontId), name, leaderEmployeeId: leader?.id ?? null };
      saved((await api<{ message: string }>(team ? `/api/producao/equipes/${team.id}` : "/api/producao/equipes", jsonBody(team ? "PATCH" : "POST", team ? { ...body, acao: "editar" } : body))).message);
      if (!team) { setName(""); setLeader(null); }
    } catch (problem) { setError(problemText(problem, "Não foi possível salvar a equipe.")); }
    finally { setBusy(false); }
  }
  return <form className={team ? "modal-form" : "production-form"} onSubmit={submit}>
    {!team && <h3>Nova equipe</h3>}
    {!team && <label>Frente<FrontSelect fronts={fronts} value={frontId} onChange={setFrontId} /></label>}
    <label className={team ? "full" : ""}>Nome da equipe<input value={name} required maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
    <label className={team ? "full" : "production-form-wide"}>Responsável<ProductionEmployeePicker value={leader} onPick={setLeader} frontId={Number(frontId) || null} group="SKIDDER" placeholder="Buscar operador de skidder..." /></label>
    {error && <p className="fleet-form-error full">! {error}</p>}
    {team ? <div className="modal-footer full"><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button></div> : <button className="primary" disabled={busy}>{busy ? "Salvando..." : "Cadastrar equipe"}</button>}
  </form>;
}

function TeamMembersModal({ team, manage, close, flash }: { team: Team; manage: boolean; close: () => void; flash: (message: string) => void }) {
  const [rows, setRows] = useState<Member[] | null>(null);
  const [error, setError] = useState("");
  const [employee, setEmployee] = useState<ProductionEmployee | null>(null);
  const [joinedAt, setJoinedAt] = useState(localToday());
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<{ id: number; date: string } | null>(null);
  const load = useCallback(() => { api<{ members: Member[] }>(`/api/producao/equipes/${team.id}`).then((result) => setRows(result.members)).catch((problem) => setError(problemText(problem, "Não foi possível carregar os integrantes."))); }, [team.id]);
  useEffect(() => { load(); }, [load]);
  const base = `/api/producao/equipes/${team.id}/integrantes`;
  async function run(action: () => Promise<{ message: string }>) {
    setBusy(true); setError("");
    try { flash((await action()).message); load(); return true; }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); return false; }
    finally { setBusy(false); }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!employee) { setError("Escolha o funcionário."); return; }
    if (await run(() => api(base, jsonBody("POST", { employeeId: employee.id, joinedAt })))) setEmployee(null);
  }
  const leave = async (member: Member, date: string) => {
    if (await run(() => api(base, jsonBody("PATCH", { memberId: member.id, joinedAt: member.joinedAt, leftAt: date })))) setLeaving(null);
  };
  const back = (member: Member) => run(() => api(base, jsonBody("PATCH", { memberId: member.id, joinedAt: member.joinedAt, leftAt: null })));
  const remove = (member: Member) => {
    if (!window.confirm(`Excluir ${member.name} da equipe? Use só para corrigir uma inclusão por engano; quem saiu da equipe ganha data de saída.`)) return;
    run(() => api(`${base}?integrante=${member.id}`, { method: "DELETE" }));
  };
  return <Modal title={`Integrantes — ${team.name}`} subtitle={`Frente ${team.frontName}. Quem sai da equipe fica no histórico com a data de saída.`} close={close} busy={busy} wide>
    <div className="production-modal-body">
      {manage && <form className="production-form compact" onSubmit={add}>
        <label className="production-form-wide">Funcionário<ProductionEmployeePicker value={employee} onPick={setEmployee} frontId={team.serviceFrontId} group={null} /></label>
        <label>Entrada<input type="date" value={joinedAt} required max={localToday()} onChange={(event) => setJoinedAt(event.target.value)} /></label>
        <button className="primary" disabled={busy}>Incluir</button>
      </form>}
      {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      {!rows ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Funcionário</th><th>Função</th><th>Empresa</th><th>Entrada</th><th>Saída</th>{manage && <th />}</tr></thead>
        <tbody>{rows.map((member) => <tr key={member.id} className={member.leftAt ? "production-row-muted" : ""}>
          <td data-label="Funcionário"><strong>{member.name}</strong>{member.employeeStatus === "DEMITIDO" && <small className="production-sub"> desligado</small>}</td>
          <td data-label="Função">{member.jobTitle}</td>
          <td data-label="Empresa">{member.company}</td>
          <td data-label="Entrada">{brDay(member.joinedAt)}</td>
          <td data-label="Saída">{member.leftAt ? brDay(member.leftAt) : "—"}</td>
          {manage && <td><div className="equipment-row-actions">
            {member.leftAt ? <button type="button" disabled={busy} onClick={() => back(member)}>Voltar à equipe</button>
              : leaving?.id === member.id ? <><input type="date" aria-label={`Data de saída de ${member.name}`} value={leaving.date} min={member.joinedAt} max={localToday()} onChange={(event) => setLeaving({ id: member.id, date: event.target.value })} />
                <button type="button" disabled={busy || !leaving.date} onClick={() => leave(member, leaving.date)}>Confirmar saída</button><button type="button" onClick={() => setLeaving(null)}>Cancelar</button></>
              : <button type="button" disabled={busy} onClick={() => setLeaving({ id: member.id, date: localToday() })}>Registrar saída</button>}
            <button type="button" disabled={busy} onClick={() => remove(member)}>Excluir</button>
          </div></td>}
        </tr>)}</tbody>
      </table>{rows.length === 0 && <div className="empty-state">Nenhum integrante.</div>}</div>}
    </div>
  </Modal>;
}

// ---------------------------------------------------------------------------
// Preços por frente (produtos marcados "Usar na Produção")
// ---------------------------------------------------------------------------
function PricesPanel({ context, query, flash }: { context: ProductionContext; query: string; flash: (message: string) => void }) {
  const [data, setData] = useState<{ products: PriceProduct[]; fronts: ProductionFront[] } | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const manage = context.access.manage;
  const load = useCallback(() => { setError(""); api<{ products: PriceProduct[]; fronts: ProductionFront[] }>(`/api/producao/precos?${query}`).then((result) => { setData(result); setDrafts({}); }).catch((problem) => setError(problemText(problem, "Não foi possível carregar os preços."))); }, [query]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (search.trim().length < 2) { setCandidates([]); return; }
    const timer = window.setTimeout(() => { api<{ candidates: Candidate[] }>(`/api/producao/precos?buscar=${encodeURIComponent(search.trim())}`).then((result) => setCandidates(result.candidates)).catch(() => setCandidates([])); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  async function mark(productId: number, productionUse: boolean, label: string) {
    if (!productionUse && !window.confirm(`Retirar ${label} da Produção? Os preços por frente dele continuam guardados.`)) return;
    setBusy(`mark-${productId}`);
    try { flash((await api<{ message: string }>("/api/producao/precos", jsonBody("POST", { productId, productionUse }))).message); setSearch(""); load(); }
    catch (problem) { failure(problem, "Não foi possível alterar o produto."); }
    finally { setBusy(""); }
  }
  async function savePrice(productId: number, frontId: number) {
    const key = `${productId}:${frontId}`;
    setBusy(key);
    try { flash((await api<{ message: string }>("/api/producao/precos", jsonBody("PUT", { productId, serviceFrontId: frontId, price: drafts[key] ?? "" }))).message); load(); }
    catch (problem) { failure(problem, "Não foi possível salvar o preço."); }
    finally { setBusy(""); }
  }

  return <article className="panel module-panel production-panel">
    <p className="production-help">Os produtos marcados para uso na Produção ficam disponíveis nos lançamentos da Derruba e do Arraste, com o preço do produto ou um preço específico por frente. Gasolina e diesel não entram aqui: o valor deles vem do estoque do Combustível (custo médio).</p>
    {manage && <div className="production-form">
      <h3>Marcar produto para a Produção</h3>
      <label className="production-form-wide">Buscar no estoque por TAG ou nome<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Ex.: lima, corrente, sabre, óleo 2 tempos..." /></label>
      {candidates.length > 0 && <ul className="production-candidates full">{candidates.map((item) => <li key={item.id}>
        <span><b>{item.tag}</b> {item.name} <small>· {money(item.price)}</small></span>
        <button type="button" className="secondary" disabled={busy === `mark-${item.id}`} onClick={() => mark(item.id, true, item.name)}>Marcar</button>
      </li>)}</ul>}
      {search.trim().length >= 2 && candidates.length === 0 && <p className="production-help full">Nenhum produto ativo e ainda não marcado com esse texto.</p>}
    </div>}
    {error && <div className="fleet-form-error">! {error}</div>}
    {!data && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : data && <div className="table-scroll"><table className="products-table production-table production-prices">
      <thead><tr><th>Produto</th><th className="num">Preço do produto</th>{data.fronts.map((front) => <th key={front.id} className="num">{front.name}</th>)}{manage && <th />}</tr></thead>
      <tbody>{data.products.map((product) => <tr key={product.id}>
        <td data-label="Produto"><b>{product.tag}</b> {product.name}{!product.active && <small className="production-sub"> inativo no estoque</small>}</td>
        <td data-label="Preço do produto" className="num">{money(product.price)}</td>
        {data.fronts.map((front) => {
          const key = `${product.id}:${front.id}`;
          const saved = product.frontPrices[front.id];
          const draft = drafts[key] ?? (saved === undefined ? "" : saved.toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
          return <td key={front.id} data-label={front.name} className="num">{manage ? <div className="production-price-cell">
            <input inputMode="decimal" value={draft} placeholder={money(product.price)} aria-label={`Preço de ${product.name} em ${front.name}`} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
            <button type="button" className="secondary" disabled={busy === key || drafts[key] === undefined} onClick={() => savePrice(product.id, front.id)}>Salvar</button>
          </div> : saved === undefined ? <small className="production-sub">{money(product.price)}</small> : money(saved)}</td>;
        })}
        {manage && <td><div className="equipment-row-actions"><button type="button" disabled={busy === `mark-${product.id}`} onClick={() => mark(product.id, false, product.name)}>Retirar</button></div></td>}
      </tr>)}</tbody>
    </table>{data.products.length === 0 && <div className="empty-state">Nenhum produto marcado para a Produção ainda.</div>}
      {data.products.length > 0 && <p className="production-help">Preço vazio na frente = vale o preço do produto. Para voltar ao preço do produto, apague o valor e clique em Salvar.</p>}
    </div>}
  </article>;
}

// ---------------------------------------------------------------------------
// Motivos de produção baixa/zero
// ---------------------------------------------------------------------------
function ReasonsPanel({ context, flash }: { context: ProductionContext; flash: (message: string) => void }) {
  const [rows, setRows] = useState<ProductionReason[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ProductionReason | "new" | null>(null);
  const admin = context.access.admin;
  const load = useCallback(() => { api<{ reasons: ProductionReason[] }>(`/api/producao/motivos?todos=1`).then((result) => setRows(result.reasons)).catch((problem) => setError(problemText(problem, "Não foi possível carregar os motivos."))); }, []);
  useEffect(() => { load(); }, [load]);
  async function toggle(reason: ProductionReason) {
    if (!window.confirm(`${reason.active ? "Inativar" : "Reativar"} o motivo ${reason.code}?`)) return;
    try { flash((await api<{ message: string }>("/api/producao/motivos", jsonBody("PATCH", { ...reason, active: !reason.active }))).message); load(); }
    catch (problem) { failure(problem, "Não foi possível alterar o motivo."); }
  }
  return <article className="panel module-panel production-panel">
    <div className="production-list-head"><h2>Motivos de produção baixa ou zero</h2>{admin && <button type="button" className="primary" onClick={() => setEditing("new")}>＋ Novo motivo</button>}</div>
    <p className="production-help">Usados na justificativa dos lançamentos da Derruba e do Arraste. {admin ? "Motivo inativo não aparece nos lançamentos novos, mas continua no histórico." : "Só o administrador edita esta lista."}</p>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!rows && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : rows && <div className="table-scroll"><table className="products-table production-table">
      <thead><tr><th>Código</th><th>Descrição</th><th>Situação</th>{admin && <th />}</tr></thead>
      <tbody>{rows.map((reason) => <tr key={reason.id} className={reason.active ? "" : "production-row-muted"}>
        <td data-label="Código"><strong>{reason.code}</strong></td><td data-label="Descrição">{reason.description}</td>
        <td data-label="Situação"><span className={`production-badge ${reason.active ? "done" : "none"}`}>{reason.active ? "Ativo" : "Inativo"}</span></td>
        {admin && <td><div className="equipment-row-actions"><button type="button" onClick={() => setEditing(reason)}>Editar</button><button type="button" onClick={() => toggle(reason)}>{reason.active ? "Inativar" : "Reativar"}</button></div></td>}
      </tr>)}</tbody>
    </table>{rows.length === 0 && <div className="empty-state">Nenhum motivo cadastrado.</div>}</div>}
    {editing && <ReasonModal reason={editing === "new" ? null : editing} close={() => setEditing(null)} saved={(message) => { setEditing(null); flash(message); load(); }} />}
  </article>;
}

function ReasonModal({ reason, close, saved }: { reason: ProductionReason | null; close: () => void; saved: (message: string) => void }) {
  const [code, setCode] = useState(reason?.code ?? "");
  const [description, setDescription] = useState(reason?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { saved((await api<{ message: string }>("/api/producao/motivos", jsonBody(reason ? "PATCH" : "POST", { id: reason?.id, code, description, active: reason?.active ?? true }))).message); }
    catch (problem) { setError(problemText(problem, "Não foi possível salvar o motivo.")); }
    finally { setBusy(false); }
  }
  return <Modal title={reason ? "Editar motivo" : "Novo motivo"} close={close} busy={busy}>
    <form className="modal-form" onSubmit={submit}>
      <label>Código<input value={code} required maxLength={12} placeholder="C.09" onChange={(event) => setCode(event.target.value)} /></label>
      <label className="full">Descrição<input value={description} required maxLength={120} placeholder="MADEIRA GROSSA" onChange={(event) => setDescription(event.target.value)} /></label>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button></div>
    </form>
  </Modal>;
}
