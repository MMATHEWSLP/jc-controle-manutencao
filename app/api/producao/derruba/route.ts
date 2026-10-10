import { scopedFrontIds } from "../../../../lib/production";
import { fellingHistory, parsePeriod } from "../../../../lib/production-felling";
import { noStore, productionRoute } from "../../../../lib/production-api";

// Histórico da derruba: ?de&ate&projeto&operador (padrão: do dia 1º do mês até hoje).
export async function GET(request: Request) {
  return productionRoute(request, "derruba.historico", async ({ db, user, fronts, params }) => {
    const rows = await fellingHistory(db, user, scopedFrontIds(fronts, params.get("frentes")), { ...parsePeriod(params), operatorId: Number(params.get("operador")) || null });
    return Response.json({ rows }, noStore);
  });
}
