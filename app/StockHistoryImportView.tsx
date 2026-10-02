"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from "react";
import { readStockHistoryFile } from "../lib/excel-client";
import type { HistoryRawRow, ProductDecision } from "../lib/stock-history-import-rules";

// ---------------------------------------------------------------------------
// Produtos → Importar movimentações (só ADMIN). Histórico do almoxarifado antigo: prévia sem gravar
// (totais, produtos/equipamentos não encontrados, duplicados, erros), decisão por produto não
// encontrado, saídas posteriores ao corte (baixar estoque só se marcado) e lotes com "Desfazer".
// Toda validação e gravação é do servidor (lib/stock-history-import.ts).
// ---------------------------------------------------------------------------
const MODEL_URL = "/api/products/history-import/modelo";
const API = "/api/products/history-import";

type Suggestion = { id: number; tag: string; name: string; price: number; active: boolean; score: number };
type Unmatched = { key: string; name: string; rows: number; quantity: number; value: number; unitPrice: number; firstDate: string | null; lastDate: string | null; ambiguous: boolean; suggestions: Suggestion[] };
type Tally = { text: string; rows: number };
type Preview = {
  fileName: string; frontId: number; cutoffDate: string;
  summary: {
    totalRows: number; validRows: number; exits: number; adjustments: number; totalValue: number; exitsValue: number; adjustmentsValue: number; errors: number; duplicates: number;
    pendingProductRows: number; skippedRows: number; toImport: number; toImportValue: number; toImportExits: number; toImportAdjustments: number; balanceRows: number; warnings: number;
    dateFrom: string | null; dateTo: string | null; productsMatched: number; productsUnmatched: number; productsPending: number; equipmentMatchedRows: number; employeeMatchedRows: number; departmentMatchedRows: number;
  };
  unmatchedProducts: Unmatched[]; unmatchedEquipment: Tally[]; unmatchedEmployees: Tally[]; unmatchedDepartments: Tally[];
  duplicates: Array<{ rowNumber: number; date: string | null; product: string; quantity: number | null; employee: string; equipment: string; reason: string | null }>;
  errors: Array<{ rowNumber: number; product: string; messages: string[] }>; warnings: Array<{ rowNumber: number; product: string; messages: string[] }>;
  afterCutoff: { cutoffDate: string; rows: number; value: number; quantity: number; pendingProductRows: number; applied: boolean; products: Array<{ productId: number | null; tag: string | null; name: string; rows: number; quantity: number; value: number; balance: number; after: number }> };
  truncated: { duplicates: boolean; errors: boolean; warnings: boolean };
};
type Result = { batchId: number; imported: number; exits: number; adjustments: number; totalValue: number; balanceRows: number; createdProducts: number; duplicates: number; errors: number; skipped: number };
type Batch = { id: number; fileName: string; rowCount: number; exitCount: number; adjustmentCount: number; balanceRowCount: number; totalValue: number; status: "PROCESSING" | "ACTIVE" | "REVERTED" | "FAILED"; createdAt: string; revertedAt: string | null; userName: string | null; front: string | null };
type Front = { id: number; name: string };

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const qty = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
const day = (value: string | null) => value ? value.split("-").reverse().join("/") : "—";
const brDateTime = (value: string) => new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

export default function StockHistoryImportModal({ close, imported, flash }: { close: () => void; imported: (message: string) => Promise<void>; flash: (message: string) => void }) {
  const [view, setView] = useState<"import" | "batches">("import");
  const [fronts, setFronts] = useState<Front[]>([]);
  const [frontId, setFrontId] = useState<number | null>(null);
  const [cutoffDate, setCutoffDate] = useState("2026-09-07");
  const [applyBalance, setApplyBalance] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ProductDecision>>({});
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<HistoryRawRow[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [analyzedWith, setAnalyzedWith] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"" | "analyze" | "confirm">("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ fronts: Front[]; defaultFrontId: number | null; cutoffDate: string }>(API)
      .then((data) => { setFronts(data.fronts); setFrontId(data.defaultFrontId); setCutoffDate(data.cutoffDate); })
      .catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar as frentes."));
  }, []);

  const signature = JSON.stringify({ frontId, cutoffDate, applyBalance, decisions });
  const stale = Boolean(preview) && analyzedWith !== signature;
  const body = (action: "ANALYZE" | "CONFIRM") => JSON.stringify({ action, fileName, rows, frontId, cutoffDate, applyBalance, decisions });

  async function analyze(input = rows, name = fileName) {
    if (!input) return;
    setBusy("analyze"); setError("");
    try {
      const data = await api<Preview>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ANALYZE", fileName: name, rows: input, frontId, cutoffDate, applyBalance, decisions }) });
      setPreview(data); setFrontId(data.frontId); setAnalyzedWith(JSON.stringify({ frontId: data.frontId, cutoffDate, applyBalance, decisions }));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível analisar."); }
    finally { setBusy(""); }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(""); setResult(null); setPreview(null); setRows(null); setDecisions({}); setApplyBalance(false);
    try {
      const parsed = await readStockHistoryFile(file);
      setFileName(file.name); setRows(parsed);
      await analyze(parsed, file.name);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível ler o arquivo."); }
  }

  async function confirm() {
    if (!preview || stale) return;
    const front = fronts.find((item) => item.id === frontId)?.name ?? "—";
    const balanceText = preview.summary.balanceRows ? `\n\nATENÇÃO: ${preview.summary.balanceRows} saída(s) posteriores a ${day(cutoffDate)} vão BAIXAR o saldo do estoque.` : "\n\nO saldo atual dos produtos NÃO será alterado (só histórico).";
    if (!window.confirm(`Importar ${preview.summary.toImport.toLocaleString("pt-BR")} movimentação(ões), ${money(preview.summary.toImportValue)}, na frente ${front}?${balanceText}`)) return;
    setBusy("confirm"); setError("");
    try {
      const data = await api<Result>(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: body("CONFIRM") });
      setResult(data);
      await imported(`Importação #${data.batchId} concluída: ${data.imported.toLocaleString("pt-BR")} movimentação(ões), ${money(data.totalValue)}.`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível importar."); }
    finally { setBusy(""); }
  }

  const decide = (key: string, decision: ProductDecision | null) => setDecisions((current) => {
    const next = { ...current };
    if (decision) next[key] = decision; else delete next[key];
    return next;
  });
  const pendingKeys = preview?.unmatchedProducts.filter((item) => !decisions[item.key]).map((item) => item.key) ?? [];

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className="modal fuel-import-modal history-import-modal">
      <header><div><p className="eyebrow">PRODUTOS · SOMENTE ADMINISTRADOR</p><h2>Importar movimentações (histórico do almoxarifado antigo)</h2><span>Nada é gravado até você conferir a prévia e clicar em &quot;Confirmar importação&quot;. Por padrão o saldo atual dos produtos não muda.</span></div><button onClick={close} disabled={Boolean(busy)} aria-label="Fechar">×</button></header>
      <div className="fuel-import-tabs" role="tablist">
        <button type="button" className={view === "import" ? "active" : ""} onClick={() => setView("import")}>Importar</button>
        <button type="button" className={view === "batches" ? "active" : ""} onClick={() => setView("batches")}>Importações anteriores</button>
      </div>
      {view === "batches" ? <BatchesPanel flash={flash} changed={imported} /> : <div className="modal-body fuel-import-body">
        {!result && <div className="fuel-import-actions">
          <a className="secondary" href={MODEL_URL} download>⇩ Baixar modelo</a>
          <label className="fuel-import-file"><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { pick(event.target.files?.[0]); event.target.value = ""; }} disabled={Boolean(busy)} /><span>{fileName || "Escolher planilha (.xlsx, aba Importar)"}</span><b>Procurar</b></label>
          {busy && <span className="table-sub">{busy === "confirm" ? "Gravando em blocos de 500 linhas..." : "Analisando..."}</span>}
        </div>}
        {!result && <div className="history-import-options">
          <label>Frente do lançamento<select value={frontId ?? ""} onChange={(event) => setFrontId(Number(event.target.value) || null)} disabled={Boolean(busy)}>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
          <label title="Saídas depois desta data podem ter acontecido depois do Relatório Geral de Estoque">Data de corte do saldo<input type="date" value={cutoffDate} onChange={(event) => setCutoffDate(event.target.value)} disabled={Boolean(busy)} /></label>
        </div>}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
        {result ? <ResultPanel result={result} again={() => { setResult(null); setPreview(null); setRows(null); setFileName(""); setDecisions({}); setApplyBalance(false); }} close={close} />
          : preview && <>
            <SummaryPanel preview={preview} />
            {preview.unmatchedProducts.length > 0 && <details className="history-import-section" open>
              <summary><b>Produtos não encontrados no cadastro: {preview.unmatchedProducts.length}</b> ({preview.unmatchedProducts.reduce((sum, item) => sum + item.rows, 0).toLocaleString("pt-BR")} linhas) · {pendingKeys.length ? <span className="text-negative">{pendingKeys.length} sem decisão</span> : "todos decididos"}</summary>
              <div className="history-import-bulk">
                <button type="button" className="secondary" disabled={!pendingKeys.length} onClick={() => setDecisions((current) => ({ ...current, ...Object.fromEntries(pendingKeys.map((key) => [key, { action: "CREATE" } as ProductDecision])) }))}>Cadastrar os {pendingKeys.length} sem decisão como novos</button>
                <button type="button" className="secondary" disabled={!pendingKeys.length} onClick={() => setDecisions((current) => ({ ...current, ...Object.fromEntries(preview.unmatchedProducts.filter((item) => pendingKeys.includes(item.key) && item.suggestions[0]?.score >= 0.9).map((item) => [item.key, { action: "LINK", productId: item.suggestions[0].id } as ProductDecision])) }))}>Vincular à 1ª sugestão quando parecida ≥ 90%</button>
                <button type="button" className="secondary" disabled={!Object.keys(decisions).length} onClick={() => setDecisions({})}>Limpar decisões</button>
              </div>
              <div className="table-scroll history-import-table-wrap"><table className="fuel-import-table history-import-products">
                <thead><tr><th>Produto na planilha</th><th>Linhas · qtd · valor</th><th>Decisão</th></tr></thead>
                <tbody>{preview.unmatchedProducts.map((item) => <UnmatchedRow key={item.key} item={item} decision={decisions[item.key] ?? null} decide={(decision) => decide(item.key, decision)} />)}</tbody>
              </table></div>
            </details>}
            <AfterCutoffPanel preview={preview} applyBalance={applyBalance} setApplyBalance={setApplyBalance} />
            <TallySection title="Equipamentos não encontrados (importados com o texto)" items={preview.unmatchedEquipment} />
            <TallySection title="Colaboradores não encontrados em Funcionários (guardados como texto)" items={preview.unmatchedEmployees} />
            <TallySection title="Departamentos não encontrados (guardados como texto)" items={preview.unmatchedDepartments} />
            {preview.duplicates.length > 0 && <details className="history-import-section">
              <summary><b>Duplicados (não serão importados): {preview.summary.duplicates.toLocaleString("pt-BR")}</b>{preview.truncated.duplicates && " · mostrando os primeiros 500"}</summary>
              <div className="table-scroll history-import-table-wrap"><table className="fuel-import-balances"><thead><tr><th>Linha</th><th>Data</th><th>Produto</th><th>Qtd.</th><th>Colaborador / equipamento</th><th>Motivo</th></tr></thead>
                <tbody>{preview.duplicates.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{day(row.date)}</td><td>{row.product}</td><td>{row.quantity === null ? "—" : qty(row.quantity)}</td><td>{[row.employee, row.equipment].filter(Boolean).join(" · ") || "—"}</td><td>{row.reason}</td></tr>)}</tbody></table></div>
            </details>}
            {preview.errors.length > 0 && <details className="history-import-section" open>
              <summary><b className="text-negative">Linhas com erro (não serão importadas): {preview.summary.errors.toLocaleString("pt-BR")}</b>{preview.truncated.errors && " · mostrando as primeiras 500"}</summary>
              <div className="table-scroll history-import-table-wrap"><table className="fuel-import-balances"><thead><tr><th>Linha</th><th>Produto</th><th>Erro</th></tr></thead>
                <tbody>{preview.errors.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.product || "—"}</td><td>{row.messages.join(" ")}</td></tr>)}</tbody></table></div>
            </details>}
            {preview.warnings.length > 0 && <details className="history-import-section">
              <summary><b>Avisos (importam normalmente): {preview.summary.warnings.toLocaleString("pt-BR")}</b>{preview.truncated.warnings && " · mostrando os primeiros 500"}</summary>
              <div className="table-scroll history-import-table-wrap"><table className="fuel-import-balances"><thead><tr><th>Linha</th><th>Produto</th><th>Aviso</th></tr></thead>
                <tbody>{preview.warnings.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.product}</td><td>{row.messages.join(" ")}</td></tr>)}</tbody></table></div>
            </details>}
            <div className="modal-footer fuel-import-footer">
              {stale && <span className="fuel-hint warning">Você mudou decisões, frente, corte ou baixa de estoque: clique em &quot;Atualizar prévia&quot; antes de confirmar.</span>}
              {!stale && preview.summary.productsPending > 0 && <span className="fuel-hint warning">Decida os {preview.summary.productsPending} produto(s) não encontrado(s) para liberar a confirmação.</span>}
              <button type="button" className="secondary" onClick={() => analyze()} disabled={Boolean(busy)}>{busy === "analyze" ? "Analisando..." : "Atualizar prévia"}</button>
              <button type="button" className="primary" onClick={confirm} disabled={Boolean(busy) || stale || preview.summary.productsPending > 0 || preview.summary.toImport === 0}>
                {busy === "confirm" ? "Importando..." : `Confirmar importação (${preview.summary.toImport.toLocaleString("pt-BR")} · ${money(preview.summary.toImportValue)})`}
              </button>
            </div>
          </>}
        {!preview && !result && !error && <div className="fuel-import-help">
          <p><b>Como funciona:</b> escolha a planilha (aba <b>Importar</b>, colunas Data, Tipo, Produto, Quantidade, Valor Unitário, Valor Total, Equipamento, Chassi/Série, Proprietário, Descrição equipamento, Local/Destino, Colaborador, Departamento). A prévia mostra os totais, os produtos e equipamentos não encontrados, os duplicados e os erros por linha.</p>
          <p>Tudo entra como <b>histórico</b> (origem IMPORTACAO_SISTEMA_ANTIGO) sem mexer no saldo. Saídas posteriores à data de corte aparecem separadas e só baixam o estoque se você marcar. AJUSTE entra como <b>Correção de Estoque</b>, fora dos relatórios de consumo.</p>
        </div>}
      </div>}
    </section>
  </div>;
}

function SummaryPanel({ preview }: { preview: Preview }) {
  const summary = preview.summary;
  return <div className="fuel-import-summary">
    <span><b>{summary.totalRows.toLocaleString("pt-BR")}</b> linhas · {day(summary.dateFrom)} a {day(summary.dateTo)}</span>
    <span><b>{summary.exits.toLocaleString("pt-BR")}</b> saídas · {money(summary.exitsValue)}</span>
    <span><b>{summary.adjustments.toLocaleString("pt-BR")}</b> ajustes (correção) · {money(summary.adjustmentsValue)}</span>
    <span>Valor total: <b>{money(summary.totalValue)}</b></span>
    <span className="ok">A importar: <b>{summary.toImport.toLocaleString("pt-BR")}</b> · {money(summary.toImportValue)}</span>
    <span className="warn"><b>{summary.duplicates.toLocaleString("pt-BR")}</b> duplicados</span>
    <span className="err"><b>{summary.errors.toLocaleString("pt-BR")}</b> com erro</span>
    {summary.pendingProductRows > 0 && <span className="err"><b>{summary.pendingProductRows.toLocaleString("pt-BR")}</b> linhas com produto sem decisão</span>}
    {summary.skippedRows > 0 && <span><b>{summary.skippedRows.toLocaleString("pt-BR")}</b> linhas marcadas para não importar</span>}
    <span>Produtos: <b>{summary.productsMatched}</b> casados · <b>{summary.productsUnmatched}</b> não encontrados</span>
    <span>Equipamento casado em <b>{summary.equipmentMatchedRows.toLocaleString("pt-BR")}</b> linhas · <b>{preview.unmatchedEquipment.length}</b> não encontrados</span>
    <span>Colaborador casado em <b>{summary.employeeMatchedRows.toLocaleString("pt-BR")}</b> linhas</span>
    {summary.balanceRows > 0 && <span className="err">Baixam estoque: <b>{summary.balanceRows}</b></span>}
  </div>;
}

function UnmatchedRow({ item, decision, decide }: { item: Unmatched; decision: ProductDecision | null; decide: (decision: ProductDecision | null) => void }) {
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<Suggestion[]>([]);
  const [picked, setPicked] = useState<Suggestion | null>(null);
  useEffect(() => {
    if (search.trim().length < 2) { setFound([]); return; }
    const timer = window.setTimeout(() => {
      api<{ products: Array<{ id: number; tag: string; name: string; price: number; active?: boolean }> }>(`/api/products?q=${encodeURIComponent(search.trim())}&pageSize=8&includeInactive=1`)
        .then((data) => setFound(data.products.map((product) => ({ id: product.id, tag: product.tag, name: product.name, price: Number(product.price), active: product.active !== false, score: 0 }))))
        .catch(() => setFound([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const options = useMemo(() => [...item.suggestions, ...(picked && !item.suggestions.some((s) => s.id === picked.id) ? [picked] : [])], [item.suggestions, picked]);
  const linkedId = decision?.action === "LINK" ? decision.productId : null;
  return <tr className={decision ? "" : "aviso"}>
    <td className="history-import-name"><b>{item.name}</b>{item.ambiguous && <small>Nome repetido no cadastro: escolha qual produto.</small>}<small>{day(item.firstDate)} a {day(item.lastDate)} · último valor {money(item.unitPrice)}</small></td>
    <td>{item.rows} · {qty(item.quantity)}<small className="table-sub">{money(item.value)}</small></td>
    <td className="history-import-decision">
      {options.map((option) => <label key={option.id} className={linkedId === option.id ? "picked" : ""}>
        <input type="radio" name={`decision-${item.key}`} checked={linkedId === option.id} onChange={() => decide({ action: "LINK", productId: option.id })} />
        <span>Vincular a <b>{option.tag}</b> {option.name}{!option.active && " (inativo)"}{option.score > 0 && option.score < 1 && <small> · {Math.round(option.score * 100)}% parecido</small>}</span>
      </label>)}
      <div className="history-import-search">
        <input placeholder="Buscar outro produto (TAG, nome ou referência)" value={search} onChange={(event) => setSearch(event.target.value)} />
        {found.length > 0 && <div className="history-import-found">{found.map((product) => <button type="button" key={product.id} onClick={() => { setPicked(product); decide({ action: "LINK", productId: product.id }); setSearch(""); setFound([]); }}><b>{product.tag}</b> {product.name}</button>)}</div>}
      </div>
      <label className={decision?.action === "CREATE" ? "picked" : ""}><input type="radio" name={`decision-${item.key}`} checked={decision?.action === "CREATE"} onChange={() => decide({ action: "CREATE" })} /><span>Cadastrar como novo (nome + preço {money(item.unitPrice)}, marcado para revisão)</span></label>
      <label className={decision?.action === "SKIP" ? "picked" : ""}><input type="radio" name={`decision-${item.key}`} checked={decision?.action === "SKIP"} onChange={() => decide({ action: "SKIP" })} /><span>Não importar estas {item.rows} linha(s)</span></label>
      {decision && <button type="button" className="link-button" onClick={() => decide(null)}>desfazer escolha</button>}
    </td>
  </tr>;
}

function AfterCutoffPanel({ preview, applyBalance, setApplyBalance }: { preview: Preview; applyBalance: boolean; setApplyBalance: (value: boolean) => void }) {
  const after = preview.afterCutoff;
  if (!after.rows) return <p className="fuel-hint">Nenhuma saída posterior a {day(after.cutoffDate)} fora do sistema: nada a baixar do estoque.</p>;
  return <details className="history-import-section history-import-after" open>
    <summary><b>Saídas posteriores a {day(after.cutoffDate)} que NÃO estão no sistema novo: {after.rows.toLocaleString("pt-BR")}</b> · {qty(after.quantity)} un. · {money(after.value)} · {after.products.length} produto(s)</summary>
    <p className="fuel-hint warning">O saldo atual veio do Relatório Geral de Estoque de {day(after.cutoffDate)}. Estas saídas aconteceram depois e não foram encontradas no sistema novo. Por padrão elas entram só como histórico. Marque abaixo apenas se elas devem <b>baixar</b> o saldo da frente.</p>
    {after.pendingProductRows > 0 && <p className="fuel-hint warning">{after.pendingProductRows} destas linhas ainda têm produto sem decisão.</p>}
    <label className="history-import-apply"><input type="checkbox" checked={applyBalance} onChange={(event) => setApplyBalance(event.target.checked)} /> Baixar o estoque destas {after.rows.toLocaleString("pt-BR")} saídas (o saldo de cada produto abaixo diminui)</label>
    <div className="table-scroll history-import-table-wrap"><table className="fuel-import-balances"><thead><tr><th>Produto</th><th>Linhas</th><th>Qtd. saída</th><th>Valor</th><th>Saldo atual</th><th>Saldo se baixar</th></tr></thead>
      <tbody>{after.products.map((item, index) => <tr key={index}><td>{item.tag ? <b>{item.tag} </b> : <small>(sem cadastro) </small>}{item.name}</td><td>{item.rows}</td><td>{qty(item.quantity)}</td><td>{money(item.value)}</td><td>{qty(item.balance)}</td><td className={item.after < 0 ? "text-negative" : ""}>{qty(item.after)}</td></tr>)}</tbody></table></div>
  </details>;
}

function TallySection({ title, items }: { title: string; items: Tally[] }) {
  if (!items.length) return null;
  return <details className="history-import-section">
    <summary><b>{title}: {items.length}</b> ({items.reduce((sum, item) => sum + item.rows, 0).toLocaleString("pt-BR")} linhas)</summary>
    <div className="history-import-tally">{items.map((item) => <span key={item.text}>{item.text} <b>{item.rows}</b></span>)}</div>
  </details>;
}

function ResultPanel({ result, again, close }: { result: Result; again: () => void; close: () => void }) {
  return <div className="fuel-import-result">
    <div className="fuel-import-summary">
      <span className="ok"><b>{result.imported.toLocaleString("pt-BR")}</b> importada(s)</span><span><b>{result.exits.toLocaleString("pt-BR")}</b> saídas</span><span><b>{result.adjustments.toLocaleString("pt-BR")}</b> correções</span>
      <span>Total <b>{money(result.totalValue)}</b></span><span>Lote <b>#{result.batchId}</b></span>
      {result.createdProducts > 0 && <span><b>{result.createdProducts}</b> produto(s) cadastrado(s) (para revisão)</span>}
      <span className={result.balanceRows ? "err" : ""}><b>{result.balanceRows}</b> baixaram estoque</span>
      {result.duplicates > 0 && <span className="warn"><b>{result.duplicates}</b> duplicados ignorados</span>}
      {result.errors > 0 && <span className="err"><b>{result.errors}</b> com erro ignorados</span>}
      {result.skipped > 0 && <span><b>{result.skipped}</b> não importados por decisão</span>}
    </div>
    <div className="modal-footer fuel-import-footer">
      <button type="button" className="secondary" onClick={again}>Importar outra planilha</button>
      <button type="button" className="primary" onClick={close}>Concluir</button>
    </div>
  </div>;
}

function BatchesPanel({ flash, changed }: { flash: (message: string) => void; changed: (message: string) => Promise<void> }) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(async () => { try { setBatches((await api<{ batches: Batch[] }>(API)).batches); } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); } }, []);
  useEffect(() => { load(); }, [load]);
  async function revert(batch: Batch) {
    const balance = batch.balanceRowCount ? ` ${batch.balanceRowCount} saída(s) que baixaram estoque terão o saldo devolvido.` : "";
    if (!window.confirm(`Desfazer a importação #${batch.id} (${batch.fileName}, ${batch.rowCount.toLocaleString("pt-BR")} linha(s), ${money(batch.totalValue)})? As linhas são apagadas do histórico.${balance}`)) return;
    setBusy(batch.id); setError("");
    try { const result = await api<{ message: string }>(`${API}/${batch.id}`, { method: "DELETE" }); flash(result.message); await changed(result.message); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível desfazer."); }
    finally { setBusy(null); }
  }
  const status = (batch: Batch) => batch.status === "ACTIVE" ? <span className="status-pill green">Ativo</span>
    : batch.status === "PROCESSING" ? <span className="status-pill orange">Gravando</span>
      : batch.status === "FAILED" ? <span className="status-pill red">Falhou (removido)</span>
        : <span className="status-pill gray">Desfeito {batch.revertedAt ? brDateTime(batch.revertedAt) : ""}</span>;
  return <div className="modal-body">
    {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
    {batches && <div className="table-scroll"><table className="fuel-import-balances">
      <thead><tr><th>Lote</th><th>Arquivo</th><th>Importado por</th><th>Quando</th><th>Frente</th><th>Linhas</th><th>Saídas · correções</th><th>Baixaram estoque</th><th>Valor</th><th>Situação</th><th /></tr></thead>
      <tbody>{batches.map((batch) => <tr key={batch.id}>
        <td>#{batch.id}</td><td>{batch.fileName}</td><td>{batch.userName ?? "—"}</td><td>{brDateTime(batch.createdAt)}</td><td>{batch.front ?? "—"}</td>
        <td>{batch.rowCount.toLocaleString("pt-BR")}</td><td>{batch.exitCount.toLocaleString("pt-BR")} · {batch.adjustmentCount.toLocaleString("pt-BR")}</td><td>{batch.balanceRowCount}</td><td>{money(batch.totalValue)}</td><td>{status(batch)}</td>
        <td>{batch.status === "ACTIVE" && <button type="button" className="danger-action" disabled={busy === batch.id} onClick={() => revert(batch)}>{busy === batch.id ? "Desfazendo..." : "Desfazer importação"}</button>}</td>
      </tr>)}</tbody>
    </table></div>}
    {batches && batches.length === 0 && <div className="empty-state">Nenhuma importação ainda.</div>}
  </div>;
}
