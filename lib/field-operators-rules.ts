// ---------------------------------------------------------------------------
// Regras puras da tela Funcionários de campo (Controle Diário): comparação de nomes, códigos de um
// lote e leitura da planilha de importação. Testadas em tests/field-operators-rules.test.mjs.
// ---------------------------------------------------------------------------
import { nameKey } from "./employee-rules";
import { gerarPin, pinObvio } from "./operadores-regras";

export { nameKey };

function distancia(a: string, b: string) {
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

// IGUAL = mesmo nome sem acento/maiúsculas/espaços (JOSÉ = Jose). PARECIDO = sobrenome faltando,
// erro de grafia ou mesmo primeiro e último nome — a pessoa decide.
export type Semelhanca = "IGUAL" | "SOBRENOME_FALTANDO" | "GRAFIA" | "PRIMEIRO_E_ULTIMO" | null;
export const SEMELHANCA_ROTULO: Record<Exclude<Semelhanca, null>, string> = {
  IGUAL: "Mesmo nome (só acento, maiúsculas ou espaços)", SOBRENOME_FALTANDO: "Sobrenome faltando", GRAFIA: "Grafia parecida", PRIMEIRO_E_ULTIMO: "Mesmo primeiro e último nome",
};

export function semelhanca(a: string, b: string): Semelhanca {
  const ka = nameKey(a); const kb = nameKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return "IGUAL";
  const ta = ka.split(" "); const tb = kb.split(" ");
  const [menor, maior] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (menor.length >= 2 && menor.every((parte) => maior.includes(parte)) && menor[0] === maior[0]) return "SOBRENOME_FALTANDO";
  if (Math.abs(ka.length - kb.length) <= 3 && distancia(ka, kb) <= Math.max(1, Math.floor(Math.min(ka.length, kb.length) / 12))) return "GRAFIA";
  if (ta.length >= 2 && tb.length >= 2 && ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return "PRIMEIRO_E_ULTIMO";
  return null;
}

// Códigos de um lote: o digitado vale (4 a 8 números; com 4, sem os óbvios); quem não tem ganha um
// aleatório de 4 dígitos sem sequências óbvias e sem repetir os demais do lote.
export type PedidoCodigo = { codigo?: string | null; anoNascimento?: string | null };
export function codigosDoLote(pedidos: PedidoCodigo[], aleatorio: (limite: number) => number): { codigos: string[]; erros: Array<string | null> } {
  const usados = new Set<string>();
  const erros: Array<string | null> = pedidos.map(() => null);
  const codigos = pedidos.map(() => "");
  pedidos.forEach((pedido, index) => {
    const codigo = (pedido.codigo ?? "").trim();
    if (!codigo) return;
    if (!/^\d{4,8}$/.test(codigo)) erros[index] = "O código deve ter de 4 a 8 números.";
    else if (codigo.length === 4 && pinObvio(codigo, pedido.anoNascimento)) erros[index] = "Código fácil de adivinhar (sequência, repetido, ano ou nascimento): escolha outro.";
    else if (usados.has(codigo)) erros[index] = "Código repetido no mesmo lote: escolha outro.";
    else { usados.add(codigo); codigos[index] = codigo; }
  });
  pedidos.forEach((pedido, index) => {
    if (codigos[index] || erros[index]) return;
    let codigo = "";
    for (let tentativa = 0; tentativa < 500 && (!codigo || usados.has(codigo)); tentativa++) codigo = gerarPin(aleatorio, pedido.anoNascimento);
    usados.add(codigo); codigos[index] = codigo;
  });
  return { codigos, erros };
}

// ---------------------------------------------------------------------------
// Planilha "Funcionários de campo":
// Nome | Função sugerida | Frente principal | Outras frentes | Equipamentos (setembro) | Lançamentos em setembro | PIN | Conferir
// ---------------------------------------------------------------------------
export type ColunaPlanilha = "nome" | "funcao" | "frentePrincipal" | "outrasFrentes" | "equipamentos" | "lancamentos" | "pin" | "conferir";
const chaveCabecalho = (texto: string) => nameKey(texto).toLowerCase();
const PADROES: Array<[ColunaPlanilha, RegExp]> = [
  ["frentePrincipal", /^frente( principal)?$/], ["outrasFrentes", /^outras? frentes?/], ["funcao", /^func(ao|oes)( sugerida)?$|^cargo$/],
  ["equipamentos", /^equipamentos?/], ["lancamentos", /^lancamentos?/], ["pin", /^(pin|codigo)( de acesso)?$/], ["conferir", /^conferir|^observ/], ["nome", /^nome( completo)?$/],
];

export function mapearCabecalho(cabecalho: string[]): { indices: Partial<Record<ColunaPlanilha, number>>; faltando: string[] } {
  const indices: Partial<Record<ColunaPlanilha, number>> = {};
  cabecalho.forEach((titulo, index) => {
    const chave = chaveCabecalho(titulo ?? "");
    const achado = PADROES.find(([coluna, padrao]) => indices[coluna] === undefined && padrao.test(chave));
    if (achado) indices[achado[0]] = index;
  });
  const faltando = (["nome", "frentePrincipal", "pin"] as ColunaPlanilha[]).filter((coluna) => indices[coluna] === undefined)
    .map((coluna) => ({ nome: "Nome", frentePrincipal: "Frente principal", pin: "PIN" } as Record<string, string>)[coluna]);
  return { indices, faltando };
}

// "Arapiuns, Mamuru" / "Arapiuns; Mamuru" / "Arapiuns e Mamuru" → nomes.
export const separarFrentes = (texto: string) => texto.split(/\s*(?:[,;/|]|\se\s)\s*/i).map((parte) => parte.trim()).filter(Boolean);

// O Excel guarda 0581 como número 581: volta para 4 dígitos.
export function lerPin(valor: unknown): string {
  if (typeof valor === "number" && Number.isInteger(valor) && valor >= 0 && valor < 10_000) return String(valor).padStart(4, "0");
  return String(valor ?? "").replace(/\s/g, "").replace(/\.0+$/, "");
}
