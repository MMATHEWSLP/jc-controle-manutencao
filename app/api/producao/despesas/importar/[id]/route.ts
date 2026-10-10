import { revertImport } from "../../../../../../lib/production-expenses";
import { productionRoute, routeId } from "../../../../../../lib/production-api";

type Context = { params: Promise<{ id: string }> };

// Desfazer o lote: estorna as saídas de estoque e exclui os outros gastos dele.
export async function DELETE(request: Request, context: Context) {
  return productionRoute(request, "importar.desfazer", async ({ db, user }) => {
    const result = await revertImport(db, user, await routeId(context));
    return Response.json({ message: `Importação desfeita (${result.exits} saída(s) de estoque estornada(s)).` });
  }, { write: true });
}
