import { listReasons } from "../../../../../lib/production";
import { fellingLaunchProjects } from "../../../../../lib/production-felling";
import { noStore, productionRoute } from "../../../../../lib/production-api";

// Tela do apontador (celular): frentes dele, projetos com a derruba aberta e os motivos. Sem valores em R$.
export async function GET(request: Request) {
  return productionRoute(request, "campo.contexto", async ({ db, fronts }) => {
    const projects = await fellingLaunchProjects(db, fronts.map((front) => front.id));
    return Response.json({
      fronts, reasons: await listReasons(db, false),
      projects: projects.map((project) => ({ id: project.id, name: project.name, frontName: project.frontName, serviceFrontId: project.serviceFrontId })),
    }, noStore);
  }, { field: true });
}
