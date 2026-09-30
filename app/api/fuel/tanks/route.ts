import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelVisibleFronts } from "../../../../lib/fuel";
import { listTanks, readTankBody, saveTank, tankErrorResponse } from "../../../../lib/fuel-tanks";

// Tanques de combustível (tabela da régua e tolerância da conciliação).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    return Response.json({ tanks: await listTanks(db, visible) });
  } catch (error) {
    console.error("[fuel.tanks.get]", error);
    return Response.json({ error: "Não foi possível carregar os tanques agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.manage");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    const id = await saveTank(db, auth.user!, visible, readTankBody(await request.json() as Record<string, unknown>), null);
    return Response.json({ id, message: "Tanque cadastrado." });
  } catch (error) {
    const known = tankErrorResponse(error); if (known) return known;
    console.error("[fuel.tanks.post]", error);
    return Response.json({ error: "Não foi possível salvar o tanque agora." }, { status: 500 });
  }
}
