import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { fuelLocalDay } from "../../../../lib/fuel";
import { describePeriod, parsePeriod, stockAdjustments, type AdjustmentRow } from "../../../../lib/more-reports";
import { exportTable } from "../../../../lib/report-export";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Peças e produtos → Ajustes de estoque (?q= produto ou TAG). ?formato=xlsx|pdf.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "ajustes-estoque")) return Response.json({ error: "Você não tem acesso aos relatórios de peças e produtos." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const filters = { ...parsePeriod(params, fuelLocalDay()), q: (params.get("q") ?? "").slice(0, 80) };
    const report = await stockAdjustments(filters, frentesEmExibicao(user, request));
    const format = params.get("formato");
    if (!format) return Response.json(report, { headers: { "Cache-Control": "no-store" } });
    const br = (day: string) => day.split("-").reverse().join("/");
    return exportTable<AdjustmentRow>(format, {
      title: "Ajustes de estoque", section: "RELATÓRIOS · PEÇAS E PRODUTOS", filters: await describePeriod(filters, [filters.q && `Produto "${filters.q}"`]), generatedBy: user.name, file: `ajustes-de-estoque-${filters.from}-a-${filters.to}`,
      columns: [
        { header: "Data", value: (row) => br(row.date), width: 1 }, { header: "Frente", value: (row) => row.front, width: 1.3 }, { header: "TAG", value: (row) => row.tag, width: 0.8 },
        { header: "Produto", value: (row) => row.product, width: 2.6 }, { header: "Quantidade", value: (row) => row.delta, width: 1 }, { header: "Valor (R$)", value: (row) => row.value, width: 1.1, money: true },
        { header: "Origem", value: (row) => row.origin, width: 2 }, { header: "Motivo", value: (row) => row.reason, width: 2.4 }, { header: "Por", value: (row) => row.user ?? "", width: 1.3 },
      ],
      rows: report.rows, total: ["TOTAL", "", "", `${report.totals.increases} entrada(s) · ${report.totals.decreases} saída(s)`, "", report.totals.increaseValue + report.totals.decreaseValue, "", "", ""],
      footer: "Ajuste manual do saldo (Produtos) e Correção de estoque do histórico importado. Valor = quantidade × valor do movimento (sem valor, o preço do cadastro).",
    });
  } catch (error) {
    console.error("[reports.stock-adjustments]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}
