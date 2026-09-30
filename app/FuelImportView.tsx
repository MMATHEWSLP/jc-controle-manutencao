"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import { readFuelImportFile } from "../lib/excel-client";

// ---------------------------------------------------------------------------
// Combustível → Importar planilha. Prévia sem gravar (OK / AVISO / ERRO), células editáveis e
// revalidação, confirmação só das linhas marcadas, resultado com saldo antes/depois e lotes
// anteriores (ADMIN pode desfazer). Toda validação e gravação é do servidor (lib/fuel-import.ts).
// ---------------------------------------------------------------------------
const MODEL_URL = "/api/fuel/import/modelo";
const COLUMNS = ["data", "tipo", "frente", "origem", "combustivel", "equipamento", "empresa", "litros", "leitura", "tanque_cheio", "motorista", "observacao"] as const;
type Column = typeof COLUMNS[number];
type Values = Record<Column, string>;
type Status = "OK" | "AVISO" | "ERRO";
type PreviewRow = {
  rowNumber: number; values: Values; status: Status; messages: string[]; typeLabel: string | null; frontName: string | null; fuelName: string | null;
  target: { kind: "FROTA" | "TERCEIRO"; code: string; plate: string | null; model: string; unit: "KM" | "HOURS" | null } | null;
  liters: number | null; reading: number | null; previousReading: number | null; difference: number | null; consumption: { value: number; unit: string } | null;
};
type Summary = { total: number; ok: number; warnings: number; errors: number; liters: number };
type Result = {
  batchId: number | null; imported: number; failed: Array<{ rowNumber: number; error: string }>; notes: Array<{ rowNumber: number; note: string }>; liters: number;
  previewErrors: number; notSelected: number; balances: Array<{ front: string; location: "FRENTE" | "PORTO"; fuel: string; before: number; after: number }>;
};
type Batch = { id: number; fileName: string; rowCount: number; liters: number; status: "ACTIVE" | "REVERTED"; createdAt: string; revertedAt: string | null; userName: string | null };

const WIDTH: Partial<Record<Column, number>> = { data: 92, tipo: 128, frente: 92, origem: 116, combustivel: 92, equipamento: 96, empresa: 104, litros: 64, leitura: 80, tanque_cheio: 56, motorista: 120, observacao: 170 };
const LABEL: Record<Column, string> = { data: "data", tipo: "tipo", frente: "frente", origem: "origem", combustivel: "combustível", equipamento: "equipamento", empresa: "empresa", litros: "litros", leitura: "leitura", tanque_cheio: "tanque cheio", motorista: "motorista", observacao: "observação" };
const num = (value: number | null, digits = 2) => value === null ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: Number.isInteger(value) ? 0 : Math.min(2, digits), maximumFractionDigits: digits });
const liters = (value: number) => `${num(value)} L`;
const brDateTime = (value: string) => new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

async function downloadRows(rows: Array<{ rowNumber: number; values: Values; error?: string }>, fileName: string) {
  const response = await fetch("/api/fuel/import/modelo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, fileName }) });
  if (!response.ok) throw new Error("Não foi possível gerar a planilha.");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob()); link.download = fileName; link.click(); URL.revokeObjectURL(link.href);
}

export default function FuelImportModal({ close, imported, flash }: { close: () => void; imported: (message: string) => Promise<void>; flash: (message: string) => void }) {
  const [view, setView] = useState<"import" | "batches">("import");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [edited, setEdited] = useState<Record<number, Values>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stale = Object.keys(edited).length > 0;
  const current = (row: PreviewRow) => edited[row.rowNumber] ?? row.values;

  async function analyze(input: Array<{ rowNumber: number; values: Values }>, name: string, keepSelection?: Set<number>) {
    setBusy(true); setError("");
    try {
      const data = await api<{ rows: PreviewRow[]; summary: Summary }>("/api/fuel/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ANALYZE", fileName: name, rows: input }) });
      setRows(data.rows); setSummary(data.summary); setEdited({});
      // Linhas válidas ficam marcadas; numa revalidação, as desmarcadas continuam desmarcadas.
      const previous = keepSelection;
      setSelected(new Set(data.rows.filter((row) => row.status !== "ERRO" && (!previous || previous.has(row.rowNumber) || !rows?.some((old) => old.rowNumber === row.rowNumber && old.status !== "ERRO"))).map((row) => row.rowNumber)));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível analisar."); }
    finally { setBusy(false); }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(""); setResult(null); setRows(null);
    try {
      const parsed = await readFuelImportFile(file);
      setFileName(file.name);
      await analyze(parsed.map((row) => ({ rowNumber: row.rowNumber, values: row.values as Values })), file.name);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível ler o arquivo."); }
  }

  async function confirm() {
    if (!rows || stale) return;
    const chosen = rows.filter((row) => selected.has(row.rowNumber) && row.status !== "ERRO");
    const total = chosen.reduce((sum, row) => sum + (row.liters ?? 0), 0);
    if (!window.confirm(`Importar ${chosen.length} lançamento(s), ${liters(total)}? Os saldos e as leituras serão atualizados.`)) return;
    setBusy(true); setError("");
    try {
      const data = await api<Result>("/api/fuel/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "CONFIRM", fileName, rows: rows.map((row) => ({ rowNumber: row.rowNumber, values: row.values })), selected: [...selected] }) });
      setResult(data);
      await imported(`Importação concluída: ${data.imported} lançamento(s), ${liters(data.liters)}.`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível importar."); }
    finally { setBusy(false); }
  }

  async function downloadErrors() {
    if (!rows) return;
    const failed = new Map((result?.failed ?? []).map((item) => [item.rowNumber, item.error]));
    const list = rows.filter((row) => row.status === "ERRO" || failed.has(row.rowNumber)).map((row) => ({ rowNumber: row.rowNumber, values: current(row), error: failed.get(row.rowNumber) ?? row.messages.join(" ") }));
    if (!list.length) { flash("Nenhuma linha com erro."); return; }
    try { await downloadRows(list, `linhas-com-erro-${fileName.replace(/\.[^.]+$/, "") || "importacao"}.xlsx`); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível baixar."); }
  }

  const chosen = useMemo(() => rows?.filter((row) => selected.has(row.rowNumber) && row.status !== "ERRO") ?? [], [rows, selected]);
  const chosenLiters = chosen.reduce((sum, row) => sum + (row.liters ?? 0), 0);
  const toggle = (rowNumber: number) => setSelected((current) => { const next = new Set(current); if (next.has(rowNumber)) next.delete(rowNumber); else next.add(rowNumber); return next; });
  const edit = (row: PreviewRow, column: Column, value: string) => setEdited((current) => ({ ...current, [row.rowNumber]: { ...(current[row.rowNumber] ?? row.values), [column]: value } }));

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal fuel-import-modal">
      <header><div><p className="eyebrow">COMBUSTÍVEL</p><h2>Importar abastecimentos por planilha</h2><span>Nada é gravado até você conferir a prévia e clicar em &quot;Confirmar importação&quot;.</span></div><button onClick={close} disabled={busy} aria-label="Fechar">×</button></header>
      <div className="fuel-import-tabs" role="tablist">
        <button type="button" className={view === "import" ? "active" : ""} onClick={() => setView("import")}>Importar</button>
        <button type="button" className={view === "batches" ? "active" : ""} onClick={() => setView("batches")}>Importações anteriores</button>
      </div>
      {view === "batches" ? <BatchesPanel flash={flash} changed={imported} /> : <div className="modal-body fuel-import-body">
        {!result && <div className="fuel-import-actions">
          <a className="secondary" href={MODEL_URL} download>⇩ Baixar modelo</a>
          <label className="fuel-import-file"><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ""; }} disabled={busy} /><span>{fileName || "Escolher planilha (.xlsx ou .csv)"}</span><b>Procurar</b></label>
          {busy && <span className="table-sub">Processando...</span>}
        </div>}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
        {result ? <ResultPanel result={result} downloadErrors={downloadErrors} again={() => { setResult(null); setRows(null); setSummary(null); setFileName(""); }} close={close} />
          : rows && summary && <>
            <div className="fuel-import-summary">
              <span><b>{summary.total}</b> linhas</span><span className="ok"><b>{summary.ok}</b> OK</span><span className="warn"><b>{summary.warnings}</b> com aviso</span><span className="err"><b>{summary.errors}</b> com erro</span>
              <span>Selecionadas: <b>{chosen.length}</b> · {liters(chosenLiters)}</span>
            </div>
            <div className="table-scroll fuel-import-table-wrap"><table className="fuel-import-table">
              <thead><tr><th><input type="checkbox" aria-label="Marcar todas as válidas" checked={chosen.length > 0 && chosen.length === rows.filter((row) => row.status !== "ERRO").length} onChange={(event) => setSelected(event.target.checked ? new Set(rows.filter((row) => row.status !== "ERRO").map((row) => row.rowNumber)) : new Set())} /></th>
                <th>Linha</th><th>Situação</th>{COLUMNS.map((column) => <th key={column}>{LABEL[column]}</th>)}<th>Encontrado</th><th>Leitura anterior</th><th>Nova</th><th>Diferença</th><th>Consumo est.</th></tr></thead>
              <tbody>{rows.map((row) => {
                const values = current(row);
                const changed = Boolean(edited[row.rowNumber]);
                return <tr key={row.rowNumber} className={`${row.status.toLowerCase()} ${changed ? "changed" : ""}`}>
                  <td><input type="checkbox" disabled={row.status === "ERRO"} checked={selected.has(row.rowNumber) && row.status !== "ERRO"} onChange={() => toggle(row.rowNumber)} aria-label={`Importar linha ${row.rowNumber}`} /></td>
                  <td>{row.rowNumber}</td>
                  <td className="fuel-import-status"><span className={`status-pill ${row.status === "OK" ? "green" : row.status === "AVISO" ? "orange" : "red"}`}>{row.status}</span>{row.messages.map((message, index) => <small key={index}>{message}</small>)}</td>
                  {COLUMNS.map((column) => <td key={column}><input value={values[column]} style={{ width: WIDTH[column] }} onChange={(event) => edit(row, column, event.target.value)} aria-label={`${LABEL[column]} da linha ${row.rowNumber}`} /></td>)}
                  <td className="fuel-import-found">{row.target ? <><b>{row.target.code}</b><small>{[row.target.plate, row.target.model].filter(Boolean).join(" · ") || "—"}</small></> : "—"}</td>
                  <td>{num(row.previousReading, 1)}</td><td>{num(row.reading, 1)}</td>
                  <td className={row.difference !== null && row.difference < 0 ? "text-negative" : ""}>{row.difference === null ? "—" : `${row.difference > 0 ? "+" : ""}${num(row.difference, 1)}`}</td>
                  <td>{row.consumption ? `${num(row.consumption.value)} ${row.consumption.unit}` : "—"}</td>
                </tr>;
              })}</tbody>
            </table></div>
            <div className="modal-footer fuel-import-footer">
              {stale && <span className="fuel-hint warning">Você alterou células: revalide antes de confirmar.</span>}
              <button type="button" className="secondary" onClick={downloadErrors} disabled={busy || !summary.errors}>Baixar linhas com erro</button>
              <button type="button" className="secondary" onClick={() => analyze(rows.map((row) => ({ rowNumber: row.rowNumber, values: current(row) })), fileName, selected)} disabled={busy}>Revalidar</button>
              <button type="button" className="primary" onClick={confirm} disabled={busy || stale || chosen.length === 0}>{busy ? "Importando..." : `Confirmar importação (${chosen.length} · ${liters(chosenLiters)})`}</button>
            </div>
          </>}
        {!rows && !result && !error && <div className="fuel-import-help">
          <p><b>Como funciona:</b> baixe o modelo, preencha a aba <b>Lançamentos</b> (uma linha por abastecimento) e escolha o arquivo. O sistema mostra a prévia com o equipamento encontrado, a leitura anterior, a diferença e o consumo estimado de cada linha.</p>
          <p><span className="status-pill green">OK</span> importa · <span className="status-pill orange">AVISO</span> importa, mas confira (salto de leitura, litragem acima da média, saldo negativo) · <span className="status-pill red">ERRO</span> não importa (corrija a célula e clique em Revalidar).</p>
        </div>}
      </div>}
    </section>
  </div>;
}

function ResultPanel({ result, downloadErrors, again, close }: { result: Result; downloadErrors: () => void; again: () => void; close: () => void }) {
  const errors = result.previewErrors + result.failed.length;
  return <div className="fuel-import-result">
    <div className="fuel-import-summary">
      <span className="ok"><b>{result.imported}</b> importado(s)</span><span className="err"><b>{errors}</b> com erro</span><span><b>{liters(result.liters)}</b> no total</span>
      {result.notSelected > 0 && <span><b>{result.notSelected}</b> desmarcada(s)</span>}{result.batchId && <span>Lote <b>#{result.batchId}</b></span>}
    </div>
    {result.balances.length > 0 && <table className="fuel-import-balances"><thead><tr><th>Frente</th><th>Estoque</th><th>Combustível</th><th>Saldo antes</th><th>Saldo depois</th></tr></thead>
      <tbody>{result.balances.map((item, index) => <tr key={index}><td>{item.front}</td><td>{item.location === "PORTO" ? "Porto" : "Frente"}</td><td>{item.fuel}</td><td>{liters(item.before)}</td><td><b>{liters(item.after)}</b></td></tr>)}</tbody></table>}
    {result.failed.length > 0 && <div className="equipment-form-error"><span>!</span><strong>Não gravadas na confirmação: {result.failed.map((item) => `linha ${item.rowNumber} (${item.error})`).join("; ")}</strong></div>}
    {result.notes.length > 0 && <p className="fuel-hint warning">{result.notes.map((item) => `Linha ${item.rowNumber}: ${item.note}`).join(" ")}</p>}
    <div className="modal-footer fuel-import-footer">
      {errors > 0 && <button type="button" className="secondary" onClick={downloadErrors}>Baixar linhas com erro</button>}
      <button type="button" className="secondary" onClick={again}>Importar outra planilha</button>
      <button type="button" className="primary" onClick={close}>Concluir</button>
    </div>
  </div>;
}

function BatchesPanel({ flash, changed }: { flash: (message: string) => void; changed: (message: string) => Promise<void> }) {
  const [data, setData] = useState<{ batches: Batch[]; canRevert: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => { try { setData(await api("/api/fuel/import")); } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); } }, []);
  useEffect(() => { load(); }, [load]);
  async function revert(batch: Batch) {
    if (!window.confirm(`Desfazer a importação #${batch.id} (${batch.fileName}, ${batch.rowCount} lançamento(s), ${liters(batch.liters)})? Os lançamentos saem do saldo e as leituras voltam ao valor anterior.`)) return;
    setBusy(batch.id); setError("");
    try { const result = await api<{ message: string }>(`/api/fuel/import/${batch.id}`, { method: "DELETE" }); flash(result.message); await changed(result.message); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível desfazer."); }
    finally { setBusy(null); }
  }
  return <div className="modal-body">
    {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
    {data && <div className="table-scroll"><table className="fuel-import-balances">
      <thead><tr><th>Lote</th><th>Arquivo</th><th>Importado por</th><th>Quando</th><th>Lançamentos</th><th>Litros</th><th>Situação</th>{data.canRevert && <th />}</tr></thead>
      <tbody>{data.batches.map((batch) => <tr key={batch.id}>
        <td>#{batch.id}</td><td>{batch.fileName}</td><td>{batch.userName ?? "—"}</td><td>{brDateTime(batch.createdAt)}</td><td>{batch.rowCount}</td><td>{liters(batch.liters)}</td>
        <td>{batch.status === "ACTIVE" ? <span className="status-pill green">Ativo</span> : <span className="status-pill gray">Desfeito {batch.revertedAt ? brDateTime(batch.revertedAt) : ""}</span>}</td>
        {data.canRevert && <td>{batch.status === "ACTIVE" && <button type="button" className="danger-action" disabled={busy === batch.id} onClick={() => revert(batch)}>{busy === batch.id ? "Desfazendo..." : "Desfazer importação"}</button>}</td>}
      </tr>)}</tbody>
    </table></div>}
    {data && data.batches.length === 0 && <div className="empty-state">Nenhuma importação ainda.</div>}
  </div>;
}
