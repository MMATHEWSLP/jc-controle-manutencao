"use client";
import { useState } from "react";
import type { ListaPendentes, PendenteVisivel } from "../lib/assistente/pendentes";
import { STATUS_ROTULO, type ItemCombustivel, type ItemProduto } from "../lib/assistente/pendentes-regras";

// ---------------------------------------------------------------------------
// "Lançamentos pendentes" no topo do painel do Assistente JC. A lista fica no banco (por usuário),
// então sobrevive a recarregar a página e a trocar de aparelho. Editar/remover mexe só na lista;
// a gravação no sistema só acontece em "Lançar tudo" → "Confirmar" (rota /api/assistente/pendentes/lancar).
// ---------------------------------------------------------------------------
type Resultado = { lancados: Array<{ id: number; descricao: string; mensagem: string }>; falharam: Array<{ id: number; descricao: string; erro: string }>; bloqueados: Array<{ id: number; descricao: string; motivo: string }>; notas: string[]; lista: ListaPendentes };

async function chamar<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { "Content-Type": "application/json" }, ...init });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível atualizar a lista agora."));
  return data as T;
}

const n = (valor: number | null | undefined, casas = 2) => (valor === null || valor === undefined ? "—" : valor.toLocaleString("pt-BR", { maximumFractionDigits: casas }));
const dataBr = (iso: string) => iso.split("-").reverse().join("/");
const CAMPO_ROTULO: Record<string, string> = { produto: "Produto", colaborador: "Colaborador", responsavel: "Motorista", equipamento: "Veículo/equipamento", departamento: "Departamento", terceiro: "Terceiro", combustivel: "Combustível", frente: "Frente", veiculoTerceiro: "Veículo do terceiro", quantidade: "Quantidade", litros: "Litros", leitura: "Leitura", data: "Data" };

function statusDe(item: PendenteVisivel) {
  if (item.avaliacao.incompleto) return { classe: "incompleto", rotulo: "Incompleto" };
  return { classe: item.avaliacao.status.toLowerCase(), rotulo: STATUS_ROTULO[item.avaliacao.status] };
}

// Formulário de edição: campos de texto são localizados no cadastro pelo servidor (como na conversa).
function Editor({ item, frentes, salvar, cancelar }: { item: PendenteVisivel; frentes: ListaPendentes["frentes"]; salvar: (campos: Record<string, unknown>) => Promise<void>; cancelar: () => void }) {
  const dados = item.item;
  const produto = dados.tipo === "SAIDA_PRODUTO" ? (dados as ItemProduto) : null;
  const comb = dados.tipo === "SAIDA_COMBUSTIVEL" ? (dados as ItemCombustivel) : null;
  const inicial: Record<string, string> = {
    frente_id: String(dados.frente?.id ?? ""), data: dados.data, observacao: dados.observacao ?? "",
    ...(produto ? {
      produto: produto.produto ? `TAG ${produto.produto.tag}` : produto.duvidas.produto?.pedido ?? "", quantidade: produto.quantidade !== null ? String(produto.quantidade).replace(".", ",") : "",
      equipamento: produto.equipamento?.prefixo ?? "", colaborador: produto.colaborador?.nome ?? "", departamento: produto.departamento && !produto.departamento.inferido ? produto.departamento.nome : "",
      terceiro: produto.terceiro?.nome ?? "", recebido_por: produto.recebidoPor ?? "",
    } : {}),
    ...(comb ? {
      combustivel: comb.combustivel?.nome ?? "", litros: comb.litros !== null ? String(comb.litros).replace(".", ",") : "", estoque: comb.estoque === "PORTO" ? "Porto" : "Frente",
      equipamento: comb.equipamento?.prefixo ?? comb.veiculo?.placa ?? "", leitura: comb.leitura !== null ? String(comb.leitura).replace(".", ",") : "", motorista: comb.responsavel?.nome ?? "",
      tanque_cheio: comb.tanqueCheio ? "sim" : "nao",
    } : {}),
  };
  const [valores, setValores] = useState(inicial);
  const [busy, setBusy] = useState(false);
  const campo = (nome: string, rotulo: string, extra: { tipo?: string; dica?: string; modo?: "decimal" | "text" } = {}) => (
    <label key={nome}>{rotulo}<input type={extra.tipo ?? "text"} inputMode={extra.modo} value={valores[nome] ?? ""} placeholder={extra.dica} onChange={(event) => setValores({ ...valores, [nome]: event.target.value })} /></label>
  );
  async function enviar() {
    const mudou: Record<string, unknown> = {};
    const limpar: string[] = [];
    for (const [nome, valor] of Object.entries(valores)) {
      if (valor === inicial[nome]) continue;
      if (nome === "frente_id") { mudou.frente_id = Number(valor); continue; }
      if (nome === "tanque_cheio") { mudou.tanque_cheio = valor === "sim"; continue; }
      if (!valor.trim()) { if (["equipamento", "colaborador", "departamento", "terceiro", "recebido_por", "leitura", "motorista", "observacao"].includes(nome)) limpar.push(nome); continue; }
      mudou[nome] = nome === "data" ? dataBr(valor) : valor.trim();
    }
    if (limpar.length) mudou.limpar = limpar;
    if (!Object.keys(mudou).length) { cancelar(); return; }
    setBusy(true);
    try { await salvar(mudou); } finally { setBusy(false); }
  }
  return (
    <div className="assistant-pend-editor">
      <div className="assistant-pend-grid">
        {frentes.length > 1 && <label>Frente<select value={valores.frente_id} onChange={(event) => setValores({ ...valores, frente_id: event.target.value })}><option value="">—</option>{frentes.map((frente) => <option key={frente.id} value={frente.id}>{frente.nome}</option>)}</select></label>}
        {campo("data", "Data", { tipo: "date" })}
        {produto && <>
          {campo("produto", "Produto (TAG ou nome)", { dica: "TAG 11 ou lima redonda" })}
          {campo("quantidade", "Quantidade", { modo: "decimal" })}
          {campo("equipamento", "Equipamento (código/placa)", { dica: "PC-20" })}
          {campo("colaborador", "Colaborador")}
          {campo("departamento", "Departamento")}
          {campo("terceiro", "Terceiro")}
          {valores.terceiro && campo("recebido_por", "Recebido por")}
        </>}
        {comb && <>
          {campo("equipamento", "Veículo (código ou placa)", { dica: "CM-35" })}
          {campo("litros", "Litros", { modo: "decimal" })}
          {campo("leitura", "Leitura (km/h)", { modo: "decimal" })}
          {campo("motorista", "Motorista")}
          {campo("combustivel", "Combustível")}
          <label>Estoque<select value={valores.estoque} onChange={(event) => setValores({ ...valores, estoque: event.target.value })}><option>Frente</option><option>Porto</option></select></label>
          <label>Tanque<select value={valores.tanque_cheio} onChange={(event) => setValores({ ...valores, tanque_cheio: event.target.value })}><option value="sim">Cheio</option><option value="nao">Parcial</option></select></label>
        </>}
        {campo("observacao", "Observação")}
      </div>
      <div className="assistant-pend-actions">
        <button type="button" onClick={cancelar} disabled={busy}>Cancelar</button>
        <button type="button" className="primary" onClick={() => void enviar()} disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
      </div>
    </div>
  );
}

export default function PendentesPainel({ lista, setLista, flash, aberto, setAberto }: {
  lista: ListaPendentes | null; setLista: (lista: ListaPendentes) => void; flash: (mensagem: string) => void; aberto: boolean; setAberto: (aberto: boolean) => void;
}) {
  const [editando, setEditando] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | "lancar" | "limpar" | null>(null);
  const [resumoAberto, setResumoAberto] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  if (!lista || (lista.itens.length === 0 && !resultado)) return null;
  const { resumo } = lista;
  const enviaveis = lista.itens.filter((item) => item.avaliacao.status !== "BLOQUEADO");
  const produtos = enviaveis.filter((item) => item.tipo === "SAIDA_PRODUTO");
  const combustivel = enviaveis.filter((item) => item.tipo === "SAIDA_COMBUSTIVEL");
  const unidades = produtos.reduce((soma, item) => soma + ((item.item as ItemProduto).quantidade ?? 0), 0);
  const litros = combustivel.reduce((soma, item) => soma + ((item.item as ItemCombustivel).litros ?? 0), 0);

  async function acao(id: number | "limpar", executar: () => Promise<{ lista: ListaPendentes }>) {
    setBusy(id);
    try { const data = await executar(); setLista(data.lista); }
    catch (problema) { flash(problema instanceof Error ? problema.message : "Não foi possível atualizar a lista."); }
    finally { setBusy(null); }
  }
  const editar = (id: number, corpo: Record<string, unknown>) => acao(id, () => chamar(`/api/assistente/pendentes/${id}`, { method: "PATCH", body: JSON.stringify(corpo) }));
  const remover = (item: PendenteVisivel) => { if (window.confirm(`Tirar da lista: ${item.descricao}?`)) void acao(item.id, () => chamar(`/api/assistente/pendentes/${item.id}`, { method: "DELETE" })); };
  const limpar = () => { if (window.confirm(`Limpar a lista (${resumo.total} item(ns))? Nada já lançado no sistema é desfeito.`)) void acao("limpar", () => chamar("/api/assistente/pendentes", { method: "DELETE" })); };
  async function confirmar() {
    setBusy("lancar");
    try {
      const data = await chamar<Resultado>("/api/assistente/pendentes/lancar", { method: "POST", body: JSON.stringify({ confirmar: true }) });
      setLista(data.lista); setResultado(data); setResumoAberto(false); setAberto(true);
      if (data.lancados.length) window.dispatchEvent(new CustomEvent("jc:fuel-changed"));
    } catch (problema) { flash(problema instanceof Error ? problema.message : "Não foi possível lançar agora."); }
    finally { setBusy(null); }
  }

  return (
    <section className={`assistant-pend ${aberto ? "open" : ""}`} aria-label="Lançamentos pendentes">
      <button type="button" className="assistant-pend-bar" onClick={() => setAberto(!aberto)} aria-expanded={aberto}>
        <span className="assistant-pend-count">{resumo.total}</span>
        <strong>{resumo.total === 1 ? "1 pendente" : `${resumo.total} pendentes`}</strong>
        <small>{[resumo.prontos ? `${resumo.prontos} pronto(s)` : "", resumo.atencao ? `${resumo.atencao} atenção` : "", resumo.bloqueados ? `${resumo.bloqueados} bloqueado(s)` : ""].filter(Boolean).join(" · ") || "Lançamentos pendentes"}</small>
        <span aria-hidden="true">{aberto ? "▴" : "▾"}</span>
      </button>
      {aberto && <div className="assistant-pend-body">
        {resultado && <div className="assistant-pend-result">
          <strong>{resultado.lancados.length} lançado(s){resultado.falharam.length ? ` · ${resultado.falharam.length} com erro` : ""}{resultado.bloqueados.length ? ` · ${resultado.bloqueados.length} bloqueado(s) não enviado(s)` : ""}</strong>
          {resultado.lancados.length > 0 && <ul>{resultado.lancados.map((item) => <li key={item.id}>✓ {item.descricao} — {item.mensagem}</li>)}</ul>}
          {resultado.falharam.length > 0 && <ul className="erro">{resultado.falharam.map((item) => <li key={item.id}>✕ {item.descricao}: {item.erro}</li>)}</ul>}
          {resultado.notas.length > 0 && <ul>{resultado.notas.map((nota, index) => <li key={index}>{nota}</li>)}</ul>}
          <button type="button" onClick={() => setResultado(null)}>Fechar</button>
        </div>}
        {lista.itens.length > 0 && <ol className="assistant-pend-list">
          {lista.itens.map((item) => {
            const status = statusDe(item);
            // perguntas = uma por dúvida (na ordem de item.duvidas) + o que falta; dúvida com opções vira botões.
            const entradas = Object.entries(item.item.duvidas);
            const duvidas = entradas.filter(([, duvida]) => duvida.opcoes.length);
            const textos = [...entradas.flatMap(([, duvida], index) => (duvida.opcoes.length ? [] : [item.avaliacao.perguntas[index]])), ...item.avaliacao.perguntas.slice(entradas.length)].filter(Boolean);
            return <li key={item.id} className={`assistant-pend-item ${status.classe}`}>
              <div className="assistant-pend-head">
                <span className={`assistant-pend-status ${status.classe}`}>{status.rotulo}</span>
                <small>{item.tipoRotulo}</small>
                <span className="assistant-pend-tools">
                  <button type="button" onClick={() => setEditando(editando === item.id ? null : item.id)} disabled={busy !== null} aria-label={`Editar ${item.descricao}`}>✎</button>
                  <button type="button" onClick={() => remover(item)} disabled={busy !== null} aria-label={`Remover ${item.descricao}`}>✕</button>
                </span>
              </div>
              <p className="assistant-pend-desc">{item.descricao}</p>
              <small className="assistant-muted">{[item.item.frente?.nome ?? "frente a definir", dataBr(item.item.data), item.item.tipo === "SAIDA_COMBUSTIVEL" ? `${(item.item as ItemCombustivel).estoque === "PORTO" ? "Porto" : "Frente"}` : null, item.viaVoz ? "🎤 por voz" : null].filter(Boolean).join(" · ")}</small>
              {item.avaliacao.bloqueios.length > 0 && <ul className="assistant-pend-msgs bloqueio">{item.avaliacao.bloqueios.map((texto, index) => <li key={index}>{texto}</li>)}</ul>}
              {item.avaliacao.avisos.length > 0 && <ul className="assistant-pend-msgs aviso">{item.avaliacao.avisos.map((texto, index) => <li key={index}>{texto}</li>)}</ul>}
              {duvidas.map(([campo, duvida]) => <div key={campo} className="assistant-pend-choice">
                <small>{CAMPO_ROTULO[campo] ?? campo}{duvida.pedido ? ` “${duvida.pedido}”` : ""}: {duvida.motivo}</small>
                <div>{duvida.opcoes.map((opcao) => <button type="button" key={opcao.id} disabled={busy !== null} onClick={() => void editar(item.id, { escolha: { campo, id: opcao.id } })}>{opcao.rotulo}</button>)}</div>
              </div>)}
              {textos.length > 0 && <ul className="assistant-pend-msgs pergunta">{textos.map((texto, index) => <li key={index}>{texto}</li>)}</ul>}
              {editando === item.id && <Editor item={item} frentes={lista.frentes} cancelar={() => setEditando(null)} salvar={async (campos) => { await editar(item.id, campos); setEditando(null); }} />}
            </li>;
          })}
        </ol>}
        {lista.itens.length > 0 && !resumoAberto && <div className="assistant-pend-footer">
          <button type="button" onClick={limpar} disabled={busy !== null}>Limpar lista</button>
          {lista.podeLancar
            ? <button type="button" className="primary" onClick={() => setResumoAberto(true)} disabled={busy !== null || enviaveis.length === 0} title={enviaveis.length ? "" : "Todos os itens estão bloqueados"}>Lançar tudo ({enviaveis.length})</button>
            : <small className="assistant-muted">Só ADMIN e GESTOR lançam. Peça a um gestor para conferir e lançar.</small>}
        </div>}
        {resumoAberto && <div className="assistant-pend-confirm" role="dialog" aria-label="Confirmar lançamentos">
          <strong>Confirmar {enviaveis.length} lançamento(s)?</strong>
          <ul>
            {produtos.length > 0 && <li>{produtos.length} saída(s) de produto · {n(unidades)} unidade(s)</li>}
            {combustivel.length > 0 && <li>{combustivel.length} saída(s) de combustível · {n(litros)} L</li>}
            {resumo.atencao > 0 && <li>{resumo.atencao} com atenção (serão lançados; confira os avisos)</li>}
            {resumo.bloqueados > 0 && <li>{resumo.bloqueados} bloqueado(s) ficam na lista e não serão enviados</li>}
          </ul>
          <small className="assistant-muted">Cada item é gravado como no formulário (baixa de estoque, saldo de combustível, leitura e alertas), com origem “Assistente JC” e o seu usuário.</small>
          <div className="assistant-pend-actions">
            <button type="button" onClick={() => setResumoAberto(false)} disabled={busy === "lancar"}>Cancelar</button>
            <button type="button" className="primary" onClick={() => void confirmar()} disabled={busy === "lancar"}>{busy === "lancar" ? "Lançando..." : "Confirmar"}</button>
          </div>
        </div>}
      </div>}
    </section>
  );
}
