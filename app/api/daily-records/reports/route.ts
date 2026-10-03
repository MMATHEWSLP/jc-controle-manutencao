import ExcelJS from "exceljs";
import { authorize } from "../../../../lib/auth";
import { canViewAll } from "../../../../lib/daily-records";
import { AGRUPAMENTOS, dieselConferencia, parseReportFilters, producao, type Agrupamento, type ReportFilters } from "../../../../lib/daily-reports";
import { fuelLocalDay } from "../../../../lib/fuel";
import { createEmployeeHistoryPdf, formatPdfDate } from "../../../../lib/pdf";

// ?tipo=producao&por=frente|local|operador|equipamento | ?tipo=diesel ; ?formato=xlsx|pdf exporta.
const n = (valor: number, casas = 2) => valor.toLocaleString("pt-BR", { maximumFractionDigits: casas });
const dia = (valor: string) => valor.split("-").reverse().join("/");
const filtrosTexto = (f: ReportFilters) => [`${dia(f.from)} a ${dia(f.to)}`, f.operator && `operador "${f.operator}"`, f.location && `local "${f.location}"`, f.origin === "IMPORTADO" ? "só importados" : f.origin === "APP" ? "só do app" : ""].filter(Boolean).join(" · ");

export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const filtros = parseReportFilters(params, fuelLocalDay());
    const formato = params.get("formato");
    if (params.get("tipo") === "diesel") {
      const linhas = await dieselConferencia(user, filtros);
      const totais = linhas.reduce((t, x) => ({ diario: t.diario + x.diario, combustivel: t.combustivel + x.combustivel }), { diario: 0, combustivel: 0 });
      if (!formato) return Response.json({ linhas, totais, filtros });
      const cabecalho = ["Data", "Equipamento", "Diário (L)", "Combustível (L)", "Diferença (L)", "Registros", "Saídas", "Operadores", "Observação"];
      const valores = linhas.map((x) => [dia(x.dia), x.prefixo, x.diario, x.combustivel, x.diferenca, x.registros, x.saidas, x.operadores ?? "", x.nota ? "Diário acima de 600 L não lançado" : ""]);
      return exportar(formato, "Diário x Combustível", filtrosTexto(filtros), cabecalho, valores, `diario-x-combustivel-${filtros.from}-${filtros.to}`,
        [{ x: 34, label: "DATA", max: 12 }, { x: 96, label: "EQUIPAMENTO", max: 14 }, { x: 180, label: "DIÁRIO (L)", max: 12 }, { x: 260, label: "COMBUSTÍVEL (L)", max: 14 }, { x: 350, label: "DIFERENÇA (L)", max: 14 }, { x: 440, label: "REGISTROS", max: 8 }, { x: 500, label: "SAÍDAS", max: 8 }, { x: 550, label: "OPERADORES", max: 60 }],
        `Diário ${n(totais.diario, 0)} L · Combustível ${n(totais.combustivel, 0)} L · diferença ${n(totais.diario - totais.combustivel, 0)} L. O diesel do diário não é saída de combustível.`);
    }
    const por = (params.get("por") ?? "frente") as Agrupamento;
    const grupo: Agrupamento = por in AGRUPAMENTOS ? por : "frente";
    const linhas = await producao(user, filtros, grupo);
    if (!formato) return Response.json({ linhas, filtros, por: grupo });
    const cabecalho = [AGRUPAMENTOS[grupo], "Registros", "Importados", "Conferir", "KM rodados", "Horas trabalhadas", "Viagens porto", "Volume porto (m³)", "Toras porto", "Viagens baldeio", "Total de viagens", "Diesel informado (L)"];
    const valores = linhas.map((x) => [x.chave, x.registros, x.importados, x.conferir, x.km, x.horas, x.viagensPorto, x.volumePorto, x.torasPorto, x.viagensBaldeio, x.viagens, x.dieselInformado]);
    return exportar(formato, `Produção por ${AGRUPAMENTOS[grupo].toLowerCase()}`, filtrosTexto(filtros), cabecalho, valores, `producao-${grupo}-${filtros.from}-${filtros.to}`,
      [{ x: 34, label: AGRUPAMENTOS[grupo].toUpperCase(), max: 30 }, { x: 210, label: "REGISTROS", max: 8 }, { x: 262, label: "KM", max: 12 }, { x: 330, label: "HORAS", max: 12 }, { x: 392, label: "V. PORTO", max: 8 }, { x: 446, label: "VOLUME M³", max: 12 }, { x: 512, label: "TORAS", max: 8 }, { x: 560, label: "V. BALDEIO", max: 8 }, { x: 620, label: "VIAGENS", max: 8 }, { x: 676, label: "DIESEL INF. (L)", max: 12 }],
      "KM/horas só dos registros sem \"Conferir\". Diesel informado pelo operador (não é saída de combustível).",
      (linha) => [String(linha[0]), n(Number(linha[1]), 0), n(Number(linha[4])), n(Number(linha[5])), n(Number(linha[6]), 0), n(Number(linha[7])), n(Number(linha[8]), 0), n(Number(linha[9]), 0), n(Number(linha[10]), 0), n(Number(linha[11]))]);
  } catch (error) {
    console.error("[daily-records.reports]", error);
    return Response.json({ error: "Não foi possível montar o relatório agora." }, { status: 500 });
  }
}

async function exportar(formato: string, titulo: string, filtros: string, cabecalho: string[], valores: Array<Array<string | number>>, arquivo: string,
  colunas: Array<{ x: number; label: string; max: number }>, rodape: string, paraPdf?: (linha: Array<string | number>) => string[]) {
  if (formato === "pdf") {
    const linhas = valores.map((linha) => paraPdf ? paraPdf(linha) : linha.map((valor) => (typeof valor === "number" ? n(valor) : valor)));
    const pdf = createEmployeeHistoryPdf({ title: titulo, filters: filtros, generatedAt: formatPdfDate(new Date().toISOString()), total: valores.length, columns: colunas, rows: linhas, section: "CONTROLE DIÁRIO", footer: rodape });
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${arquivo}.pdf"`, "Cache-Control": "private, no-store" } });
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(titulo.slice(0, 31));
  sheet.addRow([titulo]); sheet.addRow([filtros]); sheet.addRow([]);
  sheet.addRow(cabecalho).font = { bold: true };
  for (const linha of valores) sheet.addRow(linha);
  sheet.columns.forEach((coluna, index) => { coluna.width = index === 0 ? 28 : 16; });
  sheet.addRow([]); sheet.addRow([rodape]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${arquivo}.xlsx"`, "Cache-Control": "private, no-store" } });
}
