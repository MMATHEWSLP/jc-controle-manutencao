// Chave de ordenação alfanumérica "natural" para o prefixo do equipamento: ignora acento/caixa
// e preenche cada sequência de dígitos com zeros à esquerda, para que "EQ-2" ordene antes de
// "EQ-10" numa comparação de texto simples (ORDER BY sort_key no banco).
export function naturalSortKey(prefix: string): string {
  return prefix
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .trim()
    .replace(/\d+/g, (digits) => digits.padStart(10, "0"));
}
