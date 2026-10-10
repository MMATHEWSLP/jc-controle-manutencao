import { lookupProductionEmployees } from "../../../../lib/production";
import { noStore, productionRoute } from "../../../../lib/production-api";
import { isFunctionGroup } from "../../../../lib/production-rules";

// Autocomplete de funcionários da Produção: ?q=nome&frente=ID&funcao=MOTOSSERRA|AJUDANTE_MOTOSSERRA|SKIDDER|MOTORISTA&todos=1.
// Devolve só nome, função, empresa e frente (sem dados pessoais); desligados ficam de fora.
export async function GET(request: Request) {
  return productionRoute(request, "funcionarios", async ({ db, params }) => {
    const group = params.get("funcao");
    const employees = await lookupProductionEmployees(db, {
      q: (params.get("q") ?? "").slice(0, 80), frontId: Number(params.get("frente")) || null, group: isFunctionGroup(group) ? group : null, all: params.get("todos") === "1",
    });
    return Response.json({ employees }, noStore);
  });
}
