// Regras puras da correção de "data genérica" dos históricos importados de
// troca de óleo (Parte 1 do pedido). Compartilhadas entre o script de
// correção (corrigir-historico-data-generica.mjs) e os testes automatizados,
// para que a mesma definição de "elegível"/"ambíguo" nunca diverja entre os
// dois.

// 05/07/2026 — dia 5, mês 7. Nunca interpretar como 7 de maio.
export const GENERIC_DATE = "2026-07-05";
export const GENERIC_DATE_SOURCE = "IMPORT_DEFAULT";

export function isValidDateText(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return false;
  return !Number.isNaN(new Date(`${raw.slice(0, 10)}T12:00:00Z`).getTime());
}

// Elegível: representa uma troca importada realmente executada (tem leitura
// registrada), mas ficou sem data de execução válida (nula, vazia ou num
// formato que não é uma data).
export function isEligibleForGenericDate(row) {
  return !isValidDateText(row.performedAt) && row.readingValue !== null && row.readingValue !== undefined;
}

// Ambíguo: sem data válida E sem leitura — não é possível confirmar que o
// registro representa uma troca executada. Nunca corrigir automaticamente;
// fica intacto para revisão manual.
export function isAmbiguousImportedHistory(row) {
  return !isValidDateText(row.performedAt) && (row.readingValue === null || row.readingValue === undefined);
}

export function genericDateAuditPayload(row) {
  return {
    previousValue: { performedAt: row.performedAt ?? null, isGenericDate: Boolean(row.isGenericDate), dateSource: row.dateSource ?? "ORIGINAL" },
    newValue: { performedAt: GENERIC_DATE, isGenericDate: true, dateSource: GENERIC_DATE_SOURCE },
  };
}
