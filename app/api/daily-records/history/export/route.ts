import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { serviceFronts } from "../../../../../db/schema";
import { authorize } from "../../../../../lib/auth";
import { exportDailyHistory, type DailyHistoryRow } from "../../../../../lib/daily-history";
import { formatHistoryDay, formatWorked, HISTORY_EXPORT_LIMIT, historyPeriodLabel, historyStatusText, parseHistoryFilters } from "../../../../../lib/daily-history-rules";
import { canRegister, canViewAll } from "../../../../../lib/daily-records";
import { createDailyHistoryPdf, formatPdfDate } from "../../../../../lib/pdf";

// Exporta exatamente o conjunto exibido no Histórico (mesma query string de filtros da tela):
// ?formato=pdf | ?formato=xlsx. Lista vazia gera um arquivo dizendo "nenhum registro encontrado".
const unitLabel = (unit: "HOURS" | "KM") => (unit === "KM" ? "KM" : "Horímetro");
const productionLabel = (row: DailyHistoryRow) => (!row.hadProduction ? "" : row.productionType === "PORTO" ? "Porto" : row.productionType === "BALDEIO" ? "Baldeio" : "Sim");

export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const format = params.get("formato") === "xlsx" ? "xlsx" : "pdf";
    const filters = parseHistoryFilters(params);
    const fetched = await exportDailyHistory(user, filters, HISTORY_EXPORT_LIMIT + 1);
    const truncated = fetched.length > HISTORY_EXPORT_LIMIT;
    const rows = truncated ? fetched.slice(0, HISTORY_EXPORT_LIMIT) : fetched;
    const frontName = filters.frontId ? (await (await getDb()).select({ name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, filters.frontId)).limit(1))[0]?.name ?? "—" : "Todas as frentes";
    const labels = { period: historyPeriodLabel(filters), front: frontName, operators: filters.operators.length ? filters.operators.join(", ") : "Todos", search: filters.q || "—" };
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);

    if (format === "pdf") {
      const pdf = createDailyHistoryPdf({
        generatedAt: formatPdfDate(now.toISOString()), total: rows.length, truncated, filters: labels,
        items: rows.map((row) => ({
          date: formatHistoryDay(row.recordDate), prefix: row.prefix, equipment: row.equipmentModel,
          operator: row.operator, operatorNote: row.imported ? `Importado (${row.origin})` : row.manualEntry ? `Lançamento manual · por ${row.launchedBy}` : "",
          front: row.front ?? "Sem frente", location: row.location ?? "", worked: formatWorked(row.worked, row.readingUnit),
          status: historyStatusText(row), attention: !row.workedToday || row.inactiveOrProblem || row.reviewStatus === "CONFERIR",
        })),
      });
      return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="historico-registros-diarios-${stamp}.pdf"`, "Cache-Control": "private, no-store" } });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
    workbook.created = now;
    const sheet = workbook.addWorksheet("Registros Diários");
    sheet.columns = [
      { header: "Data", key: "date", width: 12 },
      { header: "Equipamento", key: "equipment", width: 14 },
      { header: "Modelo", key: "model", width: 24 },
      { header: "Operador", key: "operator", width: 26 },
      { header: "Frente de serviço", key: "front", width: 18 },
      { header: "Localização", key: "location", width: 22 },
      { header: "Unidade", key: "unit", width: 11 },
      { header: "Horímetro/KM inicial", key: "start", width: 16 },
      { header: "Horímetro/KM final", key: "end", width: 16 },
      { header: "Horas/KM trabalhados", key: "worked", width: 16 },
      { header: "Status", key: "status", width: 34 },
      { header: "Trabalhou?", key: "workedToday", width: 11 },
      { header: "Motivo (não trabalhou)", key: "noWorkReason", width: 28 },
      { header: "Inativo/problema?", key: "problem", width: 14 },
      { header: "Motivo inatividade/problema", key: "problemReason", width: 30 },
      { header: "Qtd. abastecimentos", key: "fuelingCount", width: 14 },
      { header: "Litros abastecidos", key: "liters", width: 14 },
      { header: "Teve produção?", key: "production", width: 13 },
      { header: "Tipo de produção", key: "productionType", width: 14 },
      { header: "Viagens", key: "trips", width: 9 },
      { header: "Toras", key: "logs", width: 9 },
      { header: "Metragem (m)", key: "meters", width: 12 },
      { header: "Volume no porto (m³)", key: "portVolume", width: 14 },
      { header: "Diesel informado (L)", key: "diesel", width: 14 },
      { header: "Origem", key: "origin", width: 26 },
      { header: "Conferir (motivo)", key: "review", width: 30 },
      { header: "Lançamento manual", key: "manual", width: 14 },
      { header: "Lançado por (conta)", key: "launchedBy", width: 22 },
      { header: "Observações", key: "notes", width: 30 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    header.alignment = { vertical: "middle", wrapText: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

    for (const row of rows) {
      sheet.addRow({
        date: new Date(`${row.recordDate}T12:00:00Z`), equipment: row.prefix, model: row.equipmentModel, operator: row.operator,
        front: row.front ?? "Sem frente", location: row.location ?? "", unit: unitLabel(row.readingUnit),
        start: row.startReading, end: row.endReading, worked: row.worked, status: historyStatusText(row),
        workedToday: row.workedToday ? "Sim" : "Não", noWorkReason: row.workedToday ? "" : row.noWorkReason ?? "",
        problem: row.workedToday ? (row.inactiveOrProblem ? "Sim" : "Não") : "", problemReason: row.inactiveOrProblem ? row.problemReason ?? "" : "",
        fuelingCount: row.fuelingCount, liters: row.fuelingLiters || null,
        production: row.workedToday ? (row.hadProduction ? "Sim" : "Não") : "", productionType: productionLabel(row),
        trips: row.totalTrips ?? (row.hadProduction ? row.tripCount : null), logs: row.hadProduction ? row.logsTotal : null, meters: row.hadProduction ? row.metersTotal : null,
        portVolume: row.portVolumeM3, diesel: row.reportedDieselLiters, origin: row.imported ? row.origin : "App",
        review: row.reviewStatus === "CONFERIR" ? row.reviewReason ?? "Conferir" : "",
        manual: row.manualEntry ? "Sim" : "Não", launchedBy: row.launchedBy, notes: row.notes ?? "",
      });
    }
    if (rows.length === 0) {
      const empty = sheet.addRow({ date: null, equipment: `Nenhum registro encontrado para o período e filtros selecionados (${labels.period}).` });
      empty.font = { italic: true, color: { argb: "FF5B6F7F" } };
    }
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    for (const key of ["start", "end", "worked", "liters", "meters", "portVolume", "diesel"]) sheet.getColumn(key).numFmt = "#,##0.##";

    const summary = workbook.addWorksheet("Filtros");
    summary.columns = [{ header: "Filtro", key: "label", width: 32 }, { header: "Valor", key: "value", width: 60 }];
    summary.getRow(1).font = { bold: true };
    summary.addRows([
      { label: "Relatório", value: "Histórico de Registros Diários — JC Serviços Florestais" },
      { label: "Gerado em", value: formatPdfDate(now.toISOString()) },
      { label: "Período", value: labels.period },
      { label: "Frente de serviço", value: labels.front },
      { label: "Colaboradores", value: labels.operators },
      { label: "Busca (equipamento/operador)", value: labels.search },
      { label: "Local", value: filters.location || "—" },
      { label: "Origem", value: filters.origin === "APP" ? "Feitos no app" : filters.origin === "IMPORTADO" ? "Importados" : "Todos" },
      ...(filters.review ? [{ label: "Somente", value: "Registros para conferir" }] : []),
      { label: "Registros exportados", value: rows.length },
      ...(truncated ? [{ label: "Atenção", value: `Limite de ${HISTORY_EXPORT_LIMIT} registros atingido — refine os filtros para exportar o restante.` }] : []),
    ]);

    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="historico-registros-diarios-${stamp}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[daily-records.history.export]", error);
    return Response.json({ error: "Não foi possível gerar a exportação agora." }, { status: 500 });
  }
}
