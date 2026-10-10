import { loadFellingDay, saveFellingDay } from "../../../../../lib/production-felling";
import { noStore, productionRoute, readBody } from "../../../../../lib/production-api";

// Derruba do dia pelo apontador (mesmas regras do computador).
export async function GET(request: Request) {
  return productionRoute(request, "campo.dia.get", async ({ db, fronts, params }) =>
    Response.json(await loadFellingDay(db, fronts, Number(params.get("projeto")), String(params.get("data") ?? "")), noStore), { field: true });
}

export async function PUT(request: Request) {
  return productionRoute(request, "campo.dia.put", async ({ db, user, fronts }) => {
    const result = await saveFellingDay(db, user, fronts, await readBody(request));
    return Response.json({ ...result, message: `Produção salva: ${result.saved} operador(es), ${result.trees.toLocaleString("pt-BR")} árvore(s).` });
  }, { write: true, field: true });
}
