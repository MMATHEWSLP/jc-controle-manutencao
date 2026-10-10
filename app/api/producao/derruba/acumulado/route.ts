import { scopedFrontIds } from "../../../../../lib/production";
import { accumulatedByOperator, fellingRecords, parsePeriod } from "../../../../../lib/production-felling";
import { noStore, productionRoute } from "../../../../../lib/production-api";

// Acumulado por operador: árvores, dias, média por dia e ipês (?de&ate&projeto).
export async function GET(request: Request) {
  return productionRoute(request, "derruba.acumulado", async ({ db, fronts, params }) =>
    Response.json({ operators: accumulatedByOperator(await fellingRecords(db, scopedFrontIds(fronts, params.get("frentes")), parsePeriod(params))) }, noStore));
}
