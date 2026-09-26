import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { serviceFronts } from "../../../../../db/schema";
import { authorize } from "../../../../../lib/auth";
import { describeHistoryFilters, loadHistoryForExport, parseHistoryFilters, type HistoryRow } from "../../../../../lib/daily-history";
import { canRegister, canViewAll } from "../../../../../lib/daily-records";
import { createDailyRecordsPdf, formatPdfDate } from "../../../../../lib/pdf";

// Exporta exatamente o que a tela do Histórico está filtrando (?formato=pdf|xlsx + filtros).
const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const unitSuffix = (unit: string) => (unit === "KM" ? "km" : "h");
const brDate = (value: string) => value.split("-").reverse().join("/");

function statusText(row: HistoryRow) {
  if (!row.workedToday) return `Não trabalhou${row.noWorkReason ? ` — ${row.noWorkReason}` : ""}`;
  const parts = ["Trabalhou"];
  if (row.inactiveOrProblem) parts.push("Inativo/problema");
  if (row.hadProduction) parts.push(`Produção ${row.productionType === "PORTO" ? "Porto" : "Baldeio"}`);
  if (row.frontRequestStatus === "PENDING") parts.push("Frente aguardando aprovação");
  return parts.join(" · ");
}
const workedText = (row: HistoryRow) => (row.worked === null ? "—" : `${numberFormat.format(row.worked)} ${unitSuffix(row.readingUnit)}`);

function fileSuffix(filters: ReturnType<typeof parseHistoryFilters>) {
  if (filters.from || filters.to) return `${filters.from ? brDate(filters.from).replaceAll("/", "-") : "inicio"}_a_${filters.to ? brDate(filters.to).replaceAll("/", "-") : "hoje"}`;
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const format = params.get("formato") === "xlsx" ? "xlsx" : "pdf";
    const filters = parseHistoryFilters(params);
    const rows = await loadHistoryForExport(user, filters);
    const frontName = filters.frontId ? (await (await getDb()).select({ name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, filters.frontId)).limit(1))[0]?.name ?? null : null;
    const description = describeHistoryFilters(filters, frontName);
    const filename = `historico-registros-diarios_${fileSuffix(filters)}.${format}`;

    if (format === "pdf") {
      const pdf = createDailyRecordsPdf({
        rows: rows.map((row) => ({ date: brDate(row.recordDate), equipment: row.prefix, operator: row.operator, manual: row.manualEntry, front: row.front ?? "—", worked: workedText(row), status: statusText(row) })),
        total: rows.length, generatedAt: formatPdfDate(new Date().toISOString()), filters: description,
      });
      return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Registros diários");
    sheet.columns = [
      { header: "Data", key: "date", width: 12 }, { header: "Equipamento", key: "equipment", width: 13 }, { header: "Modelo", key: "model", width: 20 },
      { header: "Operador", key: "operator", width: 28 }, { header: "Lançamento manual", key: "manual", width: 12 }, { header: "Lançado pela conta", key: "account", width: 24 },
      { header: "Frente de serviço", key: "front", width: 18 }, { header: "Localização", key: "location", width: 20 },
      { header: "Trabalhou", key: "worked", width: 10 }, { header: "Motivo (não trabalhou)", key: "noWork", width: 28 },
      { header: "Unidade", key: "unit", width: 10 }, { header: "Leitura inicial", key: "start", width: 13 }, { header: "Leitura final", key: "end", width: 13 },
      { header: "Trabalhado (h/km)", key: "total", width: 14 },
      { header: "Qtd. abastecimentos", key: "fuelings", width: 12 }, { header: "Litros abastecidos", key: "liters", width: 13 },
      { header: "Inativo/problema", key: "problem", width: 12 }, { header: "Motivo do problema", key: "problemReason", width: 30 },
      { header: "Teve produção", key: "production", width: 11 }, { header: "Tipo de produção", key: "productionType", width: 12 },
      { header: "Viagens", key: "trips", width: 9 }, { header: "Total de toras", key: "logs", width: 11 }, { header: "Metragem total", key: "meters", width: 12 },
      { header: "Frente aguardando aprovação", key: "frontPending", width: 14 }, { header: "Observações", key: "notes", width: 30 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    header.alignment = { vertical: "middle", wrapText: true };
    header.height = 30;
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    if (rows.length === 0) {
      sheet.addRow({ date: "Nenhum registro encontrado para o período e filtros selecionados." });
    }
    for (const row of rows) {
      sheet.addRow({
        date: new Date(`${row.recordDate}T12:00:00Z`), equipment: row.prefix, model: row.equipmentModel ?? "", operator: row.operator,
        manual: row.manualEntry ? "Sim" : "Não", account: row.accountName, front: row.front ?? "", location: row.location ?? "",
        worked: row.workedToday ? "Sim" : "Não", noWork: row.noWorkReason ?? "", unit: row.readingUnit === "KM" ? "KM" : "Horímetro",
        start: row.startReading, end: row.endReading, total: row.worked,
        fuelings: row.fuelings.length, liters: row.fuelings.reduce((sum, item) => sum + item.liters, 0) || null,
        problem: row.inactiveOrProblem ? "Sim" : "Não", problemReason: row.problemReason ?? "",
        production: row.hadProduction ? "Sim" : "Não", productionType: row.productionType === "PORTO" ? "Porto" : row.productionType === "BALDEIO" ? "Baldeio" : "",
        trips: row.trips.length || null, logs: row.trips.reduce((sum, trip) => sum + trip.logs, 0) || null,
        meters: row.trips.reduce((sum, trip) => sum + (trip.meters ?? 0), 0) || null,
        frontPending: row.frontRequestStatus === "PENDING" ? "Sim" : "", notes: row.notes ?? "",
      });
    }
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    for (const key of ["start", "end", "total", "liters", "meters"]) sheet.getColumn(key).numFmt = "#,##0.0";
    if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    const info = workbook.addWorksheet("Filtros");
    info.columns = [{ header: "Informação", key: "label", width: 24 }, { header: "Valor", key: "value", width: 90 }];
    info.getRow(1).font = { bold: true };
    info.addRow({ label: "Relatório", value: "Histórico de Registros Diários — Controle Diário" });
    info.addRow({ label: "Filtros aplicados", value: description });
    info.addRow({ label: "Gerado em", value: formatPdfDate(new Date().toISOString()) });
    info.addRow({ label: "Total de registros", value: rows.length });
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[daily-records.history.export]", error);
    return Response.json({ error: "Não foi possível gerar a exportação agora." }, { status: 500 });
  }
}
