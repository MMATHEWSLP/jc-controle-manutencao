// Regras do Histórico de Registros Diários, compartilhadas entre a tela (navegador), a API de
// listagem e as exportações (PDF/Excel): os mesmos filtros, o mesmo cálculo de trabalhado e os
// mesmos rótulos de status — o que a tela mostra é exatamente o que o arquivo exporta.
// Sem dependências de banco ou de React — testável isoladamente.

export type DailyHistoryFilters = {
  q: string;               // equipamento (prefixo/código/modelo/placa) ou operador — parcial, sem caixa
  from: string;            // YYYY-MM-DD ou ""
  to: string;              // YYYY-MM-DD ou ""
  frontId: number | null;  // null = todas as frentes
  operators: string[];     // nomes exibidos dos colaboradores (OR entre eles)
};

export const HISTORY_PAGE_SIZE = 50;
export const HISTORY_EXPORT_LIMIT = 20000;
export const HISTORY_Q_MAX = 80;
export const HISTORY_OPERATORS_MAX = 50;

const isoDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");

// Nomes curtos dos parâmetros na URL (a mesma query string serve para a tela, a API e as exportações).
export const HISTORY_PARAMS = { q: "q", from: "de", to: "ate", front: "frente", operator: "colaborador", page: "pagina" } as const;

export function parseHistoryFilters(params: URLSearchParams): DailyHistoryFilters {
  const front = Number(params.get(HISTORY_PARAMS.front));
  const operators = [...new Set(params.getAll(HISTORY_PARAMS.operator).map((value) => value.trim().replace(/\s+/g, " ")).filter(Boolean))].slice(0, HISTORY_OPERATORS_MAX);
  let from = isoDate(params.get(HISTORY_PARAMS.from));
  let to = isoDate(params.get(HISTORY_PARAMS.to));
  if (from && to && from > to) [from, to] = [to, from];
  return {
    q: (params.get(HISTORY_PARAMS.q) ?? "").trim().slice(0, HISTORY_Q_MAX),
    from, to,
    frontId: Number.isInteger(front) && front > 0 ? front : null,
    operators,
  };
}

export function historyFiltersToParams(filters: DailyHistoryFilters, page?: number) {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set(HISTORY_PARAMS.q, filters.q.trim());
  if (filters.from) params.set(HISTORY_PARAMS.from, filters.from);
  if (filters.to) params.set(HISTORY_PARAMS.to, filters.to);
  if (filters.frontId) params.set(HISTORY_PARAMS.front, String(filters.frontId));
  for (const name of filters.operators) params.append(HISTORY_PARAMS.operator, name);
  if (page && page > 1) params.set(HISTORY_PARAMS.page, String(page));
  return params;
}

export function parseHistoryPage(params: URLSearchParams) {
  const page = Number(params.get(HISTORY_PARAMS.page));
  return Number.isInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
}

// Escapa curingas do ILIKE para a busca livre casar só texto literal.
export function likePattern(value: string) { return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`; }

export type HistoryStatusInput = { workedToday: boolean; inactiveOrProblem: boolean; hadProduction: boolean; productionType: "BALDEIO" | "PORTO" | null };
export type HistoryStatusTag = { key: "worked" | "off" | "problem" | "production"; label: string; tone: "green" | "gray" | "orange" | "blue" };

export function historyStatusTags(row: HistoryStatusInput): HistoryStatusTag[] {
  if (!row.workedToday) return [{ key: "off", label: "Não trabalhou", tone: "gray" }];
  const tags: HistoryStatusTag[] = [{ key: "worked", label: "Trabalhou", tone: "green" }];
  if (row.inactiveOrProblem) tags.push({ key: "problem", label: "Inativo/problema", tone: "orange" });
  if (row.hadProduction) tags.push({ key: "production", label: row.productionType === "PORTO" ? "Produção (Porto)" : row.productionType === "BALDEIO" ? "Produção (Baldeio)" : "Teve produção", tone: "blue" });
  return tags;
}
export function historyStatusText(row: HistoryStatusInput) { return historyStatusTags(row).map((tag) => tag.label).join(" · "); }

// Trabalhado no dia = leitura final - inicial (horímetro ou KM). null quando não trabalhou ou falta leitura.
export function workedAmount(row: { workedToday: boolean; startReading: number | null; endReading: number | null }) {
  if (!row.workedToday || row.startReading === null || row.endReading === null) return null;
  return Math.max(0, Math.round((row.endReading - row.startReading) * 100) / 100);
}

const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
export function formatWorked(value: number | null, unit: "HOURS" | "KM") { return value === null ? "—" : `${numberFormat.format(value)} ${unit === "KM" ? "km" : "h"}`; }
export function formatHistoryDay(value: string) { return value ? value.split("-").reverse().join("/") : "—"; }

export function historyPeriodLabel(filters: Pick<DailyHistoryFilters, "from" | "to">) {
  if (filters.from && filters.to) return `${formatHistoryDay(filters.from)} a ${formatHistoryDay(filters.to)}`;
  if (filters.from) return `A partir de ${formatHistoryDay(filters.from)}`;
  if (filters.to) return `Até ${formatHistoryDay(filters.to)}`;
  return "Todo o período";
}

// Ordenação da listagem: data mais recente primeiro; no mesmo dia, ordem alfabética por
// equipamento (natural: "CM-2" antes de "CM-10") e depois por operador — o mesmo par de campos
// da busca livre. O banco aplica a mesma ordem (ORDER BY record_date DESC, sort_key, operador).
const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
export function compareHistoryRows(a: { recordDate: string; prefix: string; operator: string; id: number }, b: { recordDate: string; prefix: string; operator: string; id: number }) {
  if (a.recordDate !== b.recordDate) return a.recordDate < b.recordDate ? 1 : -1;
  return collator.compare(a.prefix, b.prefix) || collator.compare(a.operator, b.operator) || a.id - b.id;
}
