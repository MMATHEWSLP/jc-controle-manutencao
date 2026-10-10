"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, jsonBody, problemText } from "./stock-client";
import { localToday, number, ProductionEmployeePicker, type ProductionEmployee, type ProductionReason } from "./production-client";

// Lançamento diário da DERRUBA em lote (computador e celular do apontador): escolhe projeto e data uma
// vez e preenche uma linha por operador. A grade é o dia inteiro do projeto — quem sai da grade sai do
// dia (confirmado antes). No celular as linhas viram cartões (production.css).

export type LaunchProject = { id: number; name: string; frontName: string; serviceFrontId: number };
type DayLine = { operatorEmployeeId: number; helperEmployeeId: number | null; trees: number | null; ipes: number | null; gasolineLiters: number | null; reasonId: number | null; justification: string | null;
  operator: ProductionEmployee | null; helper: ProductionEmployee | null };
type DayResponse = { project: { id: number; name: string; status: string }; saved: boolean; suggestedFrom: string | null; lines: DayLine[] };
type GridLine = { key: number; operator: ProductionEmployee | null; helper: ProductionEmployee | null; trees: string; ipes: string; gasoline: string; reasonId: string; justification: string | null };
type LineError = { line: number; field: string; message: string };

// Computador: 20 linhas em branco (pedido do módulo). Celular: os operadores do dia + 3 linhas em branco
// ("＋ linha" acrescenta), para a tela não virar uma lista enorme de cartões vazios.
const START_LINES = 20;
const PHONE_BLANK_LINES = 3;
const isPhone = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 720px)").matches);
const blankCount = (filled: number) => (isPhone() ? PHONE_BLANK_LINES : Math.max(0, START_LINES - filled));
let nextKey = 1;
const emptyLine = (): GridLine => ({ key: nextKey++, operator: null, helper: null, trees: "", ipes: "", gasoline: "", reasonId: "", justification: null });
const decimal = (value: string) => { const parsed = Number(value.replace(/\./g, "").replace(",", ".")); return Number.isFinite(parsed) ? parsed : 0; };
const toText = (value: number | null) => (value === null || value === undefined ? "" : String(value).replace(".", ","));
const isBlank = (line: GridLine) => !line.operator && !line.helper && !line.trees.trim() && !line.ipes.trim() && !line.gasoline.trim() && !line.reasonId;
const brDay = (value: string) => value.split("-").reverse().join("/");

export default function ProductionFellingGrid({ projects, reasons, dayEndpoint, employeesEndpoint, flash, initialProjectId, onSaved }: {
  projects: LaunchProject[]; reasons: ProductionReason[]; dayEndpoint: string; employeesEndpoint: string; flash: (message: string) => void; initialProjectId?: number | null; onSaved?: () => void;
}) {
  const [projectId, setProjectId] = useState<string>(() => String(initialProjectId ?? (projects.length === 1 ? projects[0].id : "")));
  const [date, setDate] = useState(localToday());
  const [lines, setLines] = useState<GridLine[]>(() => Array.from({ length: blankCount(0) }, emptyLine));
  const [day, setDay] = useState<{ saved: boolean; suggestedFrom: string | null; operators: Array<{ id: number; name: string }> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lineErrors, setLineErrors] = useState<LineError[]>([]);
  const project = projects.find((item) => String(item.id) === projectId) ?? null;

  useEffect(() => { if (projectId && !projects.some((item) => String(item.id) === projectId)) setProjectId(""); }, [projects, projectId]);
  useEffect(() => {
    if (!projectId || !date) { setDay(null); return; }
    let cancelled = false;
    setLoading(true); setError(""); setLineErrors([]);
    api<DayResponse>(`${dayEndpoint}?projeto=${projectId}&data=${date}`)
      .then((result) => {
        if (cancelled) return;
        const loaded = result.lines.map((line): GridLine => ({ key: nextKey++, operator: line.operator, helper: line.helper, trees: toText(line.trees), ipes: toText(line.ipes), gasoline: toText(line.gasolineLiters), reasonId: line.reasonId ? String(line.reasonId) : "", justification: line.justification }));
        setLines([...loaded, ...Array.from({ length: blankCount(loaded.length) }, emptyLine)]);
        setDay({ saved: result.saved, suggestedFrom: result.suggestedFrom, operators: result.saved ? result.lines.filter((line) => line.operator).map((line) => ({ id: line.operatorEmployeeId, name: line.operator!.name })) : [] });
      })
      .catch((problem) => { if (!cancelled) setError(problemText(problem, "Não foi possível abrir o dia.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, date, dayEndpoint]);

  const totals = useMemo(() => lines.reduce((sum, line) => ({
    operators: sum.operators + (line.operator ? 1 : 0), trees: sum.trees + Math.trunc(decimal(line.trees)), ipes: sum.ipes + Math.trunc(decimal(line.ipes)), gasoline: sum.gasoline + decimal(line.gasoline),
  }), { operators: 0, trees: 0, ipes: 0, gasoline: 0 }), [lines]);
  const patch = (key: number, changes: Partial<GridLine>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  const errorsFor = (index: number) => lineErrors.filter((item) => item.line === index + 1);
  const fieldError = (index: number, field: string) => errorsFor(index).some((item) => item.field === field);

  async function save() {
    if (!project) { setError("Escolha o projeto."); return; }
    const kept = new Set(lines.filter((line) => line.operator).map((line) => line.operator!.id));
    const leaving = (day?.operators ?? []).filter((operator) => !kept.has(operator.id));
    if (leaving.length && !window.confirm(`${leaving.length} operador(es) saem deste dia: ${leaving.map((operator) => operator.name).join(", ")}. Confirmar?`)) return;
    setSaving(true); setError(""); setLineErrors([]);
    try {
      const body = { projectId: project.id, date, lines: lines.map((line) => isBlank(line) ? {} : {
        operatorEmployeeId: line.operator?.id ?? null, helperEmployeeId: line.helper?.id ?? null, trees: line.trees, ipes: line.ipes, gasolineLiters: line.gasoline, reasonId: line.reasonId || null, justification: line.justification,
      }) };
      const result = await api<{ message: string }>(dayEndpoint, jsonBody("PUT", body));
      flash(result.message);
      setDay({ saved: true, suggestedFrom: null, operators: lines.filter((line) => line.operator).map((line) => ({ id: line.operator!.id, name: line.operator!.name })) });
      onSaved?.();
    } catch (problem) {
      if (problem instanceof ApiError && Array.isArray(problem.data.lineErrors)) setLineErrors(problem.data.lineErrors as LineError[]);
      setError(problemText(problem, "Não foi possível salvar."));
    } finally { setSaving(false); }
  }

  return <div className="production-launch">
    <div className="production-form compact production-launch-head">
      <label>Projeto<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">Escolha o projeto</option>
        {projects.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.frontName}</option>)}
      </select></label>
      <label>Data<input type="date" value={date} max={localToday()} onChange={(event) => event.target.value && setDate(event.target.value)} /></label>
      <p className="production-help full">Os ipês já fazem parte do total de árvores. Árvores zero pedem o motivo. Linhas vazias são ignoradas.{projects.length === 0 ? " Nenhum projeto com a derruba aberta nas frentes em exibição." : ""}</p>
    </div>
    {project && day && <p className={`production-day-state ${day.saved ? "saved" : ""}`}>{day.saved ? `Dia já lançado em ${brDay(date)}: altere e salve de novo.` : day.suggestedFrom ? `Novo dia. Operadores sugeridos do último dia lançado (${brDay(day.suggestedFrom)}), com os números em branco.` : "Novo dia."}</p>}
    {error && <div className="fleet-form-error">! {error}</div>}
    {lineErrors.length > 0 && <ul className="production-line-errors">{lineErrors.map((item, index) => <li key={index}>Linha {item.line}: {item.message}</li>)}</ul>}
    {project && <div className={`table-scroll production-grid-wrap${loading ? " loading" : ""}`}><table className="products-table production-grid">
      <thead><tr><th>#</th><th>Operador</th><th>Ajudante</th><th>Motivo (se zero)</th><th className="num">Árvores</th><th className="num">Ipês</th><th className="num">Gasolina (L)</th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={line.key} className={errorsFor(index).length ? "invalid" : ""}>
        <td data-label="Linha" className="production-grid-index">{index + 1}</td>
        <td data-label="Operador"><ProductionEmployeePicker compact value={line.operator} onPick={(person) => patch(line.key, { operator: person })} frontId={project.serviceFrontId} group="MOTOSSERRA" endpoint={employeesEndpoint} placeholder="Operador..." invalid={fieldError(index, "operatorEmployeeId")} /></td>
        <td data-label="Ajudante"><ProductionEmployeePicker compact value={line.helper} onPick={(person) => patch(line.key, { helper: person })} frontId={project.serviceFrontId} group="AJUDANTE_MOTOSSERRA" endpoint={employeesEndpoint} placeholder="Ajudante..." invalid={fieldError(index, "helperEmployeeId")} /></td>
        <td data-label="Motivo (se zero)"><select className={fieldError(index, "reasonId") ? "invalid" : ""} value={line.reasonId} onChange={(event) => patch(line.key, { reasonId: event.target.value })}>
          <option value="">—</option>{reasons.map((reason) => <option key={reason.id} value={reason.id}>({reason.code}) {reason.description}</option>)}
        </select></td>
        <td data-label="Árvores" className="num"><input inputMode="numeric" className={fieldError(index, "trees") ? "invalid" : ""} value={line.trees} onChange={(event) => patch(line.key, { trees: event.target.value.replace(/[^\d]/g, "") })} aria-label={`Árvores da linha ${index + 1}`} /></td>
        <td data-label="Ipês" className="num"><input inputMode="numeric" className={fieldError(index, "ipes") ? "invalid" : ""} value={line.ipes} onChange={(event) => patch(line.key, { ipes: event.target.value.replace(/[^\d]/g, "") })} aria-label={`Ipês da linha ${index + 1}`} /></td>
        <td data-label="Gasolina (L)" className="num"><input inputMode="decimal" className={fieldError(index, "gasolineLiters") ? "invalid" : ""} value={line.gasoline} onChange={(event) => patch(line.key, { gasoline: event.target.value.replace(/[^\d,.]/g, "") })} aria-label={`Gasolina da linha ${index + 1}`} /></td>
      </tr>)}</tbody>
      <tfoot><tr><td colSpan={4}><strong>Total diário</strong> · {totals.operators} operador(es)</td><td className="num"><strong>{number(totals.trees, 0)}</strong></td><td className="num"><strong>{number(totals.ipes, 0)}</strong></td><td className="num"><strong>{number(totals.gasoline)}</strong></td></tr></tfoot>
    </table></div>}
    {project && <div className="production-launch-actions">
      <button type="button" className="secondary" onClick={() => setLines((current) => [...current, emptyLine()])}>＋ linha</button>
      <span className="production-launch-total">Total diário: <b>{number(totals.trees, 0)}</b> árvores · <b>{number(totals.ipes, 0)}</b> ipês · <b>{number(totals.gasoline)}</b> L</span>
      <button type="button" className="primary" disabled={saving || loading} onClick={save}>{saving ? "Salvando..." : <><span className="production-save-long">Salvar produção de todos os operadores</span><span className="production-save-short">Salvar a produção do dia</span></>}</button>
    </div>}
  </div>;
}
