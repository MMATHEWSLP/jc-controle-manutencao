import { scopedFrontIds } from "../../../../../lib/production";
import { fellingMultiFront, parsePeriod } from "../../../../../lib/production-felling";
import { noStore, pdfResponse, productionRoute } from "../../../../../lib/production-api";
import { fellingMultiFrontPdf } from "../../../../../lib/production-reports";

// Produção multi-frente (só produção, sem R$): ?de&ate; &formato=pdf baixa o PDF.
export async function GET(request: Request) {
  return productionRoute(request, "derruba.multifrente", async ({ db, user, fronts, params }) => {
    const frontIds = scopedFrontIds(fronts, params.get("frentes"));
    const period = { ...parsePeriod(params), projectId: null };
    const data = await fellingMultiFront(db, frontIds, period);
    if (params.get("formato") !== "pdf") return Response.json(data, noStore);
    const frontNames = frontIds.length === fronts.length ? "Todas" : fronts.filter((front) => frontIds.includes(front.id)).map((front) => front.name).join(", ");
    return pdfResponse(fellingMultiFrontPdf(data, { period, fronts: frontNames, user: user.name }), `derruba-multifrente-${period.from}-${period.to}`);
  });
}
