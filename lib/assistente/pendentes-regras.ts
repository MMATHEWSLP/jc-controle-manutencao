// ---------------------------------------------------------------------------
// Lançamentos pendentes do Assistente JC — regras puras (sem banco), testadas em
// tests/assistente-pendentes.test.mjs.
//  - Tipos do item guardado em assistant_pending_items.payload.
//  - Busca de produto (TAG primeiro, depois nome sem acento/maiúsculas) e de pessoa (Funcionários).
//  - Textos curtos para a lista e para a confirmação da assistente.
// Nada aqui grava: a gravação é só no "Lançar tudo" (lib/assistente/pendentes.ts).
// ---------------------------------------------------------------------------

export const TIPOS_ITEM = ["SAIDA_PRODUTO", "SAIDA_COMBUSTIVEL"] as const;
export type TipoItem = typeof TIPOS_ITEM[number];
export const TIPO_ROTULO: Record<TipoItem, string> = { SAIDA_PRODUTO: "Saída de produto", SAIDA_COMBUSTIVEL: "Saída de combustível" };

export type Ref = { id: number; nome: string };
export type Opcao = { id: number; rotulo: string };
// Campo que ainda não foi resolvido: o que a pessoa disse, por que não deu e as opções (até 5).
export type Duvida = { pedido: string; motivo: string; opcoes: Opcao[] };

export type DestinoProduto = "EQUIPAMENTO" | "COLABORADOR" | "DEPARTAMENTO" | "TERCEIRO";

type Base = {
  frente: Ref | null;
  data: string; // AAAA-MM-DD
  observacao: string | null;
  duvidas: Record<string, Duvida>;
  // Avisos da localização no cadastro (ex.: TAG que não bate com a descrição dita), por campo.
  alertas: Record<string, string>;
};

export type ItemProduto = Base & {
  tipo: "SAIDA_PRODUTO";
  produto: { id: number; tag: string; nome: string } | null;
  quantidade: number | null;
  destino: DestinoProduto | null;
  equipamento: { id: number; prefixo: string } | null;
  colaborador: Ref | null;
  departamento: (Ref & { inferido?: boolean }) | null;
  terceiro: Ref | null;
  veiculoTerceiro: { id: number; placa: string } | null;
  recebidoPor: string | null;
};

export type AlvoCombustivel = "FROTA" | "TERCEIRO" | "PRESTADOR";
export type ItemCombustivel = Base & {
  tipo: "SAIDA_COMBUSTIVEL";
  combustivel: Ref | null;
  estoque: "FRENTE" | "PORTO";
  litros: number | null;
  alvo: AlvoCombustivel | null;
  equipamento: { id: number; prefixo: string; controle: "HOURS" | "KM" | "HOURS_KM" } | null;
  terceiro: Ref | null;
  veiculo: { id: number; placa: string; medidor: "KM" | "HORIMETRO" } | null;
  leitura: number | null;
  tanqueCheio: boolean;
  // id null = nome digitado (fora do cadastro), aceito só com confirmação.
  responsavel: { id: number | null; nome: string } | null;
};

export type ItemPendente = ItemProduto | ItemCombustivel;

export type StatusItem = "PRONTO" | "ATENCAO" | "BLOQUEADO";
export const STATUS_ROTULO: Record<StatusItem, string> = { PRONTO: "Pronto", ATENCAO: "Atenção", BLOQUEADO: "Bloqueado" };
export type Avaliacao = {
  status: StatusItem;
  incompleto: boolean;
  // Perguntas que a assistente faz para completar o item (o que falta / qual das opções).
  perguntas: string[];
  bloqueios: string[];
  avisos: string[];
};

// ---------------------------------------------------------------------------
// Texto: sem acento, minúsculo, só letras/números; plural simples vira singular ("correntes" → "corrente").
// ---------------------------------------------------------------------------
const PALAVRAS_VAZIAS = new Set(["de", "da", "do", "das", "dos", "para", "pra", "pro", "com", "e", "a", "o", "as", "os", "um", "uma", "no", "na", "em", "tag", "produto", "item"]);

export const semAcento = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function singular(palavra: string) {
  if (palavra.length > 4 && palavra.endsWith("oes")) return `${palavra.slice(0, -3)}ao`;
  if (palavra.length > 4 && palavra.endsWith("aes")) return `${palavra.slice(0, -3)}ao`;
  if (palavra.length > 4 && /(r|z|l)es$/.test(palavra)) return palavra.slice(0, -2);
  if (palavra.length > 3 && palavra.endsWith("s") && !palavra.endsWith("ss")) return palavra.slice(0, -1);
  return palavra;
}

export function palavras(texto: string, comVazias = false) {
  return semAcento(texto).replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean)
    .filter((palavra) => comVazias || !PALAVRAS_VAZIAS.has(palavra)).map(singular);
}

const chaveTag = (tag: string) => semAcento(tag).replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, "");

// Distância de edição (para nomes falados com erro: "Claudilsom" ≈ "Claudilson").
export function distancia(a: string, b: string) {
  if (a === b) return 0;
  const linha = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0]; linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return linha[b.length];
}

// ---------------------------------------------------------------------------
// Produto: TAG (quando dita) tem prioridade; depois nome/referência. Mais de um candidato = pergunta.
// ---------------------------------------------------------------------------
export type ProdutoBusca = { id: number; tag: string; nome: string; referencias?: string[]; saldo?: number };
export type ResultadoBusca<T> = { escolhido: T | null; opcoes: T[]; motivo: string | null; aviso?: string | null };

export function buscarProduto(produtos: ProdutoBusca[], pedido: { texto?: string | null; tag?: string | null }): ResultadoBusca<ProdutoBusca> {
  const texto = (pedido.texto ?? "").trim();
  let tag = (pedido.tag ?? "").trim();
  // "TAG 11" dito no meio do texto.
  if (!tag) tag = /\btag\s*[:nº#-]?\s*([a-z0-9-]+)/i.exec(semAcento(texto))?.[1] ?? "";
  const descricao = texto.replace(/\btag\s*[:nº#-]?\s*[a-z0-9-]+/i, " ").trim();
  if (tag) {
    const chave = chaveTag(tag);
    const achados = produtos.filter((produto) => chaveTag(produto.tag) === chave);
    if (achados.length === 1) {
      // Confere se a descrição dita bate com o nome da TAG (evita lançar o produto errado por TAG trocada).
      const ditas = palavras(descricao).filter((palavra) => palavra.length > 2);
      const nome = new Set(palavras(achados[0].nome));
      const bate = ditas.length === 0 || ditas.some((palavra) => nome.has(palavra) || [...nome].some((item) => item.startsWith(palavra)));
      return { escolhido: achados[0], opcoes: [], motivo: null, aviso: bate ? null : `A TAG ${achados[0].tag} é "${achados[0].nome}", que não parece ser "${descricao}". Confira.` };
    }
    if (achados.length > 1) return { escolhido: null, opcoes: achados.slice(0, 5), motivo: `mais de um produto com a TAG ${tag}` };
    if (!descricao) return { escolhido: null, opcoes: [], motivo: `nenhum produto com a TAG ${tag}` };
  }
  const ditas = palavras(descricao);
  if (ditas.length === 0) return { escolhido: null, opcoes: [], motivo: "produto não informado" };
  const pontuados = produtos.map((produto) => {
    const nome = palavras(produto.nome);
    const extras = (produto.referencias ?? []).flatMap((referencia) => palavras(referencia));
    const todas = new Set([...nome, ...extras]);
    const casa = (palavra: string) => todas.has(palavra) || (palavra.length >= 3 && [...todas].some((item) => item.startsWith(palavra)));
    const acertos = ditas.filter(casa).length;
    const exato = nome.join(" ") === ditas.join(" ");
    return { produto, acertos, exato, sobra: nome.length - acertos };
  });
  const exatos = pontuados.filter((item) => item.exato);
  if (exatos.length === 1) return { escolhido: exatos[0].produto, opcoes: [], motivo: null };
  const completos = pontuados.filter((item) => item.acertos === ditas.length)
    .sort((a, b) => a.sobra - b.sobra || Number((b.produto.saldo ?? 0) > 0) - Number((a.produto.saldo ?? 0) > 0) || a.produto.nome.localeCompare(b.produto.nome));
  if (completos.length === 1) return { escolhido: completos[0].produto, opcoes: [], motivo: null };
  if (completos.length > 1) return { escolhido: null, opcoes: completos.slice(0, 5).map((item) => item.produto), motivo: `${completos.length} produtos combinam com "${descricao}"` };
  // Nada com todas as palavras: parecidos (maioria das palavras), sempre como pergunta.
  const minimo = Math.max(1, Math.ceil(ditas.length * 0.6));
  const parecidos = pontuados.filter((item) => item.acertos >= minimo).sort((a, b) => b.acertos - a.acertos || a.sobra - b.sobra).slice(0, 5).map((item) => item.produto);
  return { escolhido: null, opcoes: parecidos, motivo: parecidos.length ? `não achei exatamente "${descricao}"` : `nenhum produto encontrado para "${descricao}"` };
}

// ---------------------------------------------------------------------------
// Pessoa (cadastro de Funcionários): nome completo, primeiro nome ou parte do nome. Mais de um = pergunta.
// Nome parecido (erro de reconhecimento de voz) nunca é escolhido sozinho: vira opção.
// ---------------------------------------------------------------------------
export type PessoaBusca = { id: number; nome: string; ativo: boolean; frenteId?: number | null; frente?: string | null };

export function buscarPessoa(pessoas: PessoaBusca[], texto: string, frentePreferida?: number | null): ResultadoBusca<PessoaBusca> {
  const ditas = palavras(texto, true).filter((palavra) => !["de", "da", "do", "dos", "das", "e", "o", "a", "seu", "dona", "sr", "sra"].includes(palavra));
  if (ditas.length === 0) return { escolhido: null, opcoes: [], motivo: "nome não informado" };
  const ativos = pessoas.filter((pessoa) => pessoa.ativo);
  const nomeDe = (pessoa: PessoaBusca) => palavras(pessoa.nome, true);
  const exatos = ativos.filter((pessoa) => nomeDe(pessoa).join(" ") === ditas.join(" "));
  if (exatos.length === 1) return { escolhido: exatos[0], opcoes: [], motivo: null };
  const contem = ativos.filter((pessoa) => { const nome = nomeDe(pessoa); return ditas.every((palavra) => nome.some((item) => item === palavra || (palavra.length >= 4 && item.startsWith(palavra)))); });
  const ordenar = (lista: PessoaBusca[]) => [...lista].sort((a, b) => Number(b.frenteId === frentePreferida) - Number(a.frenteId === frentePreferida) || a.nome.localeCompare(b.nome));
  if (contem.length === 1) return { escolhido: contem[0], opcoes: [], motivo: null };
  if (contem.length > 1) return { escolhido: null, opcoes: ordenar(contem).slice(0, 5), motivo: `${contem.length} funcionários com "${texto}" no nome` };
  const parecidos = ativos.filter((pessoa) => {
    const nome = nomeDe(pessoa);
    return ditas.every((palavra) => nome.some((item) => palavra.length >= 4 && distancia(item, palavra) <= (palavra.length >= 7 ? 2 : 1)));
  });
  const demitidos = pessoas.filter((pessoa) => !pessoa.ativo && nomeDe(pessoa).join(" ").includes(ditas.join(" ")));
  if (parecidos.length) return { escolhido: null, opcoes: ordenar(parecidos).slice(0, 5), motivo: `não achei "${texto}" no cadastro; nomes parecidos` };
  return { escolhido: null, opcoes: [], motivo: demitidos.length ? `"${texto}" está como demitido no cadastro` : `"${texto}" não está no cadastro de Funcionários` };
}

// Cadastro simples por nome (departamento, terceiro, combustível): igual, depois "contém".
export function buscarPorNome<T extends { id: number; nome: string }>(lista: T[], texto: string): ResultadoBusca<T> {
  const ditas = palavras(texto);
  if (ditas.length === 0) return { escolhido: null, opcoes: [], motivo: "não informado" };
  const chave = ditas.join(" ");
  const exatos = lista.filter((item) => palavras(item.nome).join(" ") === chave);
  if (exatos.length === 1) return { escolhido: exatos[0], opcoes: [], motivo: null };
  const contem = lista.filter((item) => { const nome = palavras(item.nome); return ditas.every((palavra) => nome.some((parte) => parte === palavra || (palavra.length >= 3 && parte.startsWith(palavra)))); });
  if (contem.length === 1) return { escolhido: contem[0], opcoes: [], motivo: null };
  if (contem.length > 1) return { escolhido: null, opcoes: contem.slice(0, 5), motivo: `mais de um cadastro combina com "${texto}"` };
  return { escolhido: null, opcoes: [], motivo: `"${texto}" não encontrado no cadastro` };
}

// ---------------------------------------------------------------------------
// Datas e textos
// ---------------------------------------------------------------------------
// "hoje", "ontem", "anteontem", "25/09", "25/09/2026", "2026-09-25".
export function lerData(texto: string, hoje: string): string | null {
  const limpo = semAcento(texto).trim();
  const menos = (dias: number) => new Date(Date.parse(`${hoje}T12:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
  if (limpo === "hoje") return hoje;
  if (limpo === "ontem") return menos(1);
  if (limpo === "anteontem") return menos(2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(limpo)) return limpo;
  const br = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(limpo);
  if (!br) return null;
  const ano = br[3] ? (br[3].length === 2 ? `20${br[3]}` : br[3]) : hoje.slice(0, 4);
  const iso = `${ano}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? null : iso;
}

export const numeroBr = (valor: number | null | undefined, casas = 2) => (valor === null || valor === undefined || !Number.isFinite(valor) ? "—" : valor.toLocaleString("pt-BR", { maximumFractionDigits: casas }));
export const dataBr = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso);

export function destinoTexto(item: ItemPendente) {
  if (item.tipo === "SAIDA_COMBUSTIVEL") {
    if (item.alvo === "FROTA") return item.equipamento?.prefixo ?? null;
    return [item.terceiro?.nome, item.veiculo?.placa].filter(Boolean).join(" · ") || null;
  }
  if (item.destino === "TERCEIRO") return [item.terceiro?.nome, item.veiculoTerceiro?.placa, item.recebidoPor ? `recebido por ${item.recebidoPor}` : null].filter(Boolean).join(" · ") || null;
  return [item.equipamento?.prefixo, item.colaborador?.nome, item.departamento ? `${item.departamento.nome}${item.departamento.inferido ? " (pelo histórico)" : ""}` : null].filter(Boolean).join(" · ") || null;
}

// "1 FILTRO DE COMBUSTÍVEL (TAG 11) para PC-20" / "300 L de Diesel S10 no CM-35 (km 140.900)".
export function descreverItem(item: ItemPendente) {
  const destino = destinoTexto(item);
  if (item.tipo === "SAIDA_PRODUTO") {
    const produto = item.produto ? `${item.produto.nome} (TAG ${item.produto.tag})` : item.duvidas.produto ? `"${item.duvidas.produto.pedido}" (produto a confirmar)` : "produto a definir";
    return `${numeroBr(item.quantidade)} ${produto}${destino ? ` para ${destino}` : ""}`;
  }
  const alvo = destino ?? (item.duvidas.equipamento ? `"${item.duvidas.equipamento.pedido}" (a confirmar)` : "veículo a definir");
  const leitura = item.leitura !== null ? ` (${item.alvo === "FROTA" ? (item.equipamento?.controle === "KM" ? "km" : "horímetro") : item.veiculo?.medidor === "KM" ? "km" : "horímetro"} ${numeroBr(item.leitura)})` : "";
  return `${numeroBr(item.litros)} L de ${item.combustivel?.nome ?? "combustível"} no ${alvo}${leitura}${item.responsavel ? `, motorista ${item.responsavel.nome}` : ""}`;
}

// Junta bloqueios, avisos e perguntas num status (Bloqueado > Atenção > Pronto).
export function fecharAvaliacao(bloqueios: string[], avisos: string[], perguntas: string[]): Avaliacao {
  const incompleto = perguntas.length > 0;
  return { status: bloqueios.length || incompleto ? "BLOQUEADO" : avisos.length ? "ATENCAO" : "PRONTO", incompleto, perguntas, bloqueios, avisos };
}

// Pergunta para um campo em dúvida, com as opções numeradas (a assistente repete isso ao usuário).
export function perguntaDaDuvida(campo: string, duvida: Duvida) {
  const nome: Record<string, string> = { produto: "Qual produto", colaborador: "Qual colaborador", responsavel: "Qual motorista/responsável", equipamento: "Qual veículo/equipamento", departamento: "Qual departamento", terceiro: "Qual terceiro", combustivel: "Qual combustível", frente: "Qual frente", veiculoTerceiro: "Qual veículo do terceiro" };
  const opcoes = duvida.opcoes.map((opcao, index) => `${index + 1}) ${opcao.rotulo}`).join("; ");
  return `${nome[campo] ?? campo}? ${duvida.motivo}${opcoes ? `: ${opcoes}` : ""}.`;
}
