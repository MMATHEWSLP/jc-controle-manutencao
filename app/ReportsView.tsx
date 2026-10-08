"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { consumirAba } from "../lib/assistente-nav";
import { FLEET_STATUS_LABELS, FLEET_STATUSES } from "../lib/fleet-status";
import { categoryOf, groupReports, reportById, searchReports, visibleReports, type ReportDef, type ReportId } from "../lib/reports-catalog";

// Menu RELATÓRIOS: catálogo em cartões por categoria, com busca. Cada cartão abre o relatório aqui
// mesmo (com "‹ Todos os relatórios" para voltar). Os relatórios que saíram de outras telas usam os
// mesmos componentes e as mesmas rotas de antes; as rotas filtram pelas frentes da pessoa.
function Loading() { return <div className="page-loading"><span /><p>Carregando relatório...</p></div>; }
const DailyReportsPanel = dynamic(() => import("./DailyReportsPanel"), { loading: Loading });
const FleetCostsView = dynamic(() => import("./FleetCostsView"), { loading: Loading });
const WeeklyReportView = dynamic(() => import("./WeeklyReportView"), { loading: Loading });
const ConvoyReport = dynamic(() => import("./ConvoyApprovalView").then((module) => module.ConvoyReport), { loading: Loading });
const ThirdPartyConsumptionReport = dynamic(() => import("./ThirdPartiesView").then((module) => module.ThirdPartyConsumptionReport), { loading: Loading });
const ThirdPartySummaryPanel = dynamic(() => import("./ThirdPartiesView").then((module) => module.ThirdPartySummaryPanel), { loading: Loading });
const StockExitsReport = dynamic(() => import("./StockExitsView").then((module) => module.StockExitsReport), { loading: Loading });
const FuelDailySummaryModal = dynamic(() => import("./FuelDailySummary"), { loading: Loading });
const CostProductionReport = dynamic(() => import("./CostProductionReport"), { loading: Loading });
const FuelDestinationsReport = dynamic(() => import("./MoreReports").then((module) => module.FuelDestinationsReport), { loading: Loading });
const ConsumptionReport = dynamic(() => import("./MoreReports").then((module) => module.ConsumptionReport), { loading: Loading });
const StockAdjustmentsReport = dynamic(() => import("./MoreReports").then((module) => module.StockAdjustmentsReport), { loading: Loading });
const WorkOrdersReport = dynamic(() => import("./MoreReports").then((module) => module.WorkOrdersReport), { loading: Loading });
const ComponentsReport = dynamic(() => import("./MoreReports").then((module) => module.ComponentsReport), { loading: Loading });
const OtherExpensesView = dynamic(() => import("./CostProductionReport").then((module) => module.OtherExpensesView), { loading: Loading });

type User = { id: number; profile: string; permissions: string[]; canExport: boolean; allServiceFronts: boolean; serviceFrontIds: number[] };
type Front = { id: number; name: string };
type Equipment = { id: number; prefix: string; type: string; serviceFrontId?: number | null };
type Props = { authUser: User; flash: (message: string) => void; fronts: Front[]; equipment: Equipment[] };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const liters = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const brDay = (value: string) => value.slice(0, 10).split("-").reverse().join("/");
const query = (values: Record<string, string | string[] | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.filter(Boolean).forEach((item) => params.append(key, item));
    else if (value) params.set(key, value);
  }
  return params.toString();
};

async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível carregar o relatório."));
  return data as T;
}

// Relatório aberto por último: trocar a frente no topo recria a tela e ele continua aberto.
const memory: { lastOpen: ReportId | null } = { lastOpen: null };

export default function ReportsView({ authUser, flash, fronts, equipment }: Props) {
  const reports = useMemo(() => visibleReports(authUser), [authUser]);
  // Nome antigo ("Custos e Consumo", "Resumo semanal") ou atalho: abre direto no relatório; o botão
  // RELATÓRIOS do menu pede o catálogo.
  const [open, setOpen] = useState<ReportId | null>(() => {
    if (typeof window === "undefined") return null;
    const requested = consumirAba("Relatórios")?.aba ?? memory.lastOpen;
    return requested && reports.some((report) => report.id === requested) ? requested as ReportId : null;
  });
  useEffect(() => { memory.lastOpen = open; }, [open]);
  const [search, setSearch] = useState("");
  const visibleFronts = useMemo(() => authUser.profile === "ADMIN" || authUser.allServiceFronts ? fronts : fronts.filter((front) => authUser.serviceFrontIds.includes(front.id)), [authUser, fronts]);
  const report = open ? reportById(open) : null;
  useEffect(() => { window.scrollTo({ top: 0 }); }, [open]);

  if (report) return <ReportHost report={report} back={() => setOpen(null)}>
    <ReportBody report={report} authUser={authUser} flash={flash} fronts={visibleFronts} equipment={equipment} back={() => setOpen(null)} />
  </ReportHost>;

  const groups = groupReports(searchReports(reports, search));
  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">RELATÓRIOS</p><h1>Relatórios</h1><span>Todos os relatórios do sistema num lugar só. Escolha um cartão: cada relatório tem filtros e exportação, e mostra só as frentes que você enxerga (e a frente escolhida no topo).</span></div>
    </div>
    <article className="panel module-panel reports-catalog">
      <label className="page-search reports-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar relatório (ex.: diesel, terceiros, trocas, custo, comboio)..." aria-label="Buscar relatório" /></label>
      {groups.map(({ category, reports: items }) => <section key={category.key} className="reports-category" aria-label={category.label}>
        <header><h2>{category.label}</h2><p>{category.description}</p></header>
        <div className="reports-grid">{items.map((item) => <button type="button" key={item.id} className="report-card" onClick={() => setOpen(item.id)}>
          <strong>{item.title}</strong>
          <span>{item.description}</span>
          <small><b>{item.formats}</b>{item.alsoIn && <> · também em {item.alsoIn}</>}</small>
        </button>)}</div>
      </section>)}
      {groups.length === 0 && <div className="empty-state">{reports.length ? `Nenhum relatório encontrado para "${search}".` : "Nenhum relatório liberado para o seu usuário."}</div>}
    </article>
  </>;
}

// Relatórios que já têm o próprio título na tela (os demais ganham o título do catálogo).
const OWN_HEADING = new Set<ReportId>(["custos-consumo", "resumo-semanal", "resumo-mensal"]);

function ReportHost({ report, back, children }: { report: ReportDef; back: () => void; children: ReactNode }) {
  const category = categoryOf(report.category);
  return <div className="report-host">
    <nav className="reports-breadcrumb" aria-label="Relatório aberto">
      <button type="button" onClick={back}>‹ Todos os relatórios</button>
      <span>{category.label} · <strong>{report.title}</strong></span>
    </nav>
    {!OWN_HEADING.has(report.id) && <div className="page-heading module-heading">
      <div><p className="eyebrow">RELATÓRIOS · {category.label.toUpperCase()}</p><h1>{report.title}</h1><span>{report.description}</span></div>
    </div>}
    {children}
  </div>;
}

function ReportBody({ report, authUser, flash, fronts, equipment, back }: { report: ReportDef; authUser: User; flash: (message: string) => void; fronts: Front[]; equipment: Equipment[]; back: () => void }) {
  const equipmentOptions = useMemo(() => [...equipment].sort((a, b) => a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true })), [equipment]);
  switch (report.id) {
    case "producao": return <DailyReportsPanel mode="producao" fronts={fronts} equipment={equipmentOptions} />;
    case "diario-combustivel": return <DailyReportsPanel mode="diesel" fronts={fronts} equipment={equipmentOptions} />;
    case "combustivel-movimentacao": return <FuelMovementsReport />;
    case "combustivel-dia": return <FuelDayReport flash={flash} back={back} />;
    case "consumo-terceiros": return <ThirdPartyConsumptionReport />;
    case "terceiros-empresa": return <ThirdPartySummaryPanel />;
    case "comboio": return <ConvoyReport />;
    case "consumo-equipamento": return <ConsumptionReport fronts={fronts} />;
    case "combustivel-destino": return <FuelDestinationsReport fronts={fronts} />;
    case "ajustes-estoque": return <StockAdjustmentsReport fronts={fronts} />;
    case "ordens-servico": return <WorkOrdersReport fronts={fronts} equipment={equipmentOptions} />;
    case "pneus-baterias": return <ComponentsReport />;
    case "estoque-saidas": return <StockExitsReport flash={flash} />;
    case "produtos-estoque": return <ProductsExport />;
    case "trocas-oleo": return <OilChangesExport authUser={authUser} fronts={fronts} equipment={equipmentOptions} />;
    case "trocas-vencidas": return <AlertsExport fronts={fronts} equipment={equipmentOptions} />;
    case "frota-diario": return <FleetDayExport fronts={fronts} equipment={equipmentOptions} />;
    case "casado-equipamento": return <CostProductionReport initialGrouping="equipamento" fronts={fronts} equipment={equipmentOptions} flash={flash} />;
    case "casado-frente": return <CostProductionReport initialGrouping="frente" fronts={fronts} equipment={equipmentOptions} flash={flash} />;
    case "casado-geral": return <CostProductionReport initialGrouping="mes" fronts={fronts} equipment={equipmentOptions} flash={flash} />;
    case "outros-gastos": return <OtherExpensesView fronts={fronts} equipment={equipmentOptions} flash={flash} />;
    case "custos-consumo": return <FleetCostsView />;
    case "resumo-semanal": return <WeeklyReportView fronts={fronts} flash={flash} />;
    case "resumo-mensal": return <WeeklyReportView fronts={fronts} flash={flash} mode="mes" />;
    default: { const missing: never = report.id; return missing; }
  }
}

// ---------------------------------------------------------------------------
// Combustível: entradas, saídas e saldos (mesmas rotas do Histórico do Combustível)
// ---------------------------------------------------------------------------
type FuelSummary = { today: string; fronts: Front[]; fuelTypes: Array<{ id: number; code: string; name: string }>; defaultFrontId: number | null };
type Totals = { count: number; liters: number };
type FuelHistory = {
  total: number; pageSize: number;
  movements: Array<{ id: number; movementDate: string; frontName: string; fuelName: string; movementLabel: string; quantity: number; cost: number | null; equipmentPrefix: string | null; destinationLabel: string | null; thirdPartyDescription: string | null; destinationFrontName: string | null; stockLocationLabel: string; responsible: string | null }>;
  summary: { entries: Totals; exits: Totals; transfers: Totals; balance: number | null; byFuel: Array<{ fuelTypeId: number; fuelName: string; entries: Totals; exits: Totals; transfers: Totals }> };
};

function useFuelSummary() {
  const [summary, setSummary] = useState<FuelSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<FuelSummary>("/api/fuel").then(setSummary).catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar as frentes.")); }, []);
  return { summary, error };
}

function FuelMovementsReport() {
  const { summary, error: summaryError } = useFuelSummary();
  const day = today();
  const [filters, setFilters] = useState({ from: monthStart(day), to: day, frontId: "", fuelTypeId: "", movementType: "", location: "" });
  const [data, setData] = useState<FuelHistory | null>(null);
  const [error, setError] = useState("");
  const params = query(filters);
  useEffect(() => {
    setError("");
    const timer = window.setTimeout(() => { api<FuelHistory>(`/api/fuel/movements?${params}`).then(setData).catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar.")); }, 250);
    return () => window.clearTimeout(timer);
  }, [params]);
  const set = (key: keyof typeof filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const destination = (row: FuelHistory["movements"][number]) => row.equipmentPrefix ?? row.thirdPartyDescription ?? row.destinationLabel ?? (row.destinationFrontName ? `→ ${row.destinationFrontName}` : row.stockLocationLabel);
  return <article className="panel module-panel report-panel">
    <div className="products-filters fuel-history-filters">
      <label>De<input type="date" value={filters.from} max={filters.to} onChange={(event) => event.target.value && set("from")(event.target.value)} /></label>
      <label>Até<input type="date" value={filters.to} min={filters.from} onChange={(event) => event.target.value && set("to")(event.target.value)} /></label>
      <label>Frente<select value={filters.frontId} onChange={(event) => set("frontId")(event.target.value)}><option value="">Todas</option>{summary?.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      <label>Combustível<select value={filters.fuelTypeId} onChange={(event) => set("fuelTypeId")(event.target.value)}><option value="">Todos</option>{summary?.fuelTypes.map((fuel) => <option key={fuel.id} value={fuel.id}>{fuel.name}</option>)}</select></label>
      <label>Tipo<select value={filters.movementType} onChange={(event) => set("movementType")(event.target.value)}><option value="">Todos</option><option value="ENTRADA">Entradas</option><option value="SAIDA">Saídas</option><option value="TRANSFERENCIA">Transferências</option><option value="TERCEIROS">Terceiro/Doações</option><option value="PRESTADORES">Prestadores</option></select></label>
      <label>Estoque<select value={filters.location} onChange={(event) => set("location")(event.target.value)}><option value="">Frente e Porto</option><option value="FRENTE">Frente</option><option value="PORTO">Porto</option></select></label>
      <div className="fuel-export-actions"><a className="secondary" href={`/api/fuel/export?${params}&formato=xlsx`}>Excel</a><a className="secondary" href={`/api/fuel/export?${params}&formato=pdf`} target="_blank" rel="noopener noreferrer">PDF</a></div>
    </div>
    {(error || summaryError) && <div className="fleet-form-error">! {error || summaryError}</div>}
    {!data && !error ? <Loading /> : data && <>
      <div className="fuel-daily-cards">
        <article className="green"><span>Entradas</span><strong>{liters(data.summary.entries.liters)}</strong><small>{data.summary.entries.count} lançamento(s)</small></article>
        <article className="red"><span>Saídas</span><strong>{liters(data.summary.exits.liters)}</strong><small>{data.summary.exits.count} lançamento(s)</small></article>
        <article className="blue"><span>Transferências</span><strong>{liters(data.summary.transfers.liters)}</strong><small>{data.summary.transfers.count} lançamento(s)</small></article>
        {data.summary.balance !== null && <article className="gray"><span>Entradas − saídas</span><strong>{liters(data.summary.balance)}</strong><small>no período filtrado</small></article>}
      </div>
      {data.summary.byFuel.length > 1 && <p className="stock-summary">{data.summary.byFuel.map((fuel) => `${fuel.fuelName}: entradas ${liters(fuel.entries.liters)} · saídas ${liters(fuel.exits.liters)} · transferências ${liters(fuel.transfers.liters)}`).join("  |  ")}</p>}
      <div className="table-scroll"><table className="products-table fuel-history-table">
        <thead><tr><th>Data</th><th>Frente</th><th>Combustível</th><th>Tipo</th><th className="num">Litros</th><th>Equipamento / destino</th><th className="num">Valor</th><th>Responsável</th></tr></thead>
        <tbody>{data.movements.map((row) => <tr key={row.id}><td>{brDay(row.movementDate)}</td><td>{row.frontName}</td><td>{row.fuelName}</td><td>{row.movementLabel}</td><td className="num">{liters(row.quantity)}</td><td>{destination(row)}</td><td className="num">{row.cost === null ? "—" : money(row.cost)}</td><td>{row.responsible ?? "—"}</td></tr>)}</tbody>
      </table>{data.movements.length === 0 && <div className="empty-state">Nenhum lançamento no período e filtros.</div>}</div>
      {data.total > data.movements.length && <p className="table-sub">Mostrando os {data.movements.length} mais recentes de {data.total}. O Excel e o PDF trazem todos (até 5.000), com os mesmos filtros.</p>}
    </>}
  </article>;
}

function FuelDayReport({ flash, back }: { flash: (message: string) => void; back: () => void }) {
  const { summary, error } = useFuelSummary();
  if (error) return <div className="fleet-form-error">! {error}</div>;
  if (!summary) return <Loading />;
  return <>
    <p className="table-sub">Escolha a frente, o dia e o combustível na janela. Fechar volta para o catálogo.</p>
    <FuelDailySummaryModal today={summary.today} fronts={summary.fronts} fuelTypes={summary.fuelTypes} defaultFrontId={summary.defaultFrontId} close={back} flash={flash} />
  </>;
}

// ---------------------------------------------------------------------------
// Relatórios que já eram arquivos (PDF/Excel/CSV) gerados por rotas existentes: filtros + botões.
// ---------------------------------------------------------------------------
type ExportAction = { label: string; href: string };
// Confere a rota antes de baixar: sem dados (ex.: nenhuma troca no período) ou sem permissão, mostra a
// mensagem aqui em vez de abrir uma página de erro. Com o arquivo pronto, baixa pelo link normal (funciona
// também no app Android e no iPhone, que tratam o download do link).
function ExportPanel({ note, children, actions }: { note: string; children: ReactNode; actions: Array<ExportAction | false> }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function download(event: MouseEvent<HTMLAnchorElement>, action: ExportAction) {
    event.preventDefault();
    setBusy(action.label); setError("");
    try {
      const response = await fetch(action.href, { cache: "no-store" });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error ?? "Não foi possível gerar o arquivo."); }
      await response.body?.cancel();
      const link = document.createElement("a"); link.href = action.href; link.download = ""; document.body.appendChild(link); link.click(); link.remove();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível gerar o arquivo."); }
    finally { setBusy(""); }
  }
  return <article className="panel module-panel report-panel report-export">
    <div className="products-filters fuel-history-filters">{children}</div>
    <div className="fuel-export-actions report-export-actions">{actions.filter((action): action is ExportAction => Boolean(action)).map((action) => <a key={action.label} className="secondary" href={action.href} aria-busy={busy === action.label} onClick={(event) => download(event, action)}>{busy === action.label ? "Gerando..." : action.label}</a>)}</div>
    {error && <div className="fleet-form-error">! {error}</div>}
    <p className="table-sub">{note}</p>
  </article>;
}

function categoriesOf(equipment: Equipment[]) {
  return [...new Set(equipment.map((item) => item.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function ProductsExport() {
  const [text, setText] = useState("");
  const [review, setReview] = useState(false);
  const params = query({ q: text.trim(), needsReview: review ? "1" : "" });
  return <ExportPanel note="Produtos ativos com o saldo nas frentes em exibição (seletor de frente no topo). A busca vale para nome, TAG e referência."
    actions={[{ label: "PDF", href: `/api/products-pdf${params ? `?${params}` : ""}` }, { label: "CSV (Excel)", href: `/api/products-csv${params ? `?${params}` : ""}` }]}>
    <label className="stock-filter-wide">Buscar<input value={text} onChange={(event) => setText(event.target.value)} placeholder="Nome, TAG ou referência (vazio = todos)" /></label>
    <label className="report-check"><input type="checkbox" checked={review} onChange={(event) => setReview(event.target.checked)} />Só pendentes de revisão</label>
  </ExportPanel>;
}

function OilChangesExport({ authUser, fronts, equipment }: { authUser: User; fronts: Front[]; equipment: Equipment[] }) {
  const day = today();
  const [from, setFrom] = useState(monthStart(day));
  const [to, setTo] = useState(day);
  const [frontId, setFrontId] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [category, setCategory] = useState("");
  const [responsible, setResponsible] = useState("");
  const frontName = fronts.find((front) => String(front.id) === frontId)?.name ?? "";
  const canExcel = authUser.profile === "ADMIN" || authUser.profile === "GESTOR" || authUser.canExport || authUser.permissions.includes("reports.manutencao");
  const excel = query({ start: from, end: to, serviceFrontId: frontId || "ALL", equipmentId, equipmentType: category, responsible: responsible.trim() });
  const pdf = query({ from, to, front: frontName, equipment: equipmentId, category, kind: "MAINTENANCE", q: responsible.trim() });
  return <ExportPanel note="Trocas registradas no período (frota com troca de óleo habilitada), nas frentes que você enxerga. No PDF, o campo Responsável busca também no serviço e na O.S."
    actions={[canExcel && { label: "Excel", href: `/api/maintenance-export-xlsx?${excel}` }, { label: "PDF", href: `/api/history-report-pdf?${pdf}` }]}>
    <label>De<input type="date" value={from} max={to} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label>
    <label>Até<input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} /></label>
    <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
    <label>Equipamento<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Todos</option>{equipment.map((item) => <option key={item.id} value={item.id}>{item.prefix}</option>)}</select></label>
    <label>Categoria<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option>{categoriesOf(equipment).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    <label>Responsável<input value={responsible} onChange={(event) => setResponsible(event.target.value)} placeholder="Nome (opcional)" /></label>
  </ExportPanel>;
}

function AlertsExport({ fronts, equipment }: { fronts: Front[]; equipment: Equipment[] }) {
  const [status, setStatus] = useState<"VENCIDAS" | "PERTO" | "TODAS">("VENCIDAS");
  const [front, setFront] = useState("");
  const [category, setCategory] = useState("");
  const statuses = status === "VENCIDAS" ? ["OVERDUE", "NEAR"] : status === "PERTO" ? ["WARNING"] : [];
  const params = query({ status: statuses, front, category });
  return <ExportPanel note="Situação de agora dos planos de troca (a mesma da Central de alertas), nas frentes que você enxerga."
    actions={[{ label: "PDF", href: `/api/alerts-report-pdf${params ? `?${params}` : ""}` }]}>
    <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="VENCIDAS">Vencidas e urgentes</option><option value="PERTO">Perto de vencer</option><option value="TODAS">Todas</option></select></label>
    <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas</option>{fronts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
    <label>Categoria<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option>{categoriesOf(equipment).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
  </ExportPanel>;
}

function FleetDayExport({ fronts, equipment }: { fronts: Front[]; equipment: Equipment[] }) {
  const [date, setDate] = useState(today());
  const [status, setStatus] = useState("");
  const [front, setFront] = useState("");
  const [category, setCategory] = useState("");
  const params = query({ date, status, front, category });
  return <ExportPanel note="Movimentações da frota no dia escolhido (o mesmo PDF do botão da tela Status da Frota)."
    actions={[{ label: "PDF", href: `/api/fleet-status-report-pdf?${params}` }]}>
    <label>Dia<input type="date" value={date} max={today()} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
    <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option>{FLEET_STATUSES.map((value) => <option key={value} value={value}>{FLEET_STATUS_LABELS[value]}</option>)}</select></label>
    <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas</option>{fronts.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
    <label>Categoria<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option>{categoriesOf(equipment).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
  </ExportPanel>;
}
