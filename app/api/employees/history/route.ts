import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { canSeeSensitive, employeeHistory, employeeScope, type HistoryFilters } from "../../../../lib/employees";
import { createEmployeeHistoryPdf, formatPdfDate } from "../../../../lib/pdf";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const brDay = (value: string | null) => (value ? value.split("-").reverse().join("/") : "—");
const days = (value: number | null) => (value === null ? "—" : String(value));

// Histórico de folgas (ciclos) ou afastamentos, com filtros de nome, empresa e período (?formato=pdf
// exporta exatamente a mesma consulta).
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    const filters: HistoryFilters = {
      name: params.get("nome")?.trim() ?? "", company: params.get("empresa")?.trim().toUpperCase() ?? "",
      type: params.get("tipo") === "AFASTAMENTO" ? "AFASTAMENTO" : "FOLGA",
      from: DATE.test(params.get("de") ?? "") ? params.get("de") : null, to: DATE.test(params.get("ate") ?? "") ? params.get("ate") : null,
    };
    if (filters.from && filters.to && filters.from > filters.to) return Response.json({ error: "O período inicial não pode ser depois do final." }, { status: 400 });
    const db = await getDb();
    const { fronts, scope } = await employeeScope(db, auth.user!, request);
    // Afastamentos: tipo e motivo (podem ser de saúde) só para o ADMIN, na tela e no PDF.
    const rows = await employeeHistory(db, scope, filters, { showSensitive: canSeeSensitive(auth.user!) });
    if (params.get("formato") !== "pdf") return Response.json({ rows, filters });
    const frontLabel = scope.length === fronts.length && fronts.length > 1 ? "Todas as frentes" : fronts.filter((front) => scope.includes(front.id)).map((front) => front.name).join(", ") || "—";
    const filterText = [frontLabel, filters.name ? `Nome: ${filters.name}` : null, filters.company ? `Empresa: ${filters.company}` : null, filters.from || filters.to ? `Período: ${brDay(filters.from)} a ${brDay(filters.to)}` : "Todo o período"].filter(Boolean).join(" · ");
    const now = new Date();
    const pdf = filters.type === "FOLGA"
      ? createEmployeeHistoryPdf({
        title: "HISTÓRICO DE FOLGAS", filters: filterText, generatedAt: formatPdfDate(now.toISOString()), total: rows.length,
        columns: [{ x: 34, label: "FUNCIONÁRIO", max: 30 }, { x: 170, label: "EMPRESA", max: 11 }, { x: 222, label: "CICLO", max: 4 }, { x: 252, label: "INÍCIO", max: 10 }, { x: 302, label: "DIAS TRAB.", max: 6 }, { x: 352, label: "SAÍDA FRENTE", max: 10 }, { x: 414, label: "CHEG. CASA", max: 10 }, { x: 468, label: "VIAGEM IDA", max: 5 }, { x: 520, label: "SAÍDA CASA", max: 10 }, { x: 574, label: "DIAS FOLGA", max: 5 }, { x: 626, label: "CHEG. FRENTE", max: 10 }, { x: 686, label: "VIAGEM VOLTA", max: 5 }, { x: 746, label: "SITUAÇÃO", max: 14 }],
        rows: rows.map((row) => row.kind === "FOLGA" ? [row.name, row.company, String(row.cycleNumber), brDay(row.workStart), days(row.summary.workedDays), brDay(row.frontDeparture), brDay(row.homeArrival), days(row.summary.travelOutDays), brDay(row.homeDeparture), days(row.summary.offDays), brDay(row.frontArrival), days(row.summary.travelBackDays), row.summary.phaseLabel] : []),
      })
      : createEmployeeHistoryPdf({
        title: "HISTÓRICO DE AFASTAMENTOS", filters: filterText, generatedAt: formatPdfDate(now.toISOString()), total: rows.length,
        columns: [{ x: 34, label: "FUNCIONÁRIO", max: 34 }, { x: 190, label: "EMPRESA", max: 12 }, { x: 250, label: "FRENTE", max: 14 }, { x: 320, label: "TIPO", max: 18 }, { x: 410, label: "INÍCIO", max: 10 }, { x: 466, label: "TÉRMINO", max: 10 }, { x: 522, label: "DIAS", max: 5 }, { x: 560, label: "OBSERVAÇÕES", max: 60 }],
        rows: rows.map((row) => row.kind === "AFASTAMENTO" ? [row.name, row.company, row.frontName, row.absenceKind, brDay(row.startDate), row.endDate ? brDay(row.endDate) : "Em aberto", String(row.days), row.notes ?? "—"] : []),
      });
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="funcionarios-${filters.type === "FOLGA" ? "folgas" : "afastamentos"}-${now.toISOString().slice(0, 10)}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[employees.history]", error);
    return Response.json({ error: "Não foi possível carregar o histórico agora." }, { status: 500 });
  }
}
