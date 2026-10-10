import { scopedFrontIds } from "../../../../../lib/production";
import { fellingLaunchProjects, fellingProjectCards } from "../../../../../lib/production-felling";
import { noStore, productionRoute } from "../../../../../lib/production-api";

// Cards da derruba por projeto (ativos) e os projetos abertos para lançamento.
export async function GET(request: Request) {
  return productionRoute(request, "derruba.projetos", async ({ db, fronts, params }) => {
    const frontIds = scopedFrontIds(fronts, params.get("frentes"));
    const [cards, launch] = await Promise.all([fellingProjectCards(db, frontIds), fellingLaunchProjects(db, frontIds)]);
    return Response.json({ cards, launchProjects: launch.map((project) => ({ id: project.id, name: project.name, frontName: project.frontName, serviceFrontId: project.serviceFrontId })) }, noStore);
  });
}
