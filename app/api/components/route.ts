import { getDb } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { componentErrorResponse, listComponents, readComponentBody, saveComponent } from "../../../lib/components";

// Pneus e baterias: lista (com filtros, alertas e custo por km/hora) e cadastro.
export async function GET(request: Request) {
  const auth = await authorize(request, "equipment.view");
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("tipo"), status = url.searchParams.get("situacao"), equipmentId = Number(url.searchParams.get("equipamento"));
  try {
    const db = await getDb();
    return Response.json(await listComponents(db, auth.user!, {
      kind: kind === "TIRE" || kind === "BATTERY" ? kind : null,
      status: status === "STOCK" || status === "MOUNTED" || status === "DISCARDED" ? status : null,
      equipmentId: Number.isInteger(equipmentId) && equipmentId > 0 ? equipmentId : null,
      q: url.searchParams.get("q")?.trim().slice(0, 60) || null,
    }));
  } catch (error) {
    console.error("[components.get]", error);
    return Response.json({ error: "Não foi possível carregar pneus e baterias agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "maintenance.create");
  if (auth.response) return auth.response;
  try {
    const body = readComponentBody(await request.json() as Record<string, unknown>);
    const id = await saveComponent(await getDb(), auth.user!, body, null);
    return Response.json({ id, message: body.kind === "TIRE" ? `Pneu ${body.code} cadastrado.` : `Bateria ${body.code} cadastrada.` });
  } catch (error) {
    const known = componentErrorResponse(error); if (known) return known;
    console.error("[components.post]", error);
    return Response.json({ error: "Não foi possível salvar agora." }, { status: 500 });
  }
}
