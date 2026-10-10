import { lookupProductionEmployees } from "../../../../../lib/production";
import { noStore, productionRoute } from "../../../../../lib/production-api";
import { isFunctionGroup } from "../../../../../lib/production-rules";

// Busca de operador/ajudante no celular do apontador (só nome, função, empresa e frente).
export async function GET(request: Request) {
  return productionRoute(request, "campo.funcionarios", async ({ db, params }) => {
    const group = params.get("funcao");
    return Response.json({ employees: await lookupProductionEmployees(db, {
      q: (params.get("q") ?? "").slice(0, 80), frontId: Number(params.get("frente")) || null, group: isFunctionGroup(group) ? group : null, all: params.get("todos") === "1",
    }) }, noStore);
  }, { field: true });
}
