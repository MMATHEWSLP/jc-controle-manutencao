import { eq, sql } from "drizzle-orm";
import { getD1, getDb } from "../db";
import { notificationState } from "../db/schema";
import { fleetCostReport } from "./fleet-costs";
import { clip } from "./notification-events";
import { notify, runAfterResponse } from "./notifications";
import { systemUser } from "./weekly-report";

// ---------------------------------------------------------------------------
// Rotina diária das notificações: trocas de óleo vencidas, estoque baixo, consumo fora da média e
// tarefas vencendo. Roda uma vez por dia no primeiro acesso depois das 6h (horário de Fortaleza) —
// sem agendador nem segredo para configurar — ou pelo botão "Verificar agora" (ADMIN).
// Cada frente só recebe o que é NOVO desde o último aviso (notification_state guarda o que já foi
// avisado), para não repetir a mesma lista todos os dias.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>) => ((await (await getDb()).execute(query)) as unknown as { rows: Row[] }).rows;
const localNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const list = (items: string[], max = 6) => (items.length > max ? `${items.slice(0, max).join(", ")} e mais ${items.length - max}` : items.join(", "));

async function readState(key: string): Promise<string[]> {
  const db = await getDb();
  const row = (await db.select({ value: notificationState.value }).from(notificationState).where(eq(notificationState.key, key)).limit(1))[0];
  try { return row ? JSON.parse(row.value) as string[] : []; } catch { return []; }
}
async function writeState(key: string, value: string[]) {
  const db = await getDb();
  const json = JSON.stringify(value);
  await db.insert(notificationState).values({ key, value: json }).onConflictDoUpdate({ target: notificationState.key, set: { value: json, updatedAt: new Date().toISOString() } });
}

// Itens por frente → só os novos (chave de cada item) desde o último aviso; guarda a lista atual.
async function onlyNew<T extends { key: string; frontId: number | null }>(prefix: string, items: readonly T[]) {
  const byFront = new Map<number | null, T[]>();
  for (const item of items) byFront.set(item.frontId, [...(byFront.get(item.frontId) ?? []), item]);
  const known = await rows(sql`SELECT key FROM notification_state WHERE key LIKE ${`${prefix}:%`}`);
  const fronts = new Set<number | null>([...byFront.keys(), ...known.map((row) => { const id = Number(String(row.key).slice(prefix.length + 1)); return id || null; })]);
  const result: { frontId: number | null; fresh: T[]; all: T[] }[] = [];
  for (const frontId of fronts) {
    const all = byFront.get(frontId) ?? [];
    const key = `${prefix}:${frontId ?? 0}`;
    const before = new Set(await readState(key));
    await writeState(key, all.map((item) => item.key));
    const fresh = all.filter((item) => !before.has(item.key));
    if (fresh.length) result.push({ frontId, fresh, all });
  }
  return result;
}

const frontNames = async () => new Map((await rows(sql`SELECT id, name FROM service_fronts`)).map((row) => [Number(row.id), String(row.name)]));

// Trocas de óleo vencidas (e urgentes) por frente — mesma lista da Central de alertas.
export async function overdueOilChanges() {
  const result = await rows(sql`SELECT a.plan_id, a.equipment_id, a.level, a.planned_value, a.control_type, e.prefix, e.service_front_id, t.name AS maintenance
    FROM alerts a JOIN equipment e ON e.id = a.equipment_id JOIN maintenance_plans p ON p.id = a.plan_id JOIN maintenance_types t ON t.id = p.maintenance_type_id
    JOIN equipment_maintenance_types emt ON emt.equipment_id = p.equipment_id AND emt.maintenance_type_id = p.maintenance_type_id
    WHERE a.status = 'OPEN' AND a.level IN ('OVERDUE', 'NEAR') AND p.active AND emt.applicable AND e.oil_change_enabled AND e.sold_at IS NULL
    ORDER BY e.sort_key, e.prefix`);
  // A chave inclui o valor da próxima troca: depois de feita, a troca que vencer de novo é nova.
  return result.map((row) => ({ key: `${row.plan_id}:${row.planned_value}`, frontId: row.service_front_id === null ? null : Number(row.service_front_id), text: `${String(row.prefix)} (${String(row.maintenance)})` }));
}

// Estoque baixo: saldo menor que 1 mês do consumo médio dos últimos 90 dias (regra do Assistente JC).
export async function lowStock(today: string) {
  const since = addDays(today, -90);
  const result = await rows(sql`WITH saidas AS (
      SELECT sm.product_id, sm.service_front_id, sum(-sm.delta) AS qtd FROM product_stock_movements sm
      WHERE sm.delta < 0 AND sm.reversed_at IS NULL AND sm.history_kind IS DISTINCT FROM 'AJUSTE' AND sm.source <> 'ADJUSTMENT'
        AND left(coalesce(sm.movement_date, sm.created_at), 10) >= ${since} GROUP BY 1, 2)
    SELECT s.product_id, s.service_front_id, s.quantity, sa.qtd, p.tag, p.name
    FROM product_front_stock s JOIN products p ON p.id = s.product_id JOIN saidas sa ON sa.product_id = s.product_id AND sa.service_front_id = s.service_front_id
    WHERE s.active AND p.active AND sa.qtd > 0 AND s.quantity < sa.qtd / 3.0 ORDER BY p.name`);
  const fmt = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  return result.map((row) => ({ key: String(row.product_id), frontId: Number(row.service_front_id), text: `${String(row.name)} (saldo ${fmt(Number(row.quantity))}; uso ~${fmt(Number(row.qtd) / 3)}/mês)` }));
}

// Consumo dos últimos 30 dias pior que a média do tipo (acima de L/h ou abaixo de km/L), como no relatório.
export async function consumptionOutliers(today: string) {
  const report = await fleetCostReport(await getD1(), systemUser(), { from: addDays(today, -30), to: addDays(today, -1), frontId: null });
  const worse = report.rows.filter((row) => row.outlier === "ACIMA");
  if (!worse.length) return [];
  const fronts = new Map((await rows(sql`SELECT id, service_front_id FROM equipment WHERE id IN (${sql.join(worse.map((row) => sql`${row.equipmentId}`), sql`, `)})`)).map((row) => [Number(row.id), row.service_front_id === null ? null : Number(row.service_front_id)]));
  const fmt = (value: number | null) => (value === null ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
  return worse.map((row) => ({ key: String(row.equipmentId), frontId: fronts.get(row.equipmentId) ?? null, text: `${row.prefix} ${fmt(row.consumption)} ${row.unit === "KM" ? "km/L" : "L/h"} (média ${fmt(row.typeAverage)})` }));
}

export type DailyResult = { oil: number; stock: number; fuel: number; tasks: number };

export async function runDailyNotifications(today = localNow().day): Promise<DailyResult> {
  const names = await frontNames();
  const where = (frontId: number | null) => (frontId === null ? "sem frente" : names.get(frontId) ?? "frente");
  const result: DailyResult = { oil: 0, stock: 0, fuel: 0, tasks: 0 };

  for (const group of await onlyNew("oil.overdue", await overdueOilChanges())) {
    result.oil += group.fresh.length;
    await notify({
      event: "oil.overdue", frontId: group.frontId, link: { secao: "Central de alertas" },
      title: `${group.fresh.length} troca${group.fresh.length === 1 ? "" : "s"} de óleo vencida${group.fresh.length === 1 ? "" : "s"} — ${where(group.frontId)}`,
      body: `${list(group.fresh.map((item) => item.text))}${group.all.length > group.fresh.length ? `\nTotal vencidas na frente: ${group.all.length}` : ""}`,
    });
  }
  for (const group of await onlyNew("stock.low", await lowStock(today))) {
    result.stock += group.fresh.length;
    await notify({
      event: "stock.low", frontId: group.frontId, link: { secao: "Produtos" },
      title: `${group.fresh.length} produto${group.fresh.length === 1 ? "" : "s"} com estoque baixo — ${where(group.frontId)}`,
      body: `${list(group.fresh.map((item) => item.text), 5)}${group.all.length > group.fresh.length ? `\nTotal com estoque baixo: ${group.all.length}` : ""}`,
    });
  }
  for (const group of await onlyNew("fuel.outlier", await consumptionOutliers(today))) {
    result.fuel += group.fresh.length;
    await notify({
      event: "fuel.outlier", frontId: group.frontId, link: { secao: "Relatórios", aba: "consumo-equipamento" },
      title: `Consumo fora da média — ${where(group.frontId)}`,
      body: `Últimos 30 dias, mais de 25% pior que a média do tipo: ${list(group.fresh.map((item) => item.text), 5)}`,
    });
  }
  // Tarefas abertas (a fazer / em andamento) que vencem hoje ou amanhã: aviso para o responsável.
  const tasks = await rows(sql`SELECT id, title, due_date, assignee_id FROM tasks
    WHERE deleted_at IS NULL AND assignee_id IS NOT NULL AND status IN ('TODO', 'IN_PROGRESS') AND due_date BETWEEN ${today} AND ${addDays(today, 1)} ORDER BY due_date, id`);
  for (const task of tasks) {
    result.tasks += 1;
    await notify({
      event: "task.due_soon", to: [Number(task.assignee_id)], link: { secao: "Tarefas", aba: `tarefa:${Number(task.id)}` },
      title: String(task.due_date) === today ? "Tarefa vence hoje" : "Tarefa vence amanhã", body: clip(String(task.title), 200),
    });
  }
  return result;
}

// Marca o dia como feito antes de rodar: dois acessos ao mesmo tempo não rodam duas vezes.
async function claimDay(day: string) {
  const claimed = await rows(sql`INSERT INTO notification_state (key, value) VALUES ('daily', ${day})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE notification_state.value < EXCLUDED.value RETURNING key`);
  return claimed.length > 0;
}

// Chamado pela contagem do sino: depois das 6h, o primeiro acesso do dia dispara a rotina (depois da resposta).
let checkedDay = "";
export function maybeRunDaily() {
  const { day, hour } = localNow();
  if (hour < 6 || checkedDay === day) return;
  checkedDay = day;
  runAfterResponse("daily", async () => { if (await claimDay(day)) await runDailyNotifications(day); });
}

// Último dia em que a rotina rodou (tela Configurar notificações).
export async function lastDailyDay() {
  return (await rows(sql`SELECT value FROM notification_state WHERE key = 'daily'`))[0]?.value as string | undefined ?? null;
}
