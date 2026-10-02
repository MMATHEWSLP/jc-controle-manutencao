import { catalogoDoUsuario, podeConsultar, viewDoCatalogo, type ColunaCatalogo, type ViewCatalogo } from "./catalogo";
import type { Profile } from "../auth";

// ---------------------------------------------------------------------------------------------
// consultar_dados: consulta ESTRUTURADA (nunca SQL livre). O modelo manda view, colunas, filtros,
// período, agrupamento, agregações, ordem e limite; aqui tudo é validado contra o catálogo e vira
// um SELECT parametrizado sobre o schema "assistente", com o filtro das frentes do usuário sempre
// aplicado. Funções puras (sem banco) — a execução fica em lib/assistente/db.ts.
// ---------------------------------------------------------------------------------------------
export class ConsultaError extends Error {}

export const OPERADORES = ["=", "!=", ">", ">=", "<", "<=", "contem", "nao_contem", "comeca_com", "em", "nao_em", "vazio", "nao_vazio"] as const;
export type Operador = typeof OPERADORES[number];
export const FUNCOES = ["soma", "contagem", "contagem_distinta", "media", "minimo", "maximo"] as const;
export type Funcao = typeof FUNCOES[number];
export const PERIODOS_DATA = ["dia", "semana", "mes", "ano"] as const;

export const LIMITE_PADRAO = 200;
export const LIMITE_MAXIMO = 1000;

export type UsuarioConsulta = { id: number; profile: Profile; permissions: readonly string[] };
// Frentes: "ALL" = sem restrição; lista = só essas (lista vazia = nenhuma).
export type EscopoFrentes = { ids: number[] | "ALL"; nomes: string[] };

export type Filtro = { campo: string; operador: Operador; valor?: unknown };
export type Agregacao = { funcao: Funcao; campo?: string; nome?: string };
export type Ordem = { campo: string; direcao: "asc" | "desc" };
export type PedidoConsulta = {
  view: string;
  colunas?: string[];
  filtros?: Filtro[];
  periodo?: { de?: string; ate?: string } | "todo";
  agrupar_por?: string[];
  agregacoes?: Agregacao[];
  ordenar_por?: Ordem[];
  limite?: number;
};

export type ColunaSaida = { nome: string; rotulo: string; tipo: ColunaCatalogo["tipo"] | "mes" | "ano" | "semana" };
export type ConsultaMontada = {
  sql: string;
  params: unknown[];
  item: ViewCatalogo;
  colunas: ColunaSaida[];
  limite: number;
  periodo: { de: string; ate: string; padrao: boolean } | null;
  filtrosTexto: string[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const BR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const quote = (identifier: string) => `"${identifier.replace(/"/g, "")}"`;
const ALIAS = /^[a-z][a-z0-9_]{0,40}$/;

export function dataIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const br = text.match(BR);
  const iso = br ? `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}` : text.slice(0, 10);
  if (!ISO.test(iso)) return null;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

// Mês atual (dia 1 até hoje) no fuso de Fortaleza.
export function mesAtual(hoje: string) {
  return { de: `${hoje.slice(0, 8)}01`, ate: hoje };
}

function coluna(item: ViewCatalogo, nome: unknown): ColunaCatalogo {
  const found = typeof nome === "string" ? item.colunas.find((col) => col.nome === nome.trim()) : undefined;
  if (!found) throw new ConsultaError(`Coluna "${String(nome)}" não existe em ${item.view}. Colunas: ${item.colunas.map((col) => col.nome).join(", ")}.`);
  return found;
}

// "mes(data)" → agrupamento por mês da coluna de data.
function grupo(item: ViewCatalogo, raw: unknown) {
  const text = String(raw ?? "").trim();
  const match = text.match(/^(dia|semana|mes|ano)\(([a-z0-9_]+)\)$/);
  if (match) {
    const col = coluna(item, match[2]);
    if (col.tipo !== "data") throw new ConsultaError(`${match[1]}(${col.nome}) só vale para coluna de data.`);
    const unit = match[1] === "dia" ? "day" : match[1] === "semana" ? "week" : match[1] === "mes" ? "month" : "year";
    const alias = `${match[1]}_${col.nome}`;
    const expr = match[1] === "ano" ? `extract(year FROM ${quote(col.nome)})::int` : match[1] === "dia" ? quote(col.nome) : `date_trunc('${unit}', ${quote(col.nome)})::date`;
    return { expr, alias, saida: { nome: alias, rotulo: `${match[1]} de ${col.nome}`, tipo: (match[1] === "dia" ? "data" : match[1]) as ColunaSaida["tipo"] } };
  }
  const col = coluna(item, text);
  return { expr: quote(col.nome), alias: col.nome, saida: { nome: col.nome, rotulo: col.descricao, tipo: col.tipo } };
}

function valorTipado(col: ColunaCatalogo, valor: unknown, params: unknown[]): string {
  if (col.tipo === "numero") {
    const number = typeof valor === "number" ? valor : Number(String(valor ?? "").replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(number)) throw new ConsultaError(`Valor numérico inválido para ${col.nome}: ${String(valor)}.`);
    params.push(number);
    return `$${params.length}::double precision`;
  }
  if (col.tipo === "data") {
    const iso = dataIso(valor);
    if (!iso) throw new ConsultaError(`Data inválida para ${col.nome}: ${String(valor)} (use DD/MM/AAAA).`);
    params.push(iso);
    return `$${params.length}::date`;
  }
  if (col.tipo === "sim_nao") {
    const text = String(valor ?? "").trim().toLowerCase();
    const bool = valor === true || ["true", "sim", "s", "1", "yes"].includes(text) ? true : valor === false || ["false", "nao", "não", "n", "0", "no"].includes(text) ? false : null;
    if (bool === null) throw new ConsultaError(`Use sim ou não em ${col.nome}.`);
    params.push(bool);
    return `$${params.length}::boolean`;
  }
  params.push(String(valor ?? "").slice(0, 200));
  return `assistente.chave($${params.length}::text)`;
}

function condicao(item: ViewCatalogo, filtro: Filtro, params: unknown[]): string {
  const col = coluna(item, filtro.campo);
  const operador = filtro.operador;
  if (!(OPERADORES as readonly string[]).includes(operador)) throw new ConsultaError(`Operador "${String(operador)}" inválido. Use: ${OPERADORES.join(", ")}.`);
  const ref = col.tipo === "texto" ? `assistente.chave(${quote(col.nome)})` : quote(col.nome);
  if (operador === "vazio") return col.tipo === "texto" ? `coalesce(${quote(col.nome)}, '') = ''` : `${quote(col.nome)} IS NULL`;
  if (operador === "nao_vazio") return col.tipo === "texto" ? `coalesce(${quote(col.nome)}, '') <> ''` : `${quote(col.nome)} IS NOT NULL`;
  if (operador === "em" || operador === "nao_em") {
    const list = Array.isArray(filtro.valor) ? filtro.valor : String(filtro.valor ?? "").split(/[;|]/);
    const values = list.map((value) => (typeof value === "string" ? value.trim() : value)).filter((value) => value !== "" && value !== null && value !== undefined).slice(0, 50);
    if (!values.length) throw new ConsultaError(`Informe a lista de valores de ${col.nome}.`);
    const placeholders = values.map((value) => valorTipado(col, value, params)).join(", ");
    return operador === "em" ? `${ref} IN (${placeholders})` : `(${ref} IS NULL OR ${ref} NOT IN (${placeholders}))`;
  }
  if (operador === "contem" || operador === "nao_contem" || operador === "comeca_com") {
    if (col.tipo !== "texto") throw new ConsultaError(`"${operador}" só vale para texto (${col.nome} é ${col.tipo}).`);
    const text = String(filtro.valor ?? "").slice(0, 200).replace(/[\\%_]/g, (char) => `\\${char}`);
    params.push(operador === "comeca_com" ? `${text}%` : `%${text}%`);
    const like = `${ref} LIKE assistente.chave($${params.length}::text)`;
    return operador === "nao_contem" ? `(${quote(col.nome)} IS NULL OR NOT (${like}))` : like;
  }
  if (filtro.valor === undefined || filtro.valor === null || filtro.valor === "") throw new ConsultaError(`Informe o valor do filtro em ${col.nome}.`);
  if (col.tipo === "sim_nao" && !["=", "!="].includes(operador)) throw new ConsultaError(`Em ${col.nome} use = ou !=.`);
  const value = valorTipado(col, filtro.valor, params);
  return operador === "!=" ? `(${ref} IS NULL OR ${ref} <> ${value})` : `${ref} ${operador} ${value}`;
}

function aggregate(item: ViewCatalogo, agregacao: Agregacao) {
  const funcao = agregacao.funcao;
  if (!(FUNCOES as readonly string[]).includes(funcao)) throw new ConsultaError(`Agregação "${String(funcao)}" inválida. Use: ${FUNCOES.join(", ")}.`);
  const col = agregacao.campo ? coluna(item, agregacao.campo) : null;
  if (!col && funcao !== "contagem") throw new ConsultaError(`Informe o campo de ${funcao}.`);
  if ((funcao === "soma" || funcao === "media") && col?.tipo !== "numero") throw new ConsultaError(`${funcao} só vale para coluna numérica (${col?.nome}).`);
  const alias = agregacao.nome && ALIAS.test(agregacao.nome) ? agregacao.nome : `${funcao}${col ? `_${col.nome}` : ""}`;
  const ref = col ? quote(col.nome) : "*";
  const expr = funcao === "soma" ? `sum(${ref})` : funcao === "media" ? `avg(${ref})` : funcao === "minimo" ? `min(${ref})` : funcao === "maximo" ? `max(${ref})`
    : funcao === "contagem_distinta" ? `count(DISTINCT ${ref})` : `count(${ref})`;
  const tipo: ColunaSaida["tipo"] = funcao === "minimo" || funcao === "maximo" ? (col?.tipo ?? "numero") : "numero";
  return { expr, alias, saida: { nome: alias, rotulo: `${funcao}${col ? ` de ${col.nome}` : ""}`, tipo } };
}

// Monta o SELECT. Lança ConsultaError (mensagem para o modelo corrigir) se algo não bate com o catálogo.
export function montarConsulta(pedido: PedidoConsulta, user: UsuarioConsulta, frentes: EscopoFrentes, hoje: string): ConsultaMontada {
  const item = viewDoCatalogo(String(pedido?.view ?? "").trim());
  if (!item) throw new ConsultaError(`View "${String(pedido?.view)}" não existe. Use catalogo_sistema para ver as views disponíveis: ${catalogoDoUsuario(user).map((view) => view.view).join(", ")}.`);
  if (!podeConsultar(item, user)) throw new ConsultaError(`Seu usuário não tem acesso a ${item.titulo}.`);

  const params: unknown[] = [];
  const where: string[] = [];
  const filtrosTexto: string[] = [];

  // Frentes (sempre). Linha sem frente só aparece para quem enxerga todas.
  if (item.escopo === "frente" && frentes.ids !== "ALL") {
    params.push(frentes.ids);
    const cols = item.colunasFrente ?? ["frente_id"];
    where.push(`(${cols.map((col) => `${quote(col)} = ANY($${params.length}::int[])`).join(" OR ")})`);
  }
  if (item.escopo === "usuario" && user.profile !== "ADMIN") {
    params.push(user.id);
    where.push(`(${(item.colunasUsuario ?? []).map((col) => `${quote(col)} = $${params.length}::int`).join(" OR ") || "false"})`);
    filtrosTexto.push("só tarefas em que você é responsável ou criador");
  }

  // Período.
  let periodo: ConsultaMontada["periodo"] = null;
  if (item.colunaData && pedido.periodo !== "todo") {
    const pedidoPeriodo = typeof pedido.periodo === "object" && pedido.periodo ? pedido.periodo : null;
    const filtraData = (pedido.filtros ?? []).some((filtro) => filtro?.campo === item.colunaData);
    if (pedidoPeriodo && (pedidoPeriodo.de || pedidoPeriodo.ate)) {
      const de = pedidoPeriodo.de ? dataIso(pedidoPeriodo.de) : "2000-01-01";
      const ate = pedidoPeriodo.ate ? dataIso(pedidoPeriodo.ate) : hoje;
      if (!de || !ate) throw new ConsultaError("Período inválido: use datas DD/MM/AAAA.");
      periodo = de <= ate ? { de, ate, padrao: false } : { de: ate, ate: de, padrao: false };
    } else if (item.eventos && !filtraData) {
      periodo = { ...mesAtual(hoje), padrao: true };
    }
    if (periodo) {
      params.push(periodo.de, periodo.ate);
      where.push(`${quote(item.colunaData)} BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
    }
  }

  for (const filtro of (pedido.filtros ?? []).slice(0, 20)) {
    where.push(condicao(item, filtro, params));
    const valor = Array.isArray(filtro.valor) ? filtro.valor.join(", ") : filtro.valor === undefined ? "" : String(filtro.valor);
    filtrosTexto.push(`${filtro.campo} ${filtro.operador}${valor ? ` ${valor}` : ""}`);
  }

  // SELECT: agrupado ou linhas.
  const grupos = (pedido.agrupar_por ?? []).slice(0, 4).map((raw) => grupo(item, raw));
  const aggs = (pedido.agregacoes ?? []).slice(0, 8).map((agregacao) => aggregate(item, agregacao));
  const agrupado = grupos.length > 0 || aggs.length > 0;
  let select: string[]; let colunas: ColunaSaida[]; let groupBy = "";
  if (agrupado) {
    const finalAggs = aggs.length ? aggs : [aggregate(item, { funcao: "contagem" })];
    select = [...grupos.map((g) => `${g.expr} AS ${quote(g.alias)}`), ...finalAggs.map((a) => `${a.expr} AS ${quote(a.alias)}`)];
    colunas = [...grupos.map((g) => g.saida), ...finalAggs.map((a) => a.saida)];
    if (grupos.length) groupBy = ` GROUP BY ${grupos.map((_, index) => index + 1).join(", ")}`;
  } else {
    const nomes = pedido.colunas?.length ? pedido.colunas.slice(0, 30) : [...item.padrao];
    const cols = [...new Set(nomes.map((nome) => coluna(item, nome).nome))];
    select = cols.map((nome) => quote(nome));
    colunas = cols.map((nome) => { const col = coluna(item, nome); return { nome, rotulo: col.descricao, tipo: col.tipo }; });
  }

  // Ordem: só colunas do resultado.
  const permitidas = new Set(colunas.map((col) => col.nome));
  const ordens = (pedido.ordenar_por ?? []).slice(0, 4).map((ordem) => {
    if (!permitidas.has(ordem?.campo)) throw new ConsultaError(`Ordenação por "${String(ordem?.campo)}" inválida: use uma coluna do resultado (${[...permitidas].join(", ")}).`);
    return `${quote(ordem.campo)} ${ordem.direcao === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  });
  if (!ordens.length) {
    if (!agrupado && item.colunaData && permitidas.has(item.colunaData)) ordens.push(`${quote(item.colunaData)} DESC NULLS LAST`);
    else if (agrupado && grupos.length) ordens.push(...grupos.map((_, index) => `${index + 1}`));
  }

  const limite = Math.min(Math.max(Math.floor(Number(pedido.limite) || LIMITE_PADRAO), 1), LIMITE_MAXIMO);
  const sql = `SELECT ${select.join(", ")} FROM assistente.${quote(item.view)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${groupBy}${ordens.length ? ` ORDER BY ${ordens.join(", ")}` : ""} LIMIT ${limite + 1}`;
  return { sql, params, item, colunas, limite, periodo, filtrosTexto };
}

// Valor para o modelo ler (formato brasileiro). A tabela da tela recebe os valores crus.
export function formatarValor(valor: unknown, tipo: ColunaSaida["tipo"]): string | null {
  if (valor === null || valor === undefined) return null;
  if (tipo === "sim_nao") return valor ? "sim" : "não";
  if (tipo === "data" || tipo === "mes" || tipo === "semana") {
    const text = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
    const [y, m, dd] = text.split("-");
    if (!y || !m) return text;
    return tipo === "mes" ? `${m}/${y}` : `${dd}/${m}/${y}`;
  }
  if (tipo === "numero" || tipo === "ano") {
    const number = Number(valor);
    if (!Number.isFinite(number)) return String(valor);
    return tipo === "ano" ? String(number) : number.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }
  return String(valor);
}

export function valorCru(valor: unknown, tipo: ColunaSaida["tipo"]): string | number | boolean | null {
  if (valor === null || valor === undefined) return null;
  if (tipo === "numero" || tipo === "ano") { const number = Number(valor); return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : null; }
  if (tipo === "sim_nao") return Boolean(valor);
  if (tipo === "data" || tipo === "mes" || tipo === "semana") return valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
  return String(valor);
}
