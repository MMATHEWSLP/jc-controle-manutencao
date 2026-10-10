import { ProductionError } from "../../../../../lib/production";
import { analyzeImport, confirmImport, IMPORT_COLUMNS, listImportBatches, type ImportRow } from "../../../../../lib/production-expenses";
import { noStore, productionRoute, readBody } from "../../../../../lib/production-api";

// Importação de despesas da derruba por Excel (só ADMIN): lotes anteriores.
export async function GET(request: Request) {
  return productionRoute(request, "importar.get", async ({ db, user }) => {
    if (user.profile !== "ADMIN") throw new ProductionError("Só o administrador importa despesas por planilha.", 403);
    return Response.json({ batches: await listImportBatches(db) }, noStore);
  });
}

// { acao: "previa" | "confirmar", fileName, rows: [{ rowNumber, values }], allowNegative }
export async function POST(request: Request) {
  return productionRoute(request, "importar.post", async ({ db, user, fronts }) => {
    const body = await readBody(request);
    const rows: ImportRow[] = (Array.isArray(body.rows) ? body.rows as Array<Record<string, unknown>> : []).slice(0, 1001).map((row, index) => ({
      rowNumber: Number(row.rowNumber) || index + 2,
      values: Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, String((row.values as Record<string, unknown> | undefined)?.[column] ?? "").slice(0, 300)])),
    }));
    if (body.acao === "confirmar") {
      const result = await confirmImport(db, user, fronts, String(body.fileName ?? ""), rows, body.allowNegative === true);
      return Response.json({ ...result, message: `Importação concluída: ${result.imported} linha(s) gravada(s)${result.failed.length ? `, ${result.failed.length} com erro` : ""}${result.ignored ? `, ${result.ignored} ignorada(s)` : ""}.` });
    }
    return Response.json({ rows: await analyzeImport(db, user, fronts, rows) }, noStore);
  }, { write: true });
}
