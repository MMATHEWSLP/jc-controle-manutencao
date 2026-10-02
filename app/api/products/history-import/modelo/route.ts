import ExcelJS from "exceljs";
import { authorize } from "../../../../../lib/auth";
import { canImportHistory } from "../../../../../lib/stock-history-import";
import { HISTORY_COLUMNS, HISTORY_HEADERS, HISTORY_HELP, HISTORY_IMPORT_SHEET } from "../../../../../lib/stock-history-import-rules";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Modelo vazio da importação de movimentações: aba "Importar" (cabeçalho exato) + "Instruções".
export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  if (!canImportHistory(auth.user!)) return Response.json({ error: "Somente administrador importa movimentações." }, { status: 403 });
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Sistema de Manutenção Preventiva — JC Serviços Florestais";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(HISTORY_IMPORT_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = HISTORY_COLUMNS.map((column) => ({
      header: HISTORY_HEADERS[column], key: column,
      width: column === "produto" ? 44 : ["colaborador", "departamento", "proprietario", "descricao_equipamento", "local_destino"].includes(column) ? 28 : 14,
      style: column === "data" ? { numFmt: "dd/mm/yyyy" } : column.startsWith("valor") ? { numFmt: "#,##0.00" } : {},
    }));
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } };
    sheet.addRow({ data: new Date(Date.UTC(2026, 0, 8)), tipo: "SAIDA", produto: "CAT ÓLEO SAE 15W40 20L", quantidade: 5, valor_unitario: 17.5, valor_total: 87.5, equipamento: "TE-02", chassi_serie: "LJR01320", proprietario: "DWE EMPREENDIMENTOS", colaborador: "ROBERTO BRAGA DA SILVA", departamento: "Manutenção e Gestão da Frota" });
    sheet.addRow({ data: new Date(Date.UTC(2026, 0, 9)), tipo: "AJUSTE", produto: "DISCO DE CORTE 7\" X 1/16\" X 7", quantidade: 5, valor_unitario: 5.9, valor_total: 29.5, departamento: "Correção de Estoque" });

    const help = workbook.addWorksheet("Instruções");
    help.columns = [{ header: "coluna", key: "column", width: 22 }, { header: "obrigatória", key: "required", width: 12 }, { header: "formato", key: "format", width: 90 }, { header: "exemplo", key: "example", width: 30 }];
    help.getRow(1).font = { bold: true };
    for (const column of HISTORY_COLUMNS) help.addRow({ column: HISTORY_HEADERS[column], ...HISTORY_HELP[column] });
    help.addRow({});
    for (const line of [
      "Uma linha por movimentação na aba Importar (as duas linhas de exemplo devem ser apagadas). Não mude os nomes das colunas.",
      "Nada é gravado ao enviar o arquivo: a prévia mostra totais, produtos/equipamentos não encontrados, duplicados e erros. Só grava em \"Confirmar importação\".",
      "Por padrão tudo entra como HISTÓRICO e o saldo atual NÃO muda. Saídas posteriores à data de corte só baixam estoque se o administrador marcar na prévia.",
      "Duplicado = mesma data + produto + quantidade + colaborador/equipamento já lançado no sistema, ou a mesma linha já importada em um lote anterior.",
      "Cada importação vira um lote que o administrador pode desfazer em \"Importações anteriores\".",
    ]) help.addRow({ column: line });
    return new Response(new Uint8Array(await workbook.xlsx.writeBuffer()), { headers: { "Content-Type": XLSX, "Content-Disposition": "attachment; filename=\"modelo-importacao-movimentacoes.xlsx\"", "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[products.history-import.model]", error);
    return Response.json({ error: "Não foi possível gerar o modelo." }, { status: 500 });
  }
}
