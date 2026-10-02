import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { localToday, isIsoDay } from "../../../../lib/stock-options";
import { analyzeHistoryImport, canImportHistory, confirmHistoryImport, historyFronts, HistoryImportError, listHistoryImportBatches } from "../../../../lib/stock-history-import";
import { DEFAULT_CUTOFF_DATE, HISTORY_MAX_ROWS, historyPreview, parseDecisions, readHistoryRawRows } from "../../../../lib/stock-history-import-rules";

const FORBIDDEN = "Somente administrador importa movimentações.";

// Frentes (Arapiuns como padrão) e lotes já importados.
export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  if (!canImportHistory(auth.user!)) return Response.json({ error: FORBIDDEN }, { status: 403 });
  try {
    const db = await getDb();
    const [fronts, batches] = await Promise.all([historyFronts(db), listHistoryImportBatches(db)]);
    return Response.json({ ...fronts, cutoffDate: DEFAULT_CUTOFF_DATE, batches });
  } catch (error) {
    console.error("[products.history-import.list]", error);
    return Response.json({ error: "Não foi possível carregar as importações." }, { status: 500 });
  }
}

// ANALYZE = prévia sem gravar; CONFIRM = grava (analisa de novo aqui, com as decisões da tela).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  if (!canImportHistory(auth.user!)) return Response.json({ error: FORBIDDEN }, { status: 403 });
  try {
    const body = await request.json() as { action?: unknown; fileName?: unknown; rows?: unknown; frontId?: unknown; cutoffDate?: unknown; applyBalance?: unknown; decisions?: unknown };
    if (Array.isArray(body.rows) && body.rows.length > HISTORY_MAX_ROWS) return Response.json({ error: `Importe no máximo ${HISTORY_MAX_ROWS.toLocaleString("pt-BR")} linhas por arquivo.` }, { status: 400 });
    const rows = readHistoryRawRows(body.rows);
    if (!rows.length) return Response.json({ error: "A planilha não tem linhas para analisar." }, { status: 400 });
    const fileName = String(body.fileName ?? "movimentacoes.xlsx").trim().slice(0, 180) || "movimentacoes.xlsx";
    const frontId = Number(body.frontId);
    const options = {
      frontId: Number.isInteger(frontId) && frontId > 0 ? frontId : null,
      cutoffDate: isIsoDay(body.cutoffDate) ? body.cutoffDate : null,
      applyBalance: body.applyBalance === true, decisions: parseDecisions(body.decisions), today: localToday(),
    };
    const db = await getDb();
    if (body.action === "CONFIRM") return Response.json(await confirmHistoryImport(db, auth.user!, fileName, rows, options));
    const { options: resolved, analysis } = await analyzeHistoryImport(db, rows, options);
    return Response.json({ fileName, frontId: resolved.frontId, cutoffDate: resolved.cutoffDate, ...historyPreview(analysis) });
  } catch (error) {
    if (error instanceof HistoryImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[products.history-import]", error);
    return Response.json({ error: "Não foi possível processar a importação agora." }, { status: 500 });
  }
}
