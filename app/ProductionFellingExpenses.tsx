"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError, api, brDateTime, brDay, jsonBody, problemText, qtyFormat, ShortageNotice, type Shortage } from "./stock-client";
import { localToday, money, number, PeriodFilter, periodQuery, ProductionEmployeePicker, type Period, type ProductionContext, type ProductionEmployee } from "./production-client";
import type { FellingCard } from "./ProductionFellingTab";
import { readSpreadsheetMatrix } from "../lib/excel-client";

// PRODUÇÃO → Derruba → Despesas e Perdas (só quem vê os custos):
//  - Material de consumo e peça de motosserra do estoque = saída de produto para o operador (baixa o
//    estoque da frente, preço da frente); reparo/perda total sem peça = Outros gastos com o valor.
//  - Importar Excel (só ADMIN): prévia → confirmação → lote com Desfazer.
//  - Lista do período com a origem; excluir estorna a saída (o produto volta) ou exclui o gasto.

type Props = { context: ProductionContext; projects: FellingCard[]; selectedFronts: number[]; period: Period; setPeriod: (period: Period) => void; flash: (message: string) => void };
type ProductOption = { id: number; tag: string; name: string; price: number; frontPrice: boolean; balance: number };
type Expense = {
  source: "ESTOQUE" | "OUTROS" | "GASOLINA"; id: number; date: string; projectName: string | null; employeeName: string | null; equipment: string | null;
  kind: string; kindLabel: string; item: string; tool: string | null; quantity: number; value: number | null; origin: "ESTOQUE" | "MANUAL" | "IMPORTACAO" | "PRODUCAO";
};
const ORIGIN_LABELS: Record<Expense["origin"], string> = { ESTOQUE: "Saída de estoque", MANUAL: "Outros gastos", IMPORTACAO: "Importação", PRODUCAO: "Lançamento do dia" };
const failure = (problem: unknown, fallback: string) => window.alert(problemText(problem, fallback));

export default function ProductionFellingExpenses({ context, projects, selectedFronts, period, setPeriod, flash }: Props) {
  const [data, setData] = useState<{ expenses: Expense[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const query = periodQuery(period, selectedFronts);
  const load = useCallback(() => {
    setError("");
    api<{ expenses: Expense[]; total: number }>(`/api/producao/despesas?${query}`).then(setData).catch((problem) => setError(problemText(problem, "Não foi possível carregar as despesas.")));
  }, [query]);
  useEffect(() => { setData(null); load(); }, [load]);
  const saved = (message: string) => { flash(message); load(); };
  const launch = context.access.launch;
  const manage = context.access.manage;

  async function remove(row: Expense) {
    const question = row.source === "ESTOQUE" ? `Estornar a saída de ${row.item} para ${row.employeeName ?? "o funcionário"}? O produto volta ao estoque da frente.` : `Excluir a despesa "${row.item}"?`;
    if (!window.confirm(question)) return;
    try { saved((await api<{ message: string }>(`/api/producao/despesas?origem=${row.source}&id=${row.id}`, { method: "DELETE" })).message); }
    catch (problem) { failure(problem, "Não foi possível excluir."); }
  }

  return <>
    {launch && <div className="production-expense-forms">
      <MaterialForm projects={projects} saved={saved} />
      <MaintenanceForm projects={projects} saved={saved} />
    </div>}
    {context.access.admin && <ImportPanel saved={saved} />}
    <article className="panel module-panel production-panel">
      <div className="production-list-head"><h2>Despesas da derruba</h2></div>
      <PeriodFilter value={period} onChange={setPeriod} projects={projects} />
      {error && <div className="fleet-form-error">! {error}</div>}
      {!data && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : data && <>
        <p className="stock-summary">{data.expenses.length} lançamento(s) · total {money(data.total)} · a gasolina entra só como valor (litros × custo médio do estoque) e se corrige no lançamento do dia.</p>
        <div className="table-scroll"><table className="products-table production-table">
          <thead><tr><th>Data</th><th>Projeto</th><th>Funcionário</th><th>Tipo</th><th>Item</th><th>Motosserra</th><th className="num">Qtd</th><th className="num">Valor</th><th>Origem</th>{manage && <th />}</tr></thead>
          <tbody>{data.expenses.map((row) => <tr key={`${row.source}-${row.id}`}>
            <td data-label="Data">{brDay(row.date)}</td>
            <td data-label="Projeto">{row.projectName ?? "—"}</td>
            <td data-label="Funcionário">{row.employeeName ?? "—"}</td>
            <td data-label="Tipo">{row.kindLabel}</td>
            <td data-label="Item">{row.item}</td>
            <td data-label="Motosserra">{row.tool ?? "—"}</td>
            <td data-label="Qtd" className="num">{qtyFormat.format(row.quantity)}{row.source === "GASOLINA" ? " L" : ""}</td>
            <td data-label="Valor" className="num">{row.value === null ? <span className="production-sub" title="A frente não tinha custo médio de gasolina no estoque nesta data.">sem valor</span> : money(row.value)}</td>
            <td data-label="Origem"><span className="production-origin">{ORIGIN_LABELS[row.origin]}</span></td>
            {manage && <td>{row.source !== "GASOLINA" && <div className="equipment-row-actions"><button type="button" onClick={() => remove(row)}>{row.source === "ESTOQUE" ? "Estornar" : "Excluir"}</button></div>}</td>}
          </tr>)}</tbody>
        </table>{data.expenses.length === 0 && <div className="empty-state">Nenhuma despesa da derruba no período.</div>}</div>
      </>}
    </article>
  </>;
}

// Produtos marcados para a Produção na frente do projeto, com o preço da frente e o saldo.
function useProducts(frontId: number | null) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setProducts([]); setError("");
    if (!frontId) return;
    let cancelled = false;
    api<{ products: ProductOption[] }>(`/api/producao/produtos?frente=${frontId}`).then((result) => { if (!cancelled) setProducts(result.products); })
      .catch((problem) => { if (!cancelled) setError(problemText(problem, "Não foi possível carregar os produtos.")); });
    return () => { cancelled = true; };
  }, [frontId]);
  return { products, error };
}
const productLabel = (product: ProductOption) => `${product.tag} ${product.name} — ${money(product.price)} · saldo ${qtyFormat.format(product.balance)}`;

function ProjectSelect({ projects, value, onChange }: { projects: FellingCard[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} required onChange={(event) => onChange(event.target.value)}>
    <option value="">Escolha o projeto</option>
    {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.frontName}</option>)}
  </select>;
}

// Formulário com aviso de saldo insuficiente (409 → "lançar mesmo assim", só ADMIN/GESTOR).
function useExpenseSubmit(saved: (message: string) => void, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shortages, setShortages] = useState<Shortage[]>([]);
  async function send(body: Record<string, unknown>, allowNegative = false) {
    setBusy(true); setError("");
    try { saved((await api<{ message: string }>("/api/producao/despesas", jsonBody("POST", { ...body, allowNegative }))).message); setShortages([]); onDone(); }
    catch (problem) {
      setShortages(problem instanceof ApiError && Array.isArray(problem.data.shortages) && problem.status === 409 ? problem.data.shortages as Shortage[] : []);
      setError(problemText(problem, "Não foi possível lançar."));
    } finally { setBusy(false); }
  }
  return { busy, error, shortages, send, clear: () => { setError(""); setShortages([]); } };
}

function MaterialForm({ projects, saved }: { projects: FellingCard[]; saved: (message: string) => void }) {
  const [projectId, setProjectId] = useState(projects.length === 1 ? String(projects[0].id) : "");
  const [date, setDate] = useState(localToday());
  const [employee, setEmployee] = useState<ProductionEmployee | null>(null);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const project = projects.find((item) => String(item.id) === projectId) ?? null;
  const { products, error: productsError } = useProducts(project?.serviceFrontId ?? null);
  const { busy, error, shortages, send, clear } = useExpenseSubmit(saved, () => { setProductId(""); setQuantity("1"); setNotes(""); });
  const body = () => ({ tipo: "MATERIAL", projectId: Number(projectId), date, employeeId: employee?.id ?? null, productId: Number(productId) || null, quantity, notes });
  const submit = (event: FormEvent) => { event.preventDefault(); send(body()); };
  return <form className="panel production-form production-expense-form" onSubmit={submit} onChange={clear}>
    <h3>Material de consumo</h3>
    <p className="production-help full">Lima, corrente, sabre, óleo 2T... Sai do estoque da frente para o operador responsável, pelo preço da frente.</p>
    <label>Projeto<ProjectSelect projects={projects} value={projectId} onChange={(value) => { setProjectId(value); setProductId(""); }} /></label>
    <label>Data<input type="date" value={date} max={localToday()} required onChange={(event) => setDate(event.target.value)} /></label>
    <label className="full">Operador responsável<ProductionEmployeePicker value={employee} onPick={setEmployee} frontId={project?.serviceFrontId ?? null} group="MOTOSSERRA" placeholder="Buscar operador..." /></label>
    <label className="full">Produto<select value={productId} required disabled={!project} onChange={(event) => setProductId(event.target.value)}>
      <option value="">{project ? (products.length ? "Escolha o produto" : "Nenhum produto marcado para a Produção") : "Escolha o projeto primeiro"}</option>
      {products.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}
    </select></label>
    <label>Quantidade<input inputMode="decimal" required value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/[^\d,.]/g, ""))} /></label>
    <label>Observação<input value={notes} maxLength={300} onChange={(event) => setNotes(event.target.value)} /></label>
    {productsError && <p className="fleet-form-error full">! {productsError}</p>}
    {error && !shortages.length && <p className="fleet-form-error full">! {error}</p>}
    {shortages.length > 0 && <ShortageNotice shortages={shortages} busy={busy} confirm={() => send(body(), true)} />}
    <button className="primary" disabled={busy}>{busy ? "Lançando..." : "Lançar material"}</button>
  </form>;
}

function MaintenanceForm({ projects, saved }: { projects: FellingCard[]; saved: (message: string) => void }) {
  const [projectId, setProjectId] = useState(projects.length === 1 ? String(projects[0].id) : "");
  const [date, setDate] = useState(localToday());
  const [employee, setEmployee] = useState<ProductionEmployee | null>(null);
  const [kind, setKind] = useState<"MANUTENCAO" | "PERDA_TOTAL">("MANUTENCAO");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [value, setValue] = useState("");
  const [tool, setTool] = useState("");
  const [notes, setNotes] = useState("");
  const project = projects.find((item) => String(item.id) === projectId) ?? null;
  const { products, error: productsError } = useProducts(project?.serviceFrontId ?? null);
  const { busy, error, shortages, send, clear } = useExpenseSubmit(saved, () => { setProductId(""); setQuantity("1"); setValue(""); setNotes(""); });
  const body = () => ({ tipo: kind, projectId: Number(projectId), date, employeeId: employee?.id ?? null, productId: Number(productId) || null, quantity: productId ? quantity : "", value: productId ? "" : value, tool, notes });
  const submit = (event: FormEvent) => { event.preventDefault(); send(body()); };
  return <form className="panel production-form production-expense-form" onSubmit={submit} onChange={clear}>
    <h3>Manutenção de motosserra</h3>
    <p className="production-help full">Com peça do estoque, sai do estoque da frente. Sem peça (reparo/serviço), informe o valor: vai para Outros gastos.</p>
    <fieldset className="production-kind full">
      <button type="button" className={kind === "MANUTENCAO" ? "active" : ""} aria-pressed={kind === "MANUTENCAO"} onClick={() => setKind("MANUTENCAO")}>Peça / reparo</button>
      <button type="button" className={kind === "PERDA_TOTAL" ? "active" : ""} aria-pressed={kind === "PERDA_TOTAL"} onClick={() => setKind("PERDA_TOTAL")}>Perda total</button>
    </fieldset>
    <label>Projeto<ProjectSelect projects={projects} value={projectId} onChange={(next) => { setProjectId(next); setProductId(""); }} /></label>
    <label>Data<input type="date" value={date} max={localToday()} required onChange={(event) => setDate(event.target.value)} /></label>
    <label className="full">Operador responsável<ProductionEmployeePicker value={employee} onPick={setEmployee} frontId={project?.serviceFrontId ?? null} group="MOTOSSERRA" placeholder="Buscar operador..." /></label>
    <label>Motosserra (identificação)<input value={tool} maxLength={60} placeholder="Ex.: MS 07" onChange={(event) => setTool(event.target.value)} /></label>
    <label>Peça do estoque<select value={productId} disabled={!project} onChange={(event) => setProductId(event.target.value)}>
      <option value="">— sem peça (reparo/serviço) —</option>
      {products.map((product) => <option key={product.id} value={product.id}>{productLabel(product)}</option>)}
    </select></label>
    {productId
      ? <label>Quantidade<input inputMode="decimal" required value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/[^\d,.]/g, ""))} /></label>
      : <label>Valor (R$)<input inputMode="decimal" required value={value} placeholder="0,00" onChange={(event) => setValue(event.target.value.replace(/[^\d,.]/g, ""))} /></label>}
    <label>Observação<input value={notes} maxLength={300} onChange={(event) => setNotes(event.target.value)} /></label>
    {productsError && <p className="fleet-form-error full">! {productsError}</p>}
    {error && !shortages.length && <p className="fleet-form-error full">! {error}</p>}
    {shortages.length > 0 && <ShortageNotice shortages={shortages} busy={busy} confirm={() => send(body(), true)} />}
    <button className="primary" disabled={busy}>{busy ? "Lançando..." : kind === "PERDA_TOTAL" ? "Lançar perda total" : "Lançar manutenção"}</button>
  </form>;
}

// ---------------------------------------------------------------------------
// Importar Excel (só ADMIN): lê a planilha no navegador, liga as colunas, mostra a prévia do servidor
// (OK / ERRO / IGUAL) e só grava ao confirmar. Cada importação vira um lote que pode ser desfeito.
// ---------------------------------------------------------------------------
const FIELDS = [
  { key: "data", label: "Data", aliases: ["DATA", "DIA"] },
  { key: "projeto", label: "Projeto", aliases: ["PROJETO", "FAZENDA", "UPA"] },
  { key: "funcionario", label: "Funcionário", aliases: ["FUNCIONARIO", "OPERADOR", "NOME", "COLABORADOR"] },
  { key: "tipo", label: "Tipo", aliases: ["TIPO", "TIPODEDESPESA"] },
  { key: "produto", label: "Produto/TAG", aliases: ["PRODUTOTAG", "PRODUTO", "TAG"] },
  { key: "quantidade", label: "Quantidade", aliases: ["QUANTIDADE", "QTD", "QTDE"] },
  { key: "valor", label: "Valor", aliases: ["VALOR", "VALORRS", "VALORR"] },
  { key: "observacao", label: "Observação", aliases: ["OBSERVACAO", "OBS", "DESCRICAO"] },
] as const;
type FieldKey = typeof FIELDS[number]["key"];
type PreviewRow = { rowNumber: number; values: Partial<Record<FieldKey, string>>; status: "OK" | "ERRO" | "IGUAL"; messages: string[] };
type Batch = { id: number; fileName: string; rowCount: number; status: "ACTIVE" | "REVERTED"; summary: { failed?: Array<{ rowNumber: number; error: string }>; ignored?: number; errors?: number } | null; createdAt: string; revertedAt: string | null; userName: string | null };
const MODEL_URL = "/api/producao/despesas/importar/modelo";
const headerKey = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const columnLetter = (index: number) => { let label = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + ((n - 1) % 26)) + label; return label; };
function cellText(field: FieldKey, value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return field === "data" ? String(value) : String(value).replace(".", ",");
  return String(value).trim();
}

function ImportPanel({ saved }: { saved: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; matrix: unknown[][]; headerIndex: number } | null>(null);
  const [mapping, setMapping] = useState<Record<FieldKey, number>>({} as Record<FieldKey, number>);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [allowNegative, setAllowNegative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ message: string; failed: Array<{ rowNumber: number; error: string }> } | null>(null);
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const loadBatches = useCallback(() => { api<{ batches: Batch[] }>("/api/producao/despesas/importar").then((data) => setBatches(data.batches)).catch(() => setBatches([])); }, []);
  useEffect(() => { if (open) loadBatches(); }, [open, loadBatches]);

  const headers = file ? (file.matrix[file.headerIndex] ?? []).map((cell) => String(cell ?? "").trim()) : [];
  const rows = useMemo(() => {
    if (!file) return [];
    return file.matrix.slice(file.headerIndex + 1).map((row, offset) => ({
      rowNumber: file.headerIndex + offset + 2,
      values: Object.fromEntries(FIELDS.map((field) => [field.key, mapping[field.key] >= 0 ? cellText(field.key, (row ?? [])[mapping[field.key]]) : ""])),
    })).filter((row) => Object.values(row.values).some(Boolean));
  }, [file, mapping]);

  async function pick(input: HTMLInputElement) {
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    setError(""); setPreview(null); setResult(null);
    try {
      const matrix = await readSpreadsheetMatrix(chosen) as unknown[][];
      const score = (row: unknown[] | undefined) => (row ?? []).filter((cell) => FIELDS.some((field) => (field.aliases as readonly string[]).includes(headerKey(cell)))).length;
      let headerIndex = 0;
      for (let index = 0; index < Math.min(matrix.length, 25); index += 1) if (score(matrix[index]) > score(matrix[headerIndex])) headerIndex = index;
      if (score(matrix[headerIndex]) < 2) throw new Error("Não encontrei o cabeçalho (Data, Projeto, Funcionário, Tipo...). Baixe o modelo.");
      const keys = (matrix[headerIndex] ?? []).map(headerKey);
      setMapping(Object.fromEntries(FIELDS.map((field) => [field.key, keys.findIndex((key) => (field.aliases as readonly string[]).includes(key))])) as Record<FieldKey, number>);
      setFile({ name: chosen.name, matrix, headerIndex });
    } catch (problem) { setFile(null); setError(problemText(problem, "Não foi possível ler a planilha.")); }
  }
  async function analyze() {
    if (!file) return;
    setBusy(true); setError(""); setResult(null);
    try { setPreview((await api<{ rows: PreviewRow[] }>("/api/producao/despesas/importar", jsonBody("POST", { acao: "previa", fileName: file.name, rows }))).rows); }
    catch (problem) { setError(problemText(problem, "Não foi possível analisar a planilha.")); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!file || !preview) return;
    const ready = preview.filter((row) => row.status === "OK").length;
    if (!window.confirm(`Importar ${ready} linha(s)? As com erro e as iguais a registros existentes ficam de fora.`)) return;
    setBusy(true); setError("");
    try {
      const data = await api<{ message: string; failed: Array<{ rowNumber: number; error: string }> }>("/api/producao/despesas/importar", jsonBody("POST", { acao: "confirmar", fileName: file.name, rows, allowNegative }));
      setResult(data); setPreview(null); setFile(null); saved(data.message); loadBatches();
    } catch (problem) { setError(problemText(problem, "Não foi possível importar.")); }
    finally { setBusy(false); }
  }
  async function revert(batch: Batch) {
    if (!window.confirm(`Desfazer a importação #${batch.id} (${batch.fileName})? As saídas de estoque do lote são estornadas e os outros gastos, excluídos.`)) return;
    try { saved((await api<{ message: string }>(`/api/producao/despesas/importar/${batch.id}`, { method: "DELETE" })).message); loadBatches(); }
    catch (problem) { failure(problem, "Não foi possível desfazer."); }
  }
  const counts = preview ? { ok: preview.filter((row) => row.status === "OK").length, error: preview.filter((row) => row.status === "ERRO").length, same: preview.filter((row) => row.status === "IGUAL").length } : null;

  return <article className="panel module-panel production-panel production-import">
    <div className="production-list-head"><h2>Importar despesas por Excel</h2><button type="button" className="secondary" onClick={() => setOpen((value) => !value)}>{open ? "Fechar" : "Abrir importação"}</button></div>
    {open && <>
      <p className="production-help">Colunas: Data, Projeto, Funcionário, Tipo (Material, Manutenção, Perda total ou Custo operacional), Produto/TAG, Quantidade, Valor e Observação. Nada é gravado antes da confirmação. <a href={MODEL_URL} download>Baixar a planilha-modelo</a>.</p>
      <label className="production-file"><span>Planilha (.xlsx, .xls ou .csv)</span><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => pick(event.currentTarget)} /></label>
      {error && <div className="fleet-form-error">! {error}</div>}
      {file && <>
        <p className="stock-summary">{file.name} · cabeçalho na linha {file.headerIndex + 1} · {rows.length} linha(s) preenchida(s)</p>
        <div className="production-mapping">{FIELDS.map((field) => <label key={field.key}>{field.label}
          <select value={mapping[field.key] ?? -1} onChange={(event) => { setMapping((current) => ({ ...current, [field.key]: Number(event.target.value) })); setPreview(null); }}>
            <option value={-1}>— não usar —</option>
            {headers.map((header, index) => <option key={index} value={index}>{columnLetter(index)} · {header || "(sem título)"}</option>)}
          </select>
        </label>)}</div>
        <button type="button" className="primary" disabled={busy || rows.length === 0} onClick={analyze}>{busy && !preview ? "Analisando..." : "Pré-visualizar"}</button>
      </>}
      {preview && counts && <>
        <p className="stock-summary"><b>{counts.ok}</b> pronta(s) · <b>{counts.error}</b> com erro · <b>{counts.same}</b> igual(is) a registros existentes (ignoradas)</p>
        <div className="table-scroll production-preview"><table className="products-table production-table">
          <thead><tr><th>Linha</th><th>Situação</th><th>Data</th><th>Projeto</th><th>Funcionário</th><th>Tipo</th><th>Produto</th><th className="num">Qtd</th><th className="num">Valor</th><th>Observações</th></tr></thead>
          <tbody>{preview.map((row) => <tr key={row.rowNumber} className={row.status === "ERRO" ? "invalid" : ""}>
            <td data-label="Linha">{row.rowNumber}</td>
            <td data-label="Situação"><span className={`production-result ${row.status === "OK" ? "ok" : row.status === "ERRO" ? "below" : "none"}`}>{row.status === "OK" ? "Pronta" : row.status === "ERRO" ? "Erro" : "Igual"}</span></td>
            <td data-label="Data">{row.values.data || "—"}</td><td data-label="Projeto">{row.values.projeto || "—"}</td><td data-label="Funcionário">{row.values.funcionario || "—"}</td>
            <td data-label="Tipo">{row.values.tipo || "—"}</td><td data-label="Produto">{row.values.produto || "—"}</td><td data-label="Qtd" className="num">{row.values.quantidade || "—"}</td>
            <td data-label="Valor" className="num">{row.values.valor || "—"}</td><td data-label="Observações">{row.messages.join(" ") || "—"}</td>
          </tr>)}</tbody>
        </table></div>
        <label className="production-check"><input type="checkbox" checked={allowNegative} onChange={(event) => setAllowNegative(event.target.checked)} /> Lançar mesmo sem saldo no estoque (o saldo da frente fica negativo)</label>
        <button type="button" className="primary" disabled={busy || counts.ok === 0} onClick={confirm}>{busy ? "Importando..." : `Confirmar importação (${counts.ok} linha(s))`}</button>
      </>}
      {result && result.failed.length > 0 && <ul className="production-line-errors">{result.failed.map((item) => <li key={item.rowNumber}>Linha {item.rowNumber}: {item.error}</li>)}</ul>}
      <h3 className="production-section-title">Importações anteriores</h3>
      {!batches ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="table-scroll"><table className="products-table production-table">
        <thead><tr><th>Lote</th><th>Arquivo</th><th className="num">Linhas</th><th>Por</th><th>Em</th><th>Situação</th><th /></tr></thead>
        <tbody>{batches.map((batch) => <tr key={batch.id} className={batch.status === "REVERTED" ? "production-row-muted" : ""}>
          <td data-label="Lote">#{batch.id}</td><td data-label="Arquivo">{batch.fileName}</td><td data-label="Linhas" className="num">{number(batch.rowCount, 0)}</td>
          <td data-label="Por">{batch.userName ?? "—"}</td><td data-label="Em">{brDateTime(batch.createdAt)}</td>
          <td data-label="Situação">{batch.status === "REVERTED" ? `Desfeita em ${brDateTime(batch.revertedAt)}` : "Ativa"}</td>
          <td>{batch.status === "ACTIVE" && <div className="equipment-row-actions"><button type="button" onClick={() => revert(batch)}>Desfazer</button></div>}</td>
        </tr>)}</tbody>
      </table>{batches.length === 0 && <div className="empty-state">Nenhuma importação ainda.</div>}</div>}
    </>}
  </article>;
}
