"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";
import { api, brDay, problemText, StageCell, type Company, type CycleSummary, type Restricted } from "./employees-client";

type CycleRow = { kind: "FOLGA"; id: number; employeeId: number; name: string; company: string; frontName: string; cycleNumber: number; workStart: string | null; frontDeparture: string | null; homeArrival: string | null; homeDeparture: string | null; frontArrival: string | null; summary: CycleSummary };
type AbsenceRow = { kind: "AFASTAMENTO"; id: number; employeeId: number; name: string; company: string; frontName: string; absenceKind: string; startDate: string; endDate: string | null; days: number; notes: string | null };
type Filters = { nome: string; empresa: string; tipo: "FOLGA" | "AFASTAMENTO"; de: string; ate: string };

// Histórico: folgas (ciclos) ou afastamentos, com filtros aplicados no botão Filtrar e PDF da mesma consulta.
export function EmployeesHistory({ companies, open, frontQuery = "" }: { companies: Company[]; open: (id: number) => void; frontQuery?: string }) {
  const [draft, setDraft] = useState<Filters>({ nome: "", empresa: "", tipo: "FOLGA", de: "", ate: "" });
  const [applied, setApplied] = useState<Filters>(draft);
  const [rows, setRows] = useState<Array<CycleRow | AbsenceRow>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const query = [new URLSearchParams(Object.entries(applied).filter(([, value]) => value)).toString(), frontQuery].filter(Boolean).join("&");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setRows((await api<{ rows: Array<CycleRow | AbsenceRow> }>(`/api/employees/history?${query}`)).rows); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar o histórico.")); }
    finally { setLoading(false); }
  }, [query]);
  useEffect(() => { load(); }, [load]);
  const set = (key: keyof Filters) => (event: { target: { value: string } }) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  return (
    <article className="panel module-panel equipment-management-panel">
      <form className="equipment-management-filters employee-filters employee-history-filters" onSubmit={(event) => { event.preventDefault(); setApplied(draft); }}>
        <label className="page-search"><span>⌕</span><input value={draft.nome} onChange={set("nome")} placeholder="Nome do funcionário" /></label>
        <label>Empresa<select value={draft.empresa} onChange={set("empresa")}><option value="">Todas</option>{companies.map((company) => <option key={company.id} value={company.name}>{company.name}</option>)}</select></label>
        <label>Tipo<select value={draft.tipo} onChange={set("tipo")}><option value="FOLGA">Folga (ciclos)</option><option value="AFASTAMENTO">Afastamento</option></select></label>
        <label>De<input type="date" value={draft.de} onChange={set("de")} /></label>
        <label>Até<input type="date" value={draft.ate} onChange={set("ate")} /></label>
        <button className="primary">Filtrar</button>
        <a className="secondary employee-pdf-link" href={`/api/employees/history?${query}${query ? "&" : ""}formato=pdf`} target="_blank" rel="noreferrer">Exportar PDF</a>
      </form>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
      {loading ? <div className="page-loading"><span /><p>Carregando histórico...</p></div> : (
        <div className="table-scroll">
          {applied.tipo === "FOLGA" ? (
            <table className="equipment-management-table employee-cycles-table">
              <thead><tr><th>Funcionário</th><th title="Número do ciclo">Ciclo</th><th title="Início do ciclo → saída da frente · dias trabalhados">Trabalho</th><th title="Saída da frente → chegada em casa · dias de viagem (ida)">Viagem ida</th><th title="Chegada em casa → saída de casa · dias de folga">Folga</th><th title="Saída de casa → chegada na frente · dias de viagem (volta)">Viagem volta</th></tr></thead>
              <tbody>
                {rows.filter((row): row is CycleRow => row.kind === "FOLGA").map((row) => (
                  <tr key={row.id}>
                    <td><button className="link-button" onClick={() => open(row.employeeId)}>{row.name}</button><small className="table-sub">{row.company} · {row.frontName} · {row.summary.phaseLabel}</small></td>
                    <td>{row.cycleNumber}</td>
                    <td><StageCell from={row.workStart} to={row.frontDeparture} days={row.summary.workedDays} /></td>
                    <td><StageCell from={row.frontDeparture} to={row.homeArrival} days={row.summary.travelOutDays} /></td>
                    <td><StageCell from={row.homeArrival} to={row.homeDeparture} days={row.summary.offDays} /></td>
                    <td><StageCell from={row.homeDeparture} to={row.frontArrival} days={row.summary.travelBackDays} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="equipment-management-table">
              <thead><tr><th>Funcionário</th><th>Tipo</th><th title="Início → término (ou em aberto) · dias">Período</th><th>Observações</th></tr></thead>
              <tbody>
                {rows.filter((row): row is AbsenceRow => row.kind === "AFASTAMENTO").map((row) => (
                  <tr key={row.id}>
                    <td><button className="link-button" onClick={() => open(row.employeeId)}>{row.name}</button><small className="table-sub">{row.company} · {row.frontName}</small></td>
                    <td>{row.absenceKind}</td><td><span className="stage-cell"><b>{brDay(row.startDate)} → {row.endDate ? brDay(row.endDate) : "em aberto"}</b><small>{row.days} dia{row.days === 1 ? "" : "s"}</small></span></td><td>{row.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length === 0 && <div className="empty-state">Nenhum registro encontrado para os filtros.</div>}
        </div>
      )}
    </article>
  );
}

// Funcionários Restritos (demitidos que não podem ser recontratados), da empresa toda.
export function RestrictedList({ open }: { open: (id: number) => void }) {
  const [rows, setRows] = useState<Restricted[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<{ restricted: Restricted[] }>("/api/employees/restricted").then((result) => setRows(result.restricted)).catch((problem) => setError(problemText(problem, "Não foi possível carregar."))); }, []);
  return (
    <article className="panel module-panel equipment-management-panel">
      <p className="employee-tab-hint">Demitidos marcados como “não pode ser recontratado”. A lista é conferida automaticamente ao cadastrar um novo funcionário (nome, CPF ou matrícula).</p>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div></div>}
      {!rows ? <div className="page-loading"><span /><p>Carregando...</p></div> : (
        <div className="table-scroll">
          <table className="equipment-management-table">
            <thead><tr><th>Funcionário</th><th>Empresa</th><th>CPF</th><th>Matrícula</th><th>Última frente</th><th>Demissão</th><th>Motivo</th></tr></thead>
            <tbody>
              {rows.map((row) => <tr key={row.id}><td><button className="link-button" onClick={() => open(row.id)}>{row.name}</button><small className="table-sub">{row.jobTitle}</small></td><td>{row.company}</td><td>{row.cpf ?? "—"}</td><td>{row.registration ?? "—"}</td><td>{row.frontName}</td><td>{brDay(row.dismissedAt)}</td><td>{row.reason}</td></tr>)}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty-state">Nenhum funcionário restrito.</div>}
        </div>
      )}
    </article>
  );
}
