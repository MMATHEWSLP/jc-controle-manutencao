// ---------------------------------------------------------------------------
// Resumo semanal (segunda a domingo): cálculo da semana e texto para WhatsApp. Sem banco.
// ---------------------------------------------------------------------------
export type WeeklyReport = {
  period: { from: string; to: string };
  scope: string;
  fuel: { exitLiters: number; entryLiters: number; fuelCost: number; outliers: Array<{ prefix: string; consumption: number; typeAverage: number; unit: "HOURS" | "KM" }>; withoutUsage: number };
  costs: { total: number; parts: number; maintenance: number } | null;
  maintenance: { done: number; overdue: number; near: number; overdueList: string[] };
  workOrders: { opened: number; closed: number; openNow: number; oldest: Array<{ number: string; prefix: string; days: number }> };
  checklists: { total: number; blocked: number; pending: number; blockedList: string[] };
  daily: { records: number; problems: number; problemList: Array<{ prefix: string; reason: string }> };
  tanks: { measurements: number; outside: number; lossLiters: number };
  fleet: { maintenance: number; stopped: number };
  components: { alerts: number; list: string[] };
};

const DAY = 86400000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const parse = (day: string) => new Date(`${day}T12:00:00Z`);

// Semana (segunda a domingo) que contém o dia.
export function weekOf(day: string) {
  const date = parse(day);
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY);
  return { from: iso(monday), to: iso(new Date(monday.getTime() + 6 * DAY)) };
}

// Última semana completa antes de hoje (o envio de segunda fala da semana que acabou).
export function previousWeek(today: string) {
  return weekOf(iso(new Date(parse(today).getTime() - 7 * DAY)));
}

const br = (day: string) => day.split("-").reverse().slice(0, 2).join("/");
const liters = (value: number) => `${Math.round(value).toLocaleString("pt-BR")} L`;
const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const list = (items: string[], max = 5) => items.length > max ? `${items.slice(0, max).join(", ")} e mais ${items.length - max}` : items.join(", ");

// Texto com formatação do WhatsApp (*negrito*), uma seção por assunto, só com o que tem conteúdo.
export function weeklyReportText(report: WeeklyReport, link?: string) {
  const lines: string[] = [`*Resumo semanal — ${br(report.period.from)} a ${br(report.period.to)}*`, report.scope, ""];
  lines.push("*Combustível*");
  lines.push(`• Saídas para a frota: ${liters(report.fuel.exitLiters)}${report.fuel.fuelCost > 0 ? ` (${money(report.fuel.fuelCost)})` : ""}`);
  if (report.fuel.entryLiters > 0) lines.push(`• Entradas: ${liters(report.fuel.entryLiters)}`);
  if (report.fuel.outliers.length) lines.push(`• Consumo acima da média: ${list(report.fuel.outliers.map((item) => item.prefix))}`);
  if (report.tanks.outside > 0) lines.push(`• Tanque: ${report.tanks.outside} medição(ões) fora da tolerância${report.tanks.lossLiters > 0 ? ` (perda de ${liters(report.tanks.lossLiters)})` : ""}`);
  if (report.costs && report.costs.total > 0) lines.push(`• Custo total da frota: ${money(report.costs.total)} (peças ${money(report.costs.parts)}, trocas ${money(report.costs.maintenance)})`);
  lines.push("", "*Manutenção*");
  lines.push(`• Trocas registradas na semana: ${report.maintenance.done}`);
  lines.push(`• Trocas vencidas hoje: ${report.maintenance.overdue}${report.maintenance.overdueList.length ? ` (${list(report.maintenance.overdueList)})` : ""}${report.maintenance.near ? ` · urgentes: ${report.maintenance.near}` : ""}`);
  lines.push(`• O.S.: ${report.workOrders.opened} aberta(s) e ${report.workOrders.closed} fechada(s) na semana · ${report.workOrders.openNow} em aberto`);
  if (report.workOrders.oldest.length) lines.push(`• O.S. mais antigas: ${report.workOrders.oldest.map((item) => `${item.number} ${item.prefix} (${item.days} dias)`).join(", ")}`);
  if (report.fleet.maintenance + report.fleet.stopped > 0) lines.push(`• Frota agora: ${report.fleet.maintenance} em manutenção, ${report.fleet.stopped} parado(s)`);
  if (report.components.alerts > 0) lines.push(`• Pneus/baterias com alerta: ${report.components.alerts}${report.components.list.length ? ` (${list(report.components.list)})` : ""}`);
  lines.push("", "*Operação*");
  lines.push(`• Controle Diário: ${report.daily.records} registro(s), ${report.daily.problems} com problema${report.daily.problemList.length ? ` (${list(report.daily.problemList.map((item) => item.prefix))})` : ""}`);
  lines.push(`• Checklists: ${report.checklists.total} · ${report.checklists.blocked} bloqueado(s) · ${report.checklists.pending} com pendência${report.checklists.blockedList.length ? ` (bloqueados: ${list(report.checklists.blockedList)})` : ""}`);
  if (link) lines.push("", `Detalhes: ${link}`);
  return lines.join("\n");
}

// Uma linha só (parâmetro de modelo da Meta não aceita quebra de linha nem espaços repetidos).
export function weeklySummaryLine(report: WeeklyReport) {
  const parts = [
    `Combustível ${liters(report.fuel.exitLiters)}${report.fuel.outliers.length ? ` (${report.fuel.outliers.length} acima da média)` : ""}`,
    `trocas feitas ${report.maintenance.done}, vencidas ${report.maintenance.overdue}`,
    `O.S. abertas ${report.workOrders.openNow}`,
    `checklists ${report.checklists.total} (${report.checklists.blocked} bloqueados)`,
    `Controle Diário ${report.daily.records} (${report.daily.problems} com problema)`,
  ];
  if (report.tanks.outside) parts.push(`tanque fora da tolerância ${report.tanks.outside}`);
  if (report.components.alerts) parts.push(`pneus/baterias com alerta ${report.components.alerts}`);
  return parts.join("; ").replace(/\s+/g, " ").slice(0, 900);
}
