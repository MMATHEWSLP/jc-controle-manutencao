import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { fuelVisibleFronts } from "../../../../../lib/fuel";
import { readTankBody, saveTank, tankErrorResponse } from "../../../../../lib/fuel-tanks";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Tanque inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    await saveTank(db, auth.user!, visible, readTankBody(await request.json() as Record<string, unknown>), id);
    return Response.json({ id, message: "Tanque atualizado." });
  } catch (error) {
    const known = tankErrorResponse(error); if (known) return known;
    console.error("[fuel.tanks.put]", error);
    return Response.json({ error: "Não foi possível salvar o tanque agora." }, { status: 500 });
  }
}
