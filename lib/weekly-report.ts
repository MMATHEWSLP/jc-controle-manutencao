import type { D1DatabaseLike } from "../db";
import { getDb } from "../db";
import { frentesVisiveis } from "./access";
import { ALL_PERMISSIONS, type SessionUser } from "./auth";
import { listComponents } from "./components";
import { workOrderNumber } from "./document-numbers";
import { fleetCostReport } from "./fleet-costs";
import { reconcile } from "./fuel-tank-rules";
import type { WeeklyReport } from "./weekly-report-rules";

// ---------------------------------------------------------------------------
// Resumo semanal da operação (ver lib/weekly-report-rules.ts para o texto). Na tela usa as frentes
// que o usuário enxerga; no envio automático de segunda-feira, todas as frentes.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

// Usuário "sistema" (todas as frentes) para o envio agendado, que roda sem sessão.
export function systemUser(): SessionUser {
  return {
    id: 0, name: "Sistema", username: "sistema", email: "", profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false,
    lastAccessAt: null, createdAt: "", permissions: [...ALL_PERMISSIONS], serviceFrontId: null, serviceFrontName: null, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null,
  };
}

export async function buildWeeklyReport(d1: D1DatabaseLike, user: SessionUser, period: { from: string; to: string }, frontId: number | null = null): Promise<WeeklyReport> {
  const visible = frentesVisiveis(user);
  let fronts: number[] | null = visible === "ALL" ? null : visible;
  if (frontId) fronts = fronts === null || fronts.includes(frontId) ? [frontId] : [];
  const scope = (alias: string) => `(?::int[] IS NULL OR ${alias}.service_front_id = ANY(?::int[]))`;
  const all = async (query: string, binds: unknown[]) => (await d1.prepare(query).bind(...binds, fronts, fronts).all<Row>()).results;
  const end = `${period.to}T23:59:59`;

  const [costs, entries, maintenance, alerts, orders, oldest, checklists, blocked, daily, problems, tanks, fleet, frontNames, components] = await Promise.all([
    fleetCostReport(d1, user, { from: period.from, to: period.to, frontId }),
    all(`SELECT coalesce(sum(fm.quantity),0) AS liters FROM fuel_movements fm WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment AND fm.movement_type='ENTRADA' AND fm.movement_date BETWEEN ? AND ? AND ${scope("fm")}`, [period.from, period.to]),
    all(`SELECT count(*) AS total FROM maintenances m JOIN equipment e ON e.id=m.equipment_id WHERE left(m.performed_at,10) BETWEEN ? AND ? AND ${scope("e")}`, [period.from, period.to]),
    all(`SELECT a.level, e.prefix FROM alerts a JOIN equipment e ON e.id=a.equipment_id JOIN maintenance_plans p ON p.id=a.plan_id
      JOIN equipment_maintenance_types emt ON emt.equipment_id=p.equipment_id AND emt.maintenance_type_id=p.maintenance_type_id
      WHERE a.status='OPEN' AND a.level IN ('NEAR','OVERDUE') AND p.active AND emt.applicable AND e.oil_change_enabled AND e.sold_at IS NULL AND ${scope("e")} ORDER BY e.sort_key`, []),
    all(`SELECT count(*) FILTER (WHERE left(w.opened_at,10) BETWEEN ? AND ?) AS opened, count(*) FILTER (WHERE left(w.closed_at,10) BETWEEN ? AND ?) AS closed,
      count(*) FILTER (WHERE w.status='OPEN') AS open_now FROM work_orders w WHERE ${scope("w")}`, [period.from, period.to, period.from, period.to]),
    all(`SELECT w.id, e.prefix, w.opened_at FROM work_orders w JOIN equipment e ON e.id=w.equipment_id WHERE w.status='OPEN' AND ${scope("w")} ORDER BY w.opened_at LIMIT 3`, []),
    all(`SELECT count(*) AS total, count(*) FILTER (WHERE c.status='BLOQUEADO') AS blocked, count(*) FILTER (WHERE c.status='PENDENCIA') AS pending
      FROM checklist_submissions c JOIN equipment e ON e.id=c.equipment_id WHERE c.checklist_date BETWEEN ? AND ? AND ${scope("e")}`, [period.from, period.to]),
    all(`SELECT DISTINCT e.prefix, e.sort_key FROM checklist_submissions c JOIN equipment e ON e.id=c.equipment_id WHERE c.status='BLOQUEADO' AND c.checklist_date BETWEEN ? AND ? AND ${scope("e")} ORDER BY e.sort_key`, [period.from, period.to]),
    all(`SELECT count(*) AS total, count(*) FILTER (WHERE d.inactive_or_problem) AS problems FROM daily_records d JOIN equipment e ON e.id=d.equipment_id WHERE d.record_date BETWEEN ? AND ? AND ${scope("e")}`, [period.from, period.to]),
    all(`SELECT e.prefix, d.problem_reason FROM daily_records d JOIN equipment e ON e.id=d.equipment_id WHERE d.inactive_or_problem AND d.record_date BETWEEN ? AND ? AND ${scope("e")} ORDER BY d.record_date DESC LIMIT 5`, [period.from, period.to]),
    all(`SELECT t.measured_liters, t.calculated_liters, t.tolerance_percent FROM fuel_tank_measurements t WHERE t.deleted_at IS NULL AND t.measured_at BETWEEN ? AND ? AND ${scope("t")}`, [period.from, end]),
    all(`SELECT count(*) FILTER (WHERE e.status='MAINTENANCE') AS maintenance, count(*) FILTER (WHERE e.status='STOPPED') AS stopped FROM equipment e WHERE e.sold_at IS NULL AND ${scope("e")}`, []),
    fronts === null ? Promise.resolve([]) : d1.prepare(`SELECT name FROM service_fronts WHERE id = ANY(?::int[]) ORDER BY name`).bind(fronts).all<Row>().then((result) => result.results),
    listComponents(await getDb(), user, { kind: null, status: null, equipmentId: null, q: null }),
  ]);

  const today = Date.now();
  const tankResults = tanks.map((row) => reconcile(num(row.measured_liters), num(row.calculated_liters), num(row.tolerance_percent)));
  const componentAlerts = components.items.filter((item) => item.alert);
  return {
    period,
    scope: fronts === null ? "Todas as frentes" : frontNames.length ? frontNames.map((row) => String(row.name)).join(", ") : "Nenhuma frente",
    fuel: {
      exitLiters: costs.totals.liters, entryLiters: num(entries[0]?.liters), fuelCost: costs.totals.fuelCost, withoutUsage: costs.totals.withoutUsage,
      outliers: costs.rows.filter((row) => row.outlier === "ACIMA").map((row) => ({ prefix: row.prefix, consumption: row.consumption ?? 0, typeAverage: row.typeAverage ?? 0, unit: row.unit })),
    },
    costs: { total: costs.totals.totalCost, parts: costs.totals.partsCost, maintenance: costs.totals.maintenanceCost },
    maintenance: {
      done: num(maintenance[0]?.total), overdue: alerts.filter((row) => row.level === "OVERDUE").length, near: alerts.filter((row) => row.level === "NEAR").length,
      overdueList: [...new Set(alerts.filter((row) => row.level === "OVERDUE").map((row) => String(row.prefix)))],
    },
    workOrders: {
      opened: num(orders[0]?.opened), closed: num(orders[0]?.closed), openNow: num(orders[0]?.open_now),
      oldest: oldest.map((row) => ({ number: workOrderNumber(Number(row.id)), prefix: String(row.prefix), days: Math.max(0, Math.floor((today - new Date(`${String(row.opened_at).slice(0, 10)}T12:00:00Z`).getTime()) / 86400000)) })),
    },
    checklists: { total: num(checklists[0]?.total), blocked: num(checklists[0]?.blocked), pending: num(checklists[0]?.pending), blockedList: blocked.map((row) => String(row.prefix)) },
    daily: { records: num(daily[0]?.total), problems: num(daily[0]?.problems), problemList: problems.map((row) => ({ prefix: String(row.prefix), reason: String(row.problem_reason ?? "") })) },
    tanks: {
      measurements: tanks.length, outside: tankResults.filter((row) => row.status !== "OK").length,
      lossLiters: Math.round(tankResults.filter((row) => row.status === "PERDA").reduce((sum, row) => sum - row.difference, 0)),
    },
    fleet: { maintenance: num(fleet[0]?.maintenance), stopped: num(fleet[0]?.stopped) },
    components: { alerts: componentAlerts.length, list: componentAlerts.map((item) => `${item.code}${item.prefix ? ` (${item.prefix})` : ""}`) },
  };
}
