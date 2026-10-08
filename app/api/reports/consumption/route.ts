import { getD1 } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { fleetCostReport } from "../../../../lib/fleet-costs";
import { fuelLocalDay } from "../../../../lib/fuel";
import { describePeriod, parsePeriod } from "../../../../lib/more-reports";
import { exportTable } from "../../../../lib/report-export";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Combustível → Consumo por equipamento: litros, uso (horas/km) e consumo (L/h ou km/L)
// comparado à média do tipo — o mesmo cálculo do Custos e Consumo, sem os valores em R$.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "consumo-equipamento")) return Response.json({ error: "Você não tem acesso aos relatórios de combustível." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const filters = parsePeriod(params, fuelLocalDay());
    const report = await fleetCostReport(await getD1(), user, { from: filters.from, to: filters.to, frontId: filters.frontId });
    const rows = report.rows.filter((row) => row.liters > 0 && (params.get("fora") !== "1" || row.outlier === "ACIMA"))
      .map(({ equipmentId, prefix, type, front, unit, liters, usage, consumption, typeAverage, deviation, outlier }) => ({ equipmentId, prefix, type, front, unit, liters, usage, consumption, typeAverage, deviation, outlier }))
      .sort((a, b) => b.liters - a.liters || a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true }));
    const totals = { liters: Math.round(rows.reduce((sum, row) => sum + row.liters, 0) * 100) / 100, outliers: rows.filter((row) => row.outlier === "ACIMA").length, withoutUsage: rows.filter((row) => row.usage === null).length };
    const format = params.get("formato");
    if (!format) return Response.json({ rows, totals, fronts: report.fronts }, { headers: { "Cache-Control": "no-store" } });
    type Row = (typeof rows)[number];
    const unit = (row: Row) => (row.unit === "KM" ? "km/L" : "L/h");
    return exportTable<Row>(format, {
      title: "Consumo de combustível por equipamento", section: "RELATÓRIOS · COMBUSTÍVEL", filters: await describePeriod(filters, [params.get("fora") === "1" ? "Só consumo acima da média" : ""]), generatedBy: user.name,
      file: `consumo-por-equipamento-${filters.from}-a-${filters.to}`,
      columns: [
        { header: "Equipamento", value: (row) => row.prefix, width: 1 }, { header: "Tipo", value: (row) => row.type, width: 1.4 }, { header: "Frente", value: (row) => row.front ?? "", width: 1.2 },
        { header: "Litros", value: (row) => row.liters, width: 0.9 }, { header: "Uso", value: (row) => (row.usage === null ? "sem leitura" : `${row.usage.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${row.unit === "KM" ? "km" : "h"}`), width: 1 },
        { header: "Consumo", value: (row) => (row.consumption === null ? "" : `${row.consumption.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${unit(row)}`), width: 1 },
        { header: "Média do tipo", value: (row) => (row.typeAverage === null ? "" : `${row.typeAverage.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${unit(row)}`), width: 1 },
        { header: "Situação", value: (row) => (row.outlier === "ACIMA" ? "Gasta mais que a média" : row.outlier === "ABAIXO" ? "Gasta menos que a média" : ""), width: 1.5 },
      ],
      rows, total: ["TOTAL", "", "", totals.liters, `${totals.withoutUsage} sem leitura`, "", "", `${totals.outliers} acima da média`],
      footer: "Consumo = litros ÷ horas (L/h) ou km ÷ litros (km/L) no período, pelas leituras de horímetro/KM. Acima da média = mais de 25% pior que os equipamentos do mesmo tipo.",
    });
  } catch (error) {
    console.error("[reports.consumption]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}
