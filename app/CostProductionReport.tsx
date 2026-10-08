"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { COST_CATEGORIES, GROUPINGS, SORTS, variation, type CostCategory, type CostRow, type Grouping, type SortKey } from "../lib/cost-production-rules";

// RELATÓRIOS → Custos → relatórios casados: produção do Controle Diário x custos (cada gasto separado e
// o total), com indicadores, gráficos (mês a mês, por categoria e ranking), comparação com o período
// anterior e Excel/PDF com os mesmos filtros. E a tela dos Outros gastos (lançamento e lista).
type Front = { id: number; name: string };
type Equipment = { id: number; prefix: string; type: string; serviceFrontId?: number | null };
type Report = {
  rows: CostRow[]; total: CostRow; monthly: Array<{ month: string; costs: Record<CostCategory, number>; total: number }>;
  previousPeriod: { from: string; to: string } | null; options: { types: string[]; companies: Array<{ id: number; name: string }> }; canLaunch: boolean;
};

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shiftMonth = (day: string, months: number) => { const date = new Date(`${day.slice(0, 7)}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + months); return date.toISOString().slice(0, 10); };
const lastDay = (first: string) => { const date = new Date(`${first}T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1, 0); return date.toISOString().slice(0, 10); };
const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const moneyShort = (value: number) => value >= 10_000 ? `R$ ${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : money(value);
const num = (value: number, digits = 1) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const opt = (value: number | null, format: (value: number) => string) => (value === null ? "—" : format(value));
const pct = (value: number | null) => (value === null ? "" : `${value > 0 ? "+" : ""}${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`);
const br = (day: string) => day.split("-").reverse().join("/");
const brMonth = (month: string) => `${month.slice(5, 7)}/${month.slice(2, 4)}`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível carregar."));
  return data as T;
}

// Dica ao passar o mouse (ou focar com o teclado) nas barras dos gráficos.
function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const bind = (content: ReactNode) => ({
    tabIndex: 0,
    onMouseMove: (event: MouseEvent) => setTip({ x: event.clientX, y: event.clientY, content }),
    onMouseLeave: () => setTip(null),
    onFocus: (event: { currentTarget: Element }) => { const box = event.currentTarget.getBoundingClientRect(); setTip({ x: box.left + box.width / 2, y: box.top, content }); },
    onBlur: () => setTip(null),
  });
  const node = tip ? <div className="viz-tooltip" role="tooltip" style={{ left: Math.min(tip.x + 12, (typeof window === "undefined" ? 1200 : window.innerWidth) - 230), top: tip.y + 14 }}>{tip.content}</div> : null;
  return { bind, node };
}

export default function CostProductionReport({ initialGrouping, fronts, equipment, flash }: { initialGrouping: Grouping; fronts: Front[]; equipment: Equipment[]; flash: (message: string) => void }) {
  const day = today();
  const [grouping, setGrouping] = useState<Grouping>(initialGrouping);
  const [from, setFrom] = useState(initialGrouping === "mes" ? shiftMonth(day, -5) : `${day.slice(0, 7)}-01`);
  const [to, setTo] = useState(day);
  const [frontId, setFrontId] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [type, setType] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [operator, setOperator] = useState("");
  const [location, setLocation] = useState("");
  const [categories, setCategories] = useState<CostCategory[]>(COST_CATEGORIES.map((category) => category.key));
  const [compare, setCompare] = useState(initialGrouping !== "mes");
  const [sort, setSort] = useState<SortKey>("total");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [version, setVersion] = useState(0);
  const params = useMemo(() => {
    const values: Record<string, string> = { por: grouping, de: from, ate: to, ordem: sort, categorias: categories.join(",") };
    if (frontId) values.frente = frontId; if (equipmentId) values.equipamento = equipmentId; if (type) values.tipo = type; if (companyId) values.empresa = companyId;
    if (operator.trim()) values.operador = operator.trim(); if (location.trim()) values.local = location.trim(); if (compare) values.comparar = "1";
    return new URLSearchParams(values).toString();
  }, [grouping, from, to, sort, categories, frontId, equipmentId, type, companyId, operator, location, compare]);
  useEffect(() => {
    setError("");
    const timer = window.setTimeout(() => { api<Report>(`/api/reports/cost-production?${params}`).then(setReport).catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar.")); }, 300);
    return () => window.clearTimeout(timer);
  }, [params, version]);
  const shortcut = (kind: "mes" | "anterior" | "3meses" | "ano") => {
    if (kind === "mes") { setFrom(`${day.slice(0, 7)}-01`); setTo(day); }
    if (kind === "anterior") { const first = shiftMonth(day, -1); setFrom(first); setTo(lastDay(first)); }
    if (kind === "3meses") { setFrom(shiftMonth(day, -2)); setTo(day); }
    if (kind === "ano") { setFrom(`${day.slice(0, 4)}-01-01`); setTo(day); }
  };
  const toggleCategory = (key: CostCategory) => setCategories((current) => current.includes(key) ? (current.length > 1 ? current.filter((item) => item !== key) : current) : COST_CATEGORIES.map((category) => category.key).filter((item) => item === key || current.includes(item)));
  const shown = COST_CATEGORIES.filter((category) => categories.includes(category.key));
  const total = report?.total;
  const keyLabel = (row: CostRow) => (grouping === "mes" ? brMonth(row.key) : row.key);

  return <article className="panel module-panel report-panel cost-report">
    <div className="products-filters fuel-history-filters cost-report-filters">
      <label>Agrupar por<select value={grouping} onChange={(event) => setGrouping(event.target.value as Grouping)}>{(Object.keys(GROUPINGS) as Grouping[]).map((key) => <option key={key} value={key}>{GROUPINGS[key]}</option>)}</select></label>
      <label>De<input type="date" value={from} max={to} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label>
      <label>Até<input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} /></label>
      <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      <label>Equipamento<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Todos</option>{equipment.map((item) => <option key={item.id} value={item.id}>{item.prefix}</option>)}</select></label>
      <label>Tipo<select value={type} onChange={(event) => setType(event.target.value)}><option value="">Todos</option>{report?.options.types.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Empresa<select value={companyId} onChange={(event) => setCompanyId(event.target.value)}><option value="">Todas</option>{report?.options.companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Operador<input value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="Nome" /></label>
      <label>Local<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Ex.: Talhão 12" /></label>
      <label>Ordenar por<select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>{(Object.keys(SORTS) as SortKey[]).map((key) => <option key={key} value={key}>{SORTS[key]}</option>)}</select></label>
    </div>
    <div className="cost-report-bar">
      <div className="cost-shortcuts" role="group" aria-label="Período">
        <button type="button" onClick={() => shortcut("mes")}>Mês atual</button><button type="button" onClick={() => shortcut("anterior")}>Mês anterior</button>
        <button type="button" onClick={() => shortcut("3meses")}>Últimos 3 meses</button><button type="button" onClick={() => shortcut("ano")}>Ano</button>
      </div>
      <div className="cost-chips" role="group" aria-label="Gastos que entram no relatório">{COST_CATEGORIES.map((category, index) => <button type="button" key={category.key} aria-pressed={categories.includes(category.key)} className={categories.includes(category.key) ? "on" : ""} onClick={() => toggleCategory(category.key)}><i className={`viz-swatch s${index + 1}`} />{category.label}</button>)}</div>
      <label className="report-check"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Comparar com o período anterior</label>
      <div className="fuel-export-actions">
        <ExportLink href={`/api/reports/cost-production?${params}&formato=xlsx`} label="Excel" />
        <ExportLink href={`/api/reports/cost-production?${params}&formato=pdf`} label="PDF" />
        {report?.canLaunch && <button type="button" className="secondary report-action" onClick={() => setLaunching(true)}>＋ Outro gasto</button>}
      </div>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!report && !error ? <div className="page-loading"><span /><p>Somando custos e produção...</p></div> : report && total && <>
      <div className="cost-cards">
        <Card title="Custo total" value={money(total.total)} tone="total" detail={total.previous ? <>{report.previousPeriod && `${br(report.previousPeriod.from)} a ${br(report.previousPeriod.to)}: ${money(total.previous.total)}`} <b className={trend(total.total, total.previous.total)}>{pct(variation(total.total, total.previous.total))}</b></> : `${br(from)} a ${br(to)}`} />
        {shown.map((category) => <Card key={category.key} title={category.label} swatch={COST_CATEGORIES.findIndex((item) => item.key === category.key)} value={money(total.costs[category.key])} detail={category.key === "diesel" ? `${num(total.dieselLiters, 0)} L` : category.key === "gasolina" ? `${num(total.gasolineLiters, 0)} L` : total.total > 0 ? `${num((total.costs[category.key] / total.total) * 100, 0)}% do total` : "—"} />)}
        <Card title="Produção" value={`${num(total.hours)} h · ${num(total.km, 0)} km`} detail={`${num(total.trips, 0)} viagens · ${num(total.volume)} m³ · ${total.records} fichas`} />
        <Card title="Indicadores" value={`${opt(total.perHour, money)}/h`} detail={`${opt(total.perKm, money)}/km · ${opt(total.perTrip, money)}/viagem · ${opt(total.perM3, money)}/m³`} />
        <Card title="Consumo de diesel" value={`${opt(total.litersPerHour, (value) => num(value, 2))} L/h`} detail={`${opt(total.kmPerLiter, (value) => num(value, 2))} km/L · ${opt(total.litersPerM3, (value) => num(value, 2))} L/m³`} />
      </div>
      <Charts report={report} shown={shown.map((category) => category.key)} grouping={grouping} sort={sort} keyLabel={keyLabel} />
      <div className="table-scroll"><table className="products-table cost-table">
        <thead><tr><th>{GROUPINGS[grouping]}</th>{shown.map((category) => <th key={category.key} className="num">{category.label}</th>)}<th className="num">Total</th>
          {compare && <><th className="num">Anterior</th><th className="num">Var.</th></>}
          <th className="num">Horas</th><th className="num">KM</th><th className="num">Viagens</th><th className="num">m³</th><th className="num">R$/h</th><th className="num">R$/km</th><th className="num">R$/viagem</th><th className="num">R$/m³</th><th className="num">Diesel L/h</th><th className="num">km/L</th></tr></thead>
        <tbody>{report.rows.map((row) => <CostTableRow key={row.key} row={row} label={keyLabel(row)} shown={shown.map((category) => category.key)} compare={compare} />)}</tbody>
        <tfoot><CostTableRow row={total} label="Total" shown={shown.map((category) => category.key)} compare={compare} /></tfoot>
      </table>{report.rows.length === 0 && <div className="empty-state">Nenhum custo nem produção no período e filtros.</div>}</div>
      <p className="table-sub">Diesel e gasolina pelo custo médio do estoque (o mesmo do Combustível); peças pelo valor da saída; troca de óleo uma vez por troca; pneus e baterias pela compra na primeira montagem e pelos eventos. Cada custo fica na própria frente e no próprio equipamento (&quot;Sem equipamento&quot; = combustível para terceiros/doações, peças para funcionário ou departamento e outros gastos sem equipamento). Por operador/local, o custo de cada equipamento é dividido pelas horas (ou km) que cada um trabalhou com ele no período; sem ficha no período, vai para &quot;Sem Controle Diário&quot;. R$/h e L/h só dos equipamentos de horímetro; R$/km e km/L só dos de KM.{total.litersWithoutPrice > 0 && ` ${num(total.litersWithoutPrice, 0)} L de combustível sem preço de entrada (entram nos litros, não no R$).`}</p>
    </>}
    {launching && <OtherExpenseModal fronts={fronts} equipment={equipment} item={null} close={() => setLaunching(false)} saved={(message) => { setLaunching(false); flash(message); setVersion((value) => value + 1); }} />}
  </article>;
}

const trend = (current: number, previous: number | null | undefined) => (previous && current > previous ? "up" : previous && current < previous ? "down" : "");

function Card({ title, value, detail, tone, swatch }: { title: string; value: string; detail: ReactNode; tone?: string; swatch?: number }) {
  return <article className={`cost-card ${tone ?? ""}`}><span>{swatch !== undefined && <i className={`viz-swatch s${swatch + 1}`} />}{title}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function CostTableRow({ row, label, shown, compare }: { row: CostRow; label: string; shown: CostCategory[]; compare: boolean }) {
  const change = variation(row.total, row.previous?.total);
  return <tr>
    <td><strong>{label}</strong></td>
    {shown.map((key) => <td key={key} className="num">{money(row.costs[key])}</td>)}
    <td className="num"><strong>{money(row.total)}</strong></td>
    {compare && <><td className="num">{row.previous ? money(row.previous.total) : "—"}</td><td className={`num ${trend(row.total, row.previous?.total)}`}>{pct(change)}</td></>}
    <td className="num">{num(row.hours)}</td><td className="num">{num(row.km, 0)}</td><td className="num">{num(row.trips, 0)}</td><td className="num">{num(row.volume)}</td>
    <td className="num">{opt(row.perHour, money)}</td><td className="num">{opt(row.perKm, money)}</td><td className="num">{opt(row.perTrip, money)}</td><td className="num">{opt(row.perM3, money)}</td>
    <td className="num">{opt(row.litersPerHour, (value) => num(value, 2))}</td><td className="num">{opt(row.kmPerLiter, (value) => num(value, 2))}</td>
  </tr>;
}

// Gráficos simples: custo por categoria (barras), mês a mês (colunas empilhadas por categoria, cores
// fixas por categoria) e ranking (os 10 primeiros pela ordem escolhida).
function Charts({ report, shown, grouping, sort, keyLabel }: { report: Report; shown: CostCategory[]; grouping: Grouping; sort: SortKey; keyLabel: (row: CostRow) => string }) {
  const { bind, node } = useTooltip();
  const slot = (key: CostCategory) => COST_CATEGORIES.findIndex((category) => category.key === key) + 1;
  const labelOf = (key: CostCategory) => COST_CATEGORIES.find((category) => category.key === key)!.label;
  const byCategory = shown.map((key) => ({ key, value: report.total.costs[key] })).sort((a, b) => b.value - a.value);
  const maxCategory = Math.max(1, ...byCategory.map((item) => item.value));
  const maxMonth = Math.max(1, ...report.monthly.map((month) => month.total));
  const metric: Exclude<SortKey, "key"> = sort === "key" ? "total" : sort;
  const ranking = grouping === "geral" || grouping === "mes" ? [] : report.rows.filter((row) => (row[metric] ?? 0) > 0).slice(0, 10);
  const maxRank = Math.max(1, ...ranking.map((row) => row[metric] ?? 0));
  const metricText = (row: CostRow) => metric === "total" ? money(row.total) : `${opt(row[metric], money)}${metric === "perHour" ? "/h" : metric === "perKm" ? "/km" : metric === "perTrip" ? "/viagem" : "/m³"}`;
  return <div className="cost-charts viz-root">
    <section className="cost-chart" aria-label="Custo por categoria">
      <h3>Custo por categoria</h3>
      <div className="hbars">{byCategory.map((item) => <div key={item.key} className="hbar" {...bind(<><b>{labelOf(item.key)}</b><br />{money(item.value)} · {report.total.total > 0 ? num((item.value / report.total.total) * 100, 0) : 0}% do total</>)}>
        <span className="hbar-label">{labelOf(item.key)}</span><span className="hbar-track"><i className="hbar-fill" style={{ width: `${(item.value / maxCategory) * 100}%` }} /></span><span className="hbar-value">{moneyShort(item.value)}</span>
      </div>)}</div>
    </section>
    <section className="cost-chart" aria-label="Custo mês a mês">
      <h3>Mês a mês</h3>
      {report.monthly.length === 0 ? <p className="table-sub">Sem custo no período.</p> : <>
        <div className="vbars">{report.monthly.map((month) => <div key={month.month} className="vbar">
          <div className="vbar-stack" style={{ height: `${(month.total / maxMonth) * 100}%` }}>{shown.filter((key) => month.costs[key] > 0).map((key) => <i key={key} className={`viz-fill s${slot(key)}`} style={{ flexGrow: month.costs[key] }} {...bind(<><b>{brMonth(month.month)} · {labelOf(key)}</b><br />{money(month.costs[key])} de {money(month.total)}</>)} />)}</div>
          <span className="vbar-label">{brMonth(month.month)}</span>
        </div>)}</div>
        <div className="viz-legend">{shown.map((key) => <span key={key}><i className={`viz-swatch s${slot(key)}`} />{labelOf(key)}</span>)}</div>
      </>}
    </section>
    {ranking.length > 0 && <section className="cost-chart" aria-label="Ranking">
      <h3>Ranking: {SORTS[metric].toLowerCase()}</h3>
      <div className="hbars">{ranking.map((row) => <div key={row.key} className="hbar" {...bind(<><b>{keyLabel(row)}</b><br />Total {money(row.total)} · {opt(row.perHour, money)}/h · {opt(row.perKm, money)}/km</>)}>
        <span className="hbar-label">{keyLabel(row)}</span><span className="hbar-track"><i className="hbar-fill" style={{ width: `${((row[metric] ?? 0) / maxRank) * 100}%` }} /></span><span className="hbar-value">{metricText(row)}</span>
      </div>)}</div>
    </section>}
    {node}
  </div>;
}

export function ExportLink({ href, label }: { href: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error ?? "Não foi possível gerar o arquivo."); }
      await response.body?.cancel();
      const link = document.createElement("a"); link.href = href; link.download = ""; document.body.appendChild(link); link.click(); link.remove();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível gerar o arquivo."); }
    finally { setBusy(false); }
  }
  return <a className="secondary" href={href} onClick={download} title={error || undefined}>{busy ? "Gerando..." : error ? `${label} (erro)` : label}</a>;
}

// ---------------------------------------------------------------------------
// Outros gastos: lançamento (modal) e lista.
// ---------------------------------------------------------------------------
type Expense = { id: number; serviceFrontId: number; frontName: string; equipmentId: number | null; equipmentPrefix: string | null; expenseDate: string; category: "SERVICO" | "OUTROS"; categoryLabel: string; amount: number; description: string; createdByName: string | null };

export function OtherExpenseModal({ fronts, equipment, item, close, saved }: { fronts: Front[]; equipment: Equipment[]; item: Expense | null; close: () => void; saved: (message: string) => void }) {
  const [frontId, setFrontId] = useState(String(item?.serviceFrontId ?? (fronts.length === 1 ? fronts[0].id : "")));
  const [equipmentId, setEquipmentId] = useState(item?.equipmentId ? String(item.equipmentId) : "");
  const [category, setCategory] = useState<"SERVICO" | "OUTROS">(item?.category ?? "SERVICO");
  const [date, setDate] = useState(item?.expenseDate ?? today());
  const [amount, setAmount] = useState(item ? item.amount.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = equipment.filter((row) => !frontId || row.serviceFrontId === undefined || row.serviceFrontId === null || String(row.serviceFrontId) === frontId || String(row.id) === equipmentId);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body = JSON.stringify({ serviceFrontId: Number(frontId), equipmentId: equipmentId ? Number(equipmentId) : null, category, expenseDate: date, amount, description });
      const result = await api<{ message: string }>(item ? `/api/other-expenses/${item.id}` : "/api/other-expenses", { method: item ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body });
      saved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal other-expense-modal" role="dialog" aria-label={item ? "Editar outro gasto" : "Lançar outro gasto"}>
      <header><div><p className="eyebrow">RELATÓRIOS · CUSTOS</p><h2>{item ? "Editar gasto" : "Lançar outro gasto"}</h2><span>Serviço/mão de obra de fora ou outros gastos que não passam pelo estoque nem pelo combustível.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label>Frente<select value={frontId} required onChange={(event) => setFrontId(event.target.value)}><option value="">Escolha</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
        <label>Data<input type="date" value={date} required max={today()} onChange={(event) => setDate(event.target.value)} /></label>
        <fieldset className="full other-expense-category"><legend>Categoria</legend>
          <label><input type="radio" name="category" checked={category === "SERVICO"} onChange={() => setCategory("SERVICO")} />Serviço / mão de obra</label>
          <label><input type="radio" name="category" checked={category === "OUTROS"} onChange={() => setCategory("OUTROS")} />Outros</label>
        </fieldset>
        <label>Equipamento <small>(opcional)</small><select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Nenhum (gasto da frente)</option>{options.map((row) => <option key={row.id} value={row.id}>{row.prefix}</option>)}</select></label>
        <label>Valor (R$)<input value={amount} required inputMode="decimal" placeholder="0,00" onChange={(event) => setAmount(event.target.value)} /></label>
        <label className="full">Descrição<input value={description} required maxLength={300} placeholder="Ex.: mão de obra do torneiro, frete da peça, aluguel do guincho" onChange={(event) => setDescription(event.target.value)} /></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : item ? "Salvar" : "Lançar"}</button></div>
      </form>
    </section>
  </div>;
}

export function OtherExpensesView({ fronts, equipment, flash }: { fronts: Front[]; equipment: Equipment[]; flash: (message: string) => void }) {
  const day = today();
  const [from, setFrom] = useState(`${day.slice(0, 7)}-01`);
  const [to, setTo] = useState(day);
  const [frontId, setFrontId] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [category, setCategory] = useState("");
  const [data, setData] = useState<{ expenses: Expense[]; total: number; canLaunch: boolean } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const params = new URLSearchParams(Object.entries({ de: from, ate: to, frente: frontId, equipamento: equipmentId, categoria: category }).filter(([, value]) => value)).toString();
  const load = useCallback(() => { setError(""); api<{ expenses: Expense[]; total: number; canLaunch: boolean }>(`/api/other-expenses?${params}`).then(setData).catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar.")); }, [params]);
  useEffect(() => { load(); }, [load]);
  async function remove(expense: Expense) {
    if (!window.confirm(`Excluir o gasto "${expense.description}" de ${money(expense.amount)}? Ele sai dos relatórios.`)) return;
    try { flash((await api<{ message: string }>(`/api/other-expenses/${expense.id}`, { method: "DELETE" })).message); load(); }
    catch (problem) { window.alert(problem instanceof Error ? problem.message : "Não foi possível excluir."); }
  }
  return <article className="panel module-panel report-panel">
    <div className="products-filters fuel-history-filters">
      <label>De<input type="date" value={from} max={to} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label>
      <label>Até<input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} /></label>
      <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      <label>Equipamento<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Todos</option>{equipment.map((row) => <option key={row.id} value={row.id}>{row.prefix}</option>)}</select></label>
      <label>Categoria<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">Todas</option><option value="SERVICO">Serviço / mão de obra</option><option value="OUTROS">Outros</option></select></label>
      <div className="fuel-export-actions"><ExportLink href={`/api/other-expenses?${params}&formato=xlsx`} label="Excel" />{data?.canLaunch && <button type="button" className="primary" onClick={() => setEditing("new")}>＋ Lançar gasto</button>}</div>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {!data && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : data && <>
      <p className="stock-summary">{data.expenses.length} lançamento(s) · total {money(data.total)}{!data.canLaunch && " · para lançar, peça ao administrador a permissão \"Lançar Outros gastos\"."}</p>
      <div className="table-scroll"><table className="products-table">
        <thead><tr><th>Data</th><th>Frente</th><th>Equipamento</th><th>Categoria</th><th>Descrição</th><th className="num">Valor</th><th>Lançado por</th>{data.canLaunch && <th />}</tr></thead>
        <tbody>{data.expenses.map((row) => <tr key={row.id}><td>{br(row.expenseDate)}</td><td>{row.frontName}</td><td>{row.equipmentPrefix ?? "—"}</td><td>{row.categoryLabel}</td><td>{row.description}</td><td className="num">{money(row.amount)}</td><td>{row.createdByName ?? "—"}</td>
          {data.canLaunch && <td><div className="equipment-row-actions"><button type="button" onClick={() => setEditing(row)}>Editar</button><button type="button" onClick={() => remove(row)}>Excluir</button></div></td>}</tr>)}</tbody>
      </table>{data.expenses.length === 0 && <div className="empty-state">Nenhum gasto lançado no período e filtros.</div>}</div>
    </>}
    {editing && <OtherExpenseModal fronts={fronts} equipment={equipment} item={editing === "new" ? null : editing} close={() => setEditing(null)} saved={(message) => { setEditing(null); flash(message); load(); }} />}
  </article>;
}
