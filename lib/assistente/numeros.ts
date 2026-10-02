// ---------------------------------------------------------------------------
// Números ditos em português ("cento e quarenta mil e novecentos", "dois", "meia dúzia",
// "trezentos e cinquenta litros") ou escritos no formato brasileiro ("140.900", "1,5", "140 900").
// O reconhecimento de voz do navegador às vezes devolve dígitos e às vezes palavras: as duas formas
// valem. Devolve null quando o texto não tem um número reconhecível.
// ---------------------------------------------------------------------------
const UNIDADES: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16,
  dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, cincoenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400,
  quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700,
  oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
};
const MULTIPLICADORES: Record<string, number> = { mil: 1000, milhao: 1_000_000, milhoes: 1_000_000 };
// Palavras que podem aparecer junto do número e não mudam o valor.
const IGNORAR = new Set(["e", "de", "do", "da", "litro", "litros", "l", "unidade", "unidades", "un", "peca", "pecas", "km", "quilometro", "quilometros", "hora", "horas", "h", "o", "a"]);

const semAcento = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// "140.900" / "140 900" / "1.234,5" / "1,5" / "347.5" → número (mesma regra de numberOrNull do Combustível).
function numeroEscrito(texto: string): number | null {
  const limpo = texto.trim().replace(/\s+(?=\d{3}\b)/g, "");
  if (!/^-?[\d.,]+$/.test(limpo)) return null;
  const normalizado = limpo.includes(",") ? limpo.replaceAll(".", "").replace(",", ".") : /^-?\d{1,3}(\.\d{3})+$/.test(limpo) ? limpo.replaceAll(".", "") : limpo;
  const valor = Number(normalizado);
  return Number.isFinite(valor) ? valor : null;
}

export function numeroFalado(entrada: unknown): number | null {
  if (typeof entrada === "number") return Number.isFinite(entrada) ? entrada : null;
  if (typeof entrada !== "string") return null;
  const texto = semAcento(entrada).replace(/[?!;]/g, " ").trim();
  if (!texto) return null;
  const escrito = numeroEscrito(texto.replace(/\s*(litros?|l|km|h|horas?|unidades?|un|pecas?)\.?$/, ""));
  if (escrito !== null) return escrito;
  const palavras = texto.replace(/(\d)\s*([a-z])/g, "$1 $2").split(/[\s-]+/).filter(Boolean);
  let total = 0, grupo = 0, achou = false, meio = 0;
  for (let index = 0; index < palavras.length; index++) {
    const palavra = palavras[index];
    if (palavra === "meia" && (palavras[index + 1] === "duzia" || palavras[index + 1] === "duzias")) { grupo += 6; achou = true; index++; continue; }
    if (palavra === "duzia" || palavra === "duzias") { grupo = (grupo || 1) * 12; achou = true; continue; }
    if (palavra === "par" || palavra === "pares") { grupo = (grupo || 1) * 2; achou = true; continue; }
    if (palavra === "meio" || palavra === "meia") { meio = 0.5; achou = true; continue; }
    if (palavra in UNIDADES) { grupo += UNIDADES[palavra]; achou = true; continue; }
    if (palavra in MULTIPLICADORES) { total += (grupo || 1) * MULTIPLICADORES[palavra]; grupo = 0; achou = true; continue; }
    const digitos = numeroEscrito(palavra);
    if (digitos !== null) { grupo += digitos; achou = true; continue; }
    if (IGNORAR.has(palavra)) continue;
    return null;
  }
  return achou ? total + grupo + meio : null;
}
