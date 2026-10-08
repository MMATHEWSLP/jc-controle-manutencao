import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { BASE, FRENTE_ID, inIds, OPERADOR } from "./daily-reports";
import { fuelCosts } from "./fuel";
import { attachPrevious, buildCostReport, COST_CATEGORY_KEYS, GROUPINGS, previousPeriod, sortRows, SORTS, type CostCategory, type CostItem, type Grouping, type ProductionRecord, type SortKey, type Unit } from "./cost-production-rules";

// ---------------------------------------------------------------------------
// Relatórios casados (RELATÓRIOS → Custos): busca no banco, com os filtros da tela, os custos e as
// fichas do Controle Diário; o rateio, os grupos e os indicadores ficam em lib/cost-production-rules.ts.
// Fontes (as mesmas dos módulos de origem):
//  - Diesel e gasolina: saídas do Combustível (sem as excluídas e sem os ajustes de saldo), valor pelo
//    custo médio do estoque (lib/fuel.ts:fuelCosts, o mesmo do Combustível e do Custos e Consumo);
//  - Peças: saídas do estoque (Movimentação, peças de O.S. e histórico importado; sem estornos e sem
//    "Correção de estoque"), pelo valor da saída (sem valor, o preço do cadastro);
//  - Manutenção/serviços: custo das trocas de óleo (uma vez por troca, mesmo com vários itens) e os
//    Outros gastos de serviço/mão de obra;
//  - Pneus e baterias: custo de compra na primeira montagem num equipamento e o custo dos eventos
//    (recapagem, conserto...), na frente atual do equipamento;
//  - Outros: os Outros gastos da categoria "Outros".
// ---------------------------------------------------------------------------
export type CostProductionFilters = {
  from: string; to: string; frontId: number | null; equipmentId: number | null; equipmentType: string; companyId: number | null;
  operator: string; location: string; categories: CostCategory[]; grouping: Grouping; sort: SortKey; compare: boolean;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function parseCostProductionFilters(params: URLSearchParams, today: string): CostProductionFilters {
  const from = ISO.test(params.get("de") ?? "") ? params.get("de")! : `${today.slice(0, 7)}-01`;
  const to = ISO.test(params.get("ate") ?? "") ? params.get("ate")! : today;
  const categories = (params.get("categorias") ?? "").split(",").filter((key): key is CostCategory => COST_CATEGORY_KEYS.includes(key as CostCategory));
  const grouping = (params.get("por") ?? "equipamento") as Grouping;
  const sort = (params.get("ordem") ?? "total") as SortKey;
  return {
    from: from <= to ? from : to, to: from <= to ? to : from,
    frontId: Number(params.get("frente")) || null, equipmentId: Number(params.get("equipamento")) || null,
    equipmentType: (params.get("tipo") ?? "").trim().slice(0, 80), companyId: Number(params.get("empresa")) || null,
    operator: (params.get("operador") ?? "").trim().slice(0, 80), location: (params.get("local") ?? "").trim().slice(0, 80),
    categories: categories.length ? categories : [...COST_CATEGORY_KEYS],
    grouping: grouping in GROUPINGS ? grouping : "equipamento", sort: sort in SORTS ? sort : "total", compare: params.get("comparar") === "1",
  };
}

type Row = Record<string, unknown>;
const rows = async (query: SQL) => ((await (await getDb()).execute(query)) as unknown as { rows: Row[] }).rows;
const unitOf = (controlType: unknown): Unit | null => controlType === null || controlType === undefined ? null : String(controlType) === "KM" ? "KM" : "HOURS";
const label = (value: unknown) => (value === null || value === undefined ? null : String(value));

// fronts: frentes em exibição (lib/active-front.ts) — "ALL" ou a lista. Custos ficam na frente deles.
function frontScope(column: SQL, fronts: number[] | "ALL", frontId: number | null) {
  const parts: SQL[] = [];
  if (fronts !== "ALL") parts.push(inIds(column, fronts));
  if (frontId) parts.push(sql`${column} = ${frontId}`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}
// Filtros do equipamento (equipamento, tipo, empresa): com qualquer um deles, só entra custo com equipamento.
function equipmentScope(f: CostProductionFilters, column: SQL) {
  const parts: SQL[] = [];
  if (f.equipmentId) parts.push(sql`${column} = ${f.equipmentId}`);
  if (f.equipmentType) parts.push(sql`e.type = ${f.equipmentType}`);
  if (f.companyId) parts.push(sql`e.company_id = ${f.companyId}`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
}

export async function loadCosts(f: CostProductionFilters, fronts: number[] | "ALL"): Promise<CostItem[]> {
  const between = (column: SQL) => sql`${column} BETWEEN ${f.from} AND ${f.to}`;
  const want = new Set(f.categories);
  const items: CostItem[] = [];

  if (want.has("diesel") || want.has("gasolina")) {
    const fuel = await rows(sql`SELECT fm.id, fm.movement_date AS day, fm.quantity, sf.name AS front, fm.equipment_id, e.prefix, e.control_type, ft.code
      FROM fuel_movements fm JOIN fuel_types ft ON ft.id = fm.fuel_type_id JOIN service_fronts sf ON sf.id = fm.service_front_id LEFT JOIN equipment e ON e.id = fm.equipment_id
      WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment AND fm.movement_type = 'SAIDA' AND ${between(sql`fm.movement_date`)}
        AND ${frontScope(sql`fm.service_front_id`, fronts, f.frontId)} AND ${equipmentScope(f, sql`fm.equipment_id`)}`);
    const costs = fuel.length ? await fuelCosts(await getDb()) : new Map<number, { cost: number | null }>();
    for (const row of fuel) {
      const category: CostCategory = String(row.code).toUpperCase().startsWith("GASOLINA") ? "gasolina" : "diesel";
      if (!want.has(category)) continue;
      const liters = Number(row.quantity);
      const cost = costs.get(Number(row.id))?.cost ?? null;
      items.push({ category, amount: cost ?? 0, liters, litersWithoutPrice: cost === null ? liters : 0, date: String(row.day), frontName: String(row.front),
        equipmentId: row.equipment_id === null ? null : Number(row.equipment_id), equipmentLabel: label(row.prefix), unit: unitOf(row.control_type) });
    }
  }

  if (want.has("pecas")) {
    const day = sql`coalesce(sm.movement_date, substr(sm.created_at, 1, 10))`;
    const parts = await rows(sql`SELECT ${day} AS day, sum(-sm.delta * coalesce(sm.unit_price, p.price, 0))::float8 AS amount, sf.name AS front, sm.equipment_id, e.prefix, e.control_type
      FROM product_stock_movements sm JOIN products p ON p.id = sm.product_id JOIN service_fronts sf ON sf.id = sm.service_front_id LEFT JOIN equipment e ON e.id = sm.equipment_id
      WHERE sm.source IN ('STOCK_EXIT', 'WORK_ORDER', 'HISTORY_IMPORT') AND sm.delta < 0 AND sm.reversed_at IS NULL AND sm.history_kind IS DISTINCT FROM 'AJUSTE'
        AND ${between(day)} AND ${frontScope(sql`sm.service_front_id`, fronts, f.frontId)} AND ${equipmentScope(f, sql`sm.equipment_id`)}
      GROUP BY 1, 3, 4, 5, 6`);
    for (const row of parts) items.push({ category: "pecas", amount: Number(row.amount), date: String(row.day), frontName: String(row.front),
      equipmentId: row.equipment_id === null ? null : Number(row.equipment_id), equipmentLabel: label(row.prefix), unit: unitOf(row.control_type) });
  }

  if (want.has("manutencao")) {
    // O "Custo total" da troca é gravado em cada item da mesma troca: conta uma vez por registro.
    const front = sql`coalesce(m.service_front_id, e.service_front_id)`;
    const oil = await rows(sql`SELECT DISTINCT ON (m.equipment_id, m.performed_at, m.work_order, m.created_at, m.cost) left(m.performed_at, 10) AS day, m.cost, sf.name AS front, m.equipment_id, e.prefix, e.control_type
      FROM maintenances m JOIN equipment e ON e.id = m.equipment_id JOIN service_fronts sf ON sf.id = ${front}
      WHERE m.cost > 0 AND ${between(sql`left(m.performed_at, 10)`)} AND ${frontScope(front, fronts, f.frontId)} AND ${equipmentScope(f, sql`m.equipment_id`)}`);
    for (const row of oil) items.push({ category: "manutencao", amount: Number(row.cost), date: String(row.day), frontName: String(row.front),
      equipmentId: Number(row.equipment_id), equipmentLabel: label(row.prefix), unit: unitOf(row.control_type) });
  }

  if (want.has("pneus")) {
    const tires = await rows(sql`WITH montagem AS (
        SELECT DISTINCT ON (ce.component_id) ce.component_id, ce.event_date, ce.equipment_id FROM component_events ce
        WHERE ce.event_type = 'MOUNT' AND ce.deleted_at IS NULL AND ce.equipment_id IS NOT NULL ORDER BY ce.component_id, ce.event_date, ce.id
      ), custos AS (
        SELECT mo.event_date AS day, c.purchase_cost AS amount, mo.equipment_id FROM components c JOIN montagem mo ON mo.component_id = c.id
        WHERE c.deleted_at IS NULL AND c.purchase_cost > 0
        UNION ALL
        SELECT ce.event_date, ce.cost, ce.equipment_id FROM component_events ce JOIN components c ON c.id = ce.component_id
        WHERE ce.deleted_at IS NULL AND c.deleted_at IS NULL AND ce.cost > 0 AND ce.equipment_id IS NOT NULL
      )
      SELECT left(x.day, 10) AS day, x.amount, sf.name AS front, x.equipment_id, e.prefix, e.control_type
      FROM custos x JOIN equipment e ON e.id = x.equipment_id JOIN service_fronts sf ON sf.id = e.service_front_id
      WHERE ${between(sql`left(x.day, 10)`)} AND ${frontScope(sql`e.service_front_id`, fronts, f.frontId)} AND ${equipmentScope(f, sql`x.equipment_id`)}`);
    for (const row of tires) items.push({ category: "pneus", amount: Number(row.amount), date: String(row.day), frontName: String(row.front),
      equipmentId: Number(row.equipment_id), equipmentLabel: label(row.prefix), unit: unitOf(row.control_type) });
  }

  if (want.has("manutencao") || want.has("outros")) {
    const others = await rows(sql`SELECT o.expense_date AS day, o.amount, o.category, sf.name AS front, o.equipment_id, e.prefix, e.control_type
      FROM other_expenses o JOIN service_fronts sf ON sf.id = o.service_front_id LEFT JOIN equipment e ON e.id = o.equipment_id
      WHERE o.deleted_at IS NULL AND ${between(sql`o.expense_date`)} AND ${frontScope(sql`o.service_front_id`, fronts, f.frontId)} AND ${equipmentScope(f, sql`o.equipment_id`)}`);
    for (const row of others) {
      const category: CostCategory = row.category === "SERVICO" ? "manutencao" : "outros";
      if (!want.has(category)) continue;
      items.push({ category, amount: Number(row.amount), date: String(row.day), frontName: String(row.front),
        equipmentId: row.equipment_id === null ? null : Number(row.equipment_id), equipmentLabel: label(row.prefix), unit: unitOf(row.control_type) });
    }
  }
  return items;
}

// Fichas do Controle Diário (as mesmas regras do relatório de Produção: horas/km só sem "Conferir").
export async function loadProduction(f: CostProductionFilters, fronts: number[] | "ALL"): Promise<ProductionRecord[]> {
  const result = await rows(sql`SELECT d.record_date AS day, coalesce(sf.name, 'Sem frente') AS front, d.equipment_id, e.prefix, ${OPERADOR} AS operator,
      coalesce(nullif(trim(d.location), ''), 'Sem local') AS location, d.reading_unit,
      CASE WHEN d.review_status = 'OK' AND d.end_reading >= d.start_reading THEN d.end_reading - d.start_reading ELSE 0 END AS worked,
      coalesce(d.total_trips, tr.porto + tr.baldeio, 0) AS trips, coalesce(d.port_volume_m3, tr.volume, 0) AS volume,
      coalesce(d.port_logs, CASE WHEN d.production_type = 'PORTO' THEN tr.toras END, 0) AS logs
    ${BASE} WHERE d.record_date BETWEEN ${f.from} AND ${f.to} AND ${frontScope(FRENTE_ID, fronts, f.frontId)} AND ${equipmentScope(f, sql`d.equipment_id`)}`);
  return result.map((row) => ({
    date: String(row.day), frontName: String(row.front), equipmentId: Number(row.equipment_id), equipmentLabel: String(row.prefix), operator: String(row.operator), location: String(row.location),
    unit: String(row.reading_unit) === "KM" ? "KM" : "HOURS", worked: Number(row.worked) || 0, trips: Number(row.trips) || 0, volume: Number(row.volume) || 0, logs: Number(row.logs) || 0,
  }));
}

export async function costProductionReport(f: CostProductionFilters, fronts: number[] | "ALL", today: string) {
  const build = async (period: { from: string; to: string }) => {
    const filters = { ...f, ...period };
    const [costs, records] = await Promise.all([loadCosts(filters, fronts), loadProduction(filters, fronts)]);
    return buildCostReport({ costs, records, grouping: f.grouping, operator: f.operator, location: f.location, categories: f.categories });
  };
  const current = await build({ from: f.from, to: f.to });
  const previous = f.compare ? previousPeriod(f.from, f.to, today) : null;
  const report = previous ? attachPrevious(current, await build(previous)) : current;
  return { ...report, rows: sortRows(report.rows, f.sort, f.grouping), previousPeriod: previous };
}

// Opções dos filtros: tipos de equipamento e empresas (registro do veículo) das frentes em exibição.
export async function costProductionOptions(fronts: number[] | "ALL") {
  const scope = fronts === "ALL" ? sql`true` : inIds(sql`e.service_front_id`, fronts);
  const [types, companies] = await Promise.all([
    rows(sql`SELECT DISTINCT e.type FROM equipment e WHERE e.sold_at IS NULL AND ${scope} AND e.type <> '' ORDER BY 1`),
    rows(sql`SELECT DISTINCT c.id, c.name FROM equipment e JOIN companies c ON c.id = e.company_id WHERE e.sold_at IS NULL AND ${scope} ORDER BY c.name`),
  ]);
  return { types: types.map((row) => String(row.type)), companies: companies.map((row) => ({ id: Number(row.id), name: String(row.name) })) };
}
