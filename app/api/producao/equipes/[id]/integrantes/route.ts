import { addTeamMember, removeTeamMember, updateTeamMember } from "../../../../../../lib/production";
import { productionRoute, readBody, routeId } from "../../../../../../lib/production-api";

type Context = { params: Promise<{ id: string }> };

// Incluir integrante (funcionário + data de entrada).
export async function POST(request: Request, context: Context) {
  return productionRoute(request, "equipes.integrante.post", async ({ db, user, fronts }) => {
    await addTeamMember(db, user, fronts, await routeId(context), await readBody(request));
    return Response.json({ message: "Integrante incluído." }, { status: 201 });
  }, { write: true });
}

// Datas de entrada/saída de um integrante ({ memberId, joinedAt, leftAt }).
export async function PATCH(request: Request, context: Context) {
  return productionRoute(request, "equipes.integrante.patch", async ({ db, user, fronts }) => {
    const body = await readBody(request);
    await updateTeamMember(db, user, fronts, await routeId(context), Number(body.memberId), body);
    return Response.json({ message: "Integrante alterado." });
  }, { write: true });
}

// Excluir integrante incluído por engano (?integrante=ID).
export async function DELETE(request: Request, context: Context) {
  return productionRoute(request, "equipes.integrante.delete", async ({ db, user, fronts, params }) => {
    await removeTeamMember(db, user, fronts, await routeId(context), Number(params.get("integrante")));
    return Response.json({ message: "Integrante excluído." });
  }, { write: true });
}
