import { listTeamMembers, ProductionError, setTeamActive, updateTeam } from "../../../../../lib/production";
import { noStore, productionRoute, readBody, routeId } from "../../../../../lib/production-api";

type Context = { params: Promise<{ id: string }> };

// Integrantes da equipe (ativos primeiro, depois quem já saiu).
export async function GET(request: Request, context: Context) {
  return productionRoute(request, "equipes.membros", async ({ db, fronts }) =>
    Response.json({ members: await listTeamMembers(db, fronts, await routeId(context)) }, noStore));
}

export async function PATCH(request: Request, context: Context) {
  return productionRoute(request, "equipes.patch", async ({ db, user, fronts }) => {
    const id = await routeId(context);
    const body = await readBody(request);
    switch (body.acao) {
      case "editar": await updateTeam(db, user, fronts, id, body); return Response.json({ message: "Equipe alterada." });
      case "inativar": await setTeamActive(db, user, fronts, id, false); return Response.json({ message: "Equipe inativada." });
      case "reativar": await setTeamActive(db, user, fronts, id, true); return Response.json({ message: "Equipe reativada." });
      default: throw new ProductionError("Ação inválida.");
    }
  }, { write: true });
}
