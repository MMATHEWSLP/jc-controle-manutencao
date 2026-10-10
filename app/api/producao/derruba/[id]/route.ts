import { deleteFellingLine, updateFellingLine } from "../../../../../lib/production-felling";
import { productionRoute, readBody, routeId } from "../../../../../lib/production-api";

type Context = { params: Promise<{ id: string }> };

// Editar uma linha do histórico (ajudante, árvores, ipês, gasolina, motivo, justificativa).
export async function PATCH(request: Request, context: Context) {
  return productionRoute(request, "derruba.patch", async ({ db, user, fronts }) => {
    await updateFellingLine(db, user, fronts, await routeId(context), await readBody(request));
    return Response.json({ message: "Lançamento alterado." });
  }, { write: true });
}

export async function DELETE(request: Request, context: Context) {
  return productionRoute(request, "derruba.delete", async ({ db, user, fronts }) => {
    await deleteFellingLine(db, user, fronts, await routeId(context));
    return Response.json({ message: "Lançamento excluído." });
  }, { write: true });
}
