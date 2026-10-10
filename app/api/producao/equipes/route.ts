import { createTeam, listTeams, scopedFrontIds } from "../../../../lib/production";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";

// Equipes das frentes em exibição. ?situacao=inativas|todas (padrão: ativas).
export async function GET(request: Request) {
  return productionRoute(request, "equipes.get", async ({ db, fronts, params }) => {
    const situation = params.get("situacao");
    return Response.json({ teams: await listTeams(db, scopedFrontIds(fronts, params.get("frentes")), { active: situation === "todas" ? null : situation !== "inativas" }) }, noStore);
  });
}

export async function POST(request: Request) {
  return productionRoute(request, "equipes.post", async ({ db, user, fronts }) => {
    const id = await createTeam(db, user, fronts, await readBody(request));
    return Response.json({ id, message: "Equipe cadastrada." }, { status: 201 });
  }, { write: true });
}
