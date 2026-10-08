import ExcelJS from "exceljs";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, monthStart } from "../../../../lib/fuel";
import { canSeeReport } from "../../../../lib/reports-catalog";
import { thirdPartySummary } from "../../../../lib/third-parties";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// "Resumo por empresa": combustível em veículos / para funcionários, peças em veículos / para
// funcionários e valor total, no período (padrão: mês atual). ?formato=xlsx exporta em Excel.
// Fica no menu RELATÓRIOS → Combustível (saiu do fim da tela Terceiros).
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canSeeReport(user, "terceiros-empresa")) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const today = fuelLocalDay();
    const from = DATE.test(params.get("de") ?? "") ? params.get("de")! : monthStart(today);
    const to = DATE.test(params.get("ate") ?? "") ? params.get("ate")! : today;
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    const scope = fuelScopeFronts(fronts.map((front) => front.id), frentesEmExibicao(user, request), null);
    const filters = { from: from <= to ? from : to, to: from <= to ? to : from, thirdPartyId: Number(params.get("terceiro")) || null };
    const report = await thirdPartySummary(db, scope, filters);
    if (params.get("formato") !== "xlsx") return Response.json({ ...report, filters });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Resumo por empresa");
    sheet.columns = [
      { header: "Empresa", key: "company", width: 30 },
      { header: "Combustível em veículos (L)", key: "fuelVehicleLiters", width: 18 }, { header: "Combustível em veículos (R$)", key: "fuelVehicleValue", width: 18 },
      { header: "Combustível p/ funcionários (L)", key: "fuelEmployeeLiters", width: 20 }, { header: "Combustível p/ funcionários (R$)", key: "fuelEmployeeValue", width: 20 },
      { header: "Combustível sem destino (L)", key: "fuelOtherLiters", width: 18 },
      { header: "Peças em veículos (R$)", key: "partsVehicleValue", width: 18 }, { header: "Peças p/ funcionários (R$)", key: "partsEmployeeValue", width: 18 },
      { header: "Peças sem destino (R$)", key: "partsOtherValue", width: 16 }, { header: "Total (R$)", key: "totalValue", width: 16 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of report.companies) sheet.addRow(row);
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="terceiros-resumo-${filters.from}-${filters.to}.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[third-parties.summary]", error);
    return Response.json({ error: "Não foi possível montar o resumo agora." }, { status: 500 });
  }
}
