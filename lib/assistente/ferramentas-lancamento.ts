import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantToolContext } from "../assistant-tools";
import { FerramentaError } from "./ferramentas";
import { adicionarPendente, campoDaOpcao, editarPendente, lerCampos, listarPendentes, PendenteError, removerPendentes, type ListaPendentes, type PendenteVisivel } from "./pendentes";
import { numeroBr, STATUS_ROTULO } from "./pendentes-regras";

// ---------------------------------------------------------------------------
// Ferramentas da assistente para a lista "Lançamentos pendentes". Elas só mexem na lista do próprio
// usuário (adicionar, editar, remover, listar). NÃO existe ferramenta de gravação: o lançamento no
// sistema só acontece quando a pessoa clica em "Lançar tudo" → "Confirmar" no painel.
// ---------------------------------------------------------------------------

const CAMPOS_ITEM: Record<string, unknown> = {
  frente: { type: "string", description: "Frente do lançamento, só se a pessoa disser (padrão: a frente selecionada no topo do sistema)." },
  data: { type: "string", description: "Data, só se a pessoa disser: 'ontem', '25/09', '25/09/2026'. Padrão: hoje." },
  observacao: { type: "string" },
  produto: { type: "string", description: "Saída de produto: o produto como a pessoa falou (ex.: 'filtro de combustível', 'lima redonda', 'corrente 42 dentes')." },
  produto_tag: { type: "string", description: "TAG do produto quando a pessoa disser 'TAG 11' (tem prioridade sobre o nome)." },
  quantidade: { type: ["number", "string"], description: "Quantidade de produto. Pode ser número ou como falado ('dois', 'meia dúzia'). Não dita = 1." },
  equipamento: { type: "string", description: "Código da frota (PC-20, CM-35) ou placa. No combustível também aceita a placa de veículo de terceiro." },
  colaborador: { type: "string", description: "Saída de produto para um funcionário: nome como falado (ex.: 'Claudilson')." },
  departamento: { type: "string", description: "Saída de produto para um departamento (ex.: 'Alimentação', 'Oficina'). Também usado para 'local'." },
  terceiro: { type: "string", description: "Empresa/pessoa do cadastro de Terceiros (prestador, terceirizada, pessoa física)." },
  veiculo_terceiro: { type: "string", description: "Placa do veículo do terceiro." },
  recebido_por: { type: "string", description: "Saída de produto para terceiro: quem recebeu." },
  funcionario_terceiro: { type: "string", description: "Destino Funcionário no terceiro: funcionário da empresa terceira que recebeu o combustível/peça (fora dos veículos dela). Ex.: 'diesel para o João da GREGOLETO, motosserra'." },
  finalidade: { type: "string", description: "Combustível para funcionário do terceiro: motosserra, gerador, galão (reserva), máquina não cadastrada ou outros (com finalidade_texto)." },
  finalidade_texto: { type: "string", description: "Descrição quando a finalidade é 'outros' (ex.: roçadeira, bomba d'água)." },
  combustivel: { type: "string", description: "Saída de combustível: tipo (ex.: 'diesel', 'diesel S10', 'gasolina'). Padrão: diesel." },
  estoque: { type: "string", enum: ["Frente", "Porto"], description: "Estoque de onde sai o combustível (padrão Frente)." },
  litros: { type: ["number", "string"], description: "Litros de combustível (número ou como falado: 'trezentos')." },
  leitura: { type: ["number", "string"], description: "Hodômetro (km) ou horímetro (h) no abastecimento, número ou como falado ('cento e quarenta mil e novecentos')." },
  tanque_cheio: { type: "boolean", description: "false se a pessoa disser que o tanque ficou parcial. Padrão true." },
  motorista: { type: "string", description: "Saída de combustível: motorista/responsável (nome como falado)." },
  aceitar_motorista_digitado: { type: "boolean", description: "true só se a pessoa confirmar que o motorista não está no cadastro e quer lançar com o nome dito." },
};

export const FERRAMENTAS_LANCAMENTO: Anthropic.Tool[] = [
  {
    name: "lancamento_adicionar",
    description: "Adiciona UM item à lista de Lançamentos pendentes do usuário. NÃO grava no sistema: só o botão \"Lançar tudo\" do painel grava, depois que a pessoa confirma. Use quando pedirem para lançar/registrar/dar saída. Um pedido com dois lançamentos (ex.: 2 correntes para o Vanderson E 300 L de diesel no CM-35) = duas chamadas. Passe os termos como a pessoa falou; o servidor localiza produto (TAG primeiro), equipamento, colaborador etc. no cadastro e devolve o status, as perguntas (o que falta ou é ambíguo, com opções numeradas) e uma confirmação curta.",
    input_schema: {
      type: "object",
      properties: { tipo: { type: "string", enum: ["saida_produto", "saida_combustivel"], description: "saida_produto (peças, materiais, alimentos...) ou saida_combustivel (abastecimento)." }, ...CAMPOS_ITEM },
      required: ["tipo"],
    },
  },
  {
    name: "lancamento_editar",
    description: "Altera um item da lista de Lançamentos pendentes: responder a uma pergunta (ex.: escolher uma das opções), mudar quantidade/litros/leitura/destino etc. Para escolher uma opção devolvida antes, use escolha_campo + escolha_id (o id da opção). Para trocar o destino de um produto (ex.: do equipamento para um colaborador), passe o novo campo e limpe o antigo em 'limpar'.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "id do item na lista (veja lancamento_listar)." },
        escolha_campo: { type: "string", description: "Campo da pergunta respondida: produto, colaborador, responsavel, equipamento, departamento, terceiro, funcionarioTerceiro, combustivel, frente." },
        escolha_id: { type: "integer", description: "id da opção escolhida (das opções devolvidas para esse campo)." },
        limpar: { type: "array", items: { type: "string", enum: ["equipamento", "colaborador", "departamento", "terceiro", "veiculo_terceiro", "recebido_por", "leitura", "motorista", "observacao", "funcionario_terceiro"] } },
        ...CAMPOS_ITEM,
      },
      required: ["item_id"],
    },
  },
  {
    name: "lancamento_remover",
    description: "Remove itens da lista de Lançamentos pendentes (não mexe em nada já lançado no sistema). 'remove o último' = ultimo true; 'limpa a lista' = todos true; 'tira a lima do Claudilson' = item_ids com o id desse item (consulte lancamento_listar se não souber).",
    input_schema: {
      type: "object",
      properties: { item_ids: { type: "array", items: { type: "integer" } }, ultimo: { type: "boolean" }, todos: { type: "boolean" } },
    },
  },
  {
    name: "lancamento_listar",
    description: "Mostra a lista de Lançamentos pendentes do usuário com id, descrição, status (Pronto/Atenção/Bloqueado) e o que falta. Use para 'o que tem na lista?' e para achar o id antes de editar/remover.",
    input_schema: { type: "object", properties: {} },
  },
];

// Resumo de um item para a assistente (curto: ela repete para a pessoa).
function paraModelo(item: PendenteVisivel) {
  const opcoes = Object.fromEntries(Object.entries(item.item.duvidas).filter(([, duvida]) => duvida.opcoes.length).map(([campo, duvida]) => [campo, duvida.opcoes]));
  return {
    id: item.id, tipo: item.tipoRotulo, descricao: item.descricao, frente: item.item.frente?.nome ?? null, data: item.item.data.split("-").reverse().join("/"),
    status: item.avaliacao.incompleto ? "Incompleto" : STATUS_ROTULO[item.avaliacao.status],
    ...(item.avaliacao.perguntas.length ? { perguntas: item.avaliacao.perguntas } : {}),
    ...(item.avaliacao.bloqueios.length ? { bloqueios: item.avaliacao.bloqueios } : {}),
    ...(item.avaliacao.avisos.length ? { avisos: item.avaliacao.avisos } : {}),
    ...(Object.keys(opcoes).length ? { opcoes } : {}),
  };
}

function resumoLista(lista: ListaPendentes) {
  const { resumo } = lista;
  return {
    total: resumo.total, prontos: resumo.prontos, atencao: resumo.atencao, bloqueados: resumo.bloqueados,
    itens: lista.itens.map((item) => ({ id: item.id, descricao: item.descricao, status: item.avaliacao.incompleto ? "Incompleto" : STATUS_ROTULO[item.avaliacao.status] })),
  };
}

const plural = (total: number) => `${total} ${total === 1 ? "item pendente" : "itens pendentes"}`;

function confirmacao(acao: string, item: PendenteVisivel, lista: ListaPendentes) {
  const multiFrente = lista.frentes.length > 1 && item.item.frente ? ` (${item.item.frente.nome})` : "";
  if (item.avaliacao.incompleto) return `${acao}, mas falta: ${item.avaliacao.perguntas.join(" ")} ${plural(lista.resumo.total)}.`;
  const alerta = item.avaliacao.status === "BLOQUEADO" ? ` Atenção: bloqueado — ${item.avaliacao.bloqueios.join(" ")}` : item.avaliacao.avisos.length ? ` Atenção: ${item.avaliacao.avisos.join(" ")}` : "";
  return `${acao}: ${item.descricao}${multiFrente}. ${plural(lista.resumo.total)}.${alerta}`;
}

function marcar(ctx: AssistantToolContext, lista: ListaPendentes) {
  ctx.pendentesAlterados = true;
  ctx.pendentes = lista;
}

async function adicionar(ctx: AssistantToolContext, input: Record<string, unknown>) {
  const campos = lerCampos(input);
  const tipo = input.tipo === "saida_combustivel" ? "combustivel" : "produto";
  const { id, lista } = await adicionarPendente(ctx, { ...campos, tipo }, { texto: ctx.pergunta ?? null, viaVoz: ctx.viaVoz === true });
  marcar(ctx, lista);
  const item = lista.itens.find((row) => row.id === id)!;
  return { item: paraModelo(item), confirmacao: confirmacao("Adicionado", item, lista), lista: resumoLista(lista), lembrete: "Nada foi gravado no sistema: só no botão Lançar tudo do painel." };
}

async function editar(ctx: AssistantToolContext, input: Record<string, unknown>) {
  const id = Number(input.item_id);
  if (!Number.isInteger(id) || id <= 0) throw new FerramentaError("Informe o item_id (veja lancamento_listar).");
  let campos = lerCampos(input);
  if (typeof input.escolha_campo === "string" && Number.isInteger(Number(input.escolha_id))) {
    const atual = (await listarPendentes(ctx)).itens.find((row) => row.id === id);
    if (!atual) throw new FerramentaError("Item não encontrado na lista.");
    campos = { ...campos, ...campoDaOpcao(atual.item, input.escolha_campo === "motorista" ? "responsavel" : input.escolha_campo, Number(input.escolha_id)) };
  }
  const { lista } = await editarPendente(ctx, id, campos);
  marcar(ctx, lista);
  const item = lista.itens.find((row) => row.id === id)!;
  return { item: paraModelo(item), confirmacao: confirmacao("Alterado", item, lista), lista: resumoLista(lista) };
}

async function remover(ctx: AssistantToolContext, input: Record<string, unknown>) {
  let alvo: number[] | "TODOS";
  if (input.todos === true) alvo = "TODOS";
  else if (input.ultimo === true) {
    const atual = await listarPendentes(ctx);
    if (!atual.itens.length) return { removidos: [], confirmacao: "A lista de lançamentos pendentes já está vazia." };
    alvo = [atual.itens[atual.itens.length - 1].id];
  } else alvo = Array.isArray(input.item_ids) ? input.item_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
  if (alvo !== "TODOS" && alvo.length === 0) throw new FerramentaError("Diga quais itens remover (item_ids), ou ultimo/todos.");
  const { removidos, lista } = await removerPendentes(ctx, alvo);
  marcar(ctx, lista);
  return {
    removidos, confirmacao: removidos.length ? `Removido${removidos.length > 1 ? "s" : ""}: ${removidos.map((row) => row.descricao).join("; ")}. ${plural(lista.resumo.total)}.` : alvo === "TODOS" ? "A lista de lançamentos pendentes já estava vazia." : "Nenhum item removido (não encontrei esses itens na lista).",
    lista: resumoLista(lista),
  };
}

async function listar(ctx: AssistantToolContext) {
  const lista = await listarPendentes(ctx);
  const { resumo } = lista;
  return {
    total: resumo.total, prontos: resumo.prontos, atencao: resumo.atencao, bloqueados: resumo.bloqueados,
    produtos: `${resumo.produtos} item(ns), ${numeroBr(resumo.quantidadeProdutos)} unidade(s)`, combustivel: `${resumo.combustivel} item(ns), ${numeroBr(resumo.litros)} L`,
    itens: lista.itens.map(paraModelo), pode_lancar: lista.podeLancar,
  };
}

// Erros de regra da lista viram mensagem para a assistente explicar.
const seguro = (handler: (ctx: AssistantToolContext, input: Record<string, unknown>) => Promise<unknown>) => async (ctx: AssistantToolContext, input: Record<string, unknown>) => {
  try { return await handler(ctx, input); }
  catch (error) { if (error instanceof PendenteError) throw new FerramentaError(error.message); throw error; }
};

export const HANDLERS_LANCAMENTO: Record<string, (ctx: AssistantToolContext, input: Record<string, unknown>) => Promise<unknown>> = {
  lancamento_adicionar: seguro(adicionar),
  lancamento_editar: seguro(editar),
  lancamento_remover: seguro(remover),
  lancamento_listar: seguro(async (ctx) => listar(ctx)),
};
