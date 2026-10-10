import { listReasons } from "../../../../lib/production";
import { noStore, productionRoute } from "../../../../lib/production-api";

// Dados de abertura do módulo: o que a pessoa pode fazer, as frentes que ela vê e os motivos ativos.
export async function GET(request: Request) {
  return productionRoute(request, "contexto", async ({ db, user, access, fronts }) =>
    Response.json({ access, fronts, defaultFrontId: user.serviceFrontId, reasons: await listReasons(db, false) }, noStore));
}
