import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { inIds } from "./daily-reports";
import { workOrderNumber } from "./document-numbers";
import { fuelCosts } from "./fuel";
import { purposeText, type FuelPurpose } from "./third-party-rules";

// ---------------------------------------------------------------------------
// Relatórios do menu RELATÓRIOS que eram listas soltas nos módulos (parte 3c): combustível por destino,
// ajustes de estoque e ordens de serviço. Todos nas frentes em exibição (lib/active-front.ts).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const rows = async (query: SQL) => ((await (await getDb()).execute(query)) as unknown as { rows: Row[] }).rows;
const scopeOf = (column: SQL, fronts: number[] | "ALL", frontId: number | null) => {
  const parts: SQL[] = [];
  if (fronts !== "ALL") parts.push(inIds(column, fronts));
  if (frontId) parts.push(sql`${column} = ${frontId}`);
  return parts.length ? sql.join(parts, sql` AND `) : sql`true`;
};
const round2 = (value: number) => Math.round(value * 100) / 100;
export type PeriodFilters = { from: string; to: string; frontId: number | null };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function parsePeriod(params: URLSearchParams, today: string): PeriodFilters {
  const from = ISO.test(params.get("de") ?? "") ? params.get("de")! : `${today.slice(0, 7)}-01`;
  const to = ISO.test(params.get("ate") ?? "") ? params.get("ate")! : today;
  return { from: from <= to ? from : to, to: from <= to ? to : from, frontId: Number(params.get("frente")) || null };
}

// Combustível por destino: para onde foi cada litro (equipamento da frota, terceiro/doação com o
// destino e a finalidade, prestador...), com o valor pelo custo médio do estoque.
export type DestinationRow = { destination: string; kind: string; purpose: string | null; front: string; count: number; liters: number; value: number; withoutPrice: number };
export async function fuelByDestination(f: PeriodFilters & { fuelTypeId: number | null }, fronts: number[] | "ALL") {
  const exits = await rows(sql`SELECT fm.id, fm.quantity, sf.name AS front, e.prefix, fm.third_party, fm.third_party_kind, fm.third_party_description, tp.name AS company,
      tv.plate, te.name AS worker, fm.third_party_destination, fm.purpose, fm.purpose_note, ft.name AS fuel
    FROM fuel_movements fm JOIN service_fronts sf ON sf.id = fm.service_front_id JOIN fuel_types ft ON ft.id = fm.fuel_type_id
    LEFT JOIN equipment e ON e.id = fm.equipment_id LEFT JOIN third_parties tp ON tp.id = fm.third_party_id
    LEFT JOIN third_party_vehicles tv ON tv.id = fm.third_party_vehicle_id LEFT JOIN third_party_employees te ON te.id = fm.third_party_employee_id
    WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment AND fm.movement_type = 'SAIDA' AND fm.movement_date BETWEEN ${f.from} AND ${f.to}
      AND ${scopeOf(sql`fm.service_front_id`, fronts, f.frontId)} ${f.fuelTypeId ? sql`AND fm.fuel_type_id = ${f.fuelTypeId}` : sql``}`);
  const costs = exits.length ? await fuelCosts(await getDb()) : new Map<number, { cost: number | null }>();
  const groups = new Map<string, DestinationRow>();
  for (const row of exits) {
    const purpose = purposeText(row.purpose as FuelPurpose | null, row.purpose_note as string | null);
    let destination: string; let kind: string;
    if (row.prefix) { destination = String(row.prefix); kind = "Frota JC"; }
    else if (row.company) {
      kind = row.third_party_kind === "PRESTADOR" ? "Prestador" : "Terceiro/Doações";
      destination = `${row.company}${row.third_party_destination === "FUNCIONARIO" && row.worker ? ` · ${row.worker}` : row.plate ? ` · ${row.plate}` : ""}`;
    } else if (row.third_party) { kind = row.third_party_kind === "PRESTADOR" ? "Prestador" : "Terceiro/Doações"; destination = String(row.third_party_description ?? "Sem descrição"); }
    else { kind = "Sem destino"; destination = "Sem equipamento nem terceiro"; }
    const key = `${row.front}\u0000${kind}\u0000${destination}\u0000${purpose ?? ""}`;
    const group = groups.get(key) ?? { destination, kind, purpose, front: String(row.front), count: 0, liters: 0, value: 0, withoutPrice: 0 };
    const liters = Number(row.quantity);
    const cost = costs.get(Number(row.id))?.cost ?? null;
    group.count += 1; group.liters += liters;
    if (cost === null) group.withoutPrice += liters; else group.value += cost;
    groups.set(key, group);
  }
  const list = [...groups.values()].map((group) => ({ ...group, liters: round2(group.liters), value: round2(group.value), withoutPrice: round2(group.withoutPrice) }))
    .sort((a, b) => b.liters - a.liters || a.destination.localeCompare(b.destination, "pt-BR", { numeric: true }));
  return { rows: list, totals: { count: list.reduce((sum, row) => sum + row.count, 0), liters: round2(list.reduce((sum, row) => sum + row.liters, 0)), value: round2(list.reduce((sum, row) => sum + row.value, 0)) } };
}

// Ajustes de estoque: ajuste manual do saldo (Produtos) e "Correção de estoque" do histórico importado.
export type AdjustmentRow = { id: number; date: string; front: string; tag: string; product: string; delta: number; value: number; reason: string; origin: string; user: string | null };
export async function stockAdjustments(f: PeriodFilters & { q: string }, fronts: number[] | "ALL") {
  const day = sql`coalesce(sm.movement_date, substr(sm.created_at, 1, 10))`;
  const text = f.q.trim() ? sql`AND (p.name ILIKE ${`%${f.q.trim()}%`} OR p.tag ILIKE ${`%${f.q.trim()}%`})` : sql``;
  const result = await rows(sql`SELECT sm.id, ${day} AS day, sf.name AS front, p.tag, p.name, sm.delta, (sm.delta * coalesce(sm.unit_price, p.price, 0))::float8 AS value, sm.reason,
      CASE WHEN sm.source = 'ADJUSTMENT' THEN 'Ajuste manual do saldo' ELSE 'Correção de estoque (histórico importado)' END AS origin, u.name AS user_name
    FROM product_stock_movements sm JOIN products p ON p.id = sm.product_id JOIN service_fronts sf ON sf.id = sm.service_front_id LEFT JOIN users u ON u.id = sm.created_by
    WHERE (sm.source = 'ADJUSTMENT' OR sm.history_kind = 'AJUSTE') AND sm.reversed_at IS NULL AND ${day} BETWEEN ${f.from} AND ${f.to}
      AND ${scopeOf(sql`sm.service_front_id`, fronts, f.frontId)} ${text}
    ORDER BY ${day} DESC, sm.id DESC LIMIT 5000`);
  const list: AdjustmentRow[] = result.map((row) => ({ id: Number(row.id), date: String(row.day), front: String(row.front), tag: String(row.tag), product: String(row.name), delta: Number(row.delta), value: round2(Number(row.value)), reason: String(row.reason ?? ""), origin: String(row.origin), user: row.user_name === null ? null : String(row.user_name) }));
  const positive = list.filter((row) => row.delta > 0); const negative = list.filter((row) => row.delta < 0);
  return { rows: list, totals: { count: list.length, increases: positive.length, decreases: negative.length, increaseValue: round2(positive.reduce((sum, row) => sum + row.value, 0)), decreaseValue: round2(negative.reduce((sum, row) => sum + row.value, 0)) } };
}

// Ordens de serviço abertas no período: situação, dias em aberto, peças (quantidade e valor) e mecânicos.
export type WorkOrderRow = { id: number; number: string; prefix: string; front: string; openedAt: string; closedAt: string | null; status: "OPEN" | "CLOSED"; days: number; description: string; items: number; partsTotal: number; oilChanges: number; mechanics: string };
export async function workOrdersReport(f: PeriodFilters & { status: "OPEN" | "CLOSED" | null; equipmentId: number | null }, fronts: number[] | "ALL", today: string) {
  const result = await rows(sql`SELECT w.id, e.prefix, sf.name AS front, w.opened_at, w.closed_at, w.status, w.description,
      (SELECT count(*) FROM work_order_items i WHERE i.work_order_id = w.id AND i.removed_at IS NULL)::int AS items,
      (SELECT coalesce(sum(i.quantity * coalesce(i.unit_price, 0)), 0) FROM work_order_items i WHERE i.work_order_id = w.id AND i.removed_at IS NULL)::float8 AS parts,
      (SELECT count(*) FROM maintenances m WHERE m.work_order_id = w.id)::int AS oil,
      (SELECT string_agg(mm.mechanic_name, ', ' ORDER BY mm.mechanic_name) FROM work_order_mechanics mm WHERE mm.work_order_id = w.id) AS mechanics
    FROM work_orders w JOIN equipment e ON e.id = w.equipment_id JOIN service_fronts sf ON sf.id = w.service_front_id
    WHERE left(w.opened_at, 10) BETWEEN ${f.from} AND ${f.to} AND ${scopeOf(sql`w.service_front_id`, fronts, f.frontId)}
      ${f.status ? sql`AND w.status = ${f.status}` : sql``} ${f.equipmentId ? sql`AND w.equipment_id = ${f.equipmentId}` : sql``}
    ORDER BY w.opened_at DESC, w.id DESC LIMIT 5000`);
  const dayMs = 86_400_000;
  const list: WorkOrderRow[] = result.map((row) => {
    const opened = String(row.opened_at).slice(0, 10); const closed = row.closed_at ? String(row.closed_at).slice(0, 10) : null;
    return {
      id: Number(row.id), number: workOrderNumber(Number(row.id)), prefix: String(row.prefix), front: String(row.front), openedAt: opened, closedAt: closed,
      status: row.status === "CLOSED" ? "CLOSED" : "OPEN", days: Math.max(0, Math.round((Date.parse(`${closed ?? today}T12:00:00Z`) - Date.parse(`${opened}T12:00:00Z`)) / dayMs)),
      description: String(row.description ?? ""), items: Number(row.items), partsTotal: round2(Number(row.parts)), oilChanges: Number(row.oil), mechanics: String(row.mechanics ?? ""),
    };
  });
  const closedList = list.filter((row) => row.status === "CLOSED");
  return { rows: list, totals: { count: list.length, open: list.length - closedList.length, closed: closedList.length, partsTotal: round2(list.reduce((sum, row) => sum + row.partsTotal, 0)),
    averageDaysClosed: closedList.length ? round2(closedList.reduce((sum, row) => sum + row.days, 0) / closedList.length) : null } };
}

// Filtros por extenso para o cabeçalho do Excel/PDF.
export async function describePeriod(f: PeriodFilters, extra: string[] = []) {
  const br = (day: string) => day.split("-").reverse().join("/");
  const parts = [`Período ${br(f.from)} a ${br(f.to)}`];
  if (f.frontId) parts.push(`Frente ${(await rows(sql`SELECT name FROM service_fronts WHERE id = ${f.frontId}`))[0]?.name ?? "—"}`);
  return [...parts, ...extra.filter(Boolean)];
}
