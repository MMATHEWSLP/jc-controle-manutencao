import { MANUAL_ASSISTENTE } from "./manual-texto";

// ---------------------------------------------------------------------------------------------
// ajuda_sistema: "como faço X no sistema". Busca no manual (docs/manual-assistente.md) as seções
// com mais palavras em comum com a pergunta e devolve o texto delas para o modelo responder.
// ---------------------------------------------------------------------------------------------
const STOP = new Set(["como", "faco", "fazer", "para", "que", "uma", "um", "de", "do", "da", "dos", "das", "no", "na", "nos", "nas", "o", "a", "os", "as", "e", "em", "com", "por", "sistema", "eu", "onde", "qual", "quais", "se", "ao", "tela"]);
const key = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (value: string) => key(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word));

export type SecaoManual = { titulo: string; texto: string };

export function secoesDoManual(markdown = MANUAL_ASSISTENTE): SecaoManual[] {
  return markdown.split(/\n(?=## )/).filter((part) => part.startsWith("## ")).map((part) => {
    const [head, ...rest] = part.split("\n");
    return { titulo: head.replace(/^##\s*/, "").trim(), texto: rest.join("\n").trim() };
  });
}

export function buscarNoManual(pergunta: string, limite = 3) {
  const termos = words(pergunta);
  const secoes = secoesDoManual();
  if (!termos.length) return secoes.slice(0, limite);
  const ranked = secoes.map((secao) => {
    const titulo = key(secao.titulo), corpo = key(secao.texto);
    let score = 0;
    for (const termo of termos) {
      const raiz = termo.length > 5 ? termo.slice(0, termo.length - 2) : termo;
      if (titulo.includes(raiz)) score += 3;
      const hits = corpo.split(raiz).length - 1;
      score += Math.min(hits, 4);
    }
    return { secao, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  return ranked.slice(0, limite).map((entry) => entry.secao);
}
