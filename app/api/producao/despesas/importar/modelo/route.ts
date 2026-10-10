import ExcelJS from "exceljs";
import { ProductionError } from "../../../../../../lib/production";
import { productionRoute } from "../../../../../../lib/production-api";

// Planilha-modelo da importação de despesas da derruba.
export async function GET(request: Request) {
  return productionRoute(request, "importar.modelo", async ({ user }) => {
    if (user.profile !== "ADMIN") throw new ProductionError("Só o administrador importa despesas por planilha.", 403);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "JC Manutenção";
    const sheet = workbook.addWorksheet("Despesas da derruba");
    sheet.addRow(["Data", "Projeto", "Funcionário", "Tipo", "Produto/TAG", "Quantidade", "Valor", "Observação"]).font = { bold: true };
    sheet.addRow(["05/09/2026", "FAZENDA BOA VISTA UPA 3", "JOAO DA SILVA", "Material", "109", 2, "", "Lima para a semana"]);
    sheet.addRow(["05/09/2026", "FAZENDA BOA VISTA UPA 3", "JOAO DA SILVA", "Manutenção", "", 1, "85,00", "Troca do cordão de partida — MS 01"]);
    sheet.addRow(["06/09/2026", "FAZENDA BOA VISTA UPA 3", "", "Custo operacional", "", 1, "150,00", "Frete das peças"]);
    sheet.columns.forEach((column, index) => { column.width = [12, 30, 30, 18, 14, 12, 12, 40][index] ?? 14; });
    const help = workbook.addWorksheet("Como preencher");
    for (const line of [
      "Tipo: Material, Manutenção, Perda total ou Custo operacional.",
      "Material e peça do estoque: informe a TAG do produto (marcado para uso na Produção). O valor vem do preço da frente e a linha dá baixa no estoque.",
      "Manutenção ou perda total sem peça e custo operacional: deixe o Produto vazio e informe o Valor (R$). Vai para Outros gastos.",
      "Projeto: o nome como está na Produção. Funcionário: o nome do cadastro (obrigatório, menos no custo operacional).",
      "Linhas iguais a registros que já existem são ignoradas.",
    ]) help.addRow([line]);
    help.getColumn(1).width = 120;
    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="modelo-despesas-derruba.xlsx"`, "Cache-Control": "private, no-store" } });
  });
}
