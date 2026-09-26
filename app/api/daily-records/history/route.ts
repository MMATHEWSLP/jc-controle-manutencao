import { authorize } from "../../../../lib/auth";
import { loadHistoryOperators, loadHistoryPage, parseHistoryFilters } from "../../../../lib/daily-history";
import { canRegister, canViewAll } from "../../../../lib/daily-records";

// Histórico de Registros Diários. Filtros na query (?q=&de=&ate=&frente=&colab=&colab=&pagina=).
// Quem tem "ver todos" enxerga as frentes que tem acesso; os demais, só os próprios registros.
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const page = Math.max(1, Math.min(10_000, Number(params.get("pagina")) || 1));
    const [result, operators] = await Promise.all([
      loadHistoryPage(user, parseHistoryFilters(params), page),
      params.get("colaboradores") === "1" ? loadHistoryOperators(user) : Promise.resolve(null),
    ]);
    return Response.json({ ...result, operators, scope: canViewAll(user) ? "ALL" : "MINE" });
  } catch (error) {
    console.error("[daily-records.history]", error);
    return Response.json({ error: "Não foi possível carregar o histórico agora." }, { status: 500 });
  }
}
