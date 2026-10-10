import { ProductionError, scopedFrontIds } from "../../../../../lib/production";
import { fellingAnalysis, parsePeriod } from "../../../../../lib/production-felling";
import { noStore, pdfResponse, productionRoute } from "../../../../../lib/production-api";
import { fellingAnalysisPdf } from "../../../../../lib/production-reports";

// Análises da derruba (com R$): ?de&ate&projeto; &formato=pdf baixa o PDF.
export async function GET(request: Request) {
  return productionRoute(request, "derruba.analises", async ({ db, user, access, fronts, params }) => {
    if (!access.costs) throw new ProductionError("As análises trazem custos: peça a permissão de ver os custos da Produção.", 403);
    const frontIds = scopedFrontIds(fronts, params.get("frentes"));
    const period = parsePeriod(params);
    const data = await fellingAnalysis(db, frontIds, period);
    if (params.get("formato") !== "pdf") return Response.json(data, noStore);
    const frontNames = frontIds.length === fronts.length ? "Todas" : fronts.filter((front) => frontIds.includes(front.id)).map((front) => front.name).join(", ");
    const project = period.projectId ? data.byProject.find((row) => row.projectId === period.projectId)?.projectName ?? null : null;
    return pdfResponse(fellingAnalysisPdf(data, { period, fronts: frontNames, project, user: user.name }), `derruba-analises-${period.from}-${period.to}`);
  });
}
