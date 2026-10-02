import ExcelJS from "exceljs";
import { canUseAssistant } from "../../../../lib/assistant-config";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ROWS = 5000;
type Coluna = { nome?: unknown; rotulo?: unknown; tipo?: unknown };

const titulo = (nome: string) => nome.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());

// "Baixar Excel" das tabelas do Assistente JC: a planilha é montada aqui com as linhas que a própria
// consulta devolveu à tela (datas como data, números como número), mais o período/frentes/filtros.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!canUseAssistant(auth.user!)) return Response.json({ error: "O Assistente JC não está liberado para o seu perfil." }, { status: 403 });
  try {
    const body = await request.json() as { titulo?: unknown; colunas?: unknown; linhas?: unknown; periodo?: unknown; frentes?: unknown; filtros?: unknown };
    const colunas = (Array.isArray(body.colunas) ? body.colunas : []).slice(0, 60).map((coluna: Coluna) => ({ nome: String(coluna?.nome ?? "").slice(0, 60), tipo: String(coluna?.tipo ?? "texto") }));
    const linhas = (Array.isArray(body.linhas) ? body.linhas : []).slice(0, MAX_ROWS);
    if (!colunas.length) return Response.json({ error: "Tabela vazia." }, { status: 400 });
    const name = String(body.titulo ?? "Consulta do Assistente JC").slice(0, 120);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Assistente JC";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Consulta");
    sheet.addRow([name]).font = { bold: true, size: 13 };
    const meta = [body.periodo ? `Período: ${String(body.periodo)}` : "", body.frentes ? `Frentes: ${String(body.frentes)}` : "",
      Array.isArray(body.filtros) && body.filtros.length ? `Filtros: ${body.filtros.map(String).join("; ")}` : ""].filter(Boolean).join(" · ");
    if (meta) sheet.addRow([meta.slice(0, 1000)]);
    sheet.addRow([`Gerado pelo Assistente JC em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" })}`]).font = { italic: true, color: { argb: "FF6B7785" } };
    sheet.addRow([]);
    const header = sheet.addRow(colunas.map((coluna) => titulo(coluna.nome)));
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14324A" } }; });
    for (const linha of linhas) {
      const values = Array.isArray(linha) ? linha : [];
      sheet.addRow(colunas.map((coluna, index) => {
        const value = values[index];
        if (value === null || value === undefined) return null;
        if ((coluna.tipo === "data" || coluna.tipo === "semana" || coluna.tipo === "mes") && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00Z`);
        if (typeof value === "boolean") return value ? "Sim" : "Não";
        if (typeof value === "number") return value;
        return String(value).slice(0, 2000);
      }));
    }
    colunas.forEach((coluna, index) => {
      const column = sheet.getColumn(index + 1);
      column.width = Math.min(48, Math.max(12, titulo(coluna.nome).length + 2));
      if (coluna.tipo === "data" || coluna.tipo === "semana") column.numFmt = "dd/mm/yyyy";
      else if (coluna.tipo === "mes") column.numFmt = "mm/yyyy";
      else if (coluna.tipo === "numero") column.numFmt = "#,##0.##";
    });
    sheet.views = [{ state: "frozen", ySplit: meta ? 5 : 4 }];
    const file = `${name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "consulta"}.xlsx`;
    return new Response(new Uint8Array(await workbook.xlsx.writeBuffer()), { headers: { "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[assistente.excel]", error);
    return Response.json({ error: "Não foi possível gerar a planilha." }, { status: 500 });
  }
}
