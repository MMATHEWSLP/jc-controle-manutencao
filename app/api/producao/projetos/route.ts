import { createProject, lastStageEvents, listProjects, scopedFrontIds } from "../../../../lib/production";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";
import { PRODUCTION_STAGES } from "../../../../lib/production-rules";

// Projetos (fazenda/UPA) das frentes em exibição. ?situacao=inativos|todos (padrão: ativos).
export async function GET(request: Request) {
  return productionRoute(request, "projetos.get", async ({ db, fronts, params }) => {
    const situation = params.get("situacao");
    const projects = await listProjects(db, scopedFrontIds(fronts, params.get("frentes")), { active: situation === "todos" ? null : situation !== "inativos" });
    const events = await lastStageEvents(db, projects.map((project) => project.id));
    return Response.json({
      projects: projects.map((project) => ({ ...project, stageEvents: Object.fromEntries(PRODUCTION_STAGES.map((stage) => [stage.key, events.get(`${project.id}:${stage.key}`) ?? null])) })),
    }, noStore);
  });
}

export async function POST(request: Request) {
  return productionRoute(request, "projetos.post", async ({ db, user, fronts }) => {
    const id = await createProject(db, user, fronts, await readBody(request));
    return Response.json({ id, message: "Projeto cadastrado." }, { status: 201 });
  }, { write: true });
}
