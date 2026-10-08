import { sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { fuelLocalDay } from "../../../../lib/fuel";
import { describePeriod, fuelByDestination, parsePeriod, type DestinationRow } from "../../../../lib/more-reports";
import { exportTable } from "../../../../lib/report-export";
import { canSeeReport } from "../../../../lib/reports-catalog";

// RELATÓRIOS → Combustível → Combustível por destino (?combustivel=id; padrão: gasolina). ?formato=xlsx|pdf.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "combustivel-destino")) return Response.json({ error: "Você não tem acesso aos relatórios de combustível." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const db = await getDb();
    const types = ((await db.execute(sql`SELECT id, code, name FROM fuel_types WHERE active ORDER BY sort_order, name`)) as unknown as { rows: Array<{ id: number; code: string; name: string }> }).rows;
    const requested = params.get("combustivel");
    const fuelTypeId = requested === "todos" ? null : Number(requested) || types.find((type) => type.code.startsWith("GASOLINA"))?.id || null;
    const filters = { ...parsePeriod(params, fuelLocalDay()), fuelTypeId };
    const report = await fuelByDestination(filters, frentesEmExibicao(user, request));
    const format = params.get("formato");
    if (!format) return Response.json({ ...report, fuelTypes: types, fuelTypeId }, { headers: { "Cache-Control": "no-store" } });
    const fuelName = fuelTypeId ? types.find((type) => type.id === fuelTypeId)?.name ?? "—" : "Todos os combustíveis";
    return exportTable<DestinationRow>(format, {
      title: `${fuelName} por destino`, section: "RELATÓRIOS · COMBUSTÍVEL", filters: await describePeriod(filters, [fuelName]), generatedBy: user.name, file: `combustivel-por-destino-${filters.from}-a-${filters.to}`,
      columns: [
        { header: "Destino", value: (row) => row.destination, width: 3 }, { header: "Tipo", value: (row) => row.kind, width: 1.4 }, { header: "Finalidade", value: (row) => row.purpose ?? "", width: 1.6 },
        { header: "Frente", value: (row) => row.front, width: 1.4 }, { header: "Lançamentos", value: (row) => row.count, width: 1, decimals: 0 },
        { header: "Litros", value: (row) => row.liters, width: 1 }, { header: "Valor (R$)", value: (row) => row.value, width: 1.2, money: true },
      ],
      rows: report.rows, total: ["TOTAL", "", "", "", report.totals.count, report.totals.liters, report.totals.value],
      footer: "Saídas do Combustível (sem excluídas e sem ajustes de saldo); valor pelo custo médio do estoque, o mesmo do Combustível.",
    });
  } catch (error) {
    console.error("[reports.fuel-destinations]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}
