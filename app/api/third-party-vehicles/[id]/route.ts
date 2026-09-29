import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { deleteVehicle, thirdPartyErrorResponse, updateVehicle } from "../../../../lib/third-parties";
import { parseVehicle } from "../../../../lib/third-party-rules";

type Context = { params: Promise<{ id: string }> };
const readId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

// Editar ({...campos}) ou só ativar/inativar ({ active: true|false }) um veículo de terceiro.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Veículo inválido." }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const onlyStatus = Object.keys(body).length === 1 && typeof body.active === "boolean";
    const parsed = onlyStatus ? null : parseVehicle(body);
    if (parsed?.error) return Response.json({ error: parsed.error }, { status: 400 });
    await updateVehicle(await getDb(), auth.user!, id, parsed?.value ?? null, typeof body.active === "boolean" ? body.active : undefined);
    return Response.json({ message: onlyStatus ? (body.active ? "Veículo reativado." : "Veículo inativado.") : "Veículo atualizado." });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-party-vehicles.put]", error);
    return Response.json({ error: "Não foi possível atualizar o veículo agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Veículo inválido." }, { status: 400 });
  try {
    await deleteVehicle(await getDb(), auth.user!, id);
    return Response.json({ message: "Veículo excluído." });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-party-vehicles.delete]", error);
    return Response.json({ error: "Não foi possível excluir o veículo agora." }, { status: 500 });
  }
}
