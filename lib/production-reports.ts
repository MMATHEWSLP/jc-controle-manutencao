import { createProductionReportPdf, formatPdfDate } from "./pdf";
import type { fellingAnalysis, fellingMultiFront, Period } from "./production-felling";

// ---------------------------------------------------------------------------
// PDFs da PRODUÇÃO: mesmos números da tela (as funções de lib/production-felling.ts), com os filtros
// impressos no topo e o cabeçalho/logo dos outros relatórios (lib/pdf.ts).
// ---------------------------------------------------------------------------
const br = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits }));
const fixed = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const money = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `R$ ${fixed(value, 2)}`);
const day = (value: string) => value.slice(0, 10).split("-").reverse().join("/");
const STATUS: Record<string, string> = { NAO_INICIADO: "-", EM_ANDAMENTO: "Em andamento", FINALIZADO: "Finalizado" };

function filters(period: Period, fronts: string, project: string | null) {
  return [`Período ${day(period.from)} a ${day(period.to)}`, `Frentes: ${fronts}`, ...(project ? [`Projeto: ${project}`] : [])];
}

export function fellingAnalysisPdf(data: Awaited<ReturnType<typeof fellingAnalysis>>, context: { period: Period; fronts: string; project: string | null; user: string }) {
  return createProductionReportPdf({
    title: "DERRUBA — ANÁLISES", subtitle: "Desempenho por operador e por projeto, custo operacional e o diário contra a meta",
    filters: filters(context.period, context.fronts, context.project), generatedAt: formatPdfDate(new Date().toISOString()), generatedBy: context.user,
    cards: [
      { label: "Operadores", value: br(data.kpis.operators, 0) }, { label: "Árvores", value: br(data.kpis.trees, 0) },
      { label: "Média geral/dia", value: fixed(data.kpis.perDay), detail: "árvores ÷ dias-operador" }, { label: "Ipês", value: br(data.kpis.ipes, 0) },
      { label: "Custo operacional", value: money(data.kpis.cost), detail: data.kpis.litersWithoutValue ? `${br(data.kpis.litersWithoutValue)} L de gasolina sem valor no estoque` : "gasolina + produtos + outros gastos" },
    ],
    sections: [
      { title: "Desempenho por operador", columns: [{ label: "Operador", width: 3 }, { label: "Dias", width: 0.7, align: "right" }, { label: "Árvores", width: 1, align: "right" }, { label: "Ipês", width: 0.8, align: "right" },
        { label: "Média/dia", width: 1, align: "right" }, { label: "Combustível (L)", width: 1.2, align: "right" }, { label: "Manutenções", width: 1.2, align: "right" }, { label: "Perdas", width: 0.8, align: "right" },
        { label: "Gasto", width: 1.2, align: "right" }, { label: "Custo/árvore", width: 1.1, align: "right" }],
        rows: data.byOperator.map((row) => [row.operatorName, br(row.days, 0), br(row.trees, 0), br(row.ipes, 0), fixed(row.perDay), br(row.gasolineLiters), money(row.maintenance), br(row.losses, 0), money(row.spent), money(row.costPerTree)]) },
      { title: "Resultado por projeto", columns: [{ label: "Projeto", width: 3 }, { label: "Situação", width: 1.3 }, { label: "Dias", width: 0.7, align: "right" }, { label: "Operadores", width: 1, align: "right" },
        { label: "Árvores", width: 1, align: "right" }, { label: "Média/dia", width: 1, align: "right" }, { label: "Ipês", width: 0.8, align: "right" }, { label: "Gasto", width: 1.2, align: "right" }, { label: "Custo/árvore", width: 1.1, align: "right" }],
        rows: data.byProject.map((row) => [row.projectName, STATUS[row.status] ?? row.status, br(row.days, 0), br(row.operators, 0), br(row.trees, 0), fixed(row.perDay), br(row.ipes, 0), money(row.spent), money(row.costPerTree)]) },
      { title: "Desempenho diário vs. meta", columns: [{ label: "Data", width: 0.9 }, { label: "Projeto", width: 2.2 }, { label: "Operador", width: 2.6 }, { label: "Árvores", width: 0.9, align: "right" },
        { label: "Ipês", width: 0.7, align: "right" }, { label: "Meta", width: 0.7, align: "right" }, { label: "Resultado", width: 1.3 }, { label: "Justificativa", width: 2.6 }],
        rows: data.daily.map((row) => [day(row.date), row.projectName, row.operatorName, br(row.trees, 0), br(row.ipes, 0), row.target === null ? "—" : br(row.target, 0), row.resultLabel, row.justification ?? "—"]) },
    ],
  });
}

export function fellingMultiFrontPdf(data: Awaited<ReturnType<typeof fellingMultiFront>>, context: { period: Period; fronts: string; user: string }) {
  return createProductionReportPdf({
    title: "DERRUBA — PRODUÇÃO MULTI-FRENTE", subtitle: "Só produção, sem despesas. Operador que produziu em mais de uma frente vem consolidado.",
    filters: filters(context.period, context.fronts, null), generatedAt: formatPdfDate(new Date().toISOString()), generatedBy: context.user,
    cards: [
      { label: "Operadores", value: br(data.totals.operators, 0) }, { label: "Árvores", value: br(data.totals.trees, 0) },
      { label: "Árv. nos dias na meta", value: br(data.totals.treesOnTargetDays, 0) }, { label: "Árv. acima da meta", value: br(data.totals.treesAboveTarget, 0), detail: "Σ (árvores − meta) nos dias acima" },
      { label: "Média geral/dia", value: fixed(data.totals.perDay) },
    ],
    sections: [{ title: "Por operador", columns: [{ label: "Operador", width: 2.6 }, { label: "Ajudante(s) — dias na meta", width: 3 }, { label: "Frentes", width: 1.6 }, { label: "Dias", width: 0.6, align: "right" },
      { label: "Árvores", width: 0.9, align: "right" }, { label: "Na meta", width: 0.8, align: "right" }, { label: "Abaixo", width: 0.8, align: "right" }, { label: "Árv. na meta", width: 1, align: "right" },
      { label: "Árv. acima", width: 1, align: "right" }, { label: "Média/dia", width: 0.9, align: "right" }],
      rows: data.rows.map((row) => [row.operatorName, row.helpers.map((helper) => `${helper.name} (${helper.days} ${helper.days === 1 ? "dia" : "dias"})`).join(", ") || "—", row.fronts.join(", "),
        br(row.days, 0), br(row.trees, 0), br(row.daysOnTarget, 0), br(row.daysBelow, 0), br(row.treesOnTargetDays, 0), br(row.treesAboveTarget, 0), fixed(row.perDay)]) }],
    footer: "Meta = árvores por operador por dia da frente de cada dia. Frente sem meta não conta dias na meta nem abaixo.",
  });
}
