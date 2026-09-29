import ExcelJS from "exceljs";
import { getDb } from "../../../../db";
import { frentesVisiveis } from "../../../../lib/access";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { authorize } from "../../../../lib/auth";
import { listStockMovements } from "../../../../lib/stock-history";
import { isIsoDay } from "../../../../lib/stock-options";

const positive = (value: string | null) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; };

// Exporta em Excel o Histórico da Movimentação com os mesmos filtros da tela (inclusive terceiro e
// veículo do terceiro): produto, quantidade, valor, empresa, veículo, quem recebeu, data e frente.
export async function GET(request: Request) {
  const auth = await authorize(request, "stock.exits_view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const from = url.searchParams.get("de"); const to = url.searchParams.get("ate");
    const visible = frentesVisiveis(user);
    const displayed = frentesEmExibicao(user, request);
    const rows = await listStockMovements(await getDb(), {
      equipmentId: positive(url.searchParams.get("equipamento")), employeeId: positive(url.searchParams.get("funcionario")),
      departmentId: positive(url.searchParams.get("departamento")), productId: positive(url.searchParams.get("produto")),
      thirdPartyId: positive(url.searchParams.get("terceiro")), thirdPartyVehicleId: positive(url.searchParams.get("veiculoTerceiro")),
      from: isIsoDay(from) ? from : null, to: isIsoDay(to) ? to : null,
      fronts: displayed === "ALL" ? visible : displayed, sources: ["STOCK_EXIT", "WORK_ORDER"], exitsOnly: true, closedWorkOrdersOnly: true, limit: 2000,
    });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "JC Manutenção";
    const sheet = workbook.addWorksheet("Movimentação");
    sheet.columns = [
      { header: "Data", key: "date", width: 12 }, { header: "Documento", key: "origin", width: 12 }, { header: "TAG", key: "tag", width: 10 },
      { header: "Produto", key: "product", width: 34 }, { header: "Quantidade", key: "quantity", width: 12 }, { header: "Valor unitário (R$)", key: "unitPrice", width: 16 },
      { header: "Valor total (R$)", key: "total", width: 16 }, { header: "Destino / aplicação", key: "application", width: 28 }, { header: "Empresa (terceiro)", key: "company", width: 28 },
      { header: "Veículo do terceiro", key: "vehicle", width: 18 }, { header: "Recebido por", key: "receivedBy", width: 22 }, { header: "Frente", key: "front", width: 16 },
      { header: "Lançado por", key: "createdBy", width: 22 },
    ];
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of rows) sheet.addRow({
      date: new Date(`${row.date}T12:00:00Z`), origin: row.originNumber, tag: row.product.tag, product: row.product.name, quantity: row.quantity,
      unitPrice: row.unitPrice, total: row.total, application: row.application ?? "", company: row.thirdParty?.name ?? "", vehicle: row.thirdParty?.plate ?? "",
      receivedBy: row.thirdParty?.receivedBy ?? row.withdrawnBy ?? "", front: row.front, createdBy: row.createdBy ?? "",
    });
    sheet.getColumn("date").numFmt = "dd/mm/yyyy";
    sheet.getColumn("quantity").numFmt = "#,##0.###";
    sheet.getColumn("unitPrice").numFmt = "#,##0.00";
    sheet.getColumn("total").numFmt = "#,##0.00";
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="movimentacao-${new Date().toISOString().slice(0, 10)}.xlsx"`, "Cache-Control": "private, no-store",
    } });
  } catch (error) {
    console.error("[stock-exits.export]", error);
    return Response.json({ error: "Não foi possível exportar a movimentação agora." }, { status: 500 });
  }
}
