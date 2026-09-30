"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import LoadWarning from "./LoadWarning";

type Row = {
  equipmentId: number; prefix: string; type: string; front: string | null; unit: "HOURS" | "KM";
  liters: number; fuelCost: number; fuelWithoutPrice: number; usage: number | null; consumption: number | null; typeAverage: number | null;
  deviation: number | null; outlier: "ACIMA" | "ABAIXO" | null; partsCost: number; maintenanceCost: number; totalCost: number; costPerUnit: number | null;
};
type Report = {
  period: { from: string; to: string }; fronts: Array<{ id: number; name: string }>;
  totals: { liters: number; fuelCost: number; partsCost: number; maintenanceCost: number; totalCost: number; outliers: number; withoutUsage: number };
  rows: Row[];
};

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const number = (value: number | null, digits = 1) => value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const unitLabel = (unit: Row["unit"]) => unit === "KM" ? "km/L" : "L/h";
const usageLabel = (unit: Row["unit"]) => unit === "KM" ? "km" : "h";
const brDay = (value: string) => value.split("-").reverse().join("/");

// Painel de custo e consumo por equipamento (ideias 1, 2 e 8 do relatório de teste).
export default function FleetCostsView() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [front, setFront] = useState("");
  const [onlyOutliers, setOnlyOutliers] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams(Object.entries({ de: from, ate: to, frente: front }).filter(([, value]) => value));
      const response = await fetch(`/api/fleet-costs${params.size ? `?${params}` : ""}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Não foi possível calcular os custos.");
      setReport(data); setFrom(data.period.from); setTo(data.period.to);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível calcular os custos."); }
    finally { setLoading(false); }
  }, [from, to, front]);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  const rows = useMemo(() => (report?.rows ?? []).filter((row) => !onlyOutliers || row.outlier === "ACIMA"), [report, onlyOutliers]);

  function exportCsv() {
    if (!report) return;
    const header = ["Prefixo", "Tipo", "Frente", "Litros", "Uso", "Unidade", "Consumo", "Média do tipo", "Situação", "Combustível (R$)", "Litros sem preço", "Peças (R$)", "Manutenção (R$)", "Total (R$)", "Custo por h/km (R$)"];
    const cell = (value: unknown) => { const text = value === null || value === undefined ? "" : typeof value === "number" ? value.toLocaleString("pt-BR", { maximumFractionDigits: 2, useGrouping: false }) : String(value); return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
    const lines = report.rows.map((row) => [row.prefix, row.type, row.front ?? "", row.liters, row.usage, usageLabel(row.unit), row.consumption, row.typeAverage, row.outlier === "ACIMA" ? "Consumo acima da média" : row.outlier === "ABAIXO" ? "Consumo abaixo da média" : "", row.fuelCost, row.fuelWithoutPrice, row.partsCost, row.maintenanceCost, row.totalCost, row.costPerUnit].map(cell).join(";"));
    const blob = new Blob([`﻿${[header.join(";"), ...lines].join("\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `custos-consumo-${report.period.from}-a-${report.period.to}.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  return <>
    <div className="page-heading module-heading">
      <div><p className="eyebrow">FROTA PRÓPRIA</p><h1>Custos e consumo</h1><span>Combustível, peças e trocas por equipamento no período, com o consumo comparado à média dos equipamentos do mesmo tipo.</span></div>
      <div className="heading-actions"><button className="secondary" onClick={exportCsv} disabled={!report?.rows.length}>Exportar CSV</button></div>
    </div>
    <article className="panel module-panel fleet-costs-filters">
      <label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas</option>{report?.fronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="fleet-costs-check"><input type="checkbox" checked={onlyOutliers} onChange={(event) => setOnlyOutliers(event.target.checked)} />Só consumo acima da média</label>
      <button className="primary" onClick={load} disabled={loading}>{loading ? "Calculando..." : "Aplicar"}</button>
    </article>
    <LoadWarning message={error} />
    {report && <div className="metric-grid fleet-costs-metrics">
      <div className="metric-card"><div><strong>{money.format(report.totals.totalCost)}</strong><span>Custo total</span><small>{brDay(report.period.from)} a {brDay(report.period.to)}</small></div></div>
      <div className="metric-card"><div><strong>{number(report.totals.liters, 0)} L</strong><span>Combustível</span><small>{money.format(report.totals.fuelCost)}</small></div></div>
      <div className="metric-card"><div><strong>{money.format(report.totals.partsCost + report.totals.maintenanceCost)}</strong><span>Peças e trocas</span><small>peças {money.format(report.totals.partsCost)} · trocas {money.format(report.totals.maintenanceCost)}</small></div></div>
      <div className={`metric-card ${report.totals.outliers ? "red" : "green"}`}><div><strong>{report.totals.outliers}</strong><span>Consumo acima da média</span><small>{report.totals.withoutUsage} abastecidos sem leitura no período</small></div></div>
    </div>}
    {report && <article className="panel module-panel"><div className="table-scroll"><table>
      <thead><tr><th>Equipamento</th><th>Frente</th><th>Litros</th><th>Uso</th><th>Consumo</th><th>Média do tipo</th><th>Combustível</th><th>Peças</th><th>Trocas</th><th>Total</th><th>Custo por h/km</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.equipmentId}>
        <td><b>{row.prefix}</b><small className="table-sub">{row.type}</small></td>
        <td>{row.front ?? "—"}</td>
        <td>{number(row.liters, 0)}{row.fuelWithoutPrice > 0 && <small className="table-sub" title="Litros de estoque sem preço de entrada informado">{number(row.fuelWithoutPrice, 0)} L sem preço</small>}</td>
        <td>{row.usage === null ? <span className="table-sub" title="Sem leituras de horímetro/KM no período">sem leitura</span> : `${number(row.usage)} ${usageLabel(row.unit)}`}</td>
        <td>{row.consumption === null ? "—" : `${number(row.consumption, 2)} ${unitLabel(row.unit)}`}{row.outlier && <span className={`status-pill ${row.outlier === "ACIMA" ? "red" : "blue"}`} title={`${number((row.deviation ?? 0) * 100, 0)}% em relação à média do tipo`}>{row.outlier === "ACIMA" ? "Gasta mais" : "Gasta menos"}</span>}</td>
        <td>{row.typeAverage === null ? "—" : `${number(row.typeAverage, 2)} ${unitLabel(row.unit)}`}</td>
        <td>{money.format(row.fuelCost)}</td>
        <td>{money.format(row.partsCost)}</td>
        <td>{money.format(row.maintenanceCost)}</td>
        <td><b>{money.format(row.totalCost)}</b></td>
        <td>{row.costPerUnit === null ? "—" : `${money.format(row.costPerUnit)}/${usageLabel(row.unit)}`}</td>
      </tr>)}</tbody>
    </table></div>{rows.length === 0 && <div className="empty-state">Nenhum equipamento com abastecimento, peça ou troca no período.</div>}
    <p className="table-sub">Consumo = litros ÷ horas (L/h) ou km ÷ litros (km/L) no período, pelas leituras de horímetro/KM. “Gasta mais” = mais de 25% pior que a média dos equipamentos do mesmo tipo. Custo do combustível pelo custo médio das entradas com preço.</p></article>}
  </>;
}
