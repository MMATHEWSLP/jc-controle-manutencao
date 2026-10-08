import ExcelJS from "exceljs";
import { createEmployeeHistoryPdf, formatPdfDate } from "./pdf";

// ---------------------------------------------------------------------------
// Exportação Excel/PDF dos relatórios simples do menu RELATÓRIOS (uma tabela): cabeçalho com o
// título, os filtros, quem gerou e quando; a linha de total no fim. As colunas dizem o valor de cada
// linha e a largura relativa no PDF (paisagem).
// ---------------------------------------------------------------------------
export type ExportCell = string | number | null;
export type ExportColumn<T> = { header: string; value: (row: T) => ExportCell; width?: number; money?: boolean; decimals?: number };
export type ExportInput<T> = { title: string; section: string; filters: string[]; generatedBy: string; file: string; columns: ExportColumn<T>[]; rows: readonly T[]; total?: ExportCell[]; footer?: string };

const pdfText = (value: ExportCell, column: { money?: boolean; decimals?: number }) => {
  if (value === null || value === "") return "—";
  if (typeof value !== "number") return value;
  return column.money ? value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value.toLocaleString("pt-BR", { maximumFractionDigits: column.decimals ?? 2 });
};

export async function exportTable<T>(format: string | null, input: ExportInput<T>) {
  const generatedAt = formatPdfDate(new Date().toISOString());
  if (format === "pdf") {
    const widths = input.columns.map((column) => column.width ?? 1);
    const sum = widths.reduce((a, b) => a + b, 0);
    let x = 34;
    const columns = input.columns.map((column, index) => {
      const width = (766 * widths[index]) / sum;
      const result = { x: Math.round(x), label: column.header.toUpperCase(), max: Math.max(4, Math.floor(width / 4.1)) };
      x += width;
      return result;
    });
    const rows = input.rows.map((row) => input.columns.map((column) => pdfText(column.value(row), column)));
    if (input.total) rows.push(input.total.map((value, index) => pdfText(value, input.columns[index] ?? {})));
    const pdf = createEmployeeHistoryPdf({
      title: input.title, section: input.section, generatedAt, total: input.rows.length, columns, rows,
      filters: [...input.filters, `Gerado por ${input.generatedBy}`].join(" · "), footer: input.footer ?? "Valores calculados com os mesmos filtros da tela. Nenhum registro foi alterado.",
    });
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${input.file}.pdf"`, "Cache-Control": "private, no-store" } });
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "JC Manutenção";
  const sheet = workbook.addWorksheet(input.title.slice(0, 31).replace(/[\\/*?:[\]]/g, " "));
  sheet.addRow([input.title]).font = { bold: true, size: 13 };
  for (const line of input.filters) sheet.addRow([line]);
  sheet.addRow([`Gerado por ${input.generatedBy} em ${generatedAt}`]);
  sheet.addRow([]);
  sheet.addRow(input.columns.map((column) => column.header)).font = { bold: true };
  for (const row of input.rows) sheet.addRow(input.columns.map((column) => column.value(row)));
  if (input.total) sheet.addRow(input.total).font = { bold: true };
  input.columns.forEach((column, index) => {
    const target = sheet.getColumn(index + 1);
    target.width = Math.max(12, Math.min(48, (column.width ?? 1) * 14));
    if (column.money) target.numFmt = "#,##0.00";
  });
  if (input.footer) { sheet.addRow([]); sheet.addRow([input.footer]); }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${input.file}.xlsx"`, "Cache-Control": "private, no-store" } });
}
