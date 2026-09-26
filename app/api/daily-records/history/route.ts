import { authorize } from "../../../../lib/auth";
import { listDailyHistory } from "../../../../lib/daily-history";
import { parseHistoryFilters, parseHistoryPage } from "../../../../lib/daily-history-rules";
import { canRegister, canViewAll } from "../../../../lib/daily-records";

// Histórico de Registros Diários: lista paginada com os filtros da tela (mesma query string da URL).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    return Response.json(await listDailyHistory(user, parseHistoryFilters(params), parseHistoryPage(params)));
  } catch (error) {
    console.error("[daily-records.history.get]", error);
    return Response.json({ error: "Não foi possível carregar o histórico agora." }, { status: 500 });
  }
}
