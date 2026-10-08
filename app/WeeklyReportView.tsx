"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import type { WeeklyReport } from "../lib/weekly-report-rules";
import LoadWarning from "./LoadWarning";

type Front = { id: number; name: string };
type Response = { report: WeeklyReport; text: string; canSend: boolean };

const br = (day: string) => day.split("-").reverse().join("/");
const liters = (value: number) => `${Math.round(value).toLocaleString("pt-BR")} L`;
const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const shift = (day: string, days: number) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

// RELATÓRIOS → Resumo semanal: o que aconteceu na semana (segunda a domingo) em uma tela, com o
// mesmo texto que vai pelo WhatsApp toda segunda-feira. mode="mes": o Resumo mensal (o mês inteiro,
// o mês corrente até hoje), com o mesmo conteúdo e sem o envio automático.
const shiftMonth = (month: string, months: number) => { const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + months); return date.toISOString().slice(0, 7); };
export default function WeeklyReportView({ fronts, flash, mode = "semana" }: { fronts: Front[]; flash: (message: string) => void; mode?: "semana" | "mes" }) {
  const monthly = mode === "mes";
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [week, setWeek] = useState<string | null>(null);
  const [front, setFront] = useState("");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const params = new URLSearchParams();
    if (monthly) params.set("mes", month);
    else if (week) params.set("semana", week);
    if (front) params.set("frente", front);
    try { setData(await api<Response>(`/api/weekly-report?${params.toString()}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
    finally { setLoading(false); }
  }, [week, front, monthly, month]);
  useEffect(() => { load(); }, [load]);

  const report = data?.report;
  const from = report?.period.from ?? null;
  const isCurrentOrFuture = monthly ? month >= today().slice(0, 7) : from !== null && shift(from, 7) > today();
  async function copy() {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.text); flash("Texto copiado. É só colar no WhatsApp."); }
    catch { flash("Não foi possível copiar automaticamente. Selecione o texto e copie."); }
  }
  async function send() {
    if (!report || !window.confirm(`Enviar o resumo de ${br(report.period.from)} a ${br(report.period.to)} (todas as frentes) pelo WhatsApp aos destinatários marcados?`)) return;
    setSending(true);
    try { flash((await api<{ message: string }>("/api/weekly-report/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ semana: report.period.from }) })).message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível enviar."); }
    finally { setSending(false); }
  }

  return <>
    <div className="page-heading module-heading weekly-heading">
      {monthly ? <div><p className="eyebrow">RELATÓRIOS · RESUMOS</p><h1>Resumo mensal</h1><span>Combustível, custos, manutenção, O.S., checklists e Controle Diário do mês inteiro (o mês corrente vai até hoje), com o texto para copiar.</span></div>
        : <div><p className="eyebrow">GESTÃO</p><h1>Resumo semanal</h1><span>Combustível, manutenção, O.S., checklists e Controle Diário da semana (segunda a domingo). Toda segunda-feira este resumo vai pelo WhatsApp para os destinatários marcados.</span></div>}
      <div className="heading-actions">
        <button className="secondary" onClick={copy} disabled={!data}>Copiar texto</button>
        <button className="secondary" onClick={() => window.print()} disabled={!data}>Imprimir</button>
        {data?.canSend && <button className="primary" onClick={send} disabled={sending || !data}>{sending ? "Enviando..." : "Enviar pelo WhatsApp"}</button>}
      </div>
    </div>
    <article className="panel module-panel weekly-filters">
      <div className="weekly-nav">
        {monthly ? <button type="button" className="secondary" onClick={() => setMonth(shiftMonth(month, -1))}>‹ Mês anterior</button>
          : <button type="button" className="secondary" onClick={() => from && setWeek(shift(from, -7))} disabled={!from}>‹ Semana anterior</button>}
        <strong>{report ? `${br(report.period.from)} a ${br(report.period.to)}` : "…"}</strong>
        {monthly ? <button type="button" className="secondary" onClick={() => setMonth(shiftMonth(month, 1))} disabled={isCurrentOrFuture}>Próximo mês ›</button>
          : <button type="button" className="secondary" onClick={() => from && setWeek(shift(from, 7))} disabled={!from || isCurrentOrFuture}>Próxima semana ›</button>}
      </div>
      <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas que você enxerga</option>{fronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </article>
    <LoadWarning message={error} />
    {loading && !report && <div className="page-loading"><span /><p>Montando o resumo...</p></div>}
    {report && <>
      {isCurrentOrFuture && <p className="table-sub weekly-note">{monthly ? "Mês em andamento: os números ainda vão mudar até o fim do mês." : "Semana em andamento: os números ainda vão mudar até domingo."}</p>}
      <div className="metric-grid weekly-metrics">
        <div className="metric-card"><div><strong>{liters(report.fuel.exitLiters)}</strong><span>Combustível na frota</span><small>{money(report.fuel.fuelCost)} · entradas {liters(report.fuel.entryLiters)}</small></div></div>
        <div className={`metric-card ${report.maintenance.overdue ? "red" : "green"}`}><div><strong>{report.maintenance.overdue}</strong><span>Trocas vencidas hoje</span><small>{report.maintenance.done} troca(s) feitas {monthly ? "no mês" : "na semana"} · {report.maintenance.near} urgente(s)</small></div></div>
        <div className="metric-card"><div><strong>{report.workOrders.openNow}</strong><span>O.S. em aberto</span><small>{report.workOrders.opened} aberta(s) e {report.workOrders.closed} fechada(s) {monthly ? "no mês" : "na semana"}</small></div></div>
        <div className={`metric-card ${report.checklists.blocked ? "red" : ""}`}><div><strong>{report.checklists.total}</strong><span>Checklists</span><small>{report.checklists.blocked} bloqueado(s) · {report.checklists.pending} com pendência</small></div></div>
      </div>
      <div className="weekly-grid">
        <article className="panel module-panel weekly-card"><h2>Combustível e custos</h2><ul>
          <li><span>Saídas para a frota</span><b>{liters(report.fuel.exitLiters)}</b></li>
          <li><span>Custo do combustível</span><b>{money(report.fuel.fuelCost)}</b></li>
          {report.costs && <li><span>Custo total (combustível + peças + trocas)</span><b>{money(report.costs.total)}</b></li>}
          <li><span>Consumo acima da média</span><b>{report.fuel.outliers.length ? report.fuel.outliers.map((item) => item.prefix).join(", ") : "nenhum"}</b></li>
          <li><span>Abastecidos sem leitura {monthly ? "no mês" : "na semana"}</span><b>{report.fuel.withoutUsage}</b></li>
          <li><span>Medições do tanque fora da tolerância</span><b>{report.tanks.outside} de {report.tanks.measurements}{report.tanks.lossLiters > 0 ? ` · perda ${liters(report.tanks.lossLiters)}` : ""}</b></li>
        </ul></article>
        <article className="panel module-panel weekly-card"><h2>Manutenção</h2><ul>
          <li><span>Trocas vencidas</span><b>{report.maintenance.overdueList.length ? report.maintenance.overdueList.join(", ") : "nenhuma"}</b></li>
          <li><span>O.S. mais antigas em aberto</span><b>{report.workOrders.oldest.length ? report.workOrders.oldest.map((item) => `${item.number} ${item.prefix} (${item.days} d)`).join(", ") : "nenhuma"}</b></li>
          <li><span>Frota agora</span><b>{report.fleet.maintenance} em manutenção · {report.fleet.stopped} parado(s)</b></li>
          <li><span>Pneus e baterias com alerta</span><b>{report.components.alerts ? report.components.list.join(", ") : "nenhum"}</b></li>
        </ul></article>
        <article className="panel module-panel weekly-card"><h2>Operação</h2><ul>
          <li><span>Registros do Controle Diário</span><b>{report.daily.records}</b></li>
          <li><span>Com problema informado</span><b>{report.daily.problems}</b></li>
          {report.daily.problemList.map((item, index) => <li key={index} className="sub"><span>{item.prefix}</span><b>{item.reason || "—"}</b></li>)}
          <li><span>Checklists bloqueados</span><b>{report.checklists.blockedList.length ? report.checklists.blockedList.join(", ") : "nenhum"}</b></li>
        </ul></article>
        <article className="panel module-panel weekly-card weekly-text"><h2>{monthly ? "Texto para copiar" : "Texto do WhatsApp"}</h2><pre>{data?.text}</pre></article>
      </div>
      <p className="table-sub">{report.scope}. Custo do combustível pelo custo médio das entradas com preço; consumo acima da média = mais de 25% pior que os equipamentos do mesmo tipo (como em Custos e Consumo).</p>
    </>}
  </>;
}
