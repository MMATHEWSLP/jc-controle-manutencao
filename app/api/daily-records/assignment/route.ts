import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { DailyRecordError, requireEquipment, saveAssignment } from "../../../../lib/daily-records";

// Atualiza a "memória" do equipamento do operador logado assim que ele troca de máquina.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.register"); if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const equipmentId = Number(body.equipmentId);
    if (!Number.isInteger(equipmentId) || equipmentId <= 0) return Response.json({ error: "Equipamento inválido." }, { status: 400 });
    await requireEquipment(auth.user!, equipmentId);
    await saveAssignment(auth.user!.id, equipmentId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-records.assignment]", error);
    return Response.json({ error: "Não foi possível salvar o equipamento atual." }, { status: 500 });
  }
}
