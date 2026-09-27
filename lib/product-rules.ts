// Regras puras do cadastro de Produtos (sem banco), testadas em tests/product-rules.test.mjs.

function stripAccents(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Chave de comparação de referência: "W 950", "W-950" e "w950" são a mesma peça.
// A migration 0013 usa a mesma regra em SQL para a carga inicial.
export function normalizeReference(value: string) {
  return stripAccents(value).toUpperCase().replace(/[\s./-]/g, "");
}

// Lista de referências vinda do formulário: aceita array ou texto separado por "/", ";" ou quebra
// de linha. Remove vazias e repetidas (pela chave normalizada), mantendo a ordem digitada.
export function parseReferenceList(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map((item) => String(item ?? "")) : typeof input === "string" ? input.split(/\s\/\s|[;\n]/) : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const reference = item.trim().toUpperCase();
    const key = normalizeReference(reference);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

export function joinReferences(references: string[]) {
  return references.length ? references.join(" / ") : null;
}

// TAG sempre em maiúsculas e sem espaços nas pontas; a unicidade é global (índice único no banco).
export function normalizeTag(value: string) {
  return value.trim().toUpperCase();
}

// Próxima TAG da sequência: as TAGs da base são números (ex.: 2878, 3067). Pega o maior número
// entre as TAGs puramente numéricas e soma 1, mantendo zeros à esquerda se a maior tiver.
export function nextSequentialTag(existing: string[]) {
  let max = 0;
  let width = 0;
  for (const tag of existing) {
    const value = tag.trim();
    if (!/^\d+$/.test(value)) continue;
    const number = Number(value);
    if (number >= max) {
      max = number;
      width = value.length;
    }
  }
  return String(max + 1).padStart(width, "0");
}

// ---------------------------------------------------------------------------
// Nome parecido: normaliza (sem acento, maiúsculas, só letras/números, tokens) e combina duas
// medidas — distância de edição (pega erro de digitação: "ABRACADEIRA" x "ABRAÇADERIA") e
// sobreposição de palavras (pega ordem trocada: "FILTRO OLEO MOTOR" x "FILTRO DO MOTOR OLEO").
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "C", "P", "COM", "PARA", "PRA"]);

export function normalizeProductName(value: string) {
  return stripAccents(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokens(normalized: string) {
  return normalized.split(" ").filter((token) => token && !STOPWORDS.has(token));
}

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function editRatio(a: string, b: string) {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

// Palavras "iguais" admitem 1 erro de digitação quando têm 5+ letras.
function tokenMatches(a: string, b: string) {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false; // medidas/números precisam bater exatamente
  return Math.min(a.length, b.length) >= 5 && levenshtein(a, b) <= 1;
}

function tokenDice(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let matches = 0;
  for (const token of a) {
    const index = remaining.findIndex((candidate) => tokenMatches(token, candidate));
    if (index >= 0) {
      matches++;
      remaining.splice(index, 1);
    }
  }
  return (2 * matches) / (a.length + b.length);
}

// 0..1. Acima de SIMILARITY_THRESHOLD o cadastro mostra o aviso (não bloqueante).
export function nameSimilarity(a: string, b: string) {
  const left = normalizeProductName(a);
  const right = normalizeProductName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const compactLeft = leftTokens.join("");
  const compactRight = rightTokens.join("");
  if (compactLeft && compactLeft === compactRight) return 0.98;
  const edit = editRatio(compactLeft, compactRight);
  const sortedEdit = editRatio([...leftTokens].sort().join(""), [...rightTokens].sort().join(""));
  const dice = tokenDice(leftTokens, rightTokens);
  const score = Math.max(edit, sortedEdit * 0.97, dice);
  // Medidas/códigos diferentes ("14MM" x "32MM") quase sempre são produtos diferentes.
  const numericLeft = leftTokens.filter((token) => /\d/.test(token)).sort().join(" ");
  const numericRight = rightTokens.filter((token) => /\d/.test(token)).sort().join(" ");
  return numericLeft && numericRight && numericLeft !== numericRight ? score * 0.75 : score;
}

export const SIMILARITY_THRESHOLD = 0.82;

export function findSimilarNames<T extends { name: string }>(name: string, candidates: T[], limit = 5, threshold = SIMILARITY_THRESHOLD) {
  if (normalizeProductName(name).length < 3) return [];
  return candidates
    .map((item) => ({ item, score: nameSimilarity(name, item.name) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
