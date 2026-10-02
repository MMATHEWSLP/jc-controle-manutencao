"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Acesso dos operadores (perfil de campo ligado ao cadastro de Funcionários):
//  - OperatorPinHost: mostra o PIN UMA vez (admissão, readmissão, mudança de função, redefinição),
//    com "Copiar" e "Imprimir / PDF". O PIN não fica guardado em texto em lugar nenhum.
//  - OperatorsView: Usuários > Operadores (status, último acesso, Redefinir PIN, criação em massa).
//  - JobFunctionsModal: cadastro de Funções com "Opera equipamento".
// ---------------------------------------------------------------------------
export type AcessoOperador = { userId: number; employeeId: number; nome: string; matricula: string | null; funcao: string; frente: string; pin: string; pdfBase64?: string };
export const EVENTO_ACESSO = "jc:acesso-operador";
export function mostrarAcessoOperador(acesso: AcessoOperador) { window.dispatchEvent(new CustomEvent(EVENTO_ACESSO, { detail: acesso })); }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível concluir agora."));
  return data as T;
}

function abrirPdf(base64: string, nome: string, baixar = false) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (baixar) { const link = document.createElement("a"); link.href = url; link.download = nome; link.click(); }
  else window.open(url, "_blank", "noopener");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function OperatorPinHost() {
  const [acesso, setAcesso] = useState<AcessoOperador | null>(null);
  const [copiado, setCopiado] = useState(false);
  useEffect(() => {
    const ouvir = (event: Event) => { setCopiado(false); setAcesso((event as CustomEvent<AcessoOperador>).detail); };
    window.addEventListener(EVENTO_ACESSO, ouvir);
    return () => window.removeEventListener(EVENTO_ACESSO, ouvir);
  }, []);
  if (!acesso) return null;
  const fechar = () => { if (window.confirm("Fechar? O PIN não aparece de novo (só redefinindo em Usuários > Operadores).")) setAcesso(null); };
  async function copiar() {
    try { await navigator.clipboard.writeText(`${acesso!.nome} — PIN ${acesso!.pin} (entrar em "Sou operador", buscar o nome e digitar o PIN)`); setCopiado(true); }
    catch { window.prompt("Copie o PIN:", acesso!.pin); }
  }
  return (
    <div className="modal-backdrop operator-pin-backdrop">
      <section className="modal transfer-modal operator-pin-modal" role="dialog" aria-label="PIN do operador">
        <header><div><p className="eyebrow">ACESSO DE OPERADOR · CONTROLE DIÁRIO</p><h2>{acesso.nome}</h2><span>{acesso.funcao} · {acesso.frente}{acesso.matricula ? ` · matrícula ${acesso.matricula}` : ""}</span></div><button onClick={fechar} aria-label="Fechar">×</button></header>
        <div className="operator-pin-body">
          <small>PIN de acesso</small>
          <strong className="operator-pin-digits" aria-label={`PIN ${acesso.pin.split("").join(" ")}`}>{acesso.pin}</strong>
          <p>Este PIN aparece <b>só agora</b>. Entregue ao operador: ele entra em <b>“Sou operador”</b> na tela de login, busca o nome (ou a matrícula) e digita o PIN. Se perder, redefina em Usuários &gt; Operadores.</p>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={copiar}>{copiado ? "✓ Copiado" : "Copiar"}</button>
          {acesso.pdfBase64 && <button type="button" className="secondary" onClick={() => abrirPdf(acesso.pdfBase64!, `acesso-${acesso.nome}.pdf`)}>Imprimir / PDF</button>}
          <button type="button" className="primary" onClick={fechar}>Já entreguei</button>
        </div>
      </section>
    </div>
  );
}

type Operador = {
  id: number; name: string; jobTitle: string | null; status: string; lastAccessAt: string | null; front: string | null; employeeId: number | null; registration: string | null;
  employeeStatus: string | null; statusAcesso: "ATIVO" | "BLOQUEADO" | "DESATIVADO"; falhas: number;
};
type Previa = {
  total: number; criar: number; reativar: number; vincular: number; porFrente: Array<{ nome: string; total: number }>; porFuncao: Array<{ nome: string; total: number }>;
  linhas: Array<{ employeeId: number; nome: string; matricula: string | null; funcao: string; frente: string; situacao: string; acao: "CRIAR" | "REATIVAR" | "VINCULAR" }>;
  foraPorDados: Array<{ nome: string; funcao: string; motivo: string }>; funcoesQueOperam: string[];
};
const STATUS_PILL: Record<Operador["statusAcesso"], [string, string]> = { ATIVO: ["green", "Ativo"], BLOQUEADO: ["orange", "Bloqueado (15 min)"], DESATIVADO: ["gray", "Desativado"] };
const dataHora = (valor: string | null) => (valor ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(valor)) : "Nunca");
const ACAO_ROTULO = { CRIAR: "Criar", REATIVAR: "Reativar (PIN novo)", VINCULAR: "Vincular (mantém o código atual)" };

export function OperatorsView({ flash, canManage }: { flash: (message: string) => void; canManage: boolean }) {
  const [dados, setDados] = useState<{ operadores: Operador[]; pendentes: number } | null>(null);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [status, setStatus] = useState("");
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [busy, setBusy] = useState<number | "massa" | "previa" | null>(null);
  const [resultado, setResultado] = useState<{ criados: number; reativados: number; vinculados: number; falhas: Array<{ nome: string; erro: string }>; pdfBase64: string | null; comPin: number } | null>(null);
  const carregar = useCallback(async () => {
    setErro("");
    try { setDados(await api("/api/operadores")); } catch (problema) { setErro(problema instanceof Error ? problema.message : "Falha ao carregar."); }
  }, []);
  useEffect(() => { void carregar(); }, [carregar]);
  async function redefinir(item: Operador) {
    if (!window.confirm(`Gerar um PIN novo para ${item.name}? O PIN atual deixa de valer na hora.`)) return;
    setBusy(item.id);
    try { const data = await api<{ message: string; acessoOperador: AcessoOperador }>(`/api/operadores/${item.id}/pin`, { method: "POST", body: "{}" }); mostrarAcessoOperador(data.acessoOperador); await carregar(); }
    catch (problema) { flash(problema instanceof Error ? problema.message : "Não foi possível redefinir."); }
    finally { setBusy(null); }
  }
  async function abrirPrevia() {
    setBusy("previa");
    try { setPrevia(await api<Previa>("/api/operadores/massa")); } catch (problema) { flash(problema instanceof Error ? problema.message : "Falha na prévia."); }
    finally { setBusy(null); }
  }
  async function criarEmMassa() {
    setBusy("massa");
    try {
      const data = await api<NonNullable<typeof resultado>>("/api/operadores/massa", { method: "POST", body: JSON.stringify({ confirmar: true }) });
      setResultado(data); setPrevia(null);
      if (data.pdfBase64) abrirPdf(data.pdfBase64, `acessos-operadores-${new Date().toISOString().slice(0, 10)}.pdf`, true);
      await carregar();
    } catch (problema) { flash(problema instanceof Error ? problema.message : "Não foi possível criar os acessos."); }
    finally { setBusy(null); }
  }
  const termo = busca.trim().toLowerCase();
  const lista = (dados?.operadores ?? []).filter((item) => (!status || item.statusAcesso === status) && (!termo || item.name.toLowerCase().includes(termo) || (item.registration ?? "").includes(termo)));
  return (
    <article className="panel module-panel operators-panel">
      <div className="panel-head"><div><h2>Operadores (acesso ao Controle Diário)</h2><p>Motoristas e operadores entram com nome (ou matrícula) + PIN de 4 números e só veem o Controle Diário da própria frente. O acesso acompanha o cadastro de Funcionários.</p></div>
        {canManage && <button className="primary" disabled={busy !== null} onClick={abrirPrevia}>{busy === "previa" ? "Calculando..." : `Criar acessos pendentes${dados?.pendentes ? ` (${dados.pendentes})` : ""}`}</button>}</div>
      <div className="stock-filters">
        <label className="page-search stock-filter-wide"><span>⌕</span><input value={busca} onChange={(event) => setBusca(event.target.value)} placeholder="Nome ou matrícula..." /></label>
        <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todas</option><option value="ATIVO">Ativo</option><option value="BLOQUEADO">Bloqueado</option><option value="DESATIVADO">Desativado</option></select></label>
      </div>
      {erro && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{erro}</p></div><button onClick={carregar}>Tentar novamente</button></div>}
      {resultado && <div className="operators-result">
        <strong>{resultado.criados} acesso(s) criado(s) · {resultado.reativados} reativado(s) · {resultado.vinculados} vinculado(s){resultado.falhas.length ? ` · ${resultado.falhas.length} com erro` : ""}</strong>
        <p>{resultado.pdfBase64 ? `O PDF "Acessos dos operadores" com ${resultado.comPin} PIN(s) foi baixado. É o único momento em que os PINs aparecem: imprima e entregue.` : "Nenhum PIN novo para imprimir."}</p>
        {resultado.falhas.length > 0 && <ul>{resultado.falhas.map((falha) => <li key={falha.nome}>{falha.nome}: {falha.erro}</li>)}</ul>}
        <div>{resultado.pdfBase64 && <button className="secondary" onClick={() => abrirPdf(resultado.pdfBase64!, "acessos-operadores.pdf")}>Abrir o PDF de novo</button>}<button className="secondary" onClick={() => setResultado(null)}>Fechar</button></div>
      </div>}
      {!dados && !erro ? <div className="page-loading"><span /><p>Carregando operadores...</p></div> : dados && <div className="table-scroll">
        <table className="users-table">
          <thead><tr><th>Nome</th><th>Matrícula</th><th>Função</th><th>Frente</th><th>Status</th><th>Último acesso</th>{canManage && <th>Ações</th>}</tr></thead>
          <tbody>{lista.map((item) => <tr key={item.id}>
            <td><strong>{item.name}</strong>{!item.employeeId && <small className="table-sub">sem vínculo com Funcionários</small>}{item.employeeStatus === "DEMITIDO" && <small className="table-sub">funcionário demitido</small>}</td>
            <td>{item.registration ?? "—"}</td><td>{item.jobTitle ?? "—"}</td><td>{item.front ?? "—"}</td>
            <td><span className={`status-pill ${STATUS_PILL[item.statusAcesso][0]}`}>{STATUS_PILL[item.statusAcesso][1]}</span>{item.falhas > 0 && item.statusAcesso === "ATIVO" && <small className="table-sub">{item.falhas} tentativa(s) errada(s)</small>}</td>
            <td>{dataHora(item.lastAccessAt)}</td>
            {canManage && <td><div className="user-actions">{item.statusAcesso !== "DESATIVADO" && <button disabled={busy !== null} onClick={() => redefinir(item)}>{busy === item.id ? "Gerando..." : "Redefinir PIN"}</button>}</div></td>}
          </tr>)}</tbody>
        </table>
        {lista.length === 0 && <div className="empty-state">Nenhum operador encontrado.</div>}
      </div>}
      {previa && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && busy !== "massa") setPrevia(null); }}>
        <section className="modal equipment-modal operators-preview">
          <header><div><p className="eyebrow">PRÉVIA · NADA FOI CRIADO AINDA</p><h2>Criar acessos de operador</h2><span>Funções que operam equipamento: {previa.funcoesQueOperam.join(", ") || "nenhuma marcada"}.</span></div><button onClick={() => setPrevia(null)} aria-label="Fechar">×</button></header>
          <div className="operators-preview-body">
            <div className="user-summary"><article><strong>{previa.total}</strong><span>Acessos</span></article><article><strong>{previa.criar}</strong><span>Novos</span></article><article><strong>{previa.reativar}</strong><span>Reativar</span></article><article><strong>{previa.vincular}</strong><span>Vincular</span></article><article><strong>{previa.foraPorDados.length}</strong><span>Fora (dados)</span></article></div>
            <div className="operators-preview-grid">
              <div><h3>Por frente</h3><ul>{previa.porFrente.map((item) => <li key={item.nome}><span>{item.nome}</span><b>{item.total}</b></li>)}</ul></div>
              <div><h3>Por função</h3><ul>{previa.porFuncao.map((item) => <li key={item.nome}><span>{item.nome}</span><b>{item.total}</b></li>)}</ul></div>
            </div>
            {previa.foraPorDados.length > 0 && <div className="operators-preview-out"><h3>Ficaram de fora por falta de dados</h3><ul>{previa.foraPorDados.map((item) => <li key={item.nome}>{item.nome} ({item.funcao}): {item.motivo}</li>)}</ul></div>}
            <details><summary>Ver as {previa.linhas.length} pessoas</summary><div className="table-scroll"><table className="users-table"><thead><tr><th>Nome</th><th>Função</th><th>Frente</th><th>Situação</th><th>Ação</th></tr></thead>
              <tbody>{previa.linhas.map((linha) => <tr key={linha.employeeId}><td>{linha.nome}</td><td>{linha.funcao}</td><td>{linha.frente}</td><td>{linha.situacao}</td><td>{ACAO_ROTULO[linha.acao]}</td></tr>)}</tbody></table></div></details>
          </div>
          <div className="modal-footer">
            <span className="fuel-missing">Ao confirmar, o PDF com os PINs é baixado. Os PINs não aparecem de novo.</span>
            <button className="secondary" onClick={() => setPrevia(null)} disabled={busy === "massa"}>Cancelar</button>
            <button className="primary" disabled={busy === "massa" || previa.total === 0} onClick={criarEmMassa}>{busy === "massa" ? "Criando..." : `Confirmar e gerar PDF (${previa.total})`}</button>
          </div>
        </section>
      </div>}
    </article>
  );
}

type Funcao = { id: number; name: string; operatesEquipment: boolean; active: boolean; ativos: number; total: number };

export function JobFunctionsModal({ close, flash }: { close: () => void; flash: (message: string) => void }) {
  const [dados, setDados] = useState<{ functions: Funcao[]; canManage: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [filtro, setFiltro] = useState("");
  const carregar = useCallback(async () => { try { setDados(await api("/api/employees/functions")); } catch (problema) { flash(problema instanceof Error ? problema.message : "Falha ao carregar."); } }, [flash]);
  useEffect(() => { void carregar(); }, [carregar]);
  async function marcar(item: Funcao, valor: boolean) {
    const texto = valor ? `Marcar "${item.name}" como opera equipamento? Os ${item.ativos} funcionário(s) ficam aguardando acesso em Usuários > Operadores (lá é gerado o PDF dos PINs).`
      : `Desmarcar "${item.name}"? Os acessos de operador dessa função são desativados agora.`;
    if (!window.confirm(texto)) return;
    setBusy(item.id);
    try { flash((await api<{ message: string }>(`/api/employees/functions/${item.id}`, { method: "PUT", body: JSON.stringify({ operatesEquipment: valor }) })).message); await carregar(); }
    catch (problema) { flash(problema instanceof Error ? problema.message : "Não foi possível alterar."); }
    finally { setBusy(null); }
  }
  const lista = (dados?.functions ?? []).filter((item) => !filtro || item.name.toLowerCase().includes(filtro.toLowerCase()));
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal equipment-modal employee-modal">
        <header><div><p className="eyebrow">CADASTRO · FUNÇÕES</p><h2>Funções</h2><span>“Opera equipamento” dá ao funcionário (não demitido) o acesso de operador ao Controle Diário.</span></div><button onClick={close} aria-label="Fechar">×</button></header>
        <div className="operators-preview-body">
          <label className="page-search"><span>⌕</span><input value={filtro} onChange={(event) => setFiltro(event.target.value)} placeholder="Buscar função..." /></label>
          {!dados ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="table-scroll"><table className="users-table">
            <thead><tr><th>Função</th><th>Funcionários (não demitidos / total)</th><th>Opera equipamento</th></tr></thead>
            <tbody>{lista.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.ativos} / {item.total}</td>
              <td><label className="job-function-toggle"><input type="checkbox" checked={item.operatesEquipment} disabled={!dados.canManage || busy !== null} onChange={(event) => void marcar(item, event.target.checked)} /> {item.operatesEquipment ? "Sim" : "Não"}</label></td></tr>)}</tbody>
          </table></div>}
        </div>
      </section>
    </div>
  );
}
