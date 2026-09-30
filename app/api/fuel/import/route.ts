import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { analyzeFuelImport, canImportFuel, confirmFuelImport, FuelImportError, importSummary, listFuelImportBatches } from "../../../../lib/fuel-import";
import { readRawRows } from "../../../../lib/fuel-import-rules";

const MAX_ROWS = 1000;

// Lotes importados (para consultar e, se ADMIN, desfazer).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  if (!canImportFuel(auth.user!)) return Response.json({ error: "Somente administrador ou gestor importa abastecimentos." }, { status: 403 });
  try { return Response.json({ batches: await listFuelImportBatches(await getDb()), canRevert: auth.user!.profile === "ADMIN" }); }
  catch (error) { console.error("[fuel.import.list]", error); return Response.json({ error: "Não foi possível carregar as importações." }, { status: 500 }); }
}

// ANALYZE = prévia sem gravar; CONFIRM = grava as linhas selecionadas (analisadas de novo aqui).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.register");
  if (auth.response) return auth.response;
  if (!canImportFuel(auth.user!)) return Response.json({ error: "Somente administrador ou gestor importa abastecimentos." }, { status: 403 });
  try {
    const body = await request.json() as { action?: unknown; fileName?: unknown; rows?: unknown; selected?: unknown };
    if (Array.isArray(body.rows) && body.rows.length > MAX_ROWS) return Response.json({ error: `Importe no máximo ${MAX_ROWS.toLocaleString("pt-BR")} linhas por arquivo.` }, { status: 400 });
    const rows = readRawRows(body.rows, MAX_ROWS);
    if (!rows.length) return Response.json({ error: "A planilha não tem linhas para analisar." }, { status: 400 });
    const fileName = String(body.fileName ?? "abastecimentos.xlsx").trim().slice(0, 180) || "abastecimentos.xlsx";
    const db = await getDb();
    if (body.action === "CONFIRM") {
      const selected = new Set((Array.isArray(body.selected) ? body.selected : []).map(Number).filter((value) => Number.isInteger(value)));
      return Response.json(await confirmFuelImport(db, auth.user!, fileName, rows, selected));
    }
    const preview = await analyzeFuelImport(db, auth.user!, rows);
    return Response.json({ fileName, rows: preview, summary: importSummary(preview) });
  } catch (error) {
    if (error instanceof FuelImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[fuel.import]", error);
    return Response.json({ error: "Não foi possível processar a importação agora." }, { status: 500 });
  }
}
