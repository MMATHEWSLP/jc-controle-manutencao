import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getD1 } from "../../db";
import { assistantLogs, assistantPendingItems, departments, employees, fuelMovements, productFrontStock, productReferences, products, serviceFronts, thirdParties } from "../../db/schema";
import { loadEquipmentIndex, matchEquipment, AssistantToolError, type AssistantToolContext, type EquipmentIndex } from "../assistant-tools";
import { assistantConfig } from "../assistant-config";
import { activeFuelTypes, fuelBalances, fuelLocalDay, fuelVisibleFronts } from "../fuel";
import { createFuelMovement, FuelCreateError } from "../fuel-create";
import { validateFuelMovement } from "../fuel-rules";
import { ReadingOperationError, saveReading } from "../readings";
import { StockError } from "../stock";
import { createStockExit } from "../stock-exits";
import { prepareThirdPartyFuel, ThirdPartyError, vehicleFuelings } from "../third-parties";
import { averageConsumption, computeConsumption, CONSUMPTION_UNITS, isOutlier, type Fueling, type MeterType } from "../third-party-rules";
import { numeroFalado } from "./numeros";
import {
  buscarPessoa, buscarPorNome, buscarProduto, dataBr, descreverItem, destinoTexto, lerData, fecharAvaliacao, numeroBr, perguntaDaDuvida, semAcento, TIPO_ROTULO,
  type Avaliacao, type ItemCombustivel, type ItemPendente, type ItemProduto, type Opcao, type PessoaBusca, type ProdutoBusca, type Ref, type TipoItem,
} from "./pendentes-regras";

// ---------------------------------------------------------------------------
// Lançamentos pendentes do Assistente JC ("carrinho" por usuário, tabela assistant_pending_items).
//  - A assistente (e o painel) só adicionam, editam e removem itens: localizam produto, equipamento,
//    colaborador etc. no cadastro e guardam o item. Nenhuma função daqui grava no sistema, EXCETO
//    lancarPendentes, chamada só pela rota do botão "Lançar tudo" → "Confirmar" (nunca pela IA).
//  - O status (Pronto / Atenção / Bloqueado) é recalculado a cada leitura, com o estoque, o saldo de
//    combustível e as leituras atuais, somando os itens anteriores da própria lista.
//  - lancarPendentes grava item por item com as MESMAS funções dos formulários: createStockExit
//    (Movimentação → saída e baixa do estoque) e createFuelMovement + saveReading (Combustível →
//    lançamento, leitura do equipamento, ciclos e alertas), marcando created_via = ASSISTENTE.
// ---------------------------------------------------------------------------
type Ctx = AssistantToolContext;
type Db = Ctx["db"];

export class PendenteError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const LIMITE_PENDENTES = 40;
const LANCANDO_EXPIRA_MS = 5 * 60_000;

// Campos aceitos pela ferramenta da assistente e pelo painel (nomes em português, como a pessoa fala).
export type CamposPedido = Partial<{
  tipo: string; frente: string; frente_id: number; data: string; observacao: string;
  produto: string; produto_tag: string; produto_id: number; quantidade: number | string;
  equipamento: string; equipamento_id: number; colaborador: string; colaborador_id: number;
  departamento: string; departamento_id: number; terceiro: string; terceiro_id: number; veiculo_terceiro: string; recebido_por: string;
  combustivel: string; combustivel_id: number; estoque: string; litros: number | string; leitura: number | string; tanque_cheio: boolean;
  motorista: string; motorista_id: number; aceitar_motorista_digitado: boolean;
  veiculo_terceiro_id: number;
  limpar: string[];
}>;

const CAMPOS_TEXTO = ["tipo", "frente", "data", "observacao", "produto", "produto_tag", "equipamento", "colaborador", "departamento", "terceiro", "veiculo_terceiro", "recebido_por", "combustivel", "estoque", "motorista"] as const;
const CAMPOS_ID = ["frente_id", "produto_id", "equipamento_id", "colaborador_id", "departamento_id", "terceiro_id", "combustivel_id", "motorista_id", "veiculo_terceiro_id"] as const;
const CAMPOS_LIMPAVEIS = ["equipamento", "colaborador", "departamento", "terceiro", "veiculo_terceiro", "recebido_por", "leitura", "motorista", "observacao"];

// Normaliza o que veio da ferramenta/painel (tipos errados viram "não informado").
export function lerCampos(entrada: unknown): CamposPedido {
  const bruto = (entrada && typeof entrada === "object" ? entrada : {}) as Record<string, unknown>;
  const campos: CamposPedido = {};
  for (const nome of CAMPOS_TEXTO) {
    const valor = bruto[nome];
    if (typeof valor === "string" && valor.trim()) (campos as Record<string, unknown>)[nome] = valor.trim().slice(0, 200);
    else if (typeof valor === "number" && Number.isFinite(valor)) (campos as Record<string, unknown>)[nome] = String(valor);
  }
  for (const nome of CAMPOS_ID) { const valor = Number(bruto[nome]); if (Number.isInteger(valor) && valor > 0) (campos as Record<string, unknown>)[nome] = valor; }
  for (const nome of ["quantidade", "litros", "leitura"] as const) {
    const valor = bruto[nome];
    if (typeof valor === "number" || (typeof valor === "string" && valor.trim())) campos[nome] = typeof valor === "string" ? valor.trim().slice(0, 80) : valor;
  }
  if (typeof bruto.tanque_cheio === "boolean") campos.tanque_cheio = bruto.tanque_cheio;
  if (bruto.aceitar_motorista_digitado === true) campos.aceitar_motorista_digitado = true;
  if (Array.isArray(bruto.limpar)) campos.limpar = bruto.limpar.filter((item): item is string => typeof item === "string" && CAMPOS_LIMPAVEIS.includes(item));
  return campos;
}

// ---------------------------------------------------------------------------
// Cadastros (carregados uma vez por pedido)
// ---------------------------------------------------------------------------
type Terceiro = { id: number; nome: string; tipo: string };
type Cadastros = ReturnType<typeof cadastros>;

function cadastros(ctx: Ctx) {
  const memo = new Map<string, Promise<unknown>>();
  const uma = <T,>(chave: string, carregar: () => Promise<T>) => {
    if (!memo.has(chave)) memo.set(chave, carregar());
    return memo.get(chave) as Promise<T>;
  };
  return {
    frentes: () => uma("frentes", () => fuelVisibleFronts(ctx.db, ctx.user)),
    produtos: () => uma("produtos", async (): Promise<ProdutoBusca[]> => {
      const [rows, refs] = await Promise.all([
        ctx.db.select({ id: products.id, tag: products.tag, nome: products.name, referencia: products.reference }).from(products).where(eq(products.active, true)),
        ctx.db.select({ productId: productReferences.productId, reference: productReferences.reference }).from(productReferences),
      ]);
      const porProduto = new Map<number, string[]>();
      for (const ref of refs) porProduto.set(ref.productId, [...(porProduto.get(ref.productId) ?? []), ref.reference]);
      return rows.map((row) => ({ id: row.id, tag: row.tag, nome: row.nome, referencias: [...(row.referencia ? [row.referencia] : []), ...(porProduto.get(row.id) ?? [])] }));
    }),
    pessoas: () => uma("pessoas", async (): Promise<PessoaBusca[]> => {
      const rows = await ctx.db.select({ id: employees.id, nome: employees.name, status: employees.status, frenteId: employees.serviceFrontId, frente: serviceFronts.name })
        .from(employees).leftJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId));
      return rows.map((row) => ({ id: row.id, nome: row.nome, ativo: row.status !== "DEMITIDO", frenteId: row.frenteId, frente: row.frente }));
    }),
    departamentos: () => uma("departamentos", async () => (await ctx.db.select({ id: departments.id, nome: departments.name }).from(departments).where(eq(departments.active, true)).orderBy(asc(departments.name)))),
    terceiros: () => uma("terceiros", async (): Promise<Terceiro[]> => (await ctx.db.select({ id: thirdParties.id, nome: thirdParties.name, tipo: thirdParties.kind }).from(thirdParties).where(eq(thirdParties.active, true)).orderBy(asc(thirdParties.name)))),
    combustiveis: () => uma("combustiveis", async () => (await activeFuelTypes(ctx.db)).map((row) => ({ id: row.id, nome: row.name }))),
    equipamentos: () => uma("equipamentos", () => loadEquipmentIndex(ctx)),
  };
}

const ref = (row: { id: number; name?: string; nome?: string }): Ref => ({ id: row.id, nome: (row.nome ?? row.name)! });

async function saldosProdutos(db: Db, frenteId: number, ids: number[]) {
  if (!ids.length) return new Map<number, number>();
  const rows = await db.select({ productId: productFrontStock.productId, quantity: productFrontStock.quantity }).from(productFrontStock)
    .where(and(eq(productFrontStock.serviceFrontId, frenteId), inArray(productFrontStock.productId, ids)));
  return new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
}

const opcaoProduto = (produto: ProdutoBusca, saldo?: number): Opcao => ({ id: produto.id, rotulo: `TAG ${produto.tag} — ${produto.nome}${saldo !== undefined ? ` (saldo ${numeroBr(saldo)})` : ""}` });
const opcaoPessoa = (pessoa: PessoaBusca): Opcao => ({ id: pessoa.id, rotulo: `${pessoa.nome}${pessoa.frente ? ` (${pessoa.frente})` : ""}` });

// Departamento do colaborador pelo histórico de saídas dele (o cadastro de Funcionários não guarda departamento).
async function departamentoDoHistorico(db: Db, employeeId: number): Promise<Ref | null> {
  const desde = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.execute(sql`SELECT d.id, d.name AS nome, count(*)::int AS vezes FROM product_stock_movements sm JOIN departments d ON d.id = sm.department_id
    WHERE sm.employee_id = ${employeeId} AND sm.delta < 0 AND sm.reversed_at IS NULL AND d.active AND coalesce(sm.movement_date, substr(sm.created_at, 1, 10)) >= ${desde}
    GROUP BY d.id, d.name ORDER BY vezes DESC, d.name LIMIT 1`);
  const row = (rows as unknown as { rows: Array<{ id: number; nome: string }> }).rows[0];
  return row ? { id: Number(row.id), nome: row.nome } : null;
}

// ---------------------------------------------------------------------------
// Monta/atualiza um item a partir dos campos ditos. Só lê cadastros.
// ---------------------------------------------------------------------------
function tipoPedido(campos: CamposPedido, atual: ItemPendente | null): TipoItem {
  if (atual) return atual.tipo;
  const tipo = semAcento(campos.tipo ?? "");
  if (/combust|diesel|gasolina|abastec/.test(tipo)) return "SAIDA_COMBUSTIVEL";
  if (/produto|peca|material/.test(tipo)) return "SAIDA_PRODUTO";
  if (campos.litros !== undefined || campos.combustivel || campos.combustivel_id || campos.motorista || campos.leitura !== undefined) return "SAIDA_COMBUSTIVEL";
  return "SAIDA_PRODUTO";
}

function novoItem(tipo: TipoItem, hoje: string): ItemPendente {
  const base = { frente: null, data: hoje, observacao: null, duvidas: {}, alertas: {} };
  return tipo === "SAIDA_PRODUTO"
    ? { ...base, tipo, produto: null, quantidade: 1, destino: null, equipamento: null, colaborador: null, departamento: null, terceiro: null, veiculoTerceiro: null, recebidoPor: null }
    : { ...base, tipo, combustivel: null, estoque: "FRENTE", litros: null, alvo: null, equipamento: null, terceiro: null, veiculo: null, leitura: null, tanqueCheio: true, responsavel: null };
}

export async function montarItem(ctx: Ctx, cad: Cadastros, atual: ItemPendente | null, campos: CamposPedido): Promise<ItemPendente> {
  const hoje = fuelLocalDay();
  const tipo = tipoPedido(campos, atual);
  const item = structuredClone(atual ?? novoItem(tipo, hoje)) as ItemPendente;
  item.duvidas ??= {}; item.alertas ??= {};
  const duvida = (campo: string, pedido: string, motivo: string, opcoes: Opcao[] = []) => { item.duvidas[campo] = { pedido, motivo, opcoes }; };
  const resolvido = (campo: string) => { delete item.duvidas[campo]; delete item.alertas[campo]; };
  const frentes = await cad.frentes();
  let frenteDita = false;

  // Frente: a dita, senão (item novo) a selecionada no topo do sistema.
  if (campos.frente_id) {
    const frente = frentes.find((row) => row.id === campos.frente_id);
    if (frente) { item.frente = ref(frente); resolvido("frente"); frenteDita = true; } else duvida("frente", String(campos.frente_id), "frente fora das que você pode lançar", frentes.map((row) => ({ id: row.id, rotulo: row.name })));
  } else if (campos.frente) {
    const achada = buscarPorNome(frentes.map((row) => ({ id: row.id, nome: row.name })), campos.frente);
    if (achada.escolhido) { item.frente = achada.escolhido; resolvido("frente"); frenteDita = true; }
    else duvida("frente", campos.frente, achada.motivo ?? "frente não encontrada", frentes.map((row) => ({ id: row.id, rotulo: row.name })));
  } else if (!atual) {
    if (frentes.length === 1) item.frente = ref(frentes[0]);
    else if (ctx.displayed !== "ALL" && ctx.displayed.length === 1) { const frente = frentes.find((row) => row.id === (ctx.displayed as number[])[0]); if (frente) item.frente = ref(frente); }
  }

  if (campos.data) {
    const data = lerData(campos.data, hoje);
    if (data) { item.data = data; resolvido("data"); } else duvida("data", campos.data, "data não entendida (use DD/MM/AAAA)");
  }
  if (campos.observacao !== undefined) item.observacao = campos.observacao || null;
  for (const campo of campos.limpar ?? []) {
    if (campo === "observacao") item.observacao = null;
    if (item.tipo === "SAIDA_PRODUTO") {
      if (campo === "equipamento") item.equipamento = null;
      if (campo === "colaborador") item.colaborador = null;
      if (campo === "departamento") item.departamento = null;
      if (campo === "terceiro") { item.terceiro = null; item.veiculoTerceiro = null; item.recebidoPor = null; }
      if (campo === "veiculo_terceiro") item.veiculoTerceiro = null;
      if (campo === "recebido_por") item.recebidoPor = null;
    } else {
      if (campo === "leitura") item.leitura = null;
      if (campo === "motorista") item.responsavel = null;
    }
    resolvido(campo === "veiculo_terceiro" ? "veiculoTerceiro" : campo === "motorista" ? "responsavel" : campo);
  }

  const equipamentoIndex = async () => cad.equipamentos();
  const acharEquipamento = (index: EquipmentIndex, texto: string) => {
    try { return matchEquipment(index, texto); } catch (error) { if (error instanceof AssistantToolError) return { fleet: [], vehicles: [] }; throw error; }
  };

  if (item.tipo === "SAIDA_PRODUTO") await montarProduto(ctx, cad, item, campos, { duvida, resolvido, equipamentoIndex, acharEquipamento });
  else await montarCombustivel(ctx, cad, item, campos, { duvida, resolvido, equipamentoIndex, acharEquipamento });

  // Sem frente dita nem selecionada: usa a do equipamento / colaborador, se for uma das suas.
  if (!item.frente && !frenteDita) {
    const index = item.equipamento ? await cad.equipamentos() : null;
    const idEquip = item.equipamento?.id;
    const daFrente = idEquip ? index?.fleet.find((row) => row.id === idEquip)?.serviceFrontId : item.tipo === "SAIDA_PRODUTO" && item.colaborador ? (await cad.pessoas()).find((row) => row.id === item.colaborador!.id)?.frenteId : null;
    const frente = frentes.find((row) => row.id === daFrente);
    if (frente) item.frente = ref(frente);
  }
  if (!item.frente && !item.duvidas.frente) duvida("frente", "", "escolha a frente do lançamento", frentes.map((row) => ({ id: row.id, rotulo: row.name })));
  if (item.frente) delete item.duvidas.frente;

  // Opções de produto mostram o saldo na frente do item.
  if (item.tipo === "SAIDA_PRODUTO" && item.duvidas.produto?.opcoes.length && item.frente) {
    const saldos = await saldosProdutos(ctx.db, item.frente.id, item.duvidas.produto.opcoes.map((opcao) => opcao.id));
    const lista = await cad.produtos();
    item.duvidas.produto.opcoes = item.duvidas.produto.opcoes.map((opcao) => { const produto = lista.find((row) => row.id === opcao.id); return produto ? opcaoProduto(produto, saldos.get(produto.id) ?? 0) : opcao; });
  }
  return item;
}

type Ajudantes = {
  duvida: (campo: string, pedido: string, motivo: string, opcoes?: Opcao[]) => void;
  resolvido: (campo: string) => void;
  equipamentoIndex: () => Promise<EquipmentIndex>;
  acharEquipamento: (index: EquipmentIndex, texto: string) => ReturnType<typeof matchEquipment>;
};

async function montarProduto(ctx: Ctx, cad: Cadastros, item: ItemProduto, campos: CamposPedido, ajuda: Ajudantes) {
  const { duvida, resolvido } = ajuda;
  if (campos.produto_id) {
    const produto = (await cad.produtos()).find((row) => row.id === campos.produto_id);
    if (produto) { item.produto = { id: produto.id, tag: produto.tag, nome: produto.nome }; resolvido("produto"); }
    else duvida("produto", String(campos.produto_id), "produto não encontrado ou desativado");
  } else if (campos.produto || campos.produto_tag) {
    const pedido = [campos.produto_tag ? `TAG ${campos.produto_tag}` : "", campos.produto ?? ""].filter(Boolean).join(" ");
    const achado = buscarProduto(await cad.produtos(), { texto: campos.produto, tag: campos.produto_tag });
    if (achado.escolhido) {
      item.produto = { id: achado.escolhido.id, tag: achado.escolhido.tag, nome: achado.escolhido.nome }; resolvido("produto");
      if (achado.aviso) item.alertas.produto = achado.aviso;
    } else { item.produto = null; duvida("produto", pedido, achado.motivo ?? "produto não encontrado", achado.opcoes.map((produto) => opcaoProduto(produto))); }
  }
  if (campos.quantidade !== undefined) {
    const quantidade = numeroFalado(campos.quantidade);
    if (quantidade !== null && quantidade > 0) { item.quantidade = quantidade; resolvido("quantidade"); } else duvida("quantidade", String(campos.quantidade), "quantidade não entendida");
  }

  // Destino: equipamento (código/placa), colaborador, departamento ou terceiro.
  if (campos.equipamento_id) {
    const achado = (await ajuda.equipamentoIndex()).fleet.find((row) => row.id === campos.equipamento_id);
    if (achado) { item.equipamento = { id: achado.id, prefixo: achado.prefix }; resolvido("equipamento"); } else duvida("equipamento", String(campos.equipamento_id), "equipamento não encontrado nas suas frentes");
  } else if (campos.equipamento) {
    const achado = ajuda.acharEquipamento(await ajuda.equipamentoIndex(), campos.equipamento);
    const exatos = achado.fleet.filter((row) => row.foundBy === "código" || row.foundBy === "placa");
    const veiculos = achado.vehicles.filter((row) => row.foundBy === "placa");
    if (exatos.length === 1) { item.equipamento = { id: exatos[0].id, prefixo: exatos[0].prefix }; resolvido("equipamento"); }
    else if (exatos.length === 0 && veiculos.length === 1) {
      item.terceiro = { id: veiculos[0].thirdPartyId, nome: veiculos[0].company }; item.veiculoTerceiro = { id: veiculos[0].id, placa: veiculos[0].plate }; resolvido("equipamento"); resolvido("terceiro");
    } else duvida("equipamento", campos.equipamento, exatos.length > 1 ? "mais de um equipamento com esse código/placa" : achado.fleet.length ? "não achei exatamente; parecidos" : "equipamento não encontrado (código ou placa)",
      (exatos.length > 1 ? exatos : achado.fleet).slice(0, 5).map((row) => ({ id: row.id, rotulo: `${row.prefix}${row.plate ? ` · ${row.plate}` : ""} (${row.frontName ?? "sem frente"})` })));
  }
  if (campos.colaborador_id) {
    const pessoa = (await cad.pessoas()).find((row) => row.id === campos.colaborador_id);
    if (pessoa?.ativo) { item.colaborador = { id: pessoa.id, nome: pessoa.nome }; resolvido("colaborador"); } else duvida("colaborador", String(campos.colaborador_id), pessoa ? "funcionário demitido" : "funcionário não encontrado");
  } else if (campos.colaborador) {
    const achado = buscarPessoa(await cad.pessoas(), campos.colaborador, item.frente?.id);
    if (achado.escolhido) { item.colaborador = { id: achado.escolhido.id, nome: achado.escolhido.nome }; resolvido("colaborador"); }
    else { item.colaborador = null; duvida("colaborador", campos.colaborador, achado.motivo ?? "não encontrado", achado.opcoes.map(opcaoPessoa)); }
  }
  if (campos.departamento_id) {
    const dep = (await cad.departamentos()).find((row) => row.id === campos.departamento_id);
    if (dep) { item.departamento = dep; resolvido("departamento"); } else duvida("departamento", String(campos.departamento_id), "departamento não encontrado");
  } else if (campos.departamento) {
    const achado = buscarPorNome(await cad.departamentos(), campos.departamento);
    if (achado.escolhido) { item.departamento = achado.escolhido; resolvido("departamento"); }
    else duvida("departamento", campos.departamento, achado.motivo ?? "não encontrado", (achado.opcoes.length ? achado.opcoes : await cad.departamentos()).slice(0, 5).map((row) => ({ id: row.id, rotulo: row.nome })));
  } else if (item.colaborador && (!item.departamento || item.departamento.inferido) && (campos.colaborador || campos.colaborador_id)) {
    // Departamento inferido pelo histórico do colaborador (quando não foi dito).
    const dep = await departamentoDoHistorico(ctx.db, item.colaborador.id);
    item.departamento = dep ? { ...dep, inferido: true } : null;
  }
  if (campos.terceiro_id || campos.terceiro) {
    const terceiros = await cad.terceiros();
    const achado = campos.terceiro_id ? { escolhido: terceiros.find((row) => row.id === campos.terceiro_id) ?? null, opcoes: [] as Terceiro[], motivo: "terceiro não encontrado" } : buscarPorNome(terceiros, campos.terceiro!);
    if (achado.escolhido) { item.terceiro = { id: achado.escolhido.id, nome: achado.escolhido.nome }; resolvido("terceiro"); if (item.veiculoTerceiro && !campos.veiculo_terceiro) item.veiculoTerceiro = null; }
    else duvida("terceiro", campos.terceiro ?? String(campos.terceiro_id), achado.motivo ?? "não encontrado", achado.opcoes.map((row) => ({ id: row.id, rotulo: row.nome })));
  }
  if (campos.veiculo_terceiro) {
    const index = await ajuda.equipamentoIndex();
    const chave = campos.veiculo_terceiro.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const veiculo = index.vehicles.find((row) => row.plateKey === chave && (!item.terceiro || row.thirdPartyId === item.terceiro.id));
    if (veiculo) { item.veiculoTerceiro = { id: veiculo.id, placa: veiculo.plate }; item.terceiro ??= { id: veiculo.thirdPartyId, nome: veiculo.company }; resolvido("veiculoTerceiro"); }
    else duvida("veiculoTerceiro", campos.veiculo_terceiro, "placa não encontrada nos veículos do terceiro");
  }
  if (campos.veiculo_terceiro_id) {
    const veiculo = (await ajuda.equipamentoIndex()).vehicles.find((row) => row.id === campos.veiculo_terceiro_id);
    if (veiculo) { item.veiculoTerceiro = { id: veiculo.id, placa: veiculo.plate }; item.terceiro = { id: veiculo.thirdPartyId, nome: veiculo.company }; resolvido("veiculoTerceiro"); resolvido("equipamento"); resolvido("terceiro"); }
    else duvida("veiculoTerceiro", String(campos.veiculo_terceiro_id), "veículo de terceiro não encontrado");
  }
  if (campos.recebido_por !== undefined) item.recebidoPor = campos.recebido_por || null;
  item.destino = item.terceiro ? "TERCEIRO" : item.equipamento ? "EQUIPAMENTO" : item.colaborador ? "COLABORADOR" : item.departamento ? "DEPARTAMENTO" : null;
  if (item.destino === "TERCEIRO") { item.equipamento = null; item.colaborador = null; item.departamento = null; }
}

async function montarCombustivel(ctx: Ctx, cad: Cadastros, item: ItemCombustivel, campos: CamposPedido, ajuda: Ajudantes) {
  const { duvida, resolvido } = ajuda;
  const combustiveis = await cad.combustiveis();
  if (campos.combustivel_id) {
    const tipo = combustiveis.find((row) => row.id === campos.combustivel_id);
    if (tipo) { item.combustivel = tipo; resolvido("combustivel"); } else duvida("combustivel", String(campos.combustivel_id), "combustível não encontrado", combustiveis.map((row) => ({ id: row.id, rotulo: row.nome })));
  } else if (campos.combustivel || !item.combustivel) {
    const texto = campos.combustivel ?? "diesel";
    const achado = buscarPorNome(combustiveis, texto);
    if (achado.escolhido) { item.combustivel = achado.escolhido; resolvido("combustivel"); }
    else if (achado.opcoes.length > 1) {
      // Mais de um tipo (ex.: Diesel S10 e S500): o mais usado na frente nos últimos 60 dias, com aviso.
      const desde = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
      const uso = item.frente ? await ctx.db.select({ id: fuelMovements.fuelTypeId, total: sql<number>`count(*)::int` }).from(fuelMovements)
        .where(and(eq(fuelMovements.serviceFrontId, item.frente.id), eq(fuelMovements.movementType, "SAIDA"), isNull(fuelMovements.deletedAt), sql`${fuelMovements.movementDate} >= ${desde}`, inArray(fuelMovements.fuelTypeId, achado.opcoes.map((row) => row.id))))
        .groupBy(fuelMovements.fuelTypeId) : [];
      const preferido = [...uso].sort((a, b) => b.total - a.total)[0];
      const escolhido = achado.opcoes.find((row) => row.id === preferido?.id) ?? achado.opcoes[0];
      item.combustivel = escolhido; resolvido("combustivel");
      item.alertas.combustivel = `Considerei ${escolhido.nome} (o mais usado na frente); outros: ${achado.opcoes.filter((row) => row.id !== escolhido.id).map((row) => row.nome).join(", ")}.`;
    } else duvida("combustivel", texto, achado.motivo ?? "combustível não encontrado", combustiveis.map((row) => ({ id: row.id, rotulo: row.nome })));
  }
  if (campos.estoque) item.estoque = /porto/i.test(campos.estoque) ? "PORTO" : "FRENTE";
  if (campos.litros !== undefined) {
    const litros = numeroFalado(campos.litros);
    if (litros !== null && litros > 0) { item.litros = litros; resolvido("litros"); } else duvida("litros", String(campos.litros), "litros não entendidos");
  }
  if (campos.leitura !== undefined) {
    const leitura = numeroFalado(campos.leitura);
    if (leitura !== null && leitura >= 0) { item.leitura = leitura; resolvido("leitura"); } else duvida("leitura", String(campos.leitura), "leitura não entendida");
  }
  if (campos.tanque_cheio !== undefined) item.tanqueCheio = campos.tanque_cheio;

  // Veículo: código/placa da frota JC ou placa de veículo de terceiro (cadastro de Terceiros).
  const index = campos.equipamento_id || campos.equipamento || campos.veiculo_terceiro || campos.veiculo_terceiro_id || campos.terceiro || campos.terceiro_id ? await ajuda.equipamentoIndex() : null;
  const usarFrota = (row: EquipmentIndex["fleet"][number]) => {
    item.alvo = "FROTA"; item.equipamento = { id: row.id, prefixo: row.prefix, controle: row.controlType as "HOURS" | "KM" | "HOURS_KM" };
    item.terceiro = null; item.veiculo = null; resolvido("equipamento");
  };
  const usarVeiculo = async (row: EquipmentIndex["vehicles"][number]) => {
    const terceiro = (await cad.terceiros()).find((party) => party.id === row.thirdPartyId);
    item.alvo = terceiro?.tipo === "PESSOA_FISICA" ? "TERCEIRO" : "PRESTADOR";
    item.terceiro = { id: row.thirdPartyId, nome: row.company }; item.veiculo = { id: row.id, placa: row.plate, medidor: row.meterType as "KM" | "HORIMETRO" };
    item.equipamento = null; resolvido("equipamento"); resolvido("terceiro");
  };
  if (index && campos.veiculo_terceiro_id) {
    const row = index.vehicles.find((vehicle) => vehicle.id === campos.veiculo_terceiro_id);
    if (row) await usarVeiculo(row); else duvida("equipamento", String(campos.veiculo_terceiro_id), "veículo de terceiro não encontrado");
  } else if (index && campos.equipamento_id) {
    const row = index.fleet.find((equip) => equip.id === campos.equipamento_id);
    if (row) usarFrota(row); else duvida("equipamento", String(campos.equipamento_id), "equipamento não encontrado nas suas frentes");
  } else if (index && (campos.equipamento || campos.veiculo_terceiro)) {
    const texto = (campos.veiculo_terceiro ?? campos.equipamento)!;
    const achado = ajuda.acharEquipamento(index, texto);
    const exatos = achado.fleet.filter((row) => row.foundBy === "código" || row.foundBy === "placa");
    const veiculos = achado.vehicles.filter((row) => row.foundBy === "placa");
    if (exatos.length === 1 && veiculos.length === 0) usarFrota(exatos[0]);
    else if (veiculos.length === 1 && exatos.length === 0) await usarVeiculo(veiculos[0]);
    else duvida("equipamento", texto, exatos.length + veiculos.length > 1 ? "mais de um veículo com esse código/placa" : "veículo/equipamento não encontrado (código da frota ou placa do terceiro)",
      [...(exatos.length + veiculos.length > 1 ? exatos : achado.fleet).map((row) => ({ id: row.id, rotulo: `${row.prefix}${row.plate ? ` · ${row.plate}` : ""} (frota JC, ${row.frontName ?? "sem frente"})` })),
        ...(exatos.length + veiculos.length > 1 ? veiculos : achado.vehicles).map((row) => ({ id: -row.id, rotulo: `${row.plate} (${row.company})` }))].slice(0, 5));
  }
  if (campos.terceiro_id || campos.terceiro) {
    const terceiros = await cad.terceiros();
    const achado = campos.terceiro_id ? { escolhido: terceiros.find((row) => row.id === campos.terceiro_id) ?? null, opcoes: [] as Terceiro[], motivo: "terceiro não encontrado" } : buscarPorNome(terceiros, campos.terceiro!);
    if (achado.escolhido) {
      const party = achado.escolhido;
      if (item.veiculo && item.terceiro?.id !== party.id) item.veiculo = null;
      item.terceiro = { id: party.id, nome: party.nome }; item.alvo = party.tipo === "PESSOA_FISICA" ? "TERCEIRO" : "PRESTADOR"; item.equipamento = null; resolvido("terceiro");
      // Terceiro com um veículo só: já escolhe.
      const veiculos = (index ?? await ajuda.equipamentoIndex()).vehicles.filter((row) => row.thirdPartyId === party.id);
      if (!item.veiculo && veiculos.length === 1) { item.veiculo = { id: veiculos[0].id, placa: veiculos[0].plate, medidor: veiculos[0].meterType as "KM" | "HORIMETRO" }; resolvido("equipamento"); }
      else if (!item.veiculo && veiculos.length > 1 && party.tipo !== "PESSOA_FISICA") duvida("equipamento", "", `qual veículo de ${party.nome}`, veiculos.slice(0, 5).map((row) => ({ id: -row.id, rotulo: `${row.plate}${row.description ? ` — ${row.description}` : ""}` })));
    } else duvida("terceiro", campos.terceiro ?? String(campos.terceiro_id), achado.motivo ?? "não encontrado", achado.opcoes.map((row) => ({ id: row.id, rotulo: row.nome })));
  }

  // Motorista/responsável (Funcionários). Fora do cadastro só com confirmação (como o "digitar nome" do formulário).
  if (campos.motorista_id) {
    const pessoa = (await cad.pessoas()).find((row) => row.id === campos.motorista_id);
    if (pessoa) { item.responsavel = { id: pessoa.id, nome: pessoa.nome }; resolvido("responsavel"); } else duvida("responsavel", String(campos.motorista_id), "funcionário não encontrado");
  } else if (campos.motorista) {
    const achado = buscarPessoa(await cad.pessoas(), campos.motorista, item.frente?.id);
    if (achado.escolhido) { item.responsavel = { id: achado.escolhido.id, nome: achado.escolhido.nome }; resolvido("responsavel"); }
    else if (campos.aceitar_motorista_digitado) { item.responsavel = { id: null, nome: campos.motorista.replace(/\s+/g, " ").replace(/(^|\s)\S/g, (letra) => letra.toUpperCase()) }; resolvido("responsavel"); }
    else { item.responsavel = null; duvida("responsavel", campos.motorista, `${achado.motivo ?? "não encontrado"}${achado.opcoes.length ? "" : " (posso lançar com o nome digitado, se confirmar)"}`, achado.opcoes.map(opcaoPessoa)); }
  } else if (campos.aceitar_motorista_digitado && item.duvidas.responsavel?.pedido) {
    item.responsavel = { id: null, nome: item.duvidas.responsavel.pedido }; resolvido("responsavel");
  }
}

// Opção escolhida no painel/conversa: o id da opção vira o campo *_id certo (veículo de terceiro = id negativo).
export function campoDaOpcao(item: ItemPendente, campo: string, id: number): CamposPedido {
  if (campo === "produto") return { produto_id: id };
  if (campo === "colaborador") return { colaborador_id: id };
  if (campo === "responsavel") return { motorista_id: id };
  if (campo === "departamento") return { departamento_id: id };
  if (campo === "terceiro") return { terceiro_id: id };
  if (campo === "combustivel") return { combustivel_id: id };
  if (campo === "frente") return { frente_id: id };
  if (campo === "equipamento") return id > 0 ? { equipamento_id: id } : { veiculo_terceiro_id: -id };
  if (campo === "veiculoTerceiro") return { veiculo_terceiro_id: Math.abs(id) };
  return {};
}

// ---------------------------------------------------------------------------
// Status de cada item (Pronto / Atenção / Bloqueado), somando os itens anteriores da lista.
// ---------------------------------------------------------------------------
export type LinhaPendente = { id: number; item: ItemPendente; lastError: string | null; sourceText: string | null; viaVoz: boolean; createdAt: string };

export async function avaliarItens(ctx: Ctx, cad: Cadastros, linhas: LinhaPendente[]): Promise<Map<number, Avaliacao>> {
  const resultado = new Map<number, Avaliacao>();
  const hoje = fuelLocalDay();
  const produtosItens = linhas.filter((linha): linha is LinhaPendente & { item: ItemProduto } => linha.item.tipo === "SAIDA_PRODUTO");
  const combustivelItens = linhas.filter((linha): linha is LinhaPendente & { item: ItemCombustivel } => linha.item.tipo === "SAIDA_COMBUSTIVEL");

  // Estoque atual, saída média (90 dias) e quantidade habitual por saída (365 dias) dos produtos da lista.
  const idsProduto = [...new Set(produtosItens.flatMap((linha) => (linha.item.produto ? [linha.item.produto.id] : [])))];
  const saldo = new Map<string, number>();
  const uso = new Map<string, { saida90: number; linhas: number; media: number }>();
  if (idsProduto.length) {
    const [estoque, historico, ativos] = await Promise.all([
      ctx.db.select({ productId: productFrontStock.productId, frontId: productFrontStock.serviceFrontId, quantity: productFrontStock.quantity }).from(productFrontStock).where(inArray(productFrontStock.productId, idsProduto)),
      ctx.db.execute(sql`SELECT product_id, service_front_id,
          coalesce(sum(-delta) FILTER (WHERE coalesce(movement_date, substr(created_at, 1, 10)) >= ${new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)}), 0)::float AS saida90,
          count(*)::int AS linhas, avg(-delta)::float AS media
        FROM product_stock_movements WHERE product_id IN (${sql.join(idsProduto.map((id) => sql`${id}`), sql`, `)}) AND delta < 0 AND reversed_at IS NULL AND source <> 'ADJUSTMENT'
          AND history_kind IS DISTINCT FROM 'AJUSTE' AND coalesce(movement_date, substr(created_at, 1, 10)) >= ${new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)}
        GROUP BY product_id, service_front_id`),
      ctx.db.select({ id: products.id }).from(products).where(and(inArray(products.id, idsProduto), eq(products.active, true))),
    ]);
    for (const row of estoque) saldo.set(`${row.productId}|${row.frontId}`, Number(row.quantity));
    for (const row of (historico as unknown as { rows: Array<{ product_id: number; service_front_id: number; saida90: number; linhas: number; media: number }> }).rows)
      uso.set(`${row.product_id}|${row.service_front_id}`, { saida90: Number(row.saida90), linhas: Number(row.linhas), media: Number(row.media) });
    const ativosSet = new Set(ativos.map((row) => row.id));
    for (const linha of produtosItens) if (linha.item.produto && !ativosSet.has(linha.item.produto.id)) linha.item.alertas.__inativo = "Produto desativado no cadastro.";
  }
  const pessoas = produtosItens.some((linha) => linha.item.colaborador) ? await cad.pessoas() : [];
  const usado = new Map<string, number>();
  for (const { id, item } of produtosItens) {
    const perguntas = Object.entries(item.duvidas).map(([campo, duvida]) => perguntaDaDuvida(campo, duvida));
    const bloqueios: string[] = []; const avisos = Object.entries(item.alertas).filter(([campo]) => campo !== "__inativo").map(([, texto]) => texto);
    if (item.alertas.__inativo) { bloqueios.push(item.alertas.__inativo); delete item.alertas.__inativo; }
    if (!item.produto && !item.duvidas.produto) perguntas.push("Qual produto?");
    if (!(item.quantidade !== null && item.quantidade > 0) && !item.duvidas.quantidade) perguntas.push("Qual a quantidade?");
    if (!item.destino && !Object.keys(item.duvidas).some((campo) => ["equipamento", "colaborador", "departamento", "terceiro"].includes(campo))) perguntas.push("Para quem/onde vai: equipamento, colaborador, departamento ou terceiro?");
    if (item.destino === "TERCEIRO" && !item.recebidoPor) perguntas.push(`Quem recebeu os produtos em ${item.terceiro?.nome ?? "terceiro"}?`);
    if (!ctx.user.permissions.includes("stock.exits_create")) bloqueios.push("Seu usuário não tem permissão para lançar saída de produtos (Movimentação).");
    if (item.data > hoje) bloqueios.push("A data da saída não pode ser futura.");
    if (item.colaborador) { const pessoa = pessoas.find((row) => row.id === item.colaborador!.id); if (!pessoa || !pessoa.ativo) bloqueios.push(`${item.colaborador.nome} está demitido ou não existe mais no cadastro.`); }
    if (item.produto && item.frente && item.quantidade && item.quantidade > 0) {
      const chave = `${item.produto.id}|${item.frente.id}`;
      const atual = saldo.get(chave) ?? 0;
      const antes = usado.get(chave) ?? 0;
      usado.set(chave, antes + item.quantidade);
      const resta = atual - antes - item.quantidade;
      if (resta < 0) bloqueios.push(`Estoque insuficiente em ${item.frente.nome}: saldo ${numeroBr(atual)}${antes ? ` (${numeroBr(antes)} já em outros itens da lista)` : ""}, pedido ${numeroBr(item.quantidade)}.`);
      else {
        const dados = uso.get(chave);
        const mensal = dados ? dados.saida90 / 3 : 0;
        if (resta === 0) avisos.push(`O estoque de ${item.produto.nome} em ${item.frente.nome} vai ficar zerado.`);
        else if (mensal > 0 && resta < mensal) avisos.push(`Estoque vai ficar baixo: restam ${numeroBr(resta)} (saída média ${numeroBr(mensal, 1)}/mês).`);
        if (dados && dados.linhas >= 3 && item.quantidade > Math.max(dados.media * 3, dados.media + 2)) avisos.push(`Quantidade acima do habitual (média ${numeroBr(dados.media, 1)} por saída).`);
      }
    }
    resultado.set(id, fecharAvaliacao(bloqueios, avisos, perguntas));
  }

  if (combustivelItens.length) {
    const index = await cad.equipamentos();
    const frentes = [...new Set(combustivelItens.flatMap((linha) => (linha.item.frente ? [linha.item.frente.id] : [])))];
    const saldos = frentes.length ? await fuelBalances(ctx.db, frentes, "0000-01-01", "9999-12-31") : new Map();
    const idsEquip = [...new Set(combustivelItens.flatMap((linha) => (linha.item.equipamento ? [linha.item.equipamento.id] : [])))];
    const historicoFrota = new Map<number, Fueling[]>();
    if (idsEquip.length) {
      const rows = await ctx.db.select({ id: fuelMovements.id, equipmentId: fuelMovements.equipmentId, date: fuelMovements.movementDate, liters: fuelMovements.quantity, reading: fuelMovements.meterReading, fullTank: fuelMovements.fullTank, readingException: fuelMovements.readingException })
        .from(fuelMovements).where(and(inArray(fuelMovements.equipmentId, idsEquip), isNull(fuelMovements.deletedAt), eq(fuelMovements.movementType, "SAIDA"), eq(fuelMovements.balanceAdjustment, false)));
      for (const row of rows) historicoFrota.set(row.equipmentId!, [...(historicoFrota.get(row.equipmentId!) ?? []), { id: row.id, date: row.date, liters: row.liters, reading: row.reading, fullTank: row.fullTank, readingException: row.readingException }]);
    }
    const idsVeiculo = [...new Set(combustivelItens.flatMap((linha) => (linha.item.veiculo ? [linha.item.veiculo.id] : [])))];
    const historicoVeiculo = idsVeiculo.length ? await vehicleFuelings(ctx.db, idsVeiculo) : new Map();
    const terceiros = await cad.terceiros();
    const usadoComb = new Map<string, number>();
    for (const { id, item } of combustivelItens) {
      const perguntas = Object.entries(item.duvidas).map(([campo, duvida]) => perguntaDaDuvida(campo, duvida));
      const bloqueios: string[] = []; const avisos = Object.values(item.alertas);
      if (!item.combustivel && !item.duvidas.combustivel) perguntas.push("Qual combustível?");
      if (!(item.litros !== null && item.litros > 0) && !item.duvidas.litros) perguntas.push("Quantos litros?");
      if (!item.alvo && !item.duvidas.equipamento && !item.duvidas.terceiro) perguntas.push("Qual veículo/equipamento (código da frota ou placa do terceiro)?");
      if (!item.responsavel && !item.duvidas.responsavel) perguntas.push("Quem é o motorista/responsável?");
      if (!ctx.user.permissions.includes("fuel.register")) bloqueios.push("Seu usuário não tem permissão para lançar combustível.");
      const historico = item.equipamento ? historicoFrota.get(item.equipamento.id) ?? [] : item.veiculo ? (historicoVeiculo.get(item.veiculo.id) ?? []) as Fueling[] : [];
      if (item.alvo === "FROTA" && item.equipamento) {
        const equip = index.fleet.find((row) => row.id === item.equipamento!.id);
        if (!equip) bloqueios.push(`Equipamento ${item.equipamento.prefixo} não encontrado nas suas frentes.`);
        else if (item.frente && item.combustivel && item.litros) {
          const problema = validateFuelMovement({
            serviceFrontId: item.frente.id, stockLocation: item.estoque, fuelTypeId: item.combustivel.id, movementType: "SAIDA", movementDate: item.data, quantity: item.litros,
            equipmentId: equip.id, meterReading: item.leitura, destinationFrontId: null, destinationLocation: null, thirdParty: false, thirdPartyKind: null,
            thirdPartyDescription: null, providerCompany: null, providerEquipment: null, unitPrice: null, responsible: item.responsavel?.nome ?? "—",
          }, { id: equip.id, prefix: equip.prefix, serviceFrontId: equip.serviceFrontId, frontName: equip.frontName }, hoje);
          if (problema) bloqueios.push(problema);
        }
        if (equip && item.leitura !== null) {
          const atual = equip.controlType === "KM" ? equip.currentKm : equip.currentHours;
          const unidade = equip.controlType === "KM" ? "km" : "h";
          if (atual !== null && atual !== undefined && item.leitura < Number(atual)) bloqueios.push(`Leitura ${numeroBr(item.leitura)} ${unidade} menor que a atual do ${equip.prefix} (${numeroBr(Number(atual))} ${unidade}).`);
          else if (item.litros) {
            const medidor: MeterType = equip.controlType === "KM" ? "KM" : "HORIMETRO";
            const deste = computeConsumption(medidor, [...historico, { id: -1, date: item.data, liters: item.litros, reading: item.leitura, fullTank: item.tanqueCheio }]).get(-1) ?? null;
            const media = averageConsumption(medidor, [...computeConsumption(medidor, historico).values()]).value;
            if (deste && isOutlier(deste.value, media)) avisos.push(`Consumo fora da média: ${numeroBr(deste.value)} ${CONSUMPTION_UNITS[medidor]} (média do ${equip.prefix}: ${numeroBr(media)} ${CONSUMPTION_UNITS[medidor]}).`);
          }
        }
      } else if (item.terceiro && item.litros) {
        const terceiro = terceiros.find((row) => row.id === item.terceiro!.id);
        if (!terceiro) bloqueios.push(`${item.terceiro.nome} está inativo ou não existe mais no cadastro de terceiros.`);
        else if (!item.veiculo && terceiro.tipo !== "PESSOA_FISICA") { if (!item.duvidas.equipamento) perguntas.push(`Qual veículo de ${terceiro.nome} (placa)?`); }
        else if (item.veiculo && item.leitura === null) { if (!item.duvidas.leitura) perguntas.push(`Qual a leitura ${item.veiculo.medidor === "KM" ? "do hodômetro (km)" : "do horímetro (h)"} do ${item.veiculo.placa}?`); }
        else {
          // Mesmas conferências do formulário (leitura menor que a última, tanque, consumo): read-only.
          let confirmTank = false; let confirmOutlier = false;
          for (let tentativa = 0; tentativa < 3; tentativa++) {
            try {
              await prepareThirdPartyFuel(ctx.db, ctx.user, {
                mode: item.alvo === "PRESTADOR" ? "PRESTADOR" : "GERAL", thirdPartyId: terceiro.id, vehicleId: item.veiculo?.id ?? null, reading: item.leitura, fullTank: item.tanqueCheio,
                quantity: item.litros, movementDate: item.data, notes: item.observacao, readingException: false, confirmTank, confirmOutlier, editingId: null, current: null,
              });
              break;
            } catch (error) {
              if (!(error instanceof ThirdPartyError)) throw error;
              const confirmar = error.extra.confirm;
              if (confirmar === "TANK") { avisos.push(error.message.replace(" Confirme se está certo.", "")); confirmTank = true; continue; }
              if (confirmar === "OUTLIER") { avisos.push(error.message.replace(/ Confirme para lançar.*$/, "")); confirmOutlier = true; continue; }
              bloqueios.push(error.message.replace(/ Marque a exceção.*$| Só ADMIN\/GESTOR.*$/, "")); break;
            }
          }
        }
      }
      // Quantidade acima do habitual (média dos últimos 10 abastecimentos do veículo).
      if (item.litros && historico.length >= 3) {
        const ultimos = [...historico].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 10);
        const media = ultimos.reduce((soma, row) => soma + row.liters, 0) / ultimos.length;
        if (item.litros > media * 2) avisos.push(`Quantidade acima do habitual (média ${numeroBr(media, 0)} L por abastecimento).`);
      }
      if (item.data > hoje) bloqueios.push("A data do lançamento não pode ser futura.");
      if (item.frente && item.combustivel && item.litros) {
        const chave = `${item.frente.id}|${item.estoque}|${item.combustivel.id}`;
        const atual = saldos.get(item.combustivel.id)?.byFront.get(item.frente.id)?.byLocation[item.estoque]?.balance ?? 0;
        const antes = usadoComb.get(chave) ?? 0;
        usadoComb.set(chave, antes + item.litros);
        if (atual - antes - item.litros < 0) bloqueios.push(`Saldo de ${item.combustivel.nome} insuficiente em ${item.frente.nome} (${item.estoque === "PORTO" ? "Porto" : "Frente"}): ${numeroBr(atual)} L${antes ? ` (${numeroBr(antes)} L já em outros itens da lista)` : ""}, pedido ${numeroBr(item.litros)} L.`);
      }
      resultado.set(id, fecharAvaliacao(bloqueios, [...new Set(avisos)], perguntas));
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Leitura, gravação e remoção da lista (só a tabela de pendentes)
// ---------------------------------------------------------------------------
export type PendenteVisivel = {
  id: number; tipo: TipoItem; tipoRotulo: string; descricao: string; destino: string | null; item: ItemPendente; avaliacao: Avaliacao;
  ultimoErro: string | null; textoOriginal: string | null; viaVoz: boolean; criadoEm: string;
};
export type ListaPendentes = {
  itens: PendenteVisivel[];
  resumo: { total: number; prontos: number; atencao: number; bloqueados: number; produtos: number; quantidadeProdutos: number; combustivel: number; litros: number };
  podeLancar: boolean;
  frentes: Ref[];
};

const lerItem = (payload: string): ItemPendente => JSON.parse(payload) as ItemPendente;

async function linhasDoUsuario(db: Db, userId: number): Promise<LinhaPendente[]> {
  const rows = await db.select().from(assistantPendingItems).where(eq(assistantPendingItems.userId, userId)).orderBy(asc(assistantPendingItems.id));
  return rows.map((row) => ({ id: row.id, item: lerItem(row.payload), lastError: row.lastError, sourceText: row.sourceText, viaVoz: row.viaVoz, createdAt: row.createdAt }));
}

export const podeLancarPendentes = (user: Ctx["user"]) => assistantConfig().launchProfiles.includes(user.profile);

export async function listarPendentes(ctx: Ctx, cad: Cadastros = cadastros(ctx)): Promise<ListaPendentes> {
  const linhas = await linhasDoUsuario(ctx.db, ctx.user.id);
  const avaliacoes = await avaliarItens(ctx, cad, linhas);
  const itens = linhas.map((linha): PendenteVisivel => ({
    id: linha.id, tipo: linha.item.tipo, tipoRotulo: TIPO_ROTULO[linha.item.tipo], descricao: descreverItem(linha.item), destino: destinoTexto(linha.item), item: linha.item,
    avaliacao: avaliacoes.get(linha.id) ?? fecharAvaliacao([], [], []), ultimoErro: linha.lastError, textoOriginal: linha.sourceText, viaVoz: linha.viaVoz, criadoEm: linha.createdAt,
  }));
  for (const item of itens) if (item.ultimoErro) item.avaliacao = { ...item.avaliacao, avisos: [`Falhou ao lançar: ${item.ultimoErro}`, ...item.avaliacao.avisos], status: item.avaliacao.status === "PRONTO" ? "ATENCAO" : item.avaliacao.status };
  const produtos = itens.filter((row) => row.item.tipo === "SAIDA_PRODUTO");
  const combustivel = itens.filter((row) => row.item.tipo === "SAIDA_COMBUSTIVEL");
  return {
    itens,
    resumo: {
      total: itens.length, prontos: itens.filter((row) => row.avaliacao.status === "PRONTO").length, atencao: itens.filter((row) => row.avaliacao.status === "ATENCAO").length,
      bloqueados: itens.filter((row) => row.avaliacao.status === "BLOQUEADO").length,
      produtos: produtos.length, quantidadeProdutos: produtos.reduce((soma, row) => soma + ((row.item as ItemProduto).quantidade ?? 0), 0),
      combustivel: combustivel.length, litros: combustivel.reduce((soma, row) => soma + ((row.item as ItemCombustivel).litros ?? 0), 0),
    },
    podeLancar: podeLancarPendentes(ctx.user),
    frentes: (await cad.frentes()).map(ref),
  };
}

export async function adicionarPendente(ctx: Ctx, campos: CamposPedido, origem: { texto?: string | null; viaVoz?: boolean } = {}) {
  const total = (await ctx.db.select({ total: sql<number>`count(*)::int` }).from(assistantPendingItems).where(eq(assistantPendingItems.userId, ctx.user.id)))[0]?.total ?? 0;
  if (total >= LIMITE_PENDENTES) throw new PendenteError(`A lista já tem ${LIMITE_PENDENTES} lançamentos pendentes. Lance ou remova alguns antes de adicionar mais.`);
  const cad = cadastros(ctx);
  const item = await montarItem(ctx, cad, null, campos);
  const [row] = await ctx.db.insert(assistantPendingItems).values({
    userId: ctx.user.id, kind: item.tipo, payload: JSON.stringify(item), sourceText: origem.texto?.slice(0, 1000) ?? null, viaVoz: origem.viaVoz === true, requestId: randomUUID(),
  }).returning({ id: assistantPendingItems.id });
  return { id: row.id, lista: await listarPendentes(ctx, cad) };
}

async function linhaDoUsuario(ctx: Ctx, id: number) {
  const row = (await ctx.db.select().from(assistantPendingItems).where(and(eq(assistantPendingItems.id, id), eq(assistantPendingItems.userId, ctx.user.id))).limit(1))[0];
  if (!row) throw new PendenteError("Item não encontrado na sua lista de lançamentos pendentes.", 404);
  return row;
}

export async function editarPendente(ctx: Ctx, id: number, campos: CamposPedido) {
  const row = await linhaDoUsuario(ctx, id);
  const cad = cadastros(ctx);
  const item = await montarItem(ctx, cad, lerItem(row.payload), campos);
  await ctx.db.update(assistantPendingItems).set({ payload: JSON.stringify(item), lastError: null, updatedAt: new Date().toISOString() }).where(eq(assistantPendingItems.id, id));
  return { id, lista: await listarPendentes(ctx, cad) };
}

export async function removerPendentes(ctx: Ctx, ids: number[] | "TODOS") {
  const condicao = ids === "TODOS" ? eq(assistantPendingItems.userId, ctx.user.id) : and(eq(assistantPendingItems.userId, ctx.user.id), inArray(assistantPendingItems.id, ids.length ? ids : [-1]));
  const removidos = await ctx.db.delete(assistantPendingItems).where(condicao).returning({ id: assistantPendingItems.id, payload: assistantPendingItems.payload });
  return { removidos: removidos.map((row) => ({ id: row.id, descricao: descreverItem(lerItem(row.payload)) })), lista: await listarPendentes(ctx) };
}

// ---------------------------------------------------------------------------
// "Lançar tudo" (só pela rota, depois do "Confirmar"): grava cada item pronto/atenção com as funções
// dos formulários, um por vez (cada um na sua transação). Gravados saem da lista; falhas ficam com o motivo.
// ---------------------------------------------------------------------------
export type ResultadoLancamento = {
  lancados: Array<{ id: number; descricao: string; mensagem: string }>;
  falharam: Array<{ id: number; descricao: string; erro: string }>;
  bloqueados: Array<{ id: number; descricao: string; motivo: string }>;
  notas: string[];
  lista: ListaPendentes;
};

export async function lancarPendentes(ctx: Ctx, ids?: number[]): Promise<ResultadoLancamento> {
  if (!podeLancarPendentes(ctx.user)) throw new PendenteError("Só ADMIN e GESTOR podem usar o “Lançar tudo”. Peça a um gestor para conferir e lançar.", 403);
  const inicio = Date.now();
  const cad = cadastros(ctx);
  const linhas = (await linhasDoUsuario(ctx.db, ctx.user.id)).filter((linha) => !ids || ids.includes(linha.id));
  const avaliacoes = await avaliarItens(ctx, cad, linhas);
  const resultado: Omit<ResultadoLancamento, "lista"> = { lancados: [], falharam: [], bloqueados: [], notas: [] };
  const index = await cad.equipamentos();
  const d1 = await getD1();
  for (const linha of linhas) {
    const descricao = descreverItem(linha.item);
    const avaliacao = avaliacoes.get(linha.id)!;
    if (avaliacao.status === "BLOQUEADO") { resultado.bloqueados.push({ id: linha.id, descricao, motivo: [...avaliacao.bloqueios, ...avaliacao.perguntas].join(" ") }); continue; }
    // Reserva o item (outra aba/clique não lança o mesmo item ao mesmo tempo).
    const agora = new Date().toISOString();
    const reservado = await ctx.db.update(assistantPendingItems).set({ launchingAt: agora })
      .where(and(eq(assistantPendingItems.id, linha.id), eq(assistantPendingItems.userId, ctx.user.id), or(isNull(assistantPendingItems.launchingAt), lt(assistantPendingItems.launchingAt, new Date(Date.now() - LANCANDO_EXPIRA_MS).toISOString()))))
      .returning({ requestId: assistantPendingItems.requestId });
    if (!reservado.length) { resultado.falharam.push({ id: linha.id, descricao, erro: "Este item já está sendo lançado em outra tela." }); continue; }
    try {
      const mensagem = linha.item.tipo === "SAIDA_PRODUTO" ? await gravarProduto(ctx, linha.item) : await gravarCombustivel(ctx, linha.item, reservado[0].requestId, index, d1, resultado.notas);
      await ctx.db.delete(assistantPendingItems).where(eq(assistantPendingItems.id, linha.id));
      resultado.lancados.push({ id: linha.id, descricao, mensagem });
    } catch (error) {
      const conhecido = error instanceof StockError || error instanceof FuelCreateError || error instanceof ThirdPartyError || error instanceof PendenteError;
      if (!conhecido) console.error("[assistente.lancar]", error);
      const erro = conhecido ? (error as Error).message : "Erro inesperado ao gravar este item.";
      await ctx.db.update(assistantPendingItems).set({ launchingAt: null, lastError: erro.slice(0, 500), updatedAt: new Date().toISOString() }).where(eq(assistantPendingItems.id, linha.id));
      resultado.falharam.push({ id: linha.id, descricao, erro });
    }
  }
  try {
    await ctx.db.insert(assistantLogs).values({
      userId: ctx.user.id, kind: "LANCAR", question: `Lançar tudo: ${linhas.length} item(ns)`, status: "OK", durationMs: Date.now() - inicio,
      answer: JSON.stringify({ lancados: resultado.lancados, falharam: resultado.falharam, bloqueados: resultado.bloqueados.map((row) => row.id), notas: resultado.notas }).slice(0, 30000),
    });
  } catch (error) { console.error("[assistente.lancar.log]", error); }
  return { ...resultado, lista: await listarPendentes(ctx) };
}

const DESTINO_SAIDA = { EQUIPAMENTO: "EQUIPMENT", COLABORADOR: "EMPLOYEE", DEPARTAMENTO: "DEPARTMENT", TERCEIRO: "THIRD_PARTY" } as const;

async function gravarProduto(ctx: Ctx, item: ItemProduto) {
  if (!ctx.user.permissions.includes("stock.exits_create")) throw new PendenteError("Seu usuário não tem permissão para lançar saída de produtos.", 403);
  const terceiro = item.destino === "TERCEIRO";
  const criado = await createStockExit(ctx.db, ctx.user, {
    serviceFrontId: item.frente!.id, exitDate: item.data, destinationType: DESTINO_SAIDA[item.destino!],
    employeeId: terceiro ? null : item.colaborador?.id ?? null, equipmentId: terceiro ? null : item.equipamento?.id ?? null, departmentId: terceiro ? null : item.departamento?.id ?? null,
    thirdPartyId: terceiro ? item.terceiro?.id ?? null : null, thirdPartyVehicleId: terceiro ? item.veiculoTerceiro?.id ?? null : null, receivedBy: terceiro ? item.recebidoPor : null,
    notes: [item.observacao, "Lançado pelo Assistente JC"].filter(Boolean).join(" — "),
    items: [{ productId: item.produto!.id, quantity: item.quantidade! }], allowNegative: false, createdVia: "ASSISTENTE",
  });
  return `Saída ${criado.number} lançada e estoque atualizado.`;
}

async function gravarCombustivel(ctx: Ctx, item: ItemCombustivel, requestId: string, index: EquipmentIndex, d1: Awaited<ReturnType<typeof getD1>>, notas: string[]) {
  if (!ctx.user.permissions.includes("fuel.register")) throw new PendenteError("Seu usuário não tem permissão para lançar combustível.", 403);
  const frota = item.alvo === "FROTA";
  const result = await createFuelMovement(ctx.db, ctx.user, {
    serviceFrontId: item.frente!.id, fuelTypeId: item.combustivel!.id, movementType: "SAIDA", movementDate: item.data, quantity: item.litros, stockLocation: item.estoque,
    notes: [item.observacao, "Lançado pelo Assistente JC"].filter(Boolean).join(" — "), responsible: item.responsavel?.nome ?? null, responsibleEmployeeId: item.responsavel?.id ?? null,
    clientRequestId: requestId, thirdParty: !frota, thirdPartyKind: frota ? null : item.alvo === "PRESTADOR" ? "PRESTADOR" : "GERAL",
    ...(frota
      ? { equipmentId: item.equipamento!.id, meterReading: item.leitura }
      // Avisos de tanque e consumo já foram mostrados no painel antes do "Confirmar".
      : { thirdPartyId: item.terceiro!.id, thirdPartyVehicleId: item.veiculo?.id ?? null, thirdPartyReading: item.leitura, fullTank: item.tanqueCheio, confirmTank: true, confirmOutlier: true, readingException: false }),
  }, { displayedFronts: ctx.displayed, createdVia: "ASSISTENTE" });
  // Frota: leitura maior que a atual atualiza o equipamento (ciclos e alertas) — mesma regra da importação de fichas.
  if (frota && item.leitura !== null && !result.duplicate) {
    const equip = index.fleet.find((row) => row.id === item.equipamento!.id);
    const unidade = equip?.controlType === "KM" ? "KM" : "HOURS";
    const atual = equip ? Number(unidade === "KM" ? equip.currentKm : equip.currentHours) : null;
    if (equip && equip.controlType !== "HOURS_KM" && atual !== null && item.leitura > atual) {
      try {
        await saveReading(d1, {
          equipmentId: equip.id, readingDate: `${item.data}T12:00`, hours: unidade === "HOURS" ? item.leitura : null, km: unidade === "KM" ? item.leitura : null,
          operator: item.responsavel?.nome ?? ctx.user.name, notes: `Abastecimento lançado pelo Assistente JC (${numeroBr(item.litros)} L, ${dataBr(item.data)})`, serviceFrontId: equip.serviceFrontId,
          actor: { id: ctx.user.id, name: ctx.user.name, profile: ctx.user.profile }, source: "ASSISTENTE",
        });
      } catch (error) {
        notas.push(`${equip.prefix}: lançado, mas a leitura do equipamento não foi atualizada${error instanceof ReadingOperationError ? ` (${error.message})` : ""}.`);
      }
    }
  }
  return result.message;
}

export { cadastros as carregarCadastros };
