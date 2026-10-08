import ExcelJS from "exceljs";
import { getDb } from "../../../db";
import { frentesEmExibicao } from "../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { canLaunchOtherExpenses, canViewOtherExpenses, createOtherExpense, listOtherExpenses, otherExpenseErrorResponse, parseOtherExpenseFilters } from "../../../lib/other-expenses";
import { formatPdfDate } from "../../../lib/pdf";

// RELATÓRIOS → Custos → Outros gastos: lista (?formato=xlsx exporta) e lançamento.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canViewOtherExpenses(user)) return Response.json({ error: "Você não tem acesso aos relatórios de custos." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const filters = parseOtherExpenseFilters(params);
    const expenses = await listOtherExpenses(await getDb(), frentesEmExibicao(user, request), filters);
    const total = Math.round(expenses.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
    if (params.get("formato") !== "xlsx") return Response.json({ expenses, total, canLaunch: canLaunchOtherExpenses(user) }, { headers: { "Cache-Control": "no-store" } });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Outros gastos");
    const br = (day: string | null) => (day ? day.split("-").reverse().join("/") : "—");
    sheet.addRow(["Outros gastos (serviços/mão de obra e outros)"]).font = { bold: true, size: 13 };
    sheet.addRow([`Período ${br(filters.from)} a ${br(filters.to)}${filters.category ? ` · ${expenses[0]?.categoryLabel ?? filters.category}` : ""}`]);
    sheet.addRow([`Gerado por ${user.name} em ${formatPdfDate(new Date().toISOString())}`]);
    sheet.addRow([]);
    sheet.addRow(["Data", "Frente", "Equipamento", "Categoria", "Descrição", "Valor (R$)", "Lançado por"]).font = { bold: true };
    for (const row of expenses) sheet.addRow([br(row.expenseDate), row.frontName, row.equipmentPrefix ?? "—", row.categoryLabel, row.description, row.amount, row.createdByName ?? "—"]);
    sheet.addRow(["", "", "", "", "Total", total]).font = { bold: true };
    sheet.columns.forEach((column, index) => { column.width = [12, 20, 16, 22, 50, 16, 24][index] ?? 16; });
    sheet.getColumn(6).numFmt = "#,##0.00";
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="outros-gastos.xlsx"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[other-expenses.get]", error);
    return Response.json({ error: "Não foi possível carregar os outros gastos." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "costs.other_expenses");
  if (auth.response) return auth.response;
  try {
    const id = await createOtherExpense(await getDb(), auth.user!, await request.json() as Record<string, unknown>);
    return Response.json({ id, message: "Gasto lançado." }, { status: 201 });
  } catch (error) {
    const known = otherExpenseErrorResponse(error); if (known) return known;
    console.error("[other-expenses.post]", error);
    return Response.json({ error: "Não foi possível lançar o gasto agora." }, { status: 500 });
  }
}
