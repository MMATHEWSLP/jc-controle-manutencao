import { listReasons, saveReason } from "../../../../lib/production";
import { noStore, productionRoute, readBody } from "../../../../lib/production-api";

// Motivos de produção baixa/zero. ?todos=1 inclui os inativos. Gravação: só ADMIN (lib/production.ts).
export async function GET(request: Request) {
  return productionRoute(request, "motivos.get", async ({ db, params }) => Response.json({ reasons: await listReasons(db, params.get("todos") === "1") }, noStore));
}

export async function POST(request: Request) {
  return productionRoute(request, "motivos.post", async ({ db, user }) => {
    await saveReason(db, user, null, await readBody(request));
    return Response.json({ message: "Motivo cadastrado." }, { status: 201 });
  }, { write: true });
}

export async function PATCH(request: Request) {
  return productionRoute(request, "motivos.patch", async ({ db, user }) => {
    const body = await readBody(request);
    await saveReason(db, user, Number(body.id) || -1, body);
    return Response.json({ message: "Motivo alterado." });
  }, { write: true });
}
