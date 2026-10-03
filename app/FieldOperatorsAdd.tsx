"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { pinObvio } from "../lib/operadores-regras";

// ---------------------------------------------------------------------------
// Funcionários de campo (Controle Diário): "＋ Adicionar" (da lista de funcionários ou manual),
// tela final com os códigos (uma única vez, com cartões para imprimir), "Vincular" e
// "Importar funcionários" (planilha, só ADMIN). Mesmas rotas/tabela/hash da tela.
// ---------------------------------------------------------------------------
type Front = { id: number; name: string };
type Candidato = { id: number; name: string; jobTitle: string; registration: string | null; status: string; serviceFrontId: number; front: string; operates: boolean; acessoSemVinculo: { id: number; name: string } | null };
export type AcessoCriado = { userId: number; employeeId: number | null; name: string; jobTitle: string; registration: string | null; fronts: string[]; code: string };
type Parecidos = {
  funcionarios: Array<{ id: number; name: string; jobTitle: string; status: string; front: string; registration: string | null; semelhancaRotulo: string; acessoId: number | null }>;
  acessos: Array<{ id: number; name: string; jobTitle: string | null; active: boolean; vinculado: boolean; semelhancaRotulo: string }>;
};

class ApiProblem extends Error { constructor(message: string, public data: Record<string, unknown>) { super(message); } }
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiProblem(String(data.error ?? "A operação não pôde ser concluída."), data);
  return data as T;
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const key = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");
const STATUS: Record<string, string> = { ATIVO: "Ativo", FOLGA: "De folga", AFASTADO: "Afastado", DEMITIDO: "Demitido" };

// Código de 4 dígitos no navegador (mesma regra do servidor: sem sequências óbvias).
function gerarCodigo(evitar: string[] = []) {
  for (let tentativa = 0; tentativa < 500; tentativa++) {
    const numero = new Uint32Array(1); crypto.getRandomValues(numero);
    const codigo = String(numero[0] % 10_000).padStart(4, "0");
    if (!pinObvio(codigo) && !evitar.includes(codigo)) return codigo;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Modal "＋ Adicionar"
// ---------------------------------------------------------------------------
export function AddFieldOperatorsModal({ fronts, canCreateEmployee, companies, today, close, done }: {
  fronts: Front[]; canCreateEmployee: boolean; companies: string[]; today: string; close: () => void; done: (criados: AcessoCriado[], message: string) => void;
}) {
  const [tab, setTab] = useState<"lista" | "manual">("lista");
  const [preselect, setPreselect] = useState<number | null>(null);
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review field-add-modal">
    <header><div><p>ACESSO DE CAMPO</p><h2>Adicionar funcionários de campo</h2><span>Entram escolhendo o nome e digitando o código; só veem o Controle Diário.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="field-add-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "lista"} className={tab === "lista" ? "active" : ""} onClick={() => setTab("lista")}>Da lista de funcionários</button>
      <button type="button" role="tab" aria-selected={tab === "manual"} className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>Cadastro manual</button>
    </div>
    {tab === "lista"
      ? <FromListTab fronts={fronts} preselect={preselect} close={close} done={done} />
      : <ManualTab fronts={fronts} canCreateEmployee={canCreateEmployee} companies={companies} today={today} close={close} done={done} pickEmployee={(id) => { setPreselect(id); setTab("lista"); }} />}
  </div></div>;
}

type Selecionado = { extraFrontIds: number[]; code: string };

function FromListTab({ fronts, preselect, close, done }: { fronts: Front[]; preselect: number | null; close: () => void; done: (criados: AcessoCriado[], message: string) => void }) {
  const [candidatos, setCandidatos] = useState<Candidato[] | null>(null);
  const [funcoes, setFuncoes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [frontId, setFrontId] = useState("");
  const [funcao, setFuncao] = useState("");
  const [soOperadores, setSoOperadores] = useState(false);
  const [selecionados, setSelecionados] = useState<Map<number, Selecionado>>(new Map());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ candidatos: Candidato[]; funcoes: string[] }>("/api/field-operators/candidates")
      .then((data) => { setCandidatos(data.candidatos); setFuncoes(data.funcoes); if (preselect && data.candidatos.some((row) => row.id === preselect)) setSelecionados(new Map([[preselect, { extraFrontIds: [], code: "" }]])); })
      .catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar."));
  }, [preselect]);
  const visiveis = useMemo(() => {
    const termo = key(query.trim());
    return (candidatos ?? []).filter((row) => (!termo || key(`${row.name} ${row.jobTitle} ${row.registration ?? ""}`).includes(termo))
      && (!frontId || String(row.serviceFrontId) === frontId) && (!funcao || row.jobTitle === funcao) && (!soOperadores || row.operates));
  }, [candidatos, query, frontId, funcao, soOperadores]);
  const selecionaveis = visiveis.filter((row) => !row.acessoSemVinculo);
  const todosMarcados = selecionaveis.length > 0 && selecionaveis.every((row) => selecionados.has(row.id));
  const alternar = (id: number) => setSelecionados((atual) => { const novo = new Map(atual); if (novo.has(id)) novo.delete(id); else novo.set(id, { extraFrontIds: [], code: "" }); return novo; });
  const marcarTodos = () => setSelecionados((atual) => {
    const novo = new Map(atual);
    if (todosMarcados) selecionaveis.forEach((row) => novo.delete(row.id)); else selecionaveis.forEach((row) => { if (!novo.has(row.id)) novo.set(row.id, { extraFrontIds: [], code: "" }); });
    return novo;
  });
  const ajustar = (id: number, valor: Partial<Selecionado>) => setSelecionados((atual) => { const novo = new Map(atual); novo.set(id, { ...novo.get(id)!, ...valor }); return novo; });
  const escolhidos = (candidatos ?? []).filter((row) => selecionados.has(row.id));
  const codigosDigitados = escolhidos.map((row) => selecionados.get(row.id)!.code).filter(Boolean);
  const problemaCodigo = (codigo: string) => (!codigo ? null : !/^\d{4,8}$/.test(codigo) ? "4 a 8 números" : codigo.length === 4 && pinObvio(codigo) ? "fácil de adivinhar" : codigosDigitados.filter((item) => item === codigo).length > 1 ? "repetido" : null);
  const temProblema = escolhidos.some((row) => problemaCodigo(selecionados.get(row.id)!.code));

  async function salvar() {
    setBusy(true); setError("");
    try {
      const items = escolhidos.map((row) => ({ employeeId: row.id, ...selecionados.get(row.id)!, code: selecionados.get(row.id)!.code || null }));
      const result = await api<{ criados: AcessoCriado[]; message: string }>("/api/field-operators/from-employees", jsonInit("POST", { items }));
      done(result.criados, result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }

  return <>
    <div className="fleet-modal-body">
      <div className="field-add-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, função ou matrícula..." autoFocus /></label>
        <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
        <label>Função<select value={funcao} onChange={(event) => setFuncao(event.target.value)}><option value="">Todas</option>{funcoes.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="field-add-check"><input type="checkbox" checked={soOperadores} onChange={(event) => setSoOperadores(event.target.checked)} /> Só motoristas e operadores</label>
      </div>
      <p className="table-sub">Funcionários do menu FUNCIONÁRIOS que não estão demitidos e ainda não têm acesso de campo. Nome, função, matrícula e frente vêm do cadastro.</p>
      {error && <div className="fleet-form-error">! {error}</div>}
      {!candidatos && !error ? <div className="page-loading"><span /><p>Carregando funcionários...</p></div> : <div className="field-add-list">
        <label className="field-add-all"><input type="checkbox" checked={todosMarcados} onChange={marcarTodos} disabled={!selecionaveis.length} /> Selecionar todos do filtro ({selecionaveis.length})</label>
        {visiveis.slice(0, 400).map((row) => (
          <label key={row.id} className={`field-add-row ${selecionados.has(row.id) ? "selected" : ""} ${row.acessoSemVinculo ? "disabled" : ""}`}>
            <input type="checkbox" checked={selecionados.has(row.id)} disabled={Boolean(row.acessoSemVinculo)} onChange={() => alternar(row.id)} />
            <span><strong>{row.name}</strong><small>{row.jobTitle}{row.registration ? ` · mat. ${row.registration}` : ""} · {row.front}{row.status !== "ATIVO" ? ` · ${STATUS[row.status] ?? row.status}` : ""}</small>
              {row.acessoSemVinculo && <small className="field-warning">Já existe o acesso “{row.acessoSemVinculo.name}” sem vínculo: use “Vincular” no card dele.</small>}</span>
            {row.operates && <span className="status-pill blue">Opera equipamento</span>}
          </label>
        ))}
        {visiveis.length === 0 && <div className="empty-state">Ninguém encontrado para os filtros.</div>}
      </div>}
      {escolhidos.length > 0 && <section className="field-add-selected">
        <h3>{escolhidos.length} selecionado(s)</h3>
        {escolhidos.map((row) => {
          const item = selecionados.get(row.id)!;
          const problema = problemaCodigo(item.code);
          return <div key={row.id} className="field-add-selected-row">
            <div><strong>{row.name}</strong><small>{row.jobTitle} · {row.front}{row.registration ? ` · mat. ${row.registration}` : ""}</small></div>
            {fronts.some((front) => front.id !== row.serviceFrontId) ? <details className="field-add-extra">
              <summary>{item.extraFrontIds.length ? `+ ${fronts.filter((front) => item.extraFrontIds.includes(front.id)).map((front) => front.name).join(", ")}` : "+ Frentes adicionais"}</summary>
              <div>{fronts.filter((front) => front.id !== row.serviceFrontId).map((front) => (
                <label key={front.id}><input type="checkbox" checked={item.extraFrontIds.includes(front.id)} onChange={() => ajustar(row.id, { extraFrontIds: item.extraFrontIds.includes(front.id) ? item.extraFrontIds.filter((id) => id !== front.id) : [...item.extraFrontIds, front.id] })} /> {front.name}</label>
              ))}</div>
            </details> : <span />}
            <label className="field-add-code">Código<input inputMode="numeric" maxLength={8} value={item.code} placeholder="automático" onChange={(event) => ajustar(row.id, { code: event.target.value.replace(/\D/g, "").slice(0, 8) })} />{problema && <small className="field-warning">{problema}</small>}</label>
          </div>;
        })}
      </section>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button type="button" className="primary" disabled={busy || !escolhidos.length || temProblema} onClick={salvar}>{busy ? "SALVANDO..." : `CRIAR ${escolhidos.length || ""} ACESSO(S)`}</button></footer>
  </>;
}

function ManualTab({ fronts, canCreateEmployee, companies, today, close, done, pickEmployee }: {
  fronts: Front[]; canCreateEmployee: boolean; companies: string[]; today: string; close: () => void; done: (criados: AcessoCriado[], message: string) => void; pickEmployee: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [frontIds, setFrontIds] = useState<number[]>(fronts.length === 1 ? [fronts[0].id] : []);
  const [code, setCode] = useState("");
  const [criarFuncionario, setCriarFuncionario] = useState(canCreateEmployee);
  const [company, setCompany] = useState(companies[0] ?? "");
  const [admissionDate, setAdmissionDate] = useState(today);
  const [parecidos, setParecidos] = useState<Parecidos | null>(null);
  const [conferidoPara, setConferidoPara] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nomeLimpo = name.trim().replace(/\s+/g, " ").toUpperCase();
  useEffect(() => {
    if (nomeLimpo.length < 5) { setParecidos(null); return; }
    const timer = window.setTimeout(() => {
      api<Parecidos>(`/api/field-operators/similar?nome=${encodeURIComponent(nomeLimpo)}`).then((data) => { setParecidos(data); setConferidoPara(nomeLimpo); }).catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [nomeLimpo]);
  const problemaCodigo = !code ? null : !/^\d{4,8}$/.test(code) ? "O código deve ter de 4 a 8 números." : code.length === 4 && pinObvio(code) ? "Código fácil de adivinhar: escolha outro." : null;
  const avisos = parecidos && conferidoPara === nomeLimpo ? parecidos : null;
  const temAvisos = Boolean(avisos && (avisos.funcionarios.length || avisos.acessos.length));

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ criados: AcessoCriado[]; message: string }>("/api/field-operators/manual", jsonInit("POST", {
        name, jobTitle, serviceFrontIds: frontIds, code: code || null, criarFuncionario, company, admissionDate, confirmarParecidos: conferidoPara === nomeLimpo,
      }));
      done(result.criados, result.message);
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.data.parecidos) { setParecidos(problem.data.parecidos as Parecidos); setConferidoPara(nomeLimpo); setError("Confira os nomes parecidos abaixo e salve de novo se for outra pessoa."); }
      else setError(problem instanceof Error ? problem.message : "Não foi possível salvar.");
    } finally { setBusy(false); }
  }
  const toggleFront = (id: number) => setFrontIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  return <form onSubmit={submit}>
    <div className="fleet-modal-body">
      <p className="table-sub">Para quem não está na lista de funcionários (ex.: temporário ou prestador).</p>
      <div className="fleet-form-grid">
        <label className="daily-field span-2">Nome completo *<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: JOÃO DA SILVA" autoCapitalize="characters" autoFocus /></label>
        <label className="daily-field">Função *<input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} placeholder="Ex.: Operador de Baldeio" /></label>
        <label className="daily-field">Código de acesso
          <span className="field-code-row"><input inputMode="numeric" maxLength={8} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="vazio = automático" />
            <button type="button" className="secondary" onClick={() => setCode(gerarCodigo())}>Gerar</button></span>
          {problemaCodigo && <small className="field-warning">{problemaCodigo}</small>}</label>
      </div>
      {temAvisos && <div className="field-similar">
        {avisos!.funcionarios.map((row) => <div key={`f${row.id}`}>
          <span>Já existe <b>{row.name}</b> na lista de funcionários ({row.jobTitle} · {row.front}{row.status !== "ATIVO" ? ` · ${STATUS[row.status] ?? row.status}` : ""}) — {row.semelhancaRotulo.toLowerCase()}.</span>
          {row.acessoId ? <small>Já tem acesso de campo.</small> : row.status === "DEMITIDO" ? <small>Demitido no cadastro.</small> : <button type="button" className="secondary" onClick={() => pickEmployee(row.id)}>Usar esse cadastro</button>}
        </div>)}
        {avisos!.acessos.map((row) => <div key={`a${row.id}`}><span>Já existe o acesso de campo <b>{row.name}</b> ({row.jobTitle ?? "—"}{row.active ? "" : " · inativo"}) — {row.semelhancaRotulo.toLowerCase()}.</span><small>Se for a mesma pessoa, use “Editar / trocar código” no card.</small></div>)}
      </div>}
      <fieldset className="daily-front-checks"><legend>Frentes em que trabalha *</legend>{fronts.map((front) => <label key={front.id}><input type="checkbox" checked={frontIds.includes(front.id)} onChange={() => toggleFront(front.id)} />{front.name}</label>)}</fieldset>
      <label className="field-add-check field-create-employee"><input type="checkbox" checked={criarFuncionario} disabled={!canCreateEmployee} onChange={(event) => setCriarFuncionario(event.target.checked)} /> Criar também no cadastro de Funcionários
        <small>{canCreateEmployee ? "Recomendado: assim ninguém fica solto só no acesso de campo. Desmarcado, o card mostra “Sem cadastro de funcionário”." : "Seu usuário não cadastra funcionários: o acesso fica sem cadastro de funcionário (dá para vincular depois)."}</small></label>
      {criarFuncionario && <div className="fleet-form-grid">
        <label className="daily-field">Empresa *<select value={company} onChange={(event) => setCompany(event.target.value)}>{companies.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="daily-field">Admissão *<input type="date" value={admissionDate} max={today} onChange={(event) => setAdmissionDate(event.target.value)} /></label>
        <p className="table-sub span-2">A frente do cadastro de Funcionários é a primeira marcada acima.</p>
      </div>}
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy || Boolean(problemaCodigo)}>{busy ? "SALVANDO..." : temAvisos ? "É OUTRA PESSOA — SALVAR" : "SALVAR"}</button></footer>
  </form>;
}

// ---------------------------------------------------------------------------
// Tela final: nome + código uma única vez, "Imprimir cartões" e "Copiar".
// ---------------------------------------------------------------------------
const escapar = (texto: string) => texto.replace(/[&<>"']/g, (letra) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[letra]!));

export function imprimirCartoes(criados: AcessoCriado[]) {
  const janela = window.open("", "_blank", "width=900,height=700");
  if (!janela) { window.alert("Libere as janelas pop-up para imprimir os cartões."); return; }
  const cartoes = criados.map((item) => `<div class="cartao"><p class="marca">JC · ACESSO DE CAMPO</p><h2>${escapar(item.name)}</h2><p>${escapar(item.jobTitle)}</p><p>${escapar(item.fronts.join(", "))}</p>
    <div class="codigo"><span>Código</span><strong>${escapar(item.code)}</strong></div><p class="site">Entre em <b>jcsistema.online</b> → “Sou operador” → seu nome → código.</p></div>`).join("");
  janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Cartões de acesso de campo</title><style>
    *{box-sizing:border-box}body{margin:0;padding:10mm;font-family:Arial,Helvetica,sans-serif;color:#10222e}
    .grade{display:grid;grid-template-columns:1fr 1fr;gap:6mm}.cartao{border:1.5px dashed #6b7c88;border-radius:4mm;padding:5mm 6mm;break-inside:avoid;min-height:58mm}
    .marca{margin:0;font-size:9pt;letter-spacing:.08em;color:#177d5f;font-weight:700}h2{margin:2mm 0 1mm;font-size:13pt}p{margin:0 0 1mm;font-size:10pt}
    .codigo{display:flex;align-items:baseline;gap:4mm;margin:3mm 0;padding:2mm 4mm;background:#eef6f2;border-radius:3mm}.codigo span{font-size:9pt;color:#4a6272}.codigo strong{font-size:26pt;letter-spacing:.25em}
    .site{font-size:9pt;color:#4a6272}@media print{body{padding:6mm}}</style></head><body><div class="grade">${cartoes}</div><script>window.onload=function(){window.print()}</script></body></html>`);
  janela.document.close();
}

export function CodesResult({ criados, close }: { criados: AcessoCriado[]; close: () => void }) {
  const [copiado, setCopiado] = useState(false);
  const texto = criados.map((item) => `${item.name} — ${item.jobTitle} — ${item.fronts.join(", ")} — código ${item.code}`).join("\n");
  async function copiar() {
    try { await navigator.clipboard.writeText(`${texto}\n\nEntrar em jcsistema.online → "Sou operador" → nome → código.`); setCopiado(true); }
    catch { window.prompt("Copie os códigos:", texto); }
  }
  const fechar = () => { if (window.confirm("Os códigos não aparecem de novo. Já imprimiu ou anotou para entregar?")) close(); };
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review field-codes">
    <header><div><p>ACESSO DE CAMPO</p><h2>{criados.length === 1 ? "Acesso criado" : `${criados.length} acessos criados`}</h2><span>Os códigos aparecem só agora. Entregue a cada um pessoalmente.</span></div><button type="button" onClick={fechar} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="field-codes-list">{criados.map((item) => <div key={item.userId}><span><strong>{item.name}</strong><small>{item.jobTitle} · {item.fronts.join(", ")}{item.employeeId ? "" : " · sem cadastro de funcionário"}</small></span><b>{item.code}</b></div>)}</div>
    </div>
    <footer><button type="button" onClick={() => imprimirCartoes(criados)}>Imprimir cartões</button><button type="button" onClick={copiar}>{copiado ? "Copiado ✓" : "Copiar"}</button><button type="button" className="primary" onClick={fechar}>JÁ ENTREGUEI / FECHAR</button></footer>
  </div></div>;
}

// ---------------------------------------------------------------------------
// "Vincular" um acesso sem cadastro de funcionário
// ---------------------------------------------------------------------------
export function LinkModal({ item, close, saved }: { item: { id: number; name: string }; close: () => void; saved: (message: string) => Promise<void> }) {
  const [candidatos, setCandidatos] = useState<Candidato[] | null>(null);
  const [parecidos, setParecidos] = useState<Parecidos["funcionarios"]>([]);
  const [query, setQuery] = useState("");
  const [escolhido, setEscolhido] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([api<{ candidatos: Candidato[] }>("/api/field-operators/candidates"), api<Parecidos>(`/api/field-operators/similar?nome=${encodeURIComponent(item.name)}&ignorar=${item.id}`)])
      .then(([lista, similares]) => { setCandidatos(lista.candidatos); setParecidos(similares.funcionarios.filter((row) => !row.acessoId && row.status !== "DEMITIDO")); })
      .catch((problem) => setError(problem instanceof Error ? problem.message : "Falha ao carregar."));
  }, [item.id, item.name]);
  const termo = key(query.trim());
  const sugeridos = new Set(parecidos.map((row) => row.id));
  const lista = (candidatos ?? []).filter((row) => (termo ? key(`${row.name} ${row.jobTitle} ${row.registration ?? ""}`).includes(termo) : sugeridos.has(row.id))).slice(0, 60);
  async function vincular() {
    setBusy(true); setError("");
    try { await saved((await api<{ message: string }>(`/api/field-operators/${item.id}/link`, jsonInit("POST", { employeeId: escolhido }))).message); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível vincular."); }
    finally { setBusy(false); }
  }
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review">
    <header><div><p>VINCULAR AO CADASTRO</p><h2>{item.name}</h2><span>Nome e função passam a vir do cadastro de Funcionários; o código continua o mesmo.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar funcionário por nome, função ou matrícula..." autoFocus /></label>
      {!termo && <p className="table-sub">{parecidos.length ? "Sugestões com nome parecido:" : "Nenhum nome parecido sem acesso: busque pelo nome."}</p>}
      {error && <div className="fleet-form-error">! {error}</div>}
      {!candidatos && !error ? <div className="page-loading"><span /><p>Carregando...</p></div> : <div className="field-add-list">
        {lista.map((row) => <label key={row.id} className={`field-add-row ${escolhido === row.id ? "selected" : ""}`}><input type="radio" name="vinculo" checked={escolhido === row.id} onChange={() => setEscolhido(row.id)} />
          <span><strong>{row.name}</strong><small>{row.jobTitle}{row.registration ? ` · mat. ${row.registration}` : ""} · {row.front}{parecidos.find((p) => p.id === row.id) ? ` · ${parecidos.find((p) => p.id === row.id)!.semelhancaRotulo.toLowerCase()}` : ""}</small></span></label>)}
        {termo && lista.length === 0 && <div className="empty-state">Ninguém sem acesso com esse nome.</div>}
      </div>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button type="button" className="primary" disabled={busy || !escolhido} onClick={vincular}>{busy ? "VINCULANDO..." : "VINCULAR"}</button></footer>
  </div></div>;
}

// ---------------------------------------------------------------------------
// "Importar funcionários" (só ADMIN): prévia sem gravar → decisões → Confirmar importação.
// ---------------------------------------------------------------------------
type Opcao = { tipo: "FUNCIONARIO" | "ACESSO"; id: number; nome: string; detalhe: string; semelhanca: string };
type LinhaPrevia = {
  linha: number; nome: string; nomeOriginal: string; funcao: string; frentes: string[]; equipamentos: string; lancamentos: string; conferir: string;
  grupo: "CRIAR" | "MANTER" | "PARECIDO" | "ERRO"; paraConferir: boolean; aprovado: boolean;
  vinculo: { id: number; nome: string; funcao: string; semelhanca: string } | null; manterAcesso: { id: number; nome: string; frentesNovas: string[] } | null; opcoes: Opcao[]; erro: string | null;
};
type Previa = { linhas: LinhaPrevia[]; resumo: { total: number; criar: number; manter: number; parecidos: number; conferir: number; erros: number; porFrente: Array<{ nome: string; total: number }> } };
type Resultado = { criados: Array<{ nome: string; vinculado: boolean }>; mantidos: Array<{ nome: string; frentesAdicionadas: string[] }>; ignorados: Array<{ linha: number; nome: string; motivo: string }> };
type Decisao = { acao: "VINCULAR" | "MANTER" | "NOVO" | "IGNORAR"; id?: number };

export function ImportFieldOperatorsModal({ close, finished }: { close: () => void; finished: (message: string) => Promise<void> }) {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [nomes, setNomes] = useState<Record<string, string>>({});
  const [aprovados, setAprovados] = useState<number[]>([]);
  const [decisoes, setDecisoes] = useState<Record<number, Decisao>>({});
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ajustes = () => JSON.stringify({ nomes, aprovados, decisoes: Object.entries(decisoes).map(([linha, decisao]) => ({ linha: Number(linha), ...decisao })) });
  async function enviar(confirmar: boolean) {
    if (!arquivo) return;
    setBusy(true); setError("");
    const form = new FormData(); form.set("arquivo", arquivo); form.set("ajustes", ajustes()); if (confirmar) form.set("confirmar", "1");
    try {
      if (confirmar) { const data = await api<{ resultado: Resultado; message: string }>("/api/field-operators/import", { method: "POST", body: form }); setResultado(data.resultado); await finished(data.message); }
      else setPrevia(await api<Previa>("/api/field-operators/import", { method: "POST", body: form }));
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível importar."); }
    finally { setBusy(false); }
  }
  const linhas = previa?.linhas ?? [];
  const conferir = linhas.filter((row) => row.paraConferir);
  const parecidos = linhas.filter((row) => !row.paraConferir && row.grupo === "PARECIDO");
  const criar = linhas.filter((row) => !row.paraConferir && row.grupo === "CRIAR");
  const manter = linhas.filter((row) => !row.paraConferir && row.grupo === "MANTER");
  const erros = linhas.filter((row) => !row.paraConferir && row.grupo === "ERRO");
  const semDecisao = linhas.filter((row) => row.grupo === "PARECIDO" && (!row.paraConferir || aprovados.includes(row.linha)) && !decisoes[row.linha]).length;
  const nomesMudaram = Object.entries(nomes).some(([linha, nome]) => linhas.find((row) => String(row.linha) === linha)?.nome !== nome.trim().toUpperCase());
  const opcoesDe = (row: LinhaPrevia) => <div className="field-import-options">
    {row.opcoes.map((opcao) => { const acao = opcao.tipo === "FUNCIONARIO" ? "VINCULAR" : "MANTER"; return <label key={`${opcao.tipo}${opcao.id}`}><input type="radio" name={`d${row.linha}`} checked={decisoes[row.linha]?.acao === acao && decisoes[row.linha]?.id === opcao.id} onChange={() => setDecisoes({ ...decisoes, [row.linha]: { acao, id: opcao.id } })} />
      {opcao.tipo === "FUNCIONARIO" ? "É " : "Já está na tela: "}<b>{opcao.nome}</b> <small>({opcao.detalhe} · {opcao.semelhanca.toLowerCase()})</small></label>; })}
    <label><input type="radio" name={`d${row.linha}`} checked={decisoes[row.linha]?.acao === "NOVO"} onChange={() => setDecisoes({ ...decisoes, [row.linha]: { acao: "NOVO" } })} /> Outra pessoa: criar sem vínculo</label>
    <label><input type="radio" name={`d${row.linha}`} checked={decisoes[row.linha]?.acao === "IGNORAR"} onChange={() => setDecisoes({ ...decisoes, [row.linha]: { acao: "IGNORAR" } })} /> Ignorar esta linha</label>
  </div>;
  const detalhe = (row: LinhaPrevia) => <small>{row.frentes.join(", ") || "—"}{row.funcao ? ` · ${row.funcao}` : ""}{row.equipamentos ? ` · ${row.equipamentos}` : ""}{row.lancamentos ? ` · ${row.lancamentos} lanç.` : ""}</small>;

  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review field-import-modal">
    <header><div><p>SÓ ADMIN</p><h2>Importar funcionários de campo</h2><span>Planilha com a aba “Funcionários de campo”: Nome | Função sugerida | Frente principal | Outras frentes | Equipamentos | Lançamentos | PIN | Conferir.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      {resultado ? <div className="field-import-result">
        <p className="stock-summary"><b>{resultado.criados.length}</b> criado(s) · <b>{resultado.mantidos.length}</b> mantido(s) · <b>{resultado.ignorados.length}</b> ignorado(s). Os códigos são os PINs da planilha (não aparecem aqui).</p>
        {resultado.mantidos.length > 0 && <><h3>Mantidos (código não mudou)</h3><ul>{resultado.mantidos.map((row) => <li key={row.nome}>{row.nome}{row.frentesAdicionadas.length ? ` — frentes completadas: ${row.frentesAdicionadas.join(", ")}` : " — nada a completar"}</li>)}</ul></>}
        {resultado.ignorados.length > 0 && <><h3>Ignorados</h3><ul>{resultado.ignorados.map((row) => <li key={row.linha}>Linha {row.linha}: {row.nome} — {row.motivo}</li>)}</ul></>}
        {resultado.criados.length > 0 && <><h3>Criados</h3><ul className="field-import-columns">{resultado.criados.map((row) => <li key={row.nome}>{row.nome}{row.vinculado ? "" : " (sem cadastro de funcionário)"}</li>)}</ul></>}
      </div> : <>
        <div className="field-import-file"><input type="file" accept=".xlsx" onChange={(event) => { setArquivo(event.target.files?.[0] ?? null); setPrevia(null); setNomes({}); setAprovados([]); setDecisoes({}); }} />
          <button type="button" className="secondary" disabled={!arquivo || busy} onClick={() => enviar(false)}>{busy && !previa ? "Lendo..." : previa ? "Atualizar prévia" : "Ver prévia (não grava)"}</button></div>
        {error && <div className="fleet-form-error">! {error}</div>}
        {previa && <>
          <div className="field-import-summary">
            <span><b>{previa.resumo.total}</b> na planilha</span><span><b>{previa.resumo.criar}</b> serão criados</span><span><b>{previa.resumo.manter}</b> já existem</span>
            <span><b>{previa.resumo.parecidos}</b> parecidos</span><span><b>{previa.resumo.conferir}</b> para conferir</span><span><b>{previa.resumo.erros}</b> com erro</span>
          </div>
          <p className="table-sub">Por frente: {previa.resumo.porFrente.map((row) => `${row.nome} ${row.total}`).join(" · ") || "—"}</p>
          {conferir.length > 0 && <section><h3>Para conferir ({conferir.length}) — só entram as aprovadas</h3>{conferir.map((row) => <div key={row.linha} className="field-import-row conferir">
            <label className="field-add-check"><input type="checkbox" checked={aprovados.includes(row.linha)} onChange={() => setAprovados(aprovados.includes(row.linha) ? aprovados.filter((linha) => linha !== row.linha) : [...aprovados, row.linha])} /> Aprovar</label>
            <div><input value={nomes[row.linha] ?? row.nome} onChange={(event) => setNomes({ ...nomes, [row.linha]: event.target.value })} aria-label="Nome" /><small className="field-warning">Linha {row.linha}: {row.conferir}</small>{detalhe(row)}
              {row.grupo === "ERRO" && <small className="field-warning">{row.erro}</small>}
              {row.grupo === "MANTER" && <small>Já está na tela como {row.manterAcesso!.nome}: só completa frentes.</small>}
              {row.vinculo && <small>Vincula a {row.vinculo.nome} ({row.vinculo.funcao}).</small>}
              {row.grupo === "PARECIDO" && aprovados.includes(row.linha) && opcoesDe(row)}</div>
          </div>)}{nomesMudaram && <p className="field-warning">Nome alterado: clique em “Atualizar prévia” para conferir de novo.</p>}</section>}
          {parecidos.length > 0 && <section><h3>Nomes parecidos — decida ({parecidos.length})</h3>{parecidos.map((row) => <div key={row.linha} className="field-import-row"><div><strong>{row.nome}</strong>{detalhe(row)}{opcoesDe(row)}</div></div>)}</section>}
          {manter.length > 0 && <section><h3>Já estão na tela ({manter.length}) — não duplica e não troca o código</h3>{manter.map((row) => <div key={row.linha} className="field-import-row"><div><strong>{row.manterAcesso!.nome}</strong><small>{row.manterAcesso!.frentesNovas.length ? `Completar frentes: ${row.manterAcesso!.frentesNovas.join(", ")}` : "Nada a completar"}</small></div></div>)}</section>}
          {criar.length > 0 && <section><h3>Serão criados ({criar.length})</h3><div className="field-import-columns">{criar.map((row) => <div key={row.linha} className="field-import-row"><div><strong>{row.vinculo?.nome ?? row.nome}</strong>{detalhe(row)}
            <small>{row.vinculo ? `Cadastro de Funcionários: ${row.vinculo.funcao}${row.vinculo.nome !== row.nome ? ` · planilha: ${row.nome} (${row.vinculo.semelhanca.toLowerCase()})` : ""}` : "Sem cadastro de funcionário (usa a função sugerida)"}</small></div></div>)}</div></section>}
          {erros.length > 0 && <section><h3>Com erro — serão ignorados ({erros.length})</h3>{erros.map((row) => <div key={row.linha} className="field-import-row"><div><strong>Linha {row.linha}: {row.nome}</strong><small className="field-warning">{row.erro}</small></div></div>)}</section>}
        </>}
      </>}
    </div>
    <footer>{resultado ? <button type="button" className="primary" onClick={close}>FECHAR</button> : <>
      <button type="button" onClick={close} disabled={busy}>Cancelar</button>
      <button type="button" className="primary" disabled={!previa || busy || semDecisao > 0 || nomesMudaram} onClick={() => { if (window.confirm("Gravar a importação? Os acessos ficam ativos com o PIN da planilha.")) void enviar(true); }}>
        {busy && previa ? "IMPORTANDO..." : semDecisao ? `DECIDA ${semDecisao} PARECIDO(S)` : "CONFIRMAR IMPORTAÇÃO"}</button></>}</footer>
  </div></div>;
}
