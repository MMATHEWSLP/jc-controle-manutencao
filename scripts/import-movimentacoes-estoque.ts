// Simulação (SEM GRAVAR) da importação do histórico de movimentações do almoxarifado antigo, com as
// MESMAS regras da tela Produtos → Importar movimentações (lib/stock-history-import-rules.ts).
// A importação real é feita só pela tela, depois de decidir os produtos não encontrados.
//
// Uso:
//   npx tsx scripts/import-movimentacoes-estoque.ts                      -> banco (conexão somente leitura)
//   npx tsx scripts/import-movimentacoes-estoque.ts --offline            -> sem banco: usa as bases do repositório
//        (produtos_import.csv, frota-fonte-2026-09.tsv, funcionários de Arapiuns/Mamuru) — aproximação
//   --arquivo=importacoes/Movimentacoes_Estoque_LIMPO_2026-10-02.xlsx   (padrão)
//   --corte=2026-09-07   --relatorio=caminho.json (relatório completo em JSON)
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import {
  analyzeHistory, DEFAULT_CUTOFF_DATE, HISTORY_IMPORT_SHEET, historyNameKey, historyRowsFromMatrix,
  type HistoryContext, type HistoryRawRow,
} from "../lib/stock-history-import-rules";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const offline = process.argv.includes("--offline");
const file = arg("arquivo") ?? "importacoes/Movimentacoes_Estoque_LIMPO_2026-10-02.xlsx";
const cutoffDate = arg("corte") ?? DEFAULT_CUTOFF_DATE;
const reportPath = arg("relatorio");
const brl = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

async function readRows(): Promise<HistoryRawRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet(HISTORY_IMPORT_SHEET) ?? workbook.worksheets[0];
  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, number) => {
    matrix[number - 1] = (row.values as unknown[]).slice(1).map((value) => {
      if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) return (value as { result: unknown }).result;
      if (value && typeof value === "object" && "richText" in (value as Record<string, unknown>)) return (value as { richText: Array<{ text: string }> }).richText.map((part) => part.text).join("");
      return value;
    });
  });
  return historyRowsFromMatrix(matrix);
}

function tsv(path: string) {
  const [header, ...lines] = readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
  return lines.map((cells) => Object.fromEntries(header.map((column, index) => [column.trim(), (cells[index] ?? "").trim()])));
}

function offlineContext(): HistoryContext {
  const csv = readFileSync("scripts/import-produtos/data/produtos_import.csv", "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(1).filter(Boolean).map((line) => line.split(";"));
  const products = csv.filter((cells) => cells[0] && !["teste1", "teste2", "Totais"].includes(cells[0]))
    .map((cells, index) => ({ id: index + 1, tag: cells[0], name: cells[1].toUpperCase(), price: Number(cells[3]) || 0, active: true }));
  const equipment = tsv("scripts/import-equipamentos/data/frota-fonte-2026-09.tsv").map((row, index) => ({ id: index + 1, code: row["Nº"], prefix: row["Nº"], plate: row["PLACA"] || null, chassis: row["CHASSI/SERIE"] || null, serialNumber: null }));
  const names = new Set<string>();
  for (const path of ["arapiuns-2026-09-27", "mamuru-2026-09-28", "folgas-2026-09-28", "afastamentos-2026-09-28", "situacao-arapiuns-2026-09-28"]) {
    for (const row of tsv(`scripts/import-funcionarios/data/${path}.tsv`)) if (row.nome) names.add(row.nome);
  }
  return {
    products, equipment, employees: [...names].map((name, index) => ({ id: index + 1, name })), departments: [], fronts: [{ id: 1, name: "Arapiuns" }],
    systemExits: [], importedHistory: [], balances: new Map(),
  };
}

async function main() {
  const rows = await readRows();
  let context: HistoryContext, frontId = 1, frontName = "Arapiuns (offline)";
  if (offline) context = offlineContext();
  else {
    process.env.DATABASE_READ_ONLY = "1";
    const { getDb } = await import("../db");
    const { historyFronts, loadHistoryContext } = await import("../lib/stock-history-import");
    const db = await getDb();
    const fronts = await historyFronts(db);
    if (!fronts.defaultFrontId) throw new Error("Nenhuma frente ativa encontrada.");
    frontId = fronts.defaultFrontId;
    frontName = fronts.fronts.find((front) => front.id === frontId)?.name ?? String(frontId);
    context = await loadHistoryContext(db, rows, frontId);
  }
  const analysis = analyzeHistory(rows, context, { frontId, cutoffDate, applyBalance: false, decisions: {}, today });
  const { summary } = analysis;
  const pendingValue = analysis.unmatchedProducts.reduce((total, item) => total + item.value, 0);

  console.log(`\n=== SIMULAÇÃO (nada foi gravado) — ${offline ? "OFFLINE: bases do repositório, não o banco" : "banco de dados (somente leitura)"} ===`);
  console.log(`Arquivo: ${file} · frente: ${frontName} · corte do saldo: ${cutoffDate}`);
  console.log(`Linhas lidas: ${summary.totalRows} (${summary.dateFrom} a ${summary.dateTo}) · válidas: ${summary.validRows} · com erro: ${summary.errors}`);
  console.log(`Saídas: ${summary.exits} (${brl(summary.exitsValue)}) · Ajustes/Correção de Estoque: ${summary.adjustments} (${brl(summary.adjustmentsValue)})`);
  console.log(`VALOR TOTAL: ${brl(summary.totalValue)}`);
  console.log(`Duplicados (já no sistema ou em lote anterior): ${summary.duplicates}`);
  console.log(`Importariam já (produto casado): ${summary.toImport} (${brl(summary.toImportValue)}) · aguardando decisão de produto: ${summary.pendingProductRows} linha(s) (${brl(pendingValue)})`);
  console.log(`Se todos os produtos pendentes forem vinculados ou cadastrados: ${summary.toImport + summary.pendingProductRows} linhas`);
  console.log(`Produtos: ${summary.productsMatched} casados · ${summary.productsUnmatched} NÃO encontrados`);
  console.log(`Equipamento casado em ${summary.equipmentMatchedRows} linhas · ${analysis.unmatchedEquipment.length} códigos não encontrados (${analysis.unmatchedEquipment.reduce((t, i) => t + i.rows, 0)} linhas)`);
  console.log(`Colaborador casado em ${summary.employeeMatchedRows} linhas · ${analysis.unmatchedEmployees.length} nomes ficam como texto`);
  console.log(`Departamento casado em ${summary.departmentMatchedRows} linhas · ${analysis.unmatchedDepartments.length} departamentos ficam como texto${offline ? " (offline: lista de departamentos do banco indisponível)" : ""}`);
  console.log(`Avisos (importam normalmente): ${summary.warnings}`);

  const after = analysis.afterCutoff;
  console.log(`\n--- Saídas posteriores a ${cutoffDate} que não estão no sistema novo: ${after.rows} linhas · ${after.quantity} un. · ${brl(after.value)} · ${after.products.length} produtos`);
  for (const item of after.products.slice(0, 15)) console.log(`  ${(item.tag ?? "(sem cadastro)").padEnd(8)} ${item.name.slice(0, 50).padEnd(50)} qtd ${String(item.quantity).padStart(7)}  ${brl(item.value).padStart(14)}  saldo ${item.balance} -> ${item.after}`);
  if (after.products.length > 15) console.log(`  ... mais ${after.products.length - 15} produto(s) (ver relatório JSON)`);

  console.log(`\n--- Produtos não encontrados (${analysis.unmatchedProducts.length}) — nome · linhas · valor · 3 sugestões`);
  for (const item of analysis.unmatchedProducts) {
    console.log(`  ${item.name} · ${item.rows}x · ${brl(item.value)}${item.ambiguous ? " · NOME REPETIDO NO CADASTRO" : ""}`);
    console.log(`      sugestões: ${item.suggestions.map((s) => `[${s.tag}] ${s.name} (${Math.round(s.score * 100)}%)`).join(" | ")}`);
  }
  console.log(`\n--- Equipamentos não encontrados (${analysis.unmatchedEquipment.length}): ${analysis.unmatchedEquipment.map((item) => `${item.text} (${item.rows})`).join(", ")}`);
  console.log(`\n--- Departamentos não encontrados (${analysis.unmatchedDepartments.length}): ${analysis.unmatchedDepartments.map((item) => `${item.text} (${item.rows})`).join(", ")}`);
  console.log(`\n--- Colaboradores guardados como texto (${analysis.unmatchedEmployees.length}, 30 primeiros): ${analysis.unmatchedEmployees.slice(0, 30).map((item) => `${item.text} (${item.rows})`).join(", ")}`);
  if (analysis.errors.length) console.log(`\n--- Erros por linha (${analysis.errors.length}): ${analysis.errors.slice(0, 30).map((row) => `L${row.rowNumber}: ${row.messages.join(" ")}`).join(" · ")}`);

  if (reportPath) {
    const { rows: _rows, ...rest } = analysis;
    void _rows;
    writeFileSync(reportPath, JSON.stringify({ file, offline, frontName, cutoffDate, ...rest, unmatchedProductKeys: analysis.unmatchedProducts.map((item) => historyNameKey(item.name)) }, null, 2));
    console.log(`\nRelatório completo: ${reportPath}`);
  }
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
