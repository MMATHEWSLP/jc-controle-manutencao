import ExcelJS from "exceljs";
import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, monthStart } from "../../../../lib/fuel";
import { thirdPartyConsumptionReport } from "../../../../lib/third-parties";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const positive = (value: string | null) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; };

// Relatório "Consumo de Terceiros": por veículo (empresa, placa, abastecimentos, litros, rodado,
// média, última leitura, fora da média) e total por empresa. ?formato=xlsx exporta em Excel.
// Escopo = frentes que a pessoa enxerga ∩ seletor global ∩ filtro de frente.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const today = fuelLocalDay();
    const from = DATE.test(params.get("de") ?? "") ? params.get("de")! : monthStart(today);
    const to = DATE.test(params.get("ate") ?? "") ? params.get("ate")! : today;
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    const scope = fuelScopeFronts(fronts.map((front) => front.id), frentesEmExibicao(user, request), positive(params.get("frente")));
    const filters = { from: from <= to ? from : to, to: from <= to ? to : from, thirdPartyId: positive(params.get("terceiro")), vehicleId: positive(params.get("veiculo")) };
    const report = await thirdPartyConsumptionReport(db, scope, filters);
    if (params.get("formato") !== "xlsx") return Response.json({ ...report, filters, fronts: fronts.filter((front) => scope.includes(front.id)) });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "JC Manutenção";
    const styleHeader = (sheet: ExcelJS.Worksheet) => {
      const header = sheet.getRow(1);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    };
    const sheet = workbook.addWorksheet("Consumo por veículo");
    sheet.columns = [
      { header: "Empresa", key: "company", width: 30 }, { header: "Placa / identificação", key: "plate", width: 18 }, { header: "Modelo", key: "description", width: 24 },
      { header: "Medição", key: "meter", width: 12 }, { header: "Abastecimentos", key: "fuelings", width: 15 }, { header: "Litros", key: "liters", width: 14 },
      { header: "Rodado (km ou h)", key: "distance", width: 16 }, { header: "Média", key: "average", width: 12 }, { header: "Unidade", key: "unit", width: 10 },
      { header: "Última leitura", key: "lastReading", width: 15 }, { header: "Fora da média", key: "outliers", width: 14 },
    ];
    styleHeader(sheet);
    for (const row of report.vehicles) sheet.addRow({
      company: row.company, plate: row.plate, description: row.description ?? "", meter: row.meterType === "KM" ? "KM" : "Horímetro", fuelings: row.fuelings,
      liters: row.liters, distance: row.distance, average: row.average, unit: row.unit, lastReading: row.lastReading, outliers: row.outliers,
    });
    for (const key of ["liters", "distance", "lastReading"]) sheet.getColumn(key).numFmt = "#,##0.00";
    sheet.getColumn("average").numFmt = "#,##0.00";
    const companies = workbook.addWorksheet("Totais por empresa");
    companies.columns = [
      { header: "Empresa", key: "company", width: 30 }, { header: "Veículos", key: "vehicles", width: 10 }, { header: "Abastecimentos", key: "fuelings", width: 15 },
      { header: "Litros", key: "liters", width: 14 }, { header: "Fora da média", key: "outliers", width: 14 },
    ];
    styleHeader(companies);
    for (const row of report.companies) companies.addRow(row);
    companies.getColumn("liters").numFmt = "#,##0.00";
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="consumo-terceiros-${filters.from}-a-${filters.to}.xlsx"`, "Cache-Control": "private, no-store",
    } });
  } catch (error) {
    console.error("[third-parties.consumption]", error);
    return Response.json({ error: "Não foi possível gerar o relatório de consumo agora." }, { status: 500 });
  }
}
