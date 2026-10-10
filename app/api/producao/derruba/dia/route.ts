import { loadFellingDay, saveFellingDay } from "../../../../../lib/production-felling";
import { noStore, productionRoute, readBody } from "../../../../../lib/production-api";

// Lançamento diário em lote: ?projeto=ID&data=AAAA-MM-DD devolve o dia (ou a sugestão do último dia).
export async function GET(request: Request) {
  return productionRoute(request, "derruba.dia.get", async ({ db, fronts, params }) =>
    Response.json(await loadFellingDay(db, fronts, Number(params.get("projeto")), String(params.get("data") ?? "")), noStore));
}

// { projectId, date, lines } — grava o dia inteiro numa transação.
export async function PUT(request: Request) {
  return productionRoute(request, "derruba.dia.put", async ({ db, user, fronts }) => {
    const result = await saveFellingDay(db, user, fronts, await readBody(request));
    return Response.json({ ...result, message: `Produção salva: ${result.saved} operador(es), ${result.trees.toLocaleString("pt-BR")} árvore(s)${result.removed ? ` · ${result.removed} tirado(s) do dia` : ""}.` });
  }, { write: true });
}
