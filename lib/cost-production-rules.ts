// ---------------------------------------------------------------------------
// Relatórios casados (RELATÓRIOS → Custos): produção do Controle Diário x custos, sem banco.
// lib/cost-production.ts busca as linhas (custos e fichas) com os filtros da tela; aqui elas são
// rateadas, agrupadas e viram indicadores.
//
// Regras:
//  - cada custo fica na própria frente, no próprio dia e no próprio equipamento (o "Sem equipamento"
//    reúne combustível para terceiros/doações, peças para funcionário/departamento e outros gastos sem
//    equipamento), então qualquer agrupamento soma o mesmo total geral;
//  - por operador e por local, o custo de cada equipamento é dividido na proporção das horas (ou km)
//    que cada operador/local trabalhou com ele no período (sem horas/km, pelo número de fichas);
//    equipamento sem ficha no período vai para "Sem Controle Diário";
//  - R$/h só com os custos dos equipamentos de horímetro e as horas; R$/km só com os de KM e os km;
//    R$/viagem e R$/m³ com o custo total do grupo.
// ---------------------------------------------------------------------------

export const COST_CATEGORIES = [
  { key: "diesel", label: "Diesel" },
  { key: "gasolina", label: "Gasolina" },
  { key: "pecas", label: "Peças" },
  { key: "manutencao", label: "Manutenção/serviços" },
  { key: "pneus", label: "Pneus e baterias" },
  { key: "outros", label: "Outros" },
] as const;
export type CostCategory = typeof COST_CATEGORIES[number]["key"];
export const COST_CATEGORY_KEYS = COST_CATEGORIES.map((category) => category.key) as CostCategory[];

export const GROUPINGS = { geral: "Geral", equipamento: "Equipamento", frente: "Frente", operador: "Operador", local: "Local", mes: "Mês" } as const;
export type Grouping = keyof typeof GROUPINGS;

export const NO_EQUIPMENT = "Sem equipamento";
export const NO_DAILY = "Sem Controle Diário";

export type Unit = "HOURS" | "KM";
export type CostItem = {
  category: CostCategory;
  amount: number;
  // Combustível: litros (e quantos ficaram sem preço de entrada para valorar).
  liters?: number;
  litersWithoutPrice?: number;
  date: string;
  frontName: string;
  equipmentId: number | null;
  equipmentLabel: string | null;
  unit: Unit | null;
};
export type ProductionRecord = {
  date: string;
  frontName: string;
  equipmentId: number;
  equipmentLabel: string;
  operator: string;
  location: string;
  unit: Unit;
  // Horas ou km trabalhados (0 quando a ficha está em "Conferir" ou a leitura voltou).
  worked: number;
  trips: number;
  volume: number;
  logs: number;
};

type Part = CostItem & { operator: string; location: string };
const round2 = (value: number) => Math.round(value * 100) / 100;
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR").trim();
export const matchesText = (value: string, filter: string) => !filter.trim() || normalize(value).includes(normalize(filter));

// Participação de cada operador/local nas fichas de cada equipamento (peso = horas/km; sem nada, 1 por ficha).
export function productionShares(records: readonly ProductionRecord[]) {
  const byEquipment = new Map<number, Map<string, { operator: string; location: string; worked: number; count: number }>>();
  for (const record of records) {
    const shares = byEquipment.get(record.equipmentId) ?? new Map();
    const key = `${record.operator}\u0000${record.location}`;
    const share = shares.get(key) ?? { operator: record.operator, location: record.location, worked: 0, count: 0 };
    share.worked += Math.max(0, record.worked); share.count += 1;
    shares.set(key, share);
    byEquipment.set(record.equipmentId, shares);
  }
  const result = new Map<number, Array<{ operator: string; location: string; weight: number }>>();
  for (const [equipmentId, shares] of byEquipment) {
    const list = [...shares.values()];
    const totalWorked = list.reduce((sum, share) => sum + share.worked, 0);
    const totalCount = list.reduce((sum, share) => sum + share.count, 0);
    result.set(equipmentId, list.map((share) => ({ operator: share.operator, location: share.location, weight: totalWorked > 0 ? share.worked / totalWorked : share.count / totalCount })));
  }
  return result;
}

// Um custo vira uma ou mais partes (operador, local); a soma das partes é o valor do custo.
export function allocateCosts(costs: readonly CostItem[], records: readonly ProductionRecord[]): Part[] {
  const shares = productionShares(records);
  const parts: Part[] = [];
  for (const cost of costs) {
    if (cost.equipmentId === null) { parts.push({ ...cost, operator: NO_EQUIPMENT, location: NO_EQUIPMENT }); continue; }
    const list = shares.get(cost.equipmentId);
    if (!list?.length) { parts.push({ ...cost, operator: NO_DAILY, location: NO_DAILY }); continue; }
    for (const share of list) parts.push({
      ...cost, operator: share.operator, location: share.location, amount: cost.amount * share.weight,
      liters: cost.liters === undefined ? undefined : cost.liters * share.weight,
      litersWithoutPrice: cost.litersWithoutPrice === undefined ? undefined : cost.litersWithoutPrice * share.weight,
    });
  }
  return parts;
}

type Keyed = { date: string; frontName: string; equipmentId: number | null; equipmentLabel: string | null; operator: string; location: string };
export function groupKey(item: Keyed, grouping: Grouping) {
  switch (grouping) {
    case "geral": return "Total";
    case "equipamento": return item.equipmentId === null ? NO_EQUIPMENT : item.equipmentLabel ?? `#${item.equipmentId}`;
    case "frente": return item.frontName;
    case "operador": return item.operator;
    case "local": return item.location;
    case "mes": return item.date.slice(0, 7);
  }
}

export type CostRow = {
  key: string;
  costs: Record<CostCategory, number>;
  total: number;
  dieselLiters: number; gasolineLiters: number; litersWithoutPrice: number;
  hours: number; km: number; trips: number; volume: number; logs: number; records: number;
  costHours: number; costKm: number; dieselHours: number; dieselKm: number;
  perHour: number | null; perKm: number | null; perTrip: number | null; perM3: number | null;
  litersPerHour: number | null; kmPerLiter: number | null; litersPerM3: number | null;
  previous?: { total: number; hours: number; km: number; trips: number; volume: number; perHour: number | null; perKm: number | null } | null;
};

const emptyCosts = () => Object.fromEntries(COST_CATEGORY_KEYS.map((key) => [key, 0])) as Record<CostCategory, number>;
function emptyRow(key: string): CostRow {
  return {
    key, costs: emptyCosts(), total: 0, dieselLiters: 0, gasolineLiters: 0, litersWithoutPrice: 0, hours: 0, km: 0, trips: 0, volume: 0, logs: 0, records: 0,
    costHours: 0, costKm: 0, dieselHours: 0, dieselKm: 0, perHour: null, perKm: null, perTrip: null, perM3: null, litersPerHour: null, kmPerLiter: null, litersPerM3: null,
  };
}
const ratio = (value: number, base: number) => (base > 0 && value > 0 ? value / base : null);

function finish(row: CostRow): CostRow {
  for (const key of COST_CATEGORY_KEYS) row.costs[key] = round2(row.costs[key]);
  row.total = round2(COST_CATEGORY_KEYS.reduce((sum, key) => sum + row.costs[key], 0));
  row.perHour = ratio(row.costHours, row.hours);
  row.perKm = ratio(row.costKm, row.km);
  row.perTrip = ratio(row.total, row.trips);
  row.perM3 = ratio(row.total, row.volume);
  row.litersPerHour = ratio(row.dieselHours, row.hours);
  row.kmPerLiter = ratio(row.km, row.dieselKm);
  row.litersPerM3 = ratio(row.dieselLiters, row.volume);
  for (const field of ["dieselLiters", "gasolineLiters", "litersWithoutPrice", "hours", "km", "volume", "costHours", "costKm", "dieselHours", "dieselKm"] as const) row[field] = round2(row[field]);
  return row;
}

export type CostReportInput = {
  costs: readonly CostItem[];
  records: readonly ProductionRecord[];
  grouping: Grouping;
  operator?: string;
  location?: string;
  categories?: readonly CostCategory[];
};

export function buildCostReport(input: CostReportInput) {
  const categories = new Set(input.categories?.length ? input.categories : COST_CATEGORY_KEYS);
  const parts = allocateCosts(input.costs, input.records)
    .filter((part) => categories.has(part.category) && matchesText(part.operator, input.operator ?? "") && matchesText(part.location, input.location ?? ""));
  const records = input.records.filter((record) => matchesText(record.operator, input.operator ?? "") && matchesText(record.location, input.location ?? ""));
  const rows = new Map<string, CostRow>();
  const total = emptyRow("Total");
  const months = new Map<string, Record<CostCategory, number>>();
  const add = (row: CostRow, part: Part) => {
    row.costs[part.category] += part.amount;
    if (part.category === "diesel") row.dieselLiters += part.liters ?? 0;
    if (part.category === "gasolina") row.gasolineLiters += part.liters ?? 0;
    row.litersWithoutPrice += part.litersWithoutPrice ?? 0;
    if (part.unit === "HOURS") { row.costHours += part.amount; if (part.category === "diesel") row.dieselHours += part.liters ?? 0; }
    if (part.unit === "KM") { row.costKm += part.amount; if (part.category === "diesel") row.dieselKm += part.liters ?? 0; }
  };
  const produce = (row: CostRow, record: ProductionRecord) => {
    if (record.unit === "HOURS") row.hours += record.worked; else row.km += record.worked;
    row.trips += record.trips; row.volume += record.volume; row.logs += record.logs; row.records += 1;
  };
  for (const part of parts) {
    const key = groupKey(part, input.grouping);
    const row = rows.get(key) ?? emptyRow(key);
    add(row, part); add(total, part);
    rows.set(key, row);
    const month = months.get(part.date.slice(0, 7)) ?? emptyCosts();
    month[part.category] += part.amount;
    months.set(part.date.slice(0, 7), month);
  }
  for (const record of records) {
    const key = groupKey(record, input.grouping);
    const row = rows.get(key) ?? emptyRow(key);
    produce(row, record); produce(total, record);
    rows.set(key, row);
  }
  return {
    rows: [...rows.values()].map(finish),
    total: finish(total),
    monthly: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, costs]) => {
      const rounded = Object.fromEntries(COST_CATEGORY_KEYS.map((key) => [key, round2(costs[key])])) as Record<CostCategory, number>;
      return { month, costs: rounded, total: round2(COST_CATEGORY_KEYS.reduce((sum, key) => sum + rounded[key], 0)) };
    }),
  };
}

export const SORTS = { total: "Custo total", perHour: "R$ por hora", perKm: "R$ por km", perTrip: "R$ por viagem", perM3: "R$ por m³", key: "Nome" } as const;
export type SortKey = keyof typeof SORTS;

// Ranking: maior primeiro (mais caro / menos produtivo); sem o indicador vai para o fim; "Sem ..." sempre no fim.
export function sortRows(rows: readonly CostRow[], sort: SortKey, grouping: Grouping) {
  const special = (row: CostRow) => row.key === NO_EQUIPMENT || row.key === NO_DAILY ? 1 : 0;
  return [...rows].sort((a, b) => {
    if (grouping === "mes") return a.key.localeCompare(b.key);
    if (sort === "key") return special(a) - special(b) || a.key.localeCompare(b.key, "pt-BR", { numeric: true });
    const va = a[sort] ?? -1; const vb = b[sort] ?? -1;
    return special(a) - special(b) || (vb as number) - (va as number) || a.key.localeCompare(b.key, "pt-BR", { numeric: true });
  });
}

// Período anterior de mesmo tamanho; um mês fechado (do dia 1 ao último dia, ou até hoje no mês corrente)
// compara com o mês anterior inteiro.
export function previousPeriod(from: string, to: string, today: string) {
  const day = (value: string) => new Date(`${value}T12:00:00Z`);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const lastOfMonth = (value: string) => { const date = day(value); date.setUTCMonth(date.getUTCMonth() + 1, 0); return iso(date); };
  if (from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7) && (to === lastOfMonth(from) || to === today)) {
    const start = day(from); start.setUTCMonth(start.getUTCMonth() - 1);
    const prevFrom = iso(start);
    return { from: prevFrom, to: lastOfMonth(prevFrom) };
  }
  const length = Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;
  const end = day(from); end.setUTCDate(end.getUTCDate() - 1);
  const start = day(iso(end)); start.setUTCDate(start.getUTCDate() - (length - 1));
  return { from: iso(start), to: iso(end) };
}

// Junta o período anterior às linhas (mesma chave) e ao total.
export function attachPrevious(current: ReturnType<typeof buildCostReport>, previous: ReturnType<typeof buildCostReport>) {
  const pick = (row: CostRow | undefined) => row ? { total: row.total, hours: row.hours, km: row.km, trips: row.trips, volume: row.volume, perHour: row.perHour, perKm: row.perKm } : null;
  const byKey = new Map(previous.rows.map((row) => [row.key, row]));
  for (const row of current.rows) row.previous = pick(byKey.get(row.key));
  current.total.previous = pick(previous.total);
  return current;
}

export function variation(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / previous;
}
