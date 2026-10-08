import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { fuelLocalDay } from "../../../../lib/fuel";
import { describePeriod, parsePeriod, workOrdersReport, type WorkOrderRow } from "../../../../lib/more-reports";
import { exportTable } from "../../../../lib/report-export";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Manutenção → Ordens de serviço (abertas no período; ?situacao=OPEN|CLOSED&equipamento=id). ?formato=xlsx|pdf.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "ordens-servico")) return Response.json({ error: "Você não tem acesso aos relatórios de manutenção." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const today = fuelLocalDay();
    const situacao = params.get("situacao");
    const filters = { ...parsePeriod(params, today), status: situacao === "OPEN" || situacao === "CLOSED" ? situacao as "OPEN" | "CLOSED" : null, equipmentId: Number(params.get("equipamento")) || null };
    const report = await workOrdersReport(filters, frentesEmExibicao(user, request), today);
    const format = params.get("formato");
    if (!format) return Response.json(report, { headers: { "Cache-Control": "no-store" } });
    const br = (day: string | null) => (day ? day.split("-").reverse().join("/") : "—");
    return exportTable<WorkOrderRow>(format, {
      title: "Ordens de serviço", section: "RELATÓRIOS · MANUTENÇÃO", generatedBy: user.name, file: `ordens-de-servico-${filters.from}-a-${filters.to}`,
      filters: await describePeriod(filters, [filters.status === "OPEN" ? "Só abertas" : filters.status === "CLOSED" ? "Só fechadas" : "", filters.equipmentId ? `Equipamento ${report.rows[0]?.prefix ?? filters.equipmentId}` : ""]),
      columns: [
        { header: "O.S.", value: (row) => row.number, width: 1 }, { header: "Equipamento", value: (row) => row.prefix, width: 1.1 }, { header: "Frente", value: (row) => row.front, width: 1.2 },
        { header: "Aberta em", value: (row) => br(row.openedAt), width: 1 }, { header: "Fechada em", value: (row) => br(row.closedAt), width: 1 }, { header: "Dias", value: (row) => row.days, width: 0.6, decimals: 0 },
        { header: "Descrição", value: (row) => row.description, width: 3 }, { header: "Peças", value: (row) => row.items, width: 0.7, decimals: 0 }, { header: "Peças (R$)", value: (row) => row.partsTotal, width: 1.1, money: true },
        { header: "Mecânicos", value: (row) => row.mechanics, width: 1.8 },
      ],
      rows: report.rows, total: ["TOTAL", `${report.totals.count} O.S.`, "", `${report.totals.open} abertas`, `${report.totals.closed} fechadas`, report.totals.averageDaysClosed, "", "", report.totals.partsTotal, ""],
      footer: "O.S. abertas no período. Dias = até o fechamento (ou até hoje, se aberta). Total da linha Dias = média das fechadas. Peças pelo valor lançado na O.S.",
    });
  } catch (error) {
    console.error("[reports.work-orders]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}
