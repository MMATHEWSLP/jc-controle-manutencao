import type Anthropic from "@anthropic-ai/sdk";
import { asc } from "drizzle-orm";
import { serviceFronts } from "../../db/schema";
import { frentesVisiveis } from "../access";
import type { AssistantToolContext } from "../assistant-tools";
import { buscarNoManual } from "./ajuda";
import { catalogoDoUsuario, podeConsultar, viewDoCatalogo, type SecaoTela } from "./catalogo";
import { ConsultaError, FUNCOES, formatarValor, LIMITE_MAXIMO, montarConsulta, OPERADORES, valorCru, type ColunaSaida, type EscopoFrentes, type PedidoConsulta } from "./consulta";
import { executarConsulta } from "./db";
import { fuelLocalDay } from "../fuel";
import type { NavegacaoAssistente } from "../assistente-nav";

// ---------------------------------------------------------------------------------------------
// Ferramentas gerais do Assistente JC: catalogo_sistema, consultar_dados e ajuda_sistema. As
// consultas passam pelo catálogo (lib/assistente/catalogo.ts) e rodam só nas views do schema
// "assistente", com o filtro das frentes do usuário. Cada consulta também vira uma tabela para a
// tela (Baixar Excel / Ver no sistema), guardada em ctx.tabelas.
// ---------------------------------------------------------------------------------------------
export type TabelaResposta = {
  titulo: string; view: string; tela: SecaoTela | null; periodo: string | null; frentes: string; filtros: string[];
  colunas: ColunaSaida[]; linhas: Array<Array<string | number | boolean | null>>; limitado: boolean;
  // "Ver no sistema": tela e filtros que ela entende (período, tipo, busca por equipamento/produto).
  navegacao: NavegacaoAssistente | null;
};

const MAX_LINHAS_MODELO = 200;
const importKey = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const brDay = (iso: string) => iso.split("-").reverse().join("/");

export class FerramentaError extends Error {}

// Frentes da consulta: as pedidas (entre as que o usuário enxerga) ou as em exibição no seletor.
export async function escopoDeFrentes(ctx: AssistantToolContext, pedidas: unknown): Promise<EscopoFrentes> {
  const visible = frentesVisiveis(ctx.user);
  const all = await ctx.db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).orderBy(asc(serviceFronts.name));
  const enxerga = visible === "ALL" ? all : all.filter((front) => visible.includes(front.id));
  const nomes = Array.isArray(pedidas) ? pedidas.map(String).filter(Boolean) : typeof pedidas === "string" && pedidas.trim() ? [pedidas] : [];
  if (nomes.length) {
    const escolhidas = nomes.map((nome) => {
      const chave = importKey(nome);
      const found = enxerga.find((front) => importKey(front.name) === chave) ?? enxerga.find((front) => importKey(front.name).includes(chave) || chave.includes(importKey(front.name)));
      if (!found) throw new FerramentaError(`Frente "${nome}" não encontrada entre as frentes do seu usuário (${enxerga.map((front) => front.name).join(", ") || "nenhuma"}).`);
      return found;
    });
    return { ids: [...new Set(escolhidas.map((front) => front.id))], nomes: [...new Set(escolhidas.map((front) => front.name))] };
  }
  const exibidas = ctx.displayed === "ALL" ? enxerga : enxerga.filter((front) => (ctx.displayed as number[]).includes(front.id));
  const lista = exibidas.length ? exibidas : enxerga;
  if (visible === "ALL" && lista.length === all.length) return { ids: "ALL", nomes: ["todas as frentes"] };
  return { ids: lista.map((front) => front.id), nomes: lista.map((front) => front.name) };
}

function catalogoSistema(ctx: AssistantToolContext, input: Record<string, unknown>) {
  const pedida = typeof input.view === "string" ? input.view.trim() : "";
  if (pedida) {
    const item = viewDoCatalogo(pedida);
    if (!item || !podeConsultar(item, ctx.user)) throw new FerramentaError(`View "${pedida}" não existe ou não está liberada para você.`);
    return {
      view: item.view, titulo: item.titulo, modulo: item.modulo, descricao: item.descricao, dica: item.dica,
      escopo: item.escopo === "frente" ? "filtrada pelas frentes do usuário" : item.escopo === "usuario" ? "só registros do usuário (ADMIN vê todos)" : item.escopo === "admin" ? "só ADMIN" : "cadastro único (sem frente)",
      coluna_do_periodo: item.colunaData ?? null, periodo_padrao: item.eventos ? "mês atual quando não informado" : "sem período (retrato atual)",
      colunas_padrao: item.padrao, colunas: item.colunas.map((col) => ({ nome: col.nome, tipo: col.tipo, descricao: col.descricao, ...(col.valores ? { valores: col.valores } : {}) })),
    };
  }
  return {
    views: catalogoDoUsuario(ctx.user).map((item) => ({ view: item.view, titulo: item.titulo, modulo: item.modulo, descricao: item.descricao, periodo: item.colunaData ?? null })),
    operadores: OPERADORES, agregacoes: FUNCOES, agrupamento_por_data: ["dia(coluna)", "semana(coluna)", "mes(coluna)", "ano(coluna)"],
  };
}

const BUSCA = ["equipamento", "codigo", "placa", "placa_terceiro", "tag", "produto", "nome", "empresa"];
const TIPO_COMBUSTIVEL: Record<string, NavegacaoAssistente["tipo"]> = { entrada: "ENTRADA", saida: "SAIDA", "saída": "SAIDA", transferencia: "TRANSFERENCIA", "transferência": "TRANSFERENCIA" };

function navegacaoDa(montada: ReturnType<typeof montarConsulta>, pedido: PedidoConsulta, frentes: EscopoFrentes): NavegacaoAssistente | null {
  if (!montada.item.tela) return null;
  const nav: NavegacaoAssistente = { secao: montada.item.tela };
  if (Array.isArray(frentes.ids) && frentes.ids.length === 1) nav.frenteId = frentes.ids[0];
  if (montada.periodo) { nav.de = montada.periodo.de; nav.ate = montada.periodo.ate; }
  for (const filtro of pedido.filtros ?? []) {
    if (filtro.operador !== "=" && filtro.operador !== "contem") continue;
    const valor = typeof filtro.valor === "string" ? filtro.valor.trim() : "";
    if (!valor) continue;
    if (!nav.busca && BUSCA.includes(filtro.campo)) nav.busca = valor;
    if (filtro.campo === "tipo" && montada.item.view === "v_combustivel_movimentacoes") nav.tipo = TIPO_COMBUSTIVEL[valor.toLowerCase()];
  }
  return nav;
}

async function consultarDados(ctx: AssistantToolContext, input: Record<string, unknown>) {
  const frentes = await escopoDeFrentes(ctx, input.frentes);
  const pedido = input as unknown as PedidoConsulta;
  let montada;
  try { montada = montarConsulta(pedido, ctx.user, frentes, fuelLocalDay()); }
  catch (error) { if (error instanceof ConsultaError) throw new FerramentaError(error.message); throw error; }
  const { rows, limitado } = await executarConsulta(montada);
  const periodo = montada.periodo ? `${brDay(montada.periodo.de)} a ${brDay(montada.periodo.ate)}${montada.periodo.padrao ? " (padrão: mês atual — avise o usuário)" : ""}` : null;
  const frentesTexto = montada.item.escopo === "frente" ? frentes.nomes.join(", ") : montada.item.escopo === "global" ? "cadastro único (todas as frentes)" : "—";
  const tabela: TabelaResposta = {
    titulo: montada.item.titulo, view: montada.item.view, tela: montada.item.tela ?? null, periodo, frentes: frentesTexto, filtros: montada.filtrosTexto,
    colunas: montada.colunas, linhas: rows.map((row) => montada.colunas.map((col) => valorCru(row[col.nome], col.tipo))), limitado,
    navegacao: navegacaoDa(montada, pedido, frentes),
  };
  (ctx.tabelas ??= []).push(tabela);
  const linhasModelo = rows.slice(0, MAX_LINHAS_MODELO).map((row) => Object.fromEntries(montada.colunas.map((col) => [col.nome, formatarValor(row[col.nome], col.tipo)])));
  return {
    view: montada.item.view, titulo: montada.item.titulo, periodo: periodo ?? (montada.item.colunaData ? "todo o histórico" : "retrato atual"), frentes: frentesTexto,
    filtros: montada.filtrosTexto.length ? montada.filtrosTexto : ["nenhum"], linhas_devolvidas: rows.length,
    ...(limitado ? { aviso: `Resultado cortado em ${montada.limite} linhas: refine os filtros ou agrupe.` } : {}),
    ...(rows.length > MAX_LINHAS_MODELO ? { aviso_modelo: `Você recebeu só as ${MAX_LINHAS_MODELO} primeiras linhas; a tabela completa aparece na tela.` } : {}),
    colunas: montada.colunas.map((col) => col.nome), linhas: linhasModelo,
    ...(rows.length === 0 ? { observacao: "Nenhum registro encontrado com esses filtros." } : {}),
  };
}

function ajudaSistema(_ctx: AssistantToolContext, input: Record<string, unknown>) {
  const pergunta = typeof input.pergunta === "string" ? input.pergunta.slice(0, 300) : "";
  const secoes = buscarNoManual(pergunta);
  if (!secoes.length) return { encontrado: false, observacao: "Nada no manual sobre isso." };
  return { encontrado: true, secoes: secoes.map((secao) => ({ tela: secao.titulo, texto: secao.texto })) };
}

const filtroSchema = {
  type: "object",
  properties: {
    campo: { type: "string", description: "Nome da coluna." },
    operador: { type: "string", enum: [...OPERADORES] },
    valor: { description: "Valor (texto, número, data DD/MM/AAAA ou sim/não). Para em/nao_em, uma lista." },
  },
  required: ["campo", "operador"],
};

export const FERRAMENTAS_GERAIS: Anthropic.Tool[] = [
  {
    name: "catalogo_sistema",
    description: "Lista as views (assuntos) que você pode consultar e, com o parâmetro view, as colunas com descrição e os valores possíveis dos campos de situação/tipo. Use antes de consultar_dados quando não souber o nome exato das colunas ou dos valores.",
    input_schema: { type: "object", properties: { view: { type: "string", description: "Nome da view (ex.: v_produtos). Vazio = lista de views." } } },
  },
  {
    name: "consultar_dados",
    description: `Consulta estruturada (não é SQL) em uma view do catálogo. Filtra automaticamente pelas frentes do usuário. Sem período em views de eventos, usa o mês atual (diga isso na resposta); periodo "todo" = sem limite de data. Com agrupar_por/agregacoes devolve totais calculados no banco. Limite padrão 200 linhas (máximo ${LIMITE_MAXIMO}). A tabela do resultado aparece na tela do usuário com "Baixar Excel".`,
    input_schema: {
      type: "object",
      properties: {
        view: { type: "string", description: "View do catálogo (ex.: v_combustivel_movimentacoes)." },
        colunas: { type: "array", items: { type: "string" }, description: "Colunas a devolver (sem agrupamento). Vazio = colunas padrão da view." },
        filtros: { type: "array", items: filtroSchema, description: "Filtros (E). Texto compara sem acento e sem maiúsculas." },
        periodo: { description: 'Objeto {"de":"DD/MM/AAAA","ate":"DD/MM/AAAA"} ou "todo".' },
        frentes: { type: "array", items: { type: "string" }, description: "Nomes de frentes (entre as que o usuário enxerga). Vazio = frentes em exibição na tela." },
        agrupar_por: { type: "array", items: { type: "string" }, description: 'Colunas para agrupar; datas aceitam "dia(data)", "semana(data)", "mes(data)", "ano(data)".' },
        agregacoes: {
          type: "array",
          items: { type: "object", properties: { funcao: { type: "string", enum: [...FUNCOES] }, campo: { type: "string" }, nome: { type: "string", description: "Nome do resultado (letras minúsculas e _)." } }, required: ["funcao"] },
        },
        ordenar_por: { type: "array", items: { type: "object", properties: { campo: { type: "string" }, direcao: { type: "string", enum: ["asc", "desc"] } }, required: ["campo"] } },
        limite: { type: "integer", description: `Máximo de linhas (1 a ${LIMITE_MAXIMO}, padrão 200).` },
      },
      required: ["view"],
    },
  },
  {
    name: "ajuda_sistema",
    description: "Explica como fazer algo no sistema (caminho no menu e passos), a partir do manual das telas. Use para perguntas do tipo \"como faço...\", \"onde fica...\".",
    input_schema: { type: "object", properties: { pergunta: { type: "string" } }, required: ["pergunta"] },
  },
];

export const HANDLERS_GERAIS: Record<string, (ctx: AssistantToolContext, input: Record<string, unknown>) => Promise<unknown> | unknown> = {
  catalogo_sistema: catalogoSistema,
  consultar_dados: consultarDados,
  ajuda_sistema: ajudaSistema,
};
