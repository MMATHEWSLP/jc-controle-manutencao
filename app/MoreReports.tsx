"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState, type ReactNode } from "react";
import { ExportLink } from "./CostProductionReport";

// RELATÓRIOS (parte 3c): combustível por destino, consumo por equipamento, ajustes de estoque, ordens
// de serviço e pneus e baterias. Cada um: filtros, cards de resumo, tabela e Excel/PDF com os mesmos filtros.
type Front = { id: number; name: string };
type Equipment = { id: number; prefix: string };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const money = (value: number | null) => (value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const num = (value: number | null, digits = 2) => (value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits }));
const br = (day: string | null) => (day ? day.split("-").reverse().join("/") : "—");
const query = (values: Record<string, string>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value)).toString();

function useReport<T>(endpoint: string, params: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    const timer = window.setTimeout(() => {
      fetch(`${endpoint}?${params}`, { cache: "no-store" }).then(async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error ?? "Não foi possível carregar."); setData(body as T); })
        .catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar."));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [endpoint, params]);
  return { data, error };
}

function Shell({ filters, endpoint, params, cards, children, note, loading, error }: { filters: ReactNode; endpoint: string; params: string; cards: ReactNode; children: ReactNode; note: string; loading: boolean; error: string }) {
  return <article className="panel module-panel report-panel">
    <div className="products-filters fuel-history-filters">{filters}<div className="fuel-export-actions"><ExportLink href={`${endpoint}?${params}&formato=xlsx`} label="Excel" /><ExportLink href={`${endpoint}?${params}&formato=pdf`} label="PDF" /></div></div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {loading && !error ? <div className="page-loading"><span /><p>Carregando relatório...</p></div> : !error && <>
      <div className="cost-cards">{cards}</div>
      {children}
      <p className="table-sub">{note}</p>
    </>}
  </article>;
}
const Card = ({ title, value, detail }: { title: string; value: string; detail?: string }) => <article className="cost-card"><span>{title}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>;
function Period({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void }) {
  return <><label>De<input type="date" value={from} max={to} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label><label>Até<input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} /></label></>;
}
const FrontSelect = ({ fronts, value, onChange }: { fronts: Front[]; value: string; onChange: (value: string) => void }) => <label>Frente<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>;
function usePeriod() { const day = today(); const [from, setFrom] = useState(`${day.slice(0, 7)}-01`); const [to, setTo] = useState(day); return { from, to, setFrom, setTo }; }

// ---------------------------------------------------------------------------
type DestinationRow = { destination: string; kind: string; purpose: string | null; front: string; count: number; liters: number; value: number; withoutPrice: number };
export function FuelDestinationsReport({ fronts }: { fronts: Front[] }) {
  const period = usePeriod();
  const [front, setFront] = useState("");
  const [fuel, setFuel] = useState("");
  const params = query({ de: period.from, ate: period.to, frente: front, combustivel: fuel });
  const { data, error } = useReport<{ rows: DestinationRow[]; totals: { count: number; liters: number; value: number }; fuelTypes: Array<{ id: number; name: string }>; fuelTypeId: number | null }>("/api/reports/fuel-destinations", params);
  return <Shell endpoint="/api/reports/fuel-destinations" params={params} loading={!data} error={error}
    filters={<><Period {...period} /><FrontSelect fronts={fronts} value={front} onChange={setFront} />
      <label>Combustível<select value={fuel || String(data?.fuelTypeId ?? "")} onChange={(event) => setFuel(event.target.value)}>{data?.fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}<option value="todos">Todos</option></select></label></>}
    cards={data && <><Card title="Litros" value={`${num(data.totals.liters, 0)} L`} /><Card title="Valor" value={money(data.totals.value)} detail="custo médio do estoque" /><Card title="Lançamentos" value={String(data.totals.count)} /></>}
    note="Saídas do Combustível no período (sem excluídas e sem ajustes de saldo). Terceiro/Doações e Prestador mostram a empresa e o veículo ou funcionário; a finalidade aparece quando foi para funcionário do terceiro.">
    {data && <div className="table-scroll"><table className="products-table"><thead><tr><th>Destino</th><th>Tipo</th><th>Finalidade</th><th>Frente</th><th className="num">Lançamentos</th><th className="num">Litros</th><th className="num">Valor</th></tr></thead>
      <tbody>{data.rows.map((row) => <tr key={`${row.front}-${row.kind}-${row.destination}-${row.purpose}`}><td><strong>{row.destination}</strong></td><td>{row.kind}</td><td>{row.purpose ?? "—"}</td><td>{row.front}</td><td className="num">{row.count}</td><td className="num">{num(row.liters)} L</td><td className="num">{money(row.value)}{row.withoutPrice > 0 && <small className="table-sub">{num(row.withoutPrice, 0)} L sem preço</small>}</td></tr>)}</tbody></table>
      {data.rows.length === 0 && <div className="empty-state">Nenhuma saída no período e filtros.</div>}</div>}
  </Shell>;
}

// ---------------------------------------------------------------------------
type ConsumptionRow = { equipmentId: number; prefix: string; type: string; front: string | null; unit: "HOURS" | "KM"; liters: number; usage: number | null; consumption: number | null; typeAverage: number | null; deviation: number | null; outlier: "ACIMA" | "ABAIXO" | null };
export function ConsumptionReport({ fronts }: { fronts: Front[] }) {
  const period = usePeriod();
  const [front, setFront] = useState("");
  const [outliers, setOutliers] = useState(false);
  const params = query({ de: period.from, ate: period.to, frente: front, fora: outliers ? "1" : "" });
  const { data, error } = useReport<{ rows: ConsumptionRow[]; totals: { liters: number; outliers: number; withoutUsage: number } }>("/api/reports/consumption", params);
  const unit = (row: ConsumptionRow) => (row.unit === "KM" ? "km/L" : "L/h");
  return <Shell endpoint="/api/reports/consumption" params={params} loading={!data} error={error}
    filters={<><Period {...period} /><FrontSelect fronts={fronts} value={front} onChange={setFront} /><label className="report-check"><input type="checkbox" checked={outliers} onChange={(event) => setOutliers(event.target.checked)} />Só consumo acima da média</label></>}
    cards={data && <><Card title="Litros" value={`${num(data.totals.liters, 0)} L`} /><Card title="Acima da média" value={String(data.totals.outliers)} detail="mais de 25% pior que o tipo" /><Card title="Sem leitura" value={String(data.totals.withoutUsage)} detail="abastecidos sem horímetro/KM no período" /></>}
    note="Consumo = litros ÷ horas (L/h) ou km ÷ litros (km/L) no período, pelas leituras de horímetro/KM. O mesmo cálculo do Custos e Consumo, sem os valores em R$.">
    {data && <div className="table-scroll"><table className="products-table"><thead><tr><th>Equipamento</th><th>Frente</th><th className="num">Litros</th><th className="num">Uso</th><th className="num">Consumo</th><th className="num">Média do tipo</th><th>Situação</th></tr></thead>
      <tbody>{data.rows.map((row) => <tr key={row.equipmentId}><td><strong>{row.prefix}</strong><small className="table-sub">{row.type}</small></td><td>{row.front ?? "—"}</td><td className="num">{num(row.liters, 0)}</td>
        <td className="num">{row.usage === null ? <span className="table-sub">sem leitura</span> : `${num(row.usage, 1)} ${row.unit === "KM" ? "km" : "h"}`}</td>
        <td className="num">{row.consumption === null ? "—" : `${num(row.consumption)} ${unit(row)}`}</td><td className="num">{row.typeAverage === null ? "—" : `${num(row.typeAverage)} ${unit(row)}`}</td>
        <td>{row.outlier && <span className={`status-pill ${row.outlier === "ACIMA" ? "red" : "blue"}`}>{row.outlier === "ACIMA" ? "Gasta mais" : "Gasta menos"}</span>}</td></tr>)}</tbody></table>
      {data.rows.length === 0 && <div className="empty-state">Nenhum equipamento abastecido no período e filtros.</div>}</div>}
  </Shell>;
}

// ---------------------------------------------------------------------------
type AdjustmentRow = { id: number; date: string; front: string; tag: string; product: string; delta: number; value: number; reason: string; origin: string; user: string | null };
export function StockAdjustmentsReport({ fronts }: { fronts: Front[] }) {
  const period = usePeriod();
  const [front, setFront] = useState("");
  const [text, setText] = useState("");
  const params = query({ de: period.from, ate: period.to, frente: front, q: text.trim() });
  const { data, error } = useReport<{ rows: AdjustmentRow[]; totals: { count: number; increases: number; decreases: number; increaseValue: number; decreaseValue: number } }>("/api/reports/stock-adjustments", params);
  return <Shell endpoint="/api/reports/stock-adjustments" params={params} loading={!data} error={error}
    filters={<><Period {...period} /><FrontSelect fronts={fronts} value={front} onChange={setFront} /><label className="stock-filter-wide">Produto<input value={text} onChange={(event) => setText(event.target.value)} placeholder="Nome ou TAG" /></label></>}
    cards={data && <><Card title="Ajustes" value={String(data.totals.count)} /><Card title="Para mais" value={money(data.totals.increaseValue)} detail={`${data.totals.increases} ajuste(s)`} /><Card title="Para menos" value={money(data.totals.decreaseValue)} detail={`${data.totals.decreases} ajuste(s)`} /></>}
    note="Ajuste manual do saldo (Produtos → saldo da frente) e Correção de estoque do histórico importado. Valor = quantidade × valor do movimento (sem valor, o preço do cadastro).">
    {data && <div className="table-scroll"><table className="products-table"><thead><tr><th>Data</th><th>Frente</th><th>Produto</th><th className="num">Quantidade</th><th className="num">Valor</th><th>Origem</th><th>Motivo</th><th>Por</th></tr></thead>
      <tbody>{data.rows.map((row) => <tr key={row.id}><td>{br(row.date)}</td><td>{row.front}</td><td><strong>{row.tag}</strong> {row.product}</td><td className="num">{row.delta > 0 ? "+" : ""}{num(row.delta)}</td><td className="num">{money(row.value)}</td><td>{row.origin}</td><td>{row.reason || "—"}</td><td>{row.user ?? "—"}</td></tr>)}</tbody></table>
      {data.rows.length === 0 && <div className="empty-state">Nenhum ajuste no período e filtros.</div>}</div>}
  </Shell>;
}

// ---------------------------------------------------------------------------
type WorkOrderRow = { id: number; number: string; prefix: string; front: string; openedAt: string; closedAt: string | null; status: "OPEN" | "CLOSED"; days: number; description: string; items: number; partsTotal: number; oilChanges: number; mechanics: string };
export function WorkOrdersReport({ fronts, equipment }: { fronts: Front[]; equipment: Equipment[] }) {
  const period = usePeriod();
  const [front, setFront] = useState("");
  const [status, setStatus] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const params = query({ de: period.from, ate: period.to, frente: front, situacao: status, equipamento: equipmentId });
  const { data, error } = useReport<{ rows: WorkOrderRow[]; totals: { count: number; open: number; closed: number; partsTotal: number; averageDaysClosed: number | null } }>("/api/reports/work-orders", params);
  return <Shell endpoint="/api/reports/work-orders" params={params} loading={!data} error={error}
    filters={<><Period {...period} /><FrontSelect fronts={fronts} value={front} onChange={setFront} />
      <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option><option value="OPEN">Abertas</option><option value="CLOSED">Fechadas</option></select></label>
      <label>Equipamento<select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}><option value="">Todos</option>{equipment.map((item) => <option key={item.id} value={item.id}>{item.prefix}</option>)}</select></label></>}
    cards={data && <><Card title="O.S. abertas no período" value={String(data.totals.count)} detail={`${data.totals.open} ainda abertas · ${data.totals.closed} fechadas`} /><Card title="Tempo médio" value={data.totals.averageDaysClosed === null ? "—" : `${num(data.totals.averageDaysClosed, 1)} dias`} detail="das fechadas" /><Card title="Peças" value={money(data.totals.partsTotal)} detail="valor lançado nas O.S." /></>}
    note="O.S. abertas no período (pela data de abertura). Dias = até o fechamento, ou até hoje se ainda aberta.">
    {data && <div className="table-scroll"><table className="products-table"><thead><tr><th>O.S.</th><th>Equipamento</th><th>Frente</th><th>Aberta</th><th>Fechada</th><th className="num">Dias</th><th>Descrição</th><th className="num">Peças</th><th>Mecânicos</th></tr></thead>
      <tbody>{data.rows.map((row) => <tr key={row.id}><td><strong>{row.number}</strong>{row.oilChanges > 0 && <small className="table-sub">{row.oilChanges} troca(s)</small>}</td><td>{row.prefix}</td><td>{row.front}</td><td>{br(row.openedAt)}</td>
        <td>{row.status === "CLOSED" ? br(row.closedAt) : <span className="status-pill orange">Aberta</span>}</td><td className="num">{row.days}</td><td>{row.description}</td><td className="num">{money(row.partsTotal)}<small className="table-sub">{row.items} item(ns)</small></td><td>{row.mechanics || "—"}</td></tr>)}</tbody></table>
      {data.rows.length === 0 && <div className="empty-state">Nenhuma O.S. aberta no período e filtros.</div>}</div>}
  </Shell>;
}

// ---------------------------------------------------------------------------
type ComponentRow = { id: number; kind: "TIRE" | "BATTERY"; code: string; brand: string; model: string | null; size: string | null; status: "STOCK" | "MOUNTED" | "DISCARDED"; prefix: string | null; position: string | null; usage: number | null; unit: string | null; lifePercent: number | null; totalCost: number | null; costPerUnit: number | null; alert: { level: string; text: string } | null };
const KIND = { TIRE: "Pneu", BATTERY: "Bateria" } as const;
const STATUS = { STOCK: "Em estoque", MOUNTED: "Montado", DISCARDED: "Descartado" } as const;
export function ComponentsReport() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [alerts, setAlerts] = useState(false);
  const [text, setText] = useState("");
  const params = query({ tipo: kind, situacao: status, alertas: alerts ? "1" : "", q: text.trim() });
  const { data, error } = useReport<{ items: ComponentRow[]; totals: { count: number; mounted: number; alerts: number; cost: number | null }; canSeeCosts: boolean }>("/api/reports/components", params);
  return <Shell endpoint="/api/reports/components" params={params} loading={!data} error={error}
    filters={<><label>Tipo<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Pneus e baterias</option><option value="TIRE">Pneus</option><option value="BATTERY">Baterias</option></select></label>
      <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option><option value="MOUNTED">Montados</option><option value="STOCK">Em estoque</option><option value="DISCARDED">Descartados</option></select></label>
      <label className="stock-filter-wide">Buscar<input value={text} onChange={(event) => setText(event.target.value)} placeholder="Código, marca, medida ou equipamento" /></label>
      <label className="report-check"><input type="checkbox" checked={alerts} onChange={(event) => setAlerts(event.target.checked)} />Só com alerta</label></>}
    cards={data && <><Card title="Itens" value={String(data.totals.count)} detail={`${data.totals.mounted} montados`} /><Card title="Com alerta" value={String(data.totals.alerts)} />{data.canSeeCosts && <Card title="Custo" value={money(data.totals.cost)} detail="compra + eventos" />}</>}
    note="Custo = compra + eventos (recapagem, conserto...); custo por km/h = custo ÷ uso. Vida usada = uso ÷ vida esperada (bateria: meses). Valores só para administrador e gestor, como na tela Pneus e Baterias.">
    {data && <div className="table-scroll"><table className="products-table"><thead><tr><th>Item</th><th>Situação</th><th>Equipamento</th><th className="num">Uso</th><th className="num">Vida usada</th>{data.canSeeCosts && <><th className="num">Custo</th><th className="num">Por km/h</th></>}<th>Alerta</th></tr></thead>
      <tbody>{data.items.map((row) => <tr key={row.id}><td><strong>{KIND[row.kind]} {row.code}</strong><small className="table-sub">{[row.brand, row.model, row.size].filter(Boolean).join(" · ")}</small></td><td>{STATUS[row.status]}</td><td>{row.prefix ?? "—"}{row.position && <small className="table-sub">{row.position}</small>}</td>
        <td className="num">{row.usage === null ? "—" : `${num(row.usage, 0)} ${row.unit === "KM" ? "km" : row.unit === "HOURS" ? "h" : "meses"}`}</td><td className="num">{row.lifePercent === null ? "—" : `${row.lifePercent}%`}</td>
        {data.canSeeCosts && <><td className="num">{money(row.totalCost)}</td><td className="num">{row.costPerUnit === null ? "—" : money(row.costPerUnit)}</td></>}
        <td>{row.alert ? <span className={`status-pill ${row.alert.level}`}>{row.alert.text}</span> : "—"}</td></tr>)}</tbody></table>
      {data.items.length === 0 && <div className="empty-state">Nenhum pneu ou bateria para os filtros.</div>}</div>}
  </Shell>;
}
