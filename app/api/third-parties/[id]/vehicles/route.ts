import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { createVehicle, thirdPartyErrorResponse } from "../../../../../lib/third-parties";
import { parseVehicle } from "../../../../../lib/third-party-rules";

type Context = { params: Promise<{ id: string }> };

// Novo veículo/máquina de um terceiro.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const thirdPartyId = Number((await params).id);
  if (!Number.isInteger(thirdPartyId) || thirdPartyId <= 0) return Response.json({ error: "Terceiro inválido." }, { status: 400 });
  try {
    const parsed = parseVehicle(await request.json() as Record<string, unknown>);
    if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
    const id = await createVehicle(await getDb(), auth.user!, thirdPartyId, parsed.value!);
    return Response.json({ id, message: `Veículo ${parsed.value!.plate} cadastrado.` }, { status: 201 });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-party-vehicles.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o veículo agora." }, { status: 500 });
  }
}
