"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { ApiError, api, brDateTime, brDay, jsonBody, problemText } from "./stock-client";
import ProductionFellingGrid, { type LaunchProject } from "./ProductionFellingGrid";
import {
  Modal, money, monthPeriod, number, PeriodFilter, periodQuery, ProductionEmployeePicker, StageBadge,
  type Period, type ProductionContext, type ProductionEmployee, type ProductionFront, type ProductionReason,
} from "./production-client";
import { acceptsLaunch, type StageStatus, type TargetResult } from "../lib/production-rules";

// PRODUÇÃO → Derruba: Produção Diária (Projetos | Lançamento | Acumulado por Operador | Histórico),
// Despesas e Perdas e Análises (só quem vê os custos) e Multi-Frente (só produção, sem R$).
// A subaba fica na URL (?sub=...). Lançar exige producao.lancar; finalizar/reabrir e metas, producao.gerenciar.
function Loading() { return <div className="page-loading"><span /><p>Carregando...</p></div>; }
const ProductionFellingExpenses = dynamic(() => import("./ProductionFellingExpenses"), { loading: Loading });

type Props = { context: ProductionContext; selectedFronts: number[]; sub: string | null; setSub: (sub: string | null) => void; flash: (message: string) => void };
export type FellingCard = {
  id: number; name: string; frontName: string; serviceFrontId: number; status: StageStatus; notes: string | null;
  trees: number; ipes: number; days: number; operators: number; perDay: number | null; lastUpdate: string | null; lastDay: string | null;
};
type HistoryRow = {
  id: number; projectId: number; projectName: string; projectStatus: StageStatus; frontId: number; frontName: string; date: string; operatorId: number; operatorName: string; operatorCompany: string;
  helperId: number | null; helperName: string | null; trees: number; ipes: number; gasolineLiters: number; reasonId: number | null; reason: string | null; justification: string | null;
  target: number | null; result: TargetResult; resultLabel: string; gasolineValue: number | null;
};
type Accumulated = { operatorId: number; operatorName: string; trees: number; ipes: number; days: number; perDay: number | null };
type Analysis = {
  kpis: { operators: number; trees: number; perDay: number | null; ipes: number; cost: number; litersWithoutValue: number };
  byOperator: Array<{ operatorId: number; operatorName: string; days: number; trees: number; ipes: number; perDay: number | null; gasolineLiters: number; maintenance: number; losses: number; spent: number; costPerTree: number | null }>;
  byProject: Array<{ projectId: number; projectName: string; status: StageStatus; days: number; operators: number; trees: number; ipes: number; perDay: number | null; spent: number; costPerTree: number | null }>;
  daily: Array<{ date: string; projectName: string; operatorName: string; trees: number; ipes: number; target: number | null; result: TargetResult; resultLabel: string; justification: string | null }>;
};
type MultiFront = {
  rows: Array<{ operatorId: number; operatorName: string; fronts: string[]; helpers: Array<{ name: string; days: number }>; days: number; trees: number; daysOnTarget: number; daysBelow: number; treesOnTargetDays: number; treesAboveTarget: number; perDay: number | null }>;
  totals: { operators: number; trees: number; treesOnTargetDays: number; treesAboveTarget: number; perDay: number | null };
  targets: Record<string, number>;
};

const DAILY = [
  { key: "projetos", label: "Projetos" },
  { key: "lancamento", label: "Lançamento" },
  { key: "acumulado", label: "Acumulado por Operador" },
  { key: "historico", label: "Histórico" },
] as const;
const SECTIONS = [
  { key: "diaria", label: "Produção Diária" },
  { key: "despesas", label: "Despesas e Perdas" },
  { key: "analises", label: "Análises" },
  { key: "multifrente", label: "Multi-Frente" },
] as const;
type View = typeof DAILY[number]["key"] | Exclude<typeof SECTIONS[number]["key"], "diaria">;
const VIEWS: readonly string[] = [...DAILY.map((item) => item.key), "despesas", "analises", "multifrente"];

// Média por dia sempre com duas casas (ex.: 534 árvores em 4 dias = 133,50).
export const average = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const failure = (problem: unknown, fallback: string) => window.alert(problemText(problem, fallback));

export default function ProductionFellingTab({ context, selectedFronts, sub, setSub, flash }: Props) {
  const { access } = context;
  const allowed = (key: string) => (key === "lancamento" ? access.launch : key === "despesas" || key === "analises" ? access.costs : true);
  const view: View = sub && VIEWS.includes(sub) && allowed(sub) ? sub as View : "projetos";
  const section = DAILY.some((item) => item.key === view) ? "diaria" : view;
  const scopeFronts = useMemo(() => (selectedFronts.length ? context.fronts.filter((front) => selectedFronts.includes(front.id)) : context.fronts), [context.fronts, selectedFronts]);
  const frontsParam = selectedFronts.length ? `?frentes=${selectedFronts.join(",")}` : "";
  const [data, setData] = useState<{ cards: FellingCard[]; launchProjects: LaunchProject[] } | null>(null);
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<Period>(monthPeriod);
  const [launchProject, setLaunchProject] = useState<number | null>(null);
  const reasons = useMemo(() => context.reasons.filter((reason) => reason.active), [context.reasons]);

  const load = useCallback(() => {
    setError("");
    Promise.all([
      api<{ cards: FellingCard[]; launchProjects: LaunchProject[] }>(`/api/producao/derruba/projetos${frontsParam}`),
      api<{ targets: Record<string, number> }>("/api/producao/metas?etapa=DERRUBA"),
    ]).then(([projects, metas]) => { setData(projects); setTargets(metas.targets); })
      .catch((problem) => setError(problemText(problem, "Não foi possível carregar a derruba.")));
  }, [frontsParam]);
  useEffect(() => { load(); }, [load]);
  // Projeto escolhido no filtro que saiu das frentes em exibição.
  useEffect(() => { if (data && period.projeto && !data.cards.some((card) => String(card.id) === period.projeto)) setPeriod((current) => ({ ...current, projeto: "" })); }, [data, period.projeto]);

  const go = (key: View) => setSub(key === "projetos" ? null : key);
  const openLaunch = (projectId: number) => { setLaunchProject(projectId); go("lancamento"); };
  const sections = SECTIONS.filter((item) => item.key === "diaria" || allowed(item.key));
  const dailyViews = DAILY.filter((item) => allowed(item.key));
  const projects = data?.cards ?? [];

  return <>
    <div className="filter-chips production-subtabs" role="tablist" aria-label="Seções da Derruba">
      {sections.map((item) => <button key={item.key} type="button" role="tab" aria-selected={section === item.key} className={section === item.key ? "selected" : ""} onClick={() => go(item.key === "diaria" ? "projetos" : item.key)}>{item.label}</button>)}
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {section === "diaria" && <>
      <TargetsCard fronts={scopeFronts} targets={targets} manage={access.manage} flash={flash} saved={load} />
      <div className="filter-chips production-subtabs production-inner-tabs" role="tablist" aria-label="Produção Diária">
        {dailyViews.map((item) => <button key={item.key} type="button" role="tab" aria-selected={view === item.key} className={view === item.key ? "selected" : ""} onClick={() => go(item.key)}>{item.label}</button>)}
      </div>
    </>}
    {!data && !error ? <Loading /> : data && <>
      {view === "projetos" && <ProjectCards cards={data.cards} context={context} flash={flash} reload={load} openLaunch={openLaunch} />}
      {view === "lancamento" && <article className="panel module-panel production-panel">
        <ProductionFellingGrid key={launchProject ?? 0} projects={data.launchProjects} reasons={reasons} dayEndpoint="/api/producao/derruba/dia" employeesEndpoint="/api/producao/funcionarios" flash={flash} initialProjectId={launchProject} onSaved={load} />
      </article>}
      {view === "acumulado" && <AccumulatedView period={period} setPeriod={setPeriod} projects={projects} selectedFronts={selectedFronts} />}
      {view === "historico" && <HistoryView period={period} setPeriod={setPeriod} projects={projects} selectedFronts={selectedFronts} context={context} reasons={reasons} flash={flash} reload={load} />}
      {view === "despesas" && <ProductionFellingExpenses context={context} projects={projects} selectedFronts={selectedFronts} period={period} setPeriod={setPeriod} flash={flash} />}
      {view === "analises" && <AnalysisView period={period} setPeriod={setPeriod} projects={projects} selectedFronts={selectedFronts} />}
      {view === "multifrente" && <MultiFrontView period={period} setPeriod={setPeriod} selectedFronts={selectedFronts} fronts={scopeFronts} />}
    </>}
  </>;
}

// ---------------------------------------------------------------------------
// Meta diária por frente (árvores por operador por dia). Sem meta, o resultado fica "Meta não definida".
// ---------------------------------------------------------------------------
function TargetsCard({ fronts, targets, manage, flash, saved }: { fronts: ProductionFront[]; targets: Record<string, number>; manage: boolean; flash: (message: string) => void; saved: () => void }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => { setDrafts(Object.fromEntries(fronts.map((front) => [front.id, targets[front.id] ? String(targets[front.id]) : ""]))); }, [fronts, targets]);
  if (fronts.length === 0) return null;
  async function save(front: ProductionFront) {
    setBusy(front.id);
    try { flash((await api<{ message: string }>("/api/producao/metas", jsonBody("PUT", { serviceFrontId: front.id, stage: "DERRUBA", value: drafts[front.id] ?? "" }))).message); saved(); }
    catch (problem) { failure(problem, "Não foi possível salvar a meta."); }
    finally { setBusy(null); }
  }
  return <div className="panel production-targets">
    <div><strong>Meta diária</strong><span>árvores por operador por dia</span></div>
    <ul>{fronts.map((front) => {
      const current = targets[front.id] ? String(targets[front.id]) : "";
      return <li key={front.id}>
        <span>{front.name}</span>
        {manage ? <form onSubmit={(event) => { event.preventDefault(); save(front); }}>
          <input inputMode="numeric" aria-label={`Meta diária da frente ${front.name}`} placeholder="sem meta" value={drafts[front.id] ?? ""} onChange={(event) => setDrafts((all) => ({ ...all, [front.id]: event.target.value.replace(/[^\d]/g, "") }))} />
          <button type="submit" className="secondary" disabled={busy === front.id || (drafts[front.id] ?? "") === current}>{busy === front.id ? "..." : "Salvar"}</button>
        </form> : <b>{current ? `${current} árv./dia` : "sem meta"}</b>}
      </li>;
    })}</ul>
  </div>;
}

// ---------------------------------------------------------------------------
// Projetos: um card por projeto ativo com os números da derruba, observação e finalizar/reabrir.
// ---------------------------------------------------------------------------
function ProjectCards({ cards, context, flash, reload, openLaunch }: { cards: FellingCard[]; context: ProductionContext; flash: (message: string) => void; reload: () => void; openLaunch: (id: number) => void }) {
  if (cards.length === 0) return <div className="empty-state">Nenhum projeto ativo nas frentes em exibição. Cadastre em Produção → Projetos.</div>;
  return <div className="production-cards">{cards.map((card) => <FellingProjectCard key={card.id} card={card} context={context} flash={flash} reload={reload} openLaunch={openLaunch} />)}</div>;
}

function FellingProjectCard({ card, context, flash, reload, openLaunch }: { card: FellingCard; context: ProductionContext; flash: (message: string) => void; reload: () => void; openLaunch: (id: number) => void }) {
  const { access } = context;
  const [notes, setNotes] = useState(card.notes ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNotes(card.notes ?? ""); }, [card.notes]);
  const canNote = access.manage || access.launch;
  const dirty = notes.trim() !== (card.notes ?? "").trim();
  async function patch(body: Record<string, unknown>, fallback: string) {
    setBusy(true);
    try { flash((await api<{ message: string }>(`/api/producao/projetos/${card.id}`, jsonBody("PATCH", body))).message); reload(); }
    catch (problem) { failure(problem, fallback); }
    finally { setBusy(false); }
  }
  const finish = () => window.confirm(`Finalizar a derruba de ${card.name}? Depois disso não entram mais lançamentos (a etapa pode ser reaberta).`) && patch({ acao: "etapa", etapa: "DERRUBA", etapaAcao: "FINALIZAR" }, "Não foi possível finalizar.");
  const reopen = () => window.confirm(`Reabrir a derruba de ${card.name}?`) && patch({ acao: "etapa", etapa: "DERRUBA", etapaAcao: "REABRIR" }, "Não foi possível reabrir.");
  return <article className="panel production-card">
    <header><div><h3>{card.name}</h3><span>{card.frontName}</span></div><StageBadge status={card.status} /></header>
    <dl className="production-card-kpis">
      <div><dt>Dias trabalhados</dt><dd>{number(card.days, 0)}</dd></div>
      <div><dt>Média/dia</dt><dd>{average(card.perDay)}</dd></div>
      <div><dt>Operadores</dt><dd>{number(card.operators, 0)}</dd></div>
      <div><dt>Árvores</dt><dd>{number(card.trees, 0)}</dd></div>
      <div><dt>Ipês</dt><dd>{number(card.ipes, 0)}</dd></div>
    </dl>
    <p className="production-card-meta">{card.lastUpdate ? `Última atualização: ${brDateTime(card.lastUpdate)} · último dia lançado ${brDay(card.lastDay)}` : "Nenhum lançamento ainda."}</p>
    <label className="production-card-notes">Observações da derruba
      <textarea value={notes} readOnly={!canNote} maxLength={1000} rows={2} placeholder={canNote ? "Ex.: área alagada, aguardando trator..." : ""} onChange={(event) => setNotes(event.target.value)} />
    </label>
    <div className="production-card-actions">
      {canNote && <button type="button" className="secondary" disabled={!dirty || busy} onClick={() => patch({ acao: "observacao", etapa: "DERRUBA", observacao: notes }, "Não foi possível salvar a observação.")}>Salvar observação</button>}
      {access.manage && (card.status === "FINALIZADO"
        ? <button type="button" className="secondary" disabled={busy} onClick={reopen}>Reabrir derruba</button>
        : <button type="button" className="secondary" disabled={busy} onClick={finish}>Finalizar derruba</button>)}
      {access.launch && acceptsLaunch(card.status) && <button type="button" className="primary" onClick={() => openLaunch(card.id)}>Lançar produção</button>}
    </div>
  </article>;
}

// ---------------------------------------------------------------------------
// Acumulado por operador
// ---------------------------------------------------------------------------
type PeriodProps = { period: Period; setPeriod: (period: Period) => void; projects: FellingCard[]; selectedFronts: number[] };

function useFetch<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!url) return;
    setError("");
    api<T>(url).then(setData).catch((problem) => setError(problemText(problem, "Não foi possível carregar.")));
  }, [url]);
  useEffect(() => { setData(null); load(); }, [load]);
  return { data, error, load };
}

function AccumulatedView({ period, setPeriod, projects, selectedFronts }: PeriodProps) {
  const { data, error } = useFetch<{ operators: Accumulated[] }>(`/api/producao/derruba/acumulado?${periodQuery(period, selectedFronts)}`);
  const rows = data?.operators ?? null;
  return <article className="panel module-panel production-panel">
    <PeriodFilter value={period} onChange={setPeriod} projects={projects} />
    {error && <div className="fleet-form-error">! {error}</div>}
    {!rows && !error ? <Loading /> : rows && <>
      <p className="stock-summary">{rows.length} operador(es) · {number(rows.reduce((sum, row) => sum + row.trees, 0), 0)} árvores · {number(rows.reduce((sum, row) => sum + row.ipes, 0), 0)} ipês</p>
      <ul className="production-operator-cards">{rows.map((row) => <li key={row.operatorId}>
        <strong>{row.operatorName}</strong>
        <span><b>{number(row.trees, 0)} árvores</b> — {row.days} dia(s) · média {average(row.perDay)}/dia · {number(row.ipes, 0)} ipês</span>
      </li>)}</ul>
      {rows.length === 0 && <div className="empty-state">Nenhuma derruba lançada no período.</div>}
    </>}
  </article>;
}

// ---------------------------------------------------------------------------
// Histórico: uma linha por operador por dia, com a meta da frente, o resultado e a justificativa.
// ---------------------------------------------------------------------------
function ResultBadge({ result, label }: { result: TargetResult; label: string }) {
  return <span className={`production-result ${result === "NA_META" ? "ok" : result === "ABAIXO" ? "below" : "none"}`}>{label}</span>;
}

function HistoryView({ period, setPeriod, projects, selectedFronts, context, reasons, flash, reload }: PeriodProps & { context: ProductionContext; reasons: ProductionReason[]; flash: (message: string) => void; reload: () => void }) {
  const [operator, setOperator] = useState<ProductionEmployee | null>(null);
  const [editing, setEditing] = useState<HistoryRow | null>(null);
  const { data, error, load } = useFetch<{ rows: HistoryRow[] }>(`/api/producao/derruba?${periodQuery(period, selectedFronts, { operador: operator ? String(operator.id) : null })}`);
  const rows = data?.rows ?? null;
  const costs = context.access.costs;
  const launch = context.access.launch;
  const manage = context.access.manage;
  const totals = useMemo(() => (rows ?? []).reduce((sum, row) => ({ trees: sum.trees + row.trees, ipes: sum.ipes + row.ipes, gasoline: sum.gasoline + row.gasolineLiters, value: sum.value + (row.gasolineValue ?? 0) }), { trees: 0, ipes: 0, gasoline: 0, value: 0 }), [rows]);
  async function remove(row: HistoryRow) {
    if (!window.confirm(`Excluir o lançamento de ${row.operatorName} em ${brDay(row.date)} (${number(row.trees, 0)} árvores)?`)) return;
    try { flash((await api<{ message: string }>(`/api/producao/derruba/${row.id}`, { method: "DELETE" })).message); load(); reload(); }
    catch (problem) { failure(problem, "Não foi possível excluir."); }
  }
  return <article className="panel module-panel production-panel">
    <PeriodFilter value={period} onChange={setPeriod} projects={projects}>
      <label>Operador<ProductionEmployeePicker compact value={operator} onPick={setOperator} frontId={null} group="MOTOSSERRA" placeholder="Todos os operadores" /></label>
    </PeriodFilter>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!rows && !error ? <Loading /> : rows && <div className="table-scroll"><table className="products-table production-table">
      <thead><tr><th>Data</th><th>Projeto</th><th>Operador</th><th>Ajudante</th><th className="num">Árvores</th><th className="num">Ipês</th><th className="num">Gasolina (L)</th>{costs && <th className="num">Gasolina (R$)</th>}<th className="num">Meta</th><th>Resultado</th><th>Justificativa</th>{launch && <th />}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td data-label="Data">{brDay(row.date)}</td>
        <td data-label="Projeto">{row.projectName}<div className="production-sub">{row.frontName}</div></td>
        <td data-label="Operador"><strong>{row.operatorName}</strong>{row.operatorCompany && <div className="production-sub">{row.operatorCompany}</div>}</td>
        <td data-label="Ajudante">{row.helperName ?? "—"}</td>
        <td data-label="Árvores" className="num">{number(row.trees, 0)}</td>
        <td data-label="Ipês" className="num">{number(row.ipes, 0)}</td>
        <td data-label="Gasolina (L)" className="num">{row.gasolineLiters ? number(row.gasolineLiters) : "—"}</td>
        {costs && <td data-label="Gasolina (R$)" className="num">{row.gasolineLiters ? (row.gasolineValue === null ? <span className="production-sub" title="A frente não tinha custo médio de gasolina no estoque nesta data.">sem valor</span> : money(row.gasolineValue)) : "—"}</td>}
        <td data-label="Meta" className="num">{row.target ?? "—"}</td>
        <td data-label="Resultado"><ResultBadge result={row.result} label={row.resultLabel} /></td>
        <td data-label="Justificativa">{[row.reason, row.justification].filter(Boolean).join(" — ") || "—"}</td>
        {launch && <td>{acceptsLaunch(row.projectStatus) ? <div className="equipment-row-actions"><button type="button" onClick={() => setEditing(row)}>Editar</button>{manage && <button type="button" onClick={() => remove(row)}>Excluir</button>}</div> : <span className="production-sub" title="Reabra a derruba do projeto para alterar">Derruba finalizada</span>}</td>}
      </tr>)}</tbody>
      {rows.length > 0 && <tfoot><tr><td colSpan={4}><strong>Total</strong> · {rows.length} lançamento(s)</td><td className="num"><strong>{number(totals.trees, 0)}</strong></td><td className="num"><strong>{number(totals.ipes, 0)}</strong></td><td className="num"><strong>{number(totals.gasoline)}</strong></td>{costs && <td className="num"><strong>{money(totals.value)}</strong></td>}<td colSpan={launch ? 4 : 3} /></tr></tfoot>}
    </table>{rows.length === 0 && <div className="empty-state">Nenhuma derruba lançada no período e filtros.</div>}</div>}
    {editing && <EditLineModal row={editing} reasons={reasons} close={() => setEditing(null)} saved={(message) => { setEditing(null); flash(message); load(); reload(); }} />}
  </article>;
}

function EditLineModal({ row, reasons, close, saved }: { row: HistoryRow; reasons: ProductionReason[]; close: () => void; saved: (message: string) => void }) {
  const [helper, setHelper] = useState<ProductionEmployee | null>(row.helperId ? { id: row.helperId, name: row.helperName ?? "", jobTitle: "", company: "", frontName: row.frontName } : null);
  const [trees, setTrees] = useState(String(row.trees));
  const [ipes, setIpes] = useState(String(row.ipes));
  const [gasoline, setGasoline] = useState(row.gasolineLiters ? String(row.gasolineLiters).replace(".", ",") : "");
  const [reasonId, setReasonId] = useState(row.reasonId ? String(row.reasonId) : "");
  const [justification, setJustification] = useState(row.justification ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Motivo inativo que já estava gravado continua aparecendo.
  const options = reasons.some((reason) => reason.id === row.reasonId) || !row.reasonId ? reasons : [...reasons, { id: row.reasonId, code: "", description: row.reason ?? "motivo inativo", active: false }];
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      saved((await api<{ message: string }>(`/api/producao/derruba/${row.id}`, jsonBody("PATCH", { helperEmployeeId: helper?.id ?? null, trees, ipes, gasolineLiters: gasoline, reasonId: reasonId || null, justification }))).message);
    } catch (problem) {
      const lines = problem instanceof ApiError && Array.isArray(problem.data.lineErrors) ? (problem.data.lineErrors as Array<{ message: string }>).map((item) => item.message) : [];
      setError(lines.length ? lines.join(" ") : problemText(problem, "Não foi possível salvar."));
    } finally { setBusy(false); }
  }
  return <Modal title="Editar lançamento da derruba" subtitle={`${row.operatorName} · ${brDay(row.date)} · ${row.projectName}. Para trocar o operador ou o dia, use a grade do Lançamento.`} close={close} busy={busy}>
    <form className="modal-form" onSubmit={submit}>
      <label className="full">Ajudante<ProductionEmployeePicker compact value={helper} onPick={setHelper} frontId={row.frontId} group="AJUDANTE_MOTOSSERRA" placeholder="Buscar ajudante..." /></label>
      <label>Árvores<input inputMode="numeric" required value={trees} onChange={(event) => setTrees(event.target.value.replace(/[^\d]/g, ""))} /></label>
      <label>Ipês (já contados nas árvores)<input inputMode="numeric" value={ipes} onChange={(event) => setIpes(event.target.value.replace(/[^\d]/g, ""))} /></label>
      <label>Gasolina (L)<input inputMode="decimal" value={gasoline} onChange={(event) => setGasoline(event.target.value.replace(/[^\d,.]/g, ""))} /></label>
      <label>Motivo (obrigatório com zero árvores)<select value={reasonId} onChange={(event) => setReasonId(event.target.value)}>
        <option value="">—</option>{options.map((reason) => <option key={reason.id} value={reason.id}>{reason.code ? `(${reason.code}) ` : ""}{reason.description}</option>)}
      </select></label>
      <label className="full">Justificativa (opcional)<textarea value={justification} maxLength={300} rows={2} onChange={(event) => setJustification(event.target.value)} /></label>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button></div>
    </form>
  </Modal>;
}

// ---------------------------------------------------------------------------
// Análises (com R$) e PDF
// ---------------------------------------------------------------------------
function PdfLink({ href }: { href: string }) {
  return <a className="secondary production-pdf" href={href} target="_blank" rel="noreferrer">Baixar PDF</a>;
}

function AnalysisView({ period, setPeriod, projects, selectedFronts }: PeriodProps) {
  const query = periodQuery(period, selectedFronts);
  const { data, error } = useFetch<Analysis>(`/api/producao/derruba/analises?${query}`);
  const [allDays, setAllDays] = useState(false);
  const daily = data ? (allDays ? data.daily : data.daily.slice(0, 200)) : [];
  return <article className="panel module-panel production-panel">
    <PeriodFilter value={period} onChange={setPeriod} projects={projects}><PdfLink href={`/api/producao/derruba/analises?${query}&formato=pdf`} /></PeriodFilter>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!data && !error ? <Loading /> : data && <>
      <div className="production-kpis">
        <div><span>Operadores</span><strong>{number(data.kpis.operators, 0)}</strong></div>
        <div><span>Árvores derrubadas</span><strong>{number(data.kpis.trees, 0)}</strong></div>
        <div><span>Média por operador/dia</span><strong>{average(data.kpis.perDay)}</strong></div>
        <div><span>Ipês</span><strong>{number(data.kpis.ipes, 0)}</strong></div>
        <div><span>Custo da derruba</span><strong>{money(data.kpis.cost)}</strong></div>
        <div><span>Custo por árvore</span><strong>{data.kpis.trees ? money(data.kpis.cost / data.kpis.trees) : "—"}</strong></div>
      </div>
      {data.kpis.litersWithoutValue > 0 && <p className="production-warning">! {number(data.kpis.litersWithoutValue)} L de gasolina ficaram sem valor: a frente não tinha custo médio de gasolina no estoque nessas datas.</p>}
      <h3 className="production-section-title">Desempenho por operador</h3>
      <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Operador</th><th className="num">Dias</th><th className="num">Árvores</th><th className="num">Ipês</th><th className="num">Média/dia</th><th className="num">Gasolina (L)</th><th className="num">Manutenção</th><th className="num">Perdas totais</th><th className="num">Gasto total</th><th className="num">Custo/árvore</th></tr></thead>
        <tbody>{data.byOperator.map((row) => <tr key={row.operatorId}>
          <td data-label="Operador"><strong>{row.operatorName}</strong></td><td data-label="Dias" className="num">{row.days}</td><td data-label="Árvores" className="num">{number(row.trees, 0)}</td>
          <td data-label="Ipês" className="num">{number(row.ipes, 0)}</td><td data-label="Média/dia" className="num">{average(row.perDay)}</td><td data-label="Gasolina (L)" className="num">{number(row.gasolineLiters)}</td>
          <td data-label="Manutenção" className="num">{money(row.maintenance)}</td><td data-label="Perdas totais" className="num">{row.losses}</td><td data-label="Gasto total" className="num">{money(row.spent)}</td>
          <td data-label="Custo/árvore" className="num">{row.costPerTree === null ? "—" : money(row.costPerTree)}</td>
        </tr>)}</tbody>
      </table>{data.byOperator.length === 0 && <div className="empty-state">Nenhuma derruba lançada no período.</div>}</div>
      <h3 className="production-section-title">Resultado por projeto</h3>
      <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Projeto</th><th>Derruba</th><th className="num">Dias</th><th className="num">Operadores</th><th className="num">Árvores</th><th className="num">Ipês</th><th className="num">Média/dia</th><th className="num">Gasto</th><th className="num">Custo/árvore</th></tr></thead>
        <tbody>{data.byProject.map((row) => <tr key={row.projectId}>
          <td data-label="Projeto"><strong>{row.projectName}</strong></td><td data-label="Derruba"><StageBadge status={row.status} /></td><td data-label="Dias" className="num">{row.days}</td>
          <td data-label="Operadores" className="num">{row.operators}</td><td data-label="Árvores" className="num">{number(row.trees, 0)}</td><td data-label="Ipês" className="num">{number(row.ipes, 0)}</td>
          <td data-label="Média/dia" className="num">{average(row.perDay)}</td><td data-label="Gasto" className="num">{money(row.spent)}</td><td data-label="Custo/árvore" className="num">{row.costPerTree === null ? "—" : money(row.costPerTree)}</td>
        </tr>)}</tbody>
      </table>{data.byProject.length === 0 && <div className="empty-state">Nenhum projeto com derruba no período.</div>}</div>
      <h3 className="production-section-title">Diário contra a meta</h3>
      <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Data</th><th>Projeto</th><th>Operador</th><th className="num">Árvores</th><th className="num">Ipês</th><th className="num">Meta</th><th>Resultado</th><th>Justificativa</th></tr></thead>
        <tbody>{daily.map((row, index) => <tr key={index}>
          <td data-label="Data">{brDay(row.date)}</td><td data-label="Projeto">{row.projectName}</td><td data-label="Operador">{row.operatorName}</td>
          <td data-label="Árvores" className="num">{number(row.trees, 0)}</td><td data-label="Ipês" className="num">{number(row.ipes, 0)}</td><td data-label="Meta" className="num">{row.target ?? "—"}</td>
          <td data-label="Resultado"><ResultBadge result={row.result} label={row.resultLabel} /></td><td data-label="Justificativa">{row.justification ?? "—"}</td>
        </tr>)}</tbody>
      </table>{data.daily.length === 0 && <div className="empty-state">Nenhum lançamento no período.</div>}</div>
      {data.daily.length > daily.length && <button type="button" className="secondary production-more" onClick={() => setAllDays(true)}>Mostrar os {data.daily.length} lançamentos</button>}
    </>}
  </article>;
}

// ---------------------------------------------------------------------------
// Multi-Frente: só produção (sem R$), base para a premiação por produção.
// ---------------------------------------------------------------------------
function MultiFrontView({ period, setPeriod, selectedFronts, fronts }: Omit<PeriodProps, "projects"> & { fronts: ProductionFront[] }) {
  const query = periodQuery({ ...period, projeto: "" }, selectedFronts);
  const { data, error } = useFetch<MultiFront>(`/api/producao/derruba/multifrente?${query}`);
  return <article className="panel module-panel production-panel">
    <PeriodFilter value={period} onChange={setPeriod}><PdfLink href={`/api/producao/derruba/multifrente?${query}&formato=pdf`} /></PeriodFilter>
    <p className="production-help">Um dia do operador numa frente soma os projetos daquela frente no dia e é comparado com a meta da frente. “Árv. acima da meta” soma o que passou da meta nos dias em que ela foi batida. Ajudantes: dias em que o operador bateu a meta com ele.</p>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!data && !error ? <Loading /> : data && <>
      <p className="stock-summary">{fronts.map((front) => `${front.name}: ${data.targets[front.id] ? `meta ${data.targets[front.id]} árv./dia` : "sem meta"}`).join(" · ")}</p>
      <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Operador</th><th>Frentes</th><th>Ajudantes</th><th className="num">Dias</th><th className="num">Árvores</th><th className="num">Média/dia</th><th className="num">Dias na meta</th><th className="num">Dias abaixo</th><th className="num">Árv. nos dias na meta</th><th className="num">Árv. acima da meta</th></tr></thead>
        <tbody>{data.rows.map((row) => <tr key={row.operatorId}>
          <td data-label="Operador"><strong>{row.operatorName}</strong></td><td data-label="Frentes">{row.fronts.join(", ")}</td>
          <td data-label="Ajudantes">{row.helpers.length ? row.helpers.map((helper) => `${helper.name} (${helper.days})`).join(", ") : "—"}</td>
          <td data-label="Dias" className="num">{row.days}</td><td data-label="Árvores" className="num">{number(row.trees, 0)}</td><td data-label="Média/dia" className="num">{average(row.perDay)}</td>
          <td data-label="Dias na meta" className="num">{row.daysOnTarget}</td><td data-label="Dias abaixo" className="num">{row.daysBelow}</td>
          <td data-label="Árv. nos dias na meta" className="num">{number(row.treesOnTargetDays, 0)}</td><td data-label="Árv. acima da meta" className="num">{number(row.treesAboveTarget, 0)}</td>
        </tr>)}</tbody>
        {data.rows.length > 0 && <tfoot><tr><td colSpan={4}><strong>Total</strong> · {data.totals.operators} operador(es)</td><td className="num"><strong>{number(data.totals.trees, 0)}</strong></td><td className="num"><strong>{average(data.totals.perDay)}</strong></td><td colSpan={2} /><td className="num"><strong>{number(data.totals.treesOnTargetDays, 0)}</strong></td><td className="num"><strong>{number(data.totals.treesAboveTarget, 0)}</strong></td></tr></tfoot>}
      </table>{data.rows.length === 0 && <div className="empty-state">Nenhuma derruba lançada no período.</div>}</div>
    </>}
  </article>;
}
