"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import FuelImportModal from "./FuelImportView";
import { navegarParaTela, type NavegacaoAssistente } from "../lib/assistente-nav";

// ---------------------------------------------------------------------------
// Assistente JC: botão flutuante com painel de conversa. Perguntas de consulta (combustível,
// consumo, saldos, trocas, histórico) e "Enviar ficha": fotos de ficha de abastecimento viram a
// tabela do modelo de importação, editável, com as dúvidas em amarelo. Nada é gravado aqui: a
// gravação só acontece em "Confirmar importação" (Combustível → Importar planilha).
// ---------------------------------------------------------------------------
const COLUMNS = ["data", "tipo", "frente", "origem", "combustivel", "equipamento", "empresa", "litros", "leitura", "tanque_cheio", "motorista", "observacao"] as const;
type Column = typeof COLUMNS[number];
type Values = Record<Column, string>;
type FichaRow = { values: Values; doubts: Partial<Record<Column, string[]>> };
type Ficha = { header: { data: string; frente: string; combustivel: string; origem: string }; rows: FichaRow[]; warnings: string[] };
type Usage = { messagesLeft: number; photosLeft: number; dailyMessages: number; dailyPhotos: number };
type Status = { allowed: boolean; configured?: boolean; usage?: Usage; canReadSheet?: boolean; canImport?: boolean; error?: string; dbMode?: "DEDICADA" | "PRINCIPAL_SOMENTE_LEITURA" };
// Tabela de uma consulta (consultar_dados): valores crus (datas AAAA-MM-DD, números) para a tela e o Excel.
type Tabela = {
  titulo: string; view: string; tela: string | null; periodo: string | null; frentes: string; filtros: string[]; limitado: boolean;
  colunas: Array<{ nome: string; rotulo: string; tipo: string }>; linhas: Array<Array<string | number | boolean | null>>; navegacao: NavegacaoAssistente | null;
};
type NewMessage = { role: "user" | "assistant"; text: string; error?: boolean; tabelas?: Tabela[] } | { role: "ficha"; ficha: Ficha; photos: number };
type Message = NewMessage & { id: number };

const WIDTH: Record<Column, number> = { data: 88, tipo: 118, frente: 90, origem: 110, combustivel: 90, equipamento: 92, empresa: 96, litros: 62, leitura: 76, tanque_cheio: 52, motorista: 124, observacao: 190 };
const LABEL: Record<Column, string> = { data: "data", tipo: "tipo", frente: "frente", origem: "origem", combustivel: "combustível", equipamento: "equipamento", empresa: "empresa", litros: "litros", leitura: "leitura", tanque_cheio: "tanque cheio", motorista: "motorista", observacao: "observação" };
const SUGGESTIONS = ["Saldo de diesel por frente", "Produtos que mais saíram no mês", "Equipamentos com troca vencida", "Consumo dos caminhões terceirizados", "O que saiu da minha frente esta semana?", "Produtos com estoque zerado ou baixo"];
const MAX_SIDE = 2000;

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível responder agora."));
  return data as T;
}

// Reduz a foto (lado maior até 2000 px, JPEG) antes de enviar: foto de celular chega a 8 MB.
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000 && file.type === "image/jpeg") return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

// Texto do assistente: parágrafos, listas com "- " e **negrito** (sem HTML).
function RichText({ text }: { text: string }) {
  const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, index) => (part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>); list = []; };
  let table: string[][] = [];
  const flushTable = () => {
    const rows = table.filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
    if (rows.length) blocks.push(<div key={`t${blocks.length}`} className="assistant-table-wrap"><table className="assistant-table"><thead><tr>{rows[0].map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.slice(1).map((cells, row) => <tr key={row}>{cells.map((cell, index) => <td key={index}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
    table = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^\|.*\|$/.test(line)) { flush(); table.push(line.slice(1, -1).split("|").map((cell) => cell.trim())); continue; }
    flushTable();
    if (/^[-•*]\s+/.test(line)) { list.push(line.replace(/^[-•*]\s+/, "")); continue; }
    flush();
    if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""))}</p>);
  }
  flush(); flushTable();
  return <>{blocks}</>;
}

const LABEL_COLUNA = (nome: string) => nome.replace(/_/g, " ").replace(/^(\w)/, (letter) => letter.toUpperCase());
function celula(valor: string | number | boolean | null, tipo: string) {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  if ((tipo === "data" || tipo === "semana" || tipo === "mes") && typeof valor === "string") {
    const [y, m, d] = valor.split("-");
    return tipo === "mes" ? `${m}/${y}` : `${d}/${m}/${y}`;
  }
  if (typeof valor === "number") return tipo === "ano" ? String(valor) : valor.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return String(valor);
}

// Tabela da consulta, com "Baixar Excel" e "Ver no sistema".
function TabelaCard({ tabela, flash, fechar }: { tabela: Tabela; flash: (message: string) => void; fechar: () => void }) {
  const [todas, setTodas] = useState(false);
  const [busy, setBusy] = useState(false);
  const visiveis = todas ? tabela.linhas : tabela.linhas.slice(0, 12);
  async function baixar() {
    setBusy(true);
    try {
      const response = await fetch("/api/assistente/excel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tabela) });
      if (!response.ok) throw new Error(String(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível gerar a planilha."));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${tabela.titulo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "-")}.xlsx`;
      link.click(); URL.revokeObjectURL(link.href);
    } catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível gerar a planilha."); }
    finally { setBusy(false); }
  }
  const meta = [tabela.periodo, tabela.frentes && tabela.frentes !== "—" ? `Frentes: ${tabela.frentes}` : "", tabela.filtros.length ? `Filtros: ${tabela.filtros.join("; ")}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="assistant-data">
      <div className="assistant-data-head"><strong>{tabela.titulo}</strong><span>{tabela.linhas.length.toLocaleString("pt-BR")} linha(s){tabela.limitado ? " (cortado)" : ""}</span></div>
      {meta && <small className="assistant-muted">{meta}</small>}
      {tabela.linhas.length > 0 ? <div className="assistant-table-wrap"><table className="assistant-table">
        <thead><tr>{tabela.colunas.map((coluna) => <th key={coluna.nome} title={coluna.rotulo}>{LABEL_COLUNA(coluna.nome)}</th>)}</tr></thead>
        <tbody>{visiveis.map((linha, row) => <tr key={row}>{tabela.colunas.map((coluna, index) => <td key={coluna.nome} className={coluna.tipo === "numero" ? "num" : ""}>{celula(linha[index], coluna.tipo)}</td>)}</tr>)}</tbody>
      </table></div> : <p className="assistant-muted">Nenhum registro.</p>}
      <div className="assistant-data-actions">
        {tabela.linhas.length > 12 && <button type="button" onClick={() => setTodas(!todas)}>{todas ? "Mostrar menos" : `Mostrar todas (${tabela.linhas.length.toLocaleString("pt-BR")})`}</button>}
        {tabela.linhas.length > 0 && <button type="button" onClick={baixar} disabled={busy}>{busy ? "Gerando..." : "⇩ Baixar Excel"}</button>}
        {tabela.navegacao && <button type="button" className="primary" onClick={() => { navegarParaTela(tabela.navegacao!); fechar(); }}>Ver no sistema →</button>}
      </div>
    </div>
  );
}

const fichaFileName = (ficha: Ficha) => `ficha-abastecimento-${(ficha.header.data || "sem-data").replace(/\//g, "-")}.xlsx`;

function FichaCard({ ficha, photos, canImport, onChange, openImport, flash }: { ficha: Ficha; photos: number; canImport: boolean; onChange: (ficha: Ficha) => void; openImport: (ficha: Ficha) => void; flash: (message: string) => void }) {
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const doubtful = ficha.rows.reduce((sum, row) => sum + Object.keys(row.doubts).length, 0);
  const edit = (index: number, column: Column, value: string) => {
    onChange({ ...ficha, rows: ficha.rows.map((row, position) => (position === index ? { ...row, values: { ...row.values, [column]: value } } : row)) });
    if (ficha.rows[index].doubts[column]) setReviewed((current) => new Set(current).add(`${index}:${column}`));
  };
  const remove = (index: number) => {
    if (!window.confirm(`Tirar a linha ${index + 1} da planilha?`)) return;
    onChange({ ...ficha, rows: ficha.rows.filter((_, position) => position !== index) });
    setReviewed(new Set());
  };
  async function download() {
    setBusy(true);
    try {
      const response = await fetch("/api/fuel/import/modelo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: fichaFileName(ficha), rows: ficha.rows.map((row, index) => ({ rowNumber: index + 2, values: row.values })) }) });
      if (!response.ok) throw new Error(String(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Não foi possível gerar a planilha."));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob()); link.download = fichaFileName(ficha); link.click(); URL.revokeObjectURL(link.href);
    } catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível gerar a planilha."); }
    finally { setBusy(false); }
  }
  return (
    <div className="assistant-ficha">
      <div className="assistant-ficha-head">
        <strong>Ficha lida · {ficha.rows.length} linha(s) · {photos} foto(s)</strong>
        <span>{[ficha.header.data, ficha.header.frente, ficha.header.combustivel].filter(Boolean).join(" · ") || "Cabeçalho não identificado"}</span>
      </div>
      {ficha.warnings.length > 0 && <ul className="assistant-ficha-warnings">{ficha.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {ficha.rows.length === 0 ? <p className="assistant-muted">Nenhuma linha de abastecimento encontrada nas fotos.</p> : <>
        <p className="assistant-muted">{doubtful ? <>Células em <mark>amarelo</mark> têm dúvida de leitura: confira com a foto e corrija aqui antes de baixar.</> : "Nenhuma dúvida de leitura. Confira mesmo assim antes de importar."}</p>
        <div className="assistant-ficha-table">
          <table>
            <thead><tr><th>#</th>{COLUMNS.map((column) => <th key={column}>{LABEL[column]}</th>)}<th /></tr></thead>
            <tbody>{ficha.rows.map((row, index) => <tr key={index}>
              <td>{index + 1}</td>
              {COLUMNS.map((column) => {
                const reasons = row.doubts[column];
                const state = reasons ? (reviewed.has(`${index}:${column}`) ? "checked" : "doubt") : "";
                return <td key={column} className={state} title={reasons?.join(" · ")}>
                  <input value={row.values[column]} style={{ width: WIDTH[column] }} onChange={(event) => edit(index, column, event.target.value)} aria-label={`${LABEL[column]} da linha ${index + 1}`} />
                </td>;
              })}
              <td><button type="button" className="assistant-row-remove" onClick={() => remove(index)} aria-label={`Tirar a linha ${index + 1}`}>✕</button></td>
            </tr>)}</tbody>
          </table>
        </div>
        {doubtful > 0 && <ul className="assistant-ficha-doubts">{ficha.rows.flatMap((row, index) => Object.entries(row.doubts).map(([column, reasons]) => (
          <li key={`${index}-${column}`} className={reviewed.has(`${index}:${column}`) ? "checked" : ""}><b>Linha {index + 1} · {LABEL[column as Column]}:</b> {(reasons ?? []).join("; ")}{reviewed.has(`${index}:${column}`) ? " — corrigido" : ""}</li>
        )))}</ul>}
        <div className="assistant-ficha-actions">
          <button type="button" onClick={download} disabled={busy}>{busy ? "Gerando..." : "⇩ Baixar planilha"}</button>
          {canImport && <button type="button" className="primary" onClick={() => openImport(ficha)}>Abrir na importação →</button>}
        </div>
        <small className="assistant-muted">Nada foi gravado. Os lançamentos só entram no sistema em &quot;Confirmar importação&quot;.</small>
      </>}
    </div>
  );
}

export default function AssistantWidget() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"" | "chat" | "ficha">("");
  const [importing, setImporting] = useState<Ficha | null>(null);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => { api<Status>("/api/assistente").then(setStatus).catch(() => setStatus({ allowed: false })); }, []);
  useEffect(() => { listEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);

  if (!status?.allowed) return null;
  const usage = status.usage;
  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 3500); };
  const push = (message: NewMessage) => setMessages((current) => [...current, { ...message, id: nextId.current++ }]);
  const updateUsage = (change: Partial<Usage>) => setStatus((current) => (current?.usage ? { ...current, usage: { ...current.usage, ...change } } : current));

  async function ask(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    const history = messages.flatMap((message) => (message.role === "user" || (message.role === "assistant" && !message.error) ? [{ role: message.role, text: message.text }] : [])).slice(-10);
    push({ role: "user", text: clean });
    setQuestion(""); setBusy("chat");
    try {
      const data = await api<{ answer: string; remaining: number; tabelas?: Tabela[] }>("/api/assistente", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: clean, history }) });
      push({ role: "assistant", text: data.answer, tabelas: data.tabelas });
      if (data.tabelas?.length) setWide(true);
      updateUsage({ messagesLeft: data.remaining });
    } catch (problem) { push({ role: "assistant", text: problem instanceof Error ? problem.message : "Não foi possível responder agora.", error: true }); }
    finally { setBusy(""); }
  }

  async function sendFicha(files: FileList | null) {
    if (!files?.length || busy) return;
    const list = [...files].slice(0, 6);
    push({ role: "user", text: `📷 Enviei ${list.length} foto(s) de ficha de abastecimento.` });
    setBusy("ficha");
    try {
      const form = new FormData();
      for (const file of await Promise.all(list.map(shrink))) form.append("fotos", file, file.name);
      const data = await api<Ficha & { remainingPhotos: number }>("/api/assistente/ficha", { method: "POST", body: form });
      push({ role: "ficha", ficha: { header: data.header, rows: data.rows, warnings: data.warnings }, photos: list.length });
      updateUsage({ photosLeft: data.remainingPhotos });
      setWide(true);
    } catch (problem) { push({ role: "assistant", text: problem instanceof Error ? problem.message : "Não foi possível ler a ficha.", error: true }); }
    finally { setBusy(""); if (fileInput.current) fileInput.current.value = ""; }
  }

  const setFicha = (id: number, ficha: Ficha) => setMessages((current) => current.map((message) => (message.id === id && message.role === "ficha" ? { ...message, ficha } : message)));

  return (
    <>
      {!open && <button type="button" className="assistant-fab" onClick={() => setOpen(true)} aria-label="Abrir o Assistente JC"><span>✦</span>Assistente JC</button>}
      {open && <section className={`assistant-panel ${wide ? "wide" : ""}`} aria-label="Assistente JC">
        <header>
          <div><strong>✦ Assistente JC</strong><small>{usage ? `${usage.messagesLeft} pergunta(s) · ${usage.photosLeft} foto(s) restantes hoje` : "Consultas do sistema"}</small></div>
          <button type="button" onClick={() => setWide(!wide)} title={wide ? "Reduzir" : "Ampliar"} aria-label={wide ? "Reduzir o painel" : "Ampliar o painel"}>{wide ? "⤡" : "⤢"}</button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar o assistente">×</button>
        </header>
        <div className="assistant-messages">
          {!status.configured && <div className="assistant-msg assistant error"><p>O Assistente JC ainda não foi configurado no servidor (falta a chave ANTHROPIC_API_KEY). Avise o administrador.</p></div>}
          {messages.length === 0 && status.configured && <div className="assistant-intro">
            <p>Pergunte sobre qualquer parte do sistema: combustível, estoque e movimentação de produtos, frota, trocas e O.S., compras, funcionários e tarefas — ou &quot;como faço&quot; algo. Eu só consulto: não registro nem altero nada.</p>
            <div>{SUGGESTIONS.map((suggestion) => <button type="button" key={suggestion} onClick={() => ask(suggestion)}>{suggestion}</button>)}</div>
            {status.dbMode === "PRINCIPAL_SOMENTE_LEITURA" && <p className="assistant-muted">Administrador: a conexão própria do assistente (ASSISTANT_DATABASE_URL, usuário assistente_leitura) ainda não foi cadastrada; as consultas usam a conexão principal em modo somente leitura.</p>}
            {status.canReadSheet && <p className="assistant-muted">Use <b>📷 Enviar ficha</b> para transformar fotos da ficha de abastecimento na planilha de importação.</p>}
          </div>}
          {messages.map((message) => message.role === "ficha"
            ? <FichaCard key={message.id} ficha={message.ficha} photos={message.photos} canImport={Boolean(status.canImport)} onChange={(ficha) => setFicha(message.id, ficha)} openImport={setImporting} flash={flash} />
            : <div key={message.id} className={`assistant-msg ${message.role} ${message.error ? "error" : ""}`}>{message.role === "assistant" ? <RichText text={message.text} /> : <p>{message.text}</p>}
              {message.role === "assistant" && message.tabelas?.map((tabela, index) => <TabelaCard key={index} tabela={tabela} flash={flash} fechar={() => setOpen(false)} />)}</div>)}
          {busy && <div className="assistant-msg assistant thinking"><span /><span /><span /><small>{busy === "ficha" ? "Lendo a ficha... pode levar até 1 minuto." : "Consultando o sistema..."}</small></div>}
          <div ref={listEnd} />
        </div>
        <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); void ask(question); }}>
          {status.canReadSheet && <>
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => void sendFicha(event.target.files)} />
            <button type="button" className="assistant-photo" disabled={Boolean(busy) || !status.configured} onClick={() => fileInput.current?.click()} title="Enviar fotos da ficha de abastecimento">📷 Enviar ficha</button>
          </>}
          <textarea value={question} rows={1} maxLength={1500} placeholder="Pergunte algo..." disabled={!status.configured}
            onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }} />
          <button type="submit" className="primary" disabled={Boolean(busy) || !question.trim() || !status.configured}>Enviar</button>
        </form>
        {notice && <div className="assistant-notice">{notice}</div>}
      </section>}
      {importing && <FuelImportModal
        initialRows={importing.rows.map((row, index) => ({ rowNumber: index + 2, values: row.values }))} initialFileName={fichaFileName(importing)}
        close={() => setImporting(null)} flash={flash}
        imported={async (message) => { flash(message); window.dispatchEvent(new CustomEvent("jc:fuel-changed")); }} />}
    </>
  );
}
