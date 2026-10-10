import { listTargets, setTarget } from "../../../../lib/production-felling";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";

// Meta diária (árvores por operador por dia) de cada frente: ?etapa=DERRUBA|ARRASTE.
export async function GET(request: Request) {
  return productionRoute(request, "metas.get", async ({ db, fronts, params }) => {
    const targets = await listTargets(db, fronts.map((front) => front.id), params.get("etapa") === "ARRASTE" ? "ARRASTE" : "DERRUBA");
    return Response.json({ targets: Object.fromEntries(targets) }, noStore);
  });
}

// { serviceFrontId, stage, value } — valor vazio apaga a meta.
export async function PUT(request: Request) {
  return productionRoute(request, "metas.put", async ({ db, user, fronts }) => {
    await setTarget(db, user, fronts, await readBody(request));
    return Response.json({ message: "Meta salva." });
  }, { write: true });
}
