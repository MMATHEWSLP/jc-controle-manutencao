import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { fuelVisibleFronts } from "../../../../../lib/fuel";
import { deleteMeasurement, tankErrorResponse } from "../../../../../lib/fuel-tanks";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Medição inválida." }, { status: 400 });
  try {
    const db = await getDb();
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    await deleteMeasurement(db, auth.user!, visible, id);
    return Response.json({ message: "Medição excluída (e o ajuste de saldo dela, se havia)." });
  } catch (error) {
    const known = tankErrorResponse(error); if (known) return known;
    console.error("[fuel.measurements.delete]", error);
    return Response.json({ error: "Não foi possível excluir a medição agora." }, { status: 500 });
  }
}
