// ---------------------------------------------------------------------------
// Acesso dos operadores (perfil CAMPO ligado ao cadastro de Funcionários) — regras puras, testadas
// em tests/operadores-regras.test.mjs.
// ---------------------------------------------------------------------------

// Mesma grafia das funções em employees.job_title e job_functions.name.
export const normalizarFuncao = (valor: unknown) => (typeof valor === "string" ? valor : "").trim().replace(/\s+/g, " ").toUpperCase();

// PIN "óbvio": todos iguais (1111), sequência crescente/decrescente (1234, 4321, 0123, 9876),
// dois pares repetidos (1212, 1122), ano (19xx/20xx) e o ano de nascimento da pessoa.
export function pinObvio(pin: string, anoNascimento?: string | null) {
  if (!/^\d{4}$/.test(pin)) return true;
  const d = pin.split("").map(Number);
  if (d.every((digito) => digito === d[0])) return true;
  const passos = d.slice(1).map((digito, index) => digito - d[index]);
  if (passos.every((passo) => passo === 1) || passos.every((passo) => passo === -1)) return true;
  if (pin.slice(0, 2) === pin.slice(2)) return true;
  if (d[0] === d[1] && d[2] === d[3]) return true;
  if (/^(19|20)\d\d$/.test(pin)) return true;
  if (anoNascimento && pin === anoNascimento) return true;
  return false;
}

// PIN de 4 dígitos aleatório (crypto), sem os óbvios. aleatorio(n) devolve um inteiro em [0, n).
export function gerarPin(aleatorio: (limite: number) => number, anoNascimento?: string | null) {
  for (let tentativa = 0; tentativa < 200; tentativa++) {
    const pin = String(aleatorio(10_000)).padStart(4, "0");
    if (!pinObvio(pin, anoNascimento)) return pin;
  }
  throw new Error("Não foi possível gerar um PIN.");
}

export type SituacaoFuncionario = "ATIVO" | "FOLGA" | "AFASTADO" | "DEMITIDO";

// Quem tem direito ao acesso: não demitido (folga e afastado mantêm) e função que opera equipamento.
export const deveTerAcesso = (status: SituacaoFuncionario | string, operaEquipamento: boolean) => status !== "DEMITIDO" && operaEquipamento;

export type StatusAcesso = "ATIVO" | "BLOQUEADO" | "DESATIVADO";
export const STATUS_ACESSO_ROTULO: Record<StatusAcesso, string> = { ATIVO: "Ativo", BLOQUEADO: "Bloqueado", DESATIVADO: "Desativado" };
