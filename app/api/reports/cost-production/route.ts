import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { costProductionOptions, costProductionReport, parseCostProductionFilters, type CostProductionFilters } from "../../../../lib/cost-production";
import { COST_CATEGORIES, COST_CATEGORY_KEYS, GROUPINGS, SORTS, type CostRow } from "../../../../lib/cost-production-rules";
import { fuelLocalDay } from "../../../../lib/fuel";
import { createFuelHistoryPdf, formatPdfDate } from "../../../../lib/pdf";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Custos → relatórios casados (custo x produção). ?formato=xlsx|pdf exporta com os
// mesmos filtros da tela; o cabeçalho traz os filtros, quem gerou e quando.
const money = (value: number) => value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (value: number, digits = 1) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const opt = (value: number | null, format: (value: number) => string) => (value === null ? "—" : format(value));
const br = (day: string) => day.split("-").reverse().join("/");
const brMonth = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "casado-geral")) return Response.json({ error: "Você não tem acesso aos relatórios de custos." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const today = fuelLocalDay();
    const filters = parseCostProductionFilters(params, today);
    const fronts = frentesEmExibicao(user, request);
    const report = await costProductionReport(filters, fronts, today);
    const format = params.get("formato");
    if (!format) {
      return Response.json({ ...report, filters, options: await costProductionOptions(fronts), canLaunch: user.permissions.includes("costs.other_expenses") }, { headers: { "Cache-Control": "no-store" } });
    }
    const description = await describeFilters(filters, report.previousPeriod);
    const keyLabel = (row: CostRow) => (filters.grouping === "mes" ? brMonth(row.key) : row.key);
    const title = `Custo x produção — ${filters.grouping === "geral" ? "geral" : `por ${GROUPINGS[filters.grouping].toLowerCase()}`}`;
    const file = `custo-producao-${filters.grouping}-${filters.from}-a-${filters.to}`;
    const generatedAt = formatPdfDate(new Date().toISOString());
    const shown = COST_CATEGORIES.filter((category) => filters.categories.includes(category.key));

    if (format === "pdf") {
      const t = report.total;
      const pdf = createFuelHistoryPdf({
        title: title.toUpperCase(), subtitle: "Produção do Controle Diário x custos (diesel, gasolina, peças, manutenção/serviços, pneus e outros)",
        generatedAt, generatedBy: user.name, filters: description, total: report.rows.length, truncated: false, emptyText: "Nenhum custo ou produção no período e filtros.",
        cardsNote: `Valores em R$ · ${num(t.hours)} h · ${num(t.km, 0)} km · ${num(t.trips, 0)} viagens · ${num(t.volume)} m³`,
        cards: [
          { label: "Custo total", value: `R$ ${money(t.total)}`, detail: t.previous ? `anterior R$ ${money(t.previous.total)}` : "no período", tone: "blue" },
          { label: "Diesel", value: `R$ ${money(t.costs.diesel)}`, detail: `${num(t.dieselLiters, 0)} L`, tone: "gray" },
          { label: "Peças", value: `R$ ${money(t.costs.pecas)}`, detail: `manut./serv. R$ ${money(t.costs.manutencao)}`, tone: "gray" },
          { label: "R$ por hora", value: opt(t.perHour, money), detail: `R$/km ${opt(t.perKm, money)}`, tone: "green" },
          { label: "R$ por viagem", value: opt(t.perTrip, money), detail: `R$/m³ ${opt(t.perM3, money)}`, tone: "green" },
        ],
        columns: [
          { x: 34, label: GROUPINGS[filters.grouping].toUpperCase(), max: 22 }, { x: 132, label: "DIESEL", max: 12 }, { x: 184, label: "GASOLINA", max: 12 },
          { x: 236, label: "PEÇAS", max: 12 }, { x: 288, label: "MANUT./SERV.", max: 12 }, { x: 344, label: "PNEUS", max: 11 }, { x: 392, label: "OUTROS", max: 11 },
          { x: 440, label: "TOTAL", max: 13 }, { x: 498, label: "HORAS", max: 9 }, { x: 540, label: "KM", max: 9 }, { x: 582, label: "VIAGENS", max: 8 },
          { x: 624, label: "M³", max: 9 }, { x: 666, label: "R$/H", max: 9 }, { x: 710, label: "R$/KM", max: 9 }, { x: 758, label: "R$/VIAGEM", max: 10 },
        ],
        rows: [...report.rows, report.total].map((row) => [
          row === report.total ? "TOTAL" : keyLabel(row), money(row.costs.diesel), money(row.costs.gasolina), money(row.costs.pecas), money(row.costs.manutencao),
          money(row.costs.pneus), money(row.costs.outros), money(row.total), num(row.hours), num(row.km, 0), num(row.trips, 0), num(row.volume),
          opt(row.perHour, money), opt(row.perKm, money), opt(row.perTrip, money),
        ]),
        footer: "Diesel/gasolina pelo custo médio do estoque; peças pelo valor da saída. Por operador/local, o custo do equipamento é dividido pelas horas (ou km) de cada um. Nenhum registro foi alterado.",
      });
      return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${file}.pdf"`, "Cache-Control": "private, no-store" } });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "JC Manutenção";
    const sheet = workbook.addWorksheet("Custo x produção");
    sheet.addRow([title]).font = { bold: true, size: 13 };
    for (const line of description) sheet.addRow([line]);
    sheet.addRow([`Gerado por ${user.name} em ${generatedAt}`]);
    sheet.addRow([]);
    const header = [GROUPINGS[filters.grouping], ...shown.map((category) => `${category.label} (R$)`), "Custo total (R$)", "Diesel (L)", "Gasolina (L)", "Horas", "KM", "Viagens", "Volume (m³)", "Toras", "Fichas",
      "R$ por hora", "R$ por km", "R$ por viagem", "R$ por m³", "Diesel L/h", "km por litro de diesel", "Diesel L/m³", ...(filters.compare ? ["Custo total anterior (R$)", "Variação do custo"] : [])];
    sheet.addRow(header).font = { bold: true };
    const line = (row: CostRow, name: string) => [name, ...shown.map((category) => row.costs[category.key]), row.total, row.dieselLiters, row.gasolineLiters, row.hours, row.km, row.trips, row.volume, row.logs, row.records,
      row.perHour, row.perKm, row.perTrip, row.perM3, row.litersPerHour, row.kmPerLiter, row.litersPerM3,
      ...(filters.compare ? [row.previous?.total ?? null, row.previous?.total ? (row.total - row.previous.total) / row.previous.total : null] : [])];
    for (const row of report.rows) sheet.addRow(line(row, keyLabel(row)));
    sheet.addRow(line(report.total, "TOTAL")).font = { bold: true };
    sheet.columns.forEach((column, index) => { column.width = index === 0 ? 30 : 15; if (index > 0) column.numFmt = "#,##0.00"; });
    sheet.addRow([]);
    sheet.addRow(["Diesel e gasolina pelo custo médio do estoque (o mesmo do Combustível). Peças pelo valor da saída. Troca de óleo contada uma vez por troca."]);
    sheet.addRow(["Por operador e por local, o custo de cada equipamento é dividido na proporção das horas (ou km) que cada um trabalhou com ele no período."]);
    if (report.total.litersWithoutPrice > 0) sheet.addRow([`${num(report.total.litersWithoutPrice, 0)} L de combustível sem preço de entrada para valorar (entram nos litros, não no R$).`]);
    const monthly = workbook.addWorksheet("Mês a mês");
    monthly.addRow(["Mês", ...shown.map((category) => `${category.label} (R$)`), "Total (R$)"]).font = { bold: true };
    for (const month of report.monthly) monthly.addRow([brMonth(month.month), ...shown.map((category) => month.costs[category.key]), month.total]);
    monthly.columns.forEach((column, index) => { column.width = index === 0 ? 12 : 18; if (index > 0) column.numFmt = "#,##0.00"; });
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${file}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[reports.cost-production]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}

// Filtros por extenso para o cabeçalho do Excel e do PDF.
async function describeFilters(f: CostProductionFilters, previous: { from: string; to: string } | null) {
  const db = await getDb();
  const name = async (query: ReturnType<typeof sql>) => ((await db.execute(query)) as unknown as { rows: Array<{ name: string }> }).rows[0]?.name ?? "—";
  const parts = [`Período ${br(f.from)} a ${br(f.to)}`, `Agrupado por ${GROUPINGS[f.grouping].toLowerCase()}`, `Ordem: ${SORTS[f.sort].toLowerCase()}`];
  if (f.frontId) parts.push(`Frente ${await name(sql`SELECT name FROM service_fronts WHERE id = ${f.frontId}`)}`);
  if (f.equipmentId) parts.push(`Equipamento ${await name(sql`SELECT prefix AS name FROM equipment WHERE id = ${f.equipmentId}`)}`);
  if (f.equipmentType) parts.push(`Tipo ${f.equipmentType}`);
  if (f.companyId) parts.push(`Empresa ${await name(sql`SELECT name FROM companies WHERE id = ${f.companyId}`)}`);
  if (f.operator) parts.push(`Operador "${f.operator}"`);
  if (f.location) parts.push(`Local "${f.location}"`);
  if (f.categories.length < COST_CATEGORY_KEYS.length) parts.push(`Gastos: ${COST_CATEGORIES.filter((category) => f.categories.includes(category.key)).map((category) => category.label).join(", ")}`);
  if (previous) parts.push(`Comparado com ${br(previous.from)} a ${br(previous.to)}`);
  return parts;
}
