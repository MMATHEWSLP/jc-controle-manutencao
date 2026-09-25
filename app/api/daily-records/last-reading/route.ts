import { authorize } from "../../../../lib/auth";
import { DailyRecordError, loadLastReading } from "../../../../lib/daily-records";

export async function GET(request: Request) {
  const auth = await authorize(request, "daily.register"); if (auth.response) return auth.response;
  try {
    const equipmentId = Number(new URL(request.url).searchParams.get("equipmentId"));
    if (!Number.isInteger(equipmentId) || equipmentId <= 0) return Response.json({ error: "Equipamento inválido." }, { status: 400 });
    return Response.json(await loadLastReading(auth.user!, equipmentId));
  } catch (error) {
    if (error instanceof DailyRecordError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-records.last-reading]", error);
    return Response.json({ error: "Não foi possível buscar a última leitura." }, { status: 500 });
  }
}
