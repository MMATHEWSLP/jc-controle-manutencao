import type { D1DatabaseLike } from "../db";
import { getDb } from "../db";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { fuelCosts } from "./fuel";

// ---------------------------------------------------------------------------
// Custo e consumo por equipamento da frota própria num período:
//  - litros e custo do combustível (custo médio ponderado de lib/fuel-rules.ts);
//  - uso (horas ou km) pelas leituras de horímetro/KM: última leitura até o fim do período menos a
//    última leitura antes do início (ou a primeira do período);
//  - consumo (L/h para horímetro, km/L para KM) e comparação com a média dos equipamentos do mesmo
//    tipo: acima/abaixo de CONSUMPTION_TOLERANCE vira destaque;
//  - peças que saíram do estoque para o equipamento e custo das trocas de óleo registradas.
// Só ADMIN e GESTOR (valores de custo).
// ---------------------------------------------------------------------------
export const CONSUMPTION_TOLERANCE = 0.25;

export function canSeeFleetCosts(user: SessionUser) {
  return user.profile === "ADMIN" || user.profile === "GESTOR";
}

type Row = Record<string, unknown>;
export type FleetCostRow = {
  equipmentId: number; prefix: string; type: string; front: string | null; unit: "HOURS" | "KM";
  liters: number; fuelCost: number; fuelWithoutPrice: number; usage: number | null; consumption: number | null; typeAverage: number | null;
  deviation: number | null; outlier: "ACIMA" | "ABAIXO" | null; partsCost: number; maintenanceCost: number; totalCost: number; costPerUnit: number | null;
};

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const money = (value: number) => Math.round(value * 100) / 100;

// L/h (horímetro) ou km/L (KM); null quando não dá para calcular.
export function consumptionOf(unit: "HOURS" | "KM", liters: number, usage: number | null) {
  if (!usage || usage <= 0 || liters <= 0) return null;
  return unit === "KM" ? usage / liters : liters / usage;
}

// Consumo "pior" que a média: mais litros por hora (L/h) ou menos km por litro (km/L).
export function consumptionDeviation(unit: "HOURS" | "KM", value: number | null, average: number | null) {
  if (value === null || average === null || average <= 0) return { deviation: null, outlier: null as FleetCostRow["outlier"] };
  const deviation = (value - average) / average;
  if (Math.abs(deviation) <= CONSUMPTION_TOLERANCE + 1e-9) return { deviation, outlier: null as FleetCostRow["outlier"] };
  const worse = unit === "KM" ? deviation < 0 : deviation > 0;
  return { deviation, outlier: (worse ? "ACIMA" : "ABAIXO") as FleetCostRow["outlier"] };
}

export async function fleetCostReport(d1: D1DatabaseLike, user: SessionUser, filters: { from: string; to: string; frontId: number | null }) {
  const visible = frentesVisiveis(user);
  let fronts: number[] | null = visible === "ALL" ? null : visible;
  if (filters.frontId) fronts = fronts === null || fronts.includes(filters.frontId) ? [filters.frontId] : [];
  const scope = `(?::int[] IS NULL OR e.service_front_id = ANY(?::int[]))`;
  const end = `${filters.to}T23:59:59`;
  const all = async (query: string, binds: unknown[]) => (await d1.prepare(query).bind(...binds).all<Row>()).results;

  const [equipment, fuel, usage, parts, maintenance, frontList] = await Promise.all([
    all(`SELECT e.id,e.prefix,e.type,e.control_type,sf.name AS front FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
      WHERE e.sold_at IS NULL AND ${scope} ORDER BY e.sort_key`, [fronts, fronts]),
    all(`SELECT fm.id,fm.equipment_id,fm.quantity FROM fuel_movements fm JOIN equipment e ON e.id=fm.equipment_id
      WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment AND fm.movement_type='SAIDA' AND fm.movement_date BETWEEN ? AND ? AND ${scope}`, [filters.from, filters.to, fronts, fronts]),
    all(`SELECT m.equipment_id,
        max(m.hours) FILTER (WHERE m.reading_date < ?) AS hours_before, min(m.hours) FILTER (WHERE m.reading_date >= ? AND m.reading_date <= ?) AS hours_first,
        max(m.hours) FILTER (WHERE m.reading_date <= ?) AS hours_end,
        max(m.km) FILTER (WHERE m.reading_date < ?) AS km_before, min(m.km) FILTER (WHERE m.reading_date >= ? AND m.reading_date <= ?) AS km_first,
        max(m.km) FILTER (WHERE m.reading_date <= ?) AS km_end,
        count(*) FILTER (WHERE m.reading_date >= ? AND m.reading_date <= ?) AS readings_in_period
      FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WHERE ${scope} GROUP BY m.equipment_id`,
      [filters.from, filters.from, end, end, filters.from, filters.from, end, end, filters.from, end, fronts, fronts]),
    all(`SELECT sm.equipment_id, sum(-sm.delta * coalesce(sm.unit_price, p.price, 0)) AS cost FROM product_stock_movements sm JOIN products p ON p.id=sm.product_id
      JOIN equipment e ON e.id=sm.equipment_id WHERE sm.delta < 0 AND sm.reversed_at IS NULL AND sm.history_kind IS DISTINCT FROM 'AJUSTE' AND left(sm.movement_date,10) BETWEEN ? AND ? AND ${scope} GROUP BY sm.equipment_id`, [filters.from, filters.to, fronts, fronts]),
    all(`SELECT m.equipment_id, sum(coalesce(m.cost,0)) AS cost FROM maintenances m JOIN equipment e ON e.id=m.equipment_id
      WHERE left(m.performed_at,10) BETWEEN ? AND ? AND ${scope} GROUP BY m.equipment_id`, [filters.from, filters.to, fronts, fronts]),
    all(`SELECT id,name FROM service_fronts WHERE active AND (?::int[] IS NULL OR id = ANY(?::int[])) ORDER BY name`, [visible === "ALL" ? null : visible, visible === "ALL" ? null : visible]),
  ]);

  const costs = fuel.length ? await fuelCosts(await getDb()) : new Map();
  const fuelBy = new Map<number, { liters: number; cost: number; withoutPrice: number }>();
  for (const row of fuel) {
    const id = Number(row.equipment_id);
    const entry = fuelBy.get(id) ?? { liters: 0, cost: 0, withoutPrice: 0 };
    const liters = num(row.quantity);
    const cost = costs.get(Number(row.id))?.cost ?? null;
    entry.liters += liters;
    if (cost === null) entry.withoutPrice += liters; else entry.cost += cost;
    fuelBy.set(id, entry);
  }
  const usageBy = new Map(usage.map((row) => [Number(row.equipment_id), row]));
  const partsBy = new Map(parts.map((row) => [Number(row.equipment_id), num(row.cost)]));
  const maintenanceBy = new Map(maintenance.map((row) => [Number(row.equipment_id), num(row.cost)]));

  const rows: FleetCostRow[] = equipment.map((item) => {
    const id = Number(item.id);
    const unit: "HOURS" | "KM" = String(item.control_type) === "KM" ? "KM" : "HOURS";
    const reading = usageBy.get(id);
    const prefix = unit === "KM" ? "km" : "hours";
    const endValue = reading ? reading[`${prefix}_end`] : null;
    const startValue = reading ? reading[`${prefix}_before`] ?? reading[`${prefix}_first`] : null;
    const used = reading && Number(reading.readings_in_period) > 0 && endValue !== null && startValue !== null ? Math.max(0, num(endValue) - num(startValue)) : null;
    const fuelEntry = fuelBy.get(id) ?? { liters: 0, cost: 0, withoutPrice: 0 };
    const partsCost = money(partsBy.get(id) ?? 0);
    const maintenanceCost = money(maintenanceBy.get(id) ?? 0);
    const totalCost = money(fuelEntry.cost + partsCost + maintenanceCost);
    return {
      equipmentId: id, prefix: String(item.prefix), type: String(item.type), front: item.front === null ? null : String(item.front), unit,
      liters: Math.round(fuelEntry.liters * 100) / 100, fuelCost: money(fuelEntry.cost), fuelWithoutPrice: Math.round(fuelEntry.withoutPrice * 100) / 100,
      usage: used, consumption: consumptionOf(unit, fuelEntry.liters, used), typeAverage: null, deviation: null, outlier: null,
      partsCost, maintenanceCost, totalCost, costPerUnit: used && used > 0 && totalCost > 0 ? money(totalCost / used) : null,
    };
  });

  // Média do tipo = total de uso ÷ total de litros (ou o inverso) dos equipamentos do mesmo tipo
  // e unidade que têm consumo calculado.
  const byType = new Map<string, { liters: number; usage: number }>();
  for (const row of rows) if (row.consumption !== null) {
    const key = `${row.type}|${row.unit}`;
    const total = byType.get(key) ?? { liters: 0, usage: 0 };
    total.liters += row.liters; total.usage += row.usage ?? 0;
    byType.set(key, total);
  }
  for (const row of rows) {
    const total = byType.get(`${row.type}|${row.unit}`);
    row.typeAverage = total ? consumptionOf(row.unit, total.liters, total.usage) : null;
    Object.assign(row, consumptionDeviation(row.unit, row.consumption, row.typeAverage));
  }

  const active = rows.filter((row) => row.liters > 0 || row.totalCost > 0 || (row.usage ?? 0) > 0);
  return {
    period: { from: filters.from, to: filters.to }, fronts: frontList.map((row) => ({ id: Number(row.id), name: String(row.name) })),
    totals: {
      liters: Math.round(active.reduce((sum, row) => sum + row.liters, 0) * 100) / 100,
      fuelCost: money(active.reduce((sum, row) => sum + row.fuelCost, 0)),
      partsCost: money(active.reduce((sum, row) => sum + row.partsCost, 0)),
      maintenanceCost: money(active.reduce((sum, row) => sum + row.maintenanceCost, 0)),
      totalCost: money(active.reduce((sum, row) => sum + row.totalCost, 0)),
      outliers: active.filter((row) => row.outlier === "ACIMA").length,
      withoutUsage: active.filter((row) => row.liters > 0 && row.usage === null).length,
    },
    rows: active.sort((a, b) => b.totalCost - a.totalCost || b.liters - a.liters || a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true })),
  };
}
