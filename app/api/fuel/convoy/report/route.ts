import { authorize } from "../../../../../lib/auth";
import { ConvoyError, convoyReport } from "../../../../../lib/convoy";
import { fortalezaDay } from "../../../../../lib/convoy-rules";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Relatório do comboio: por período, comboio, motorista do comboio e equipamento, com totais, sem foto
// por motivo, rejeitados e tempo médio até a aprovação.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    const today = fortalezaDay();
    const from = DATE.test(params.get("from") ?? "") ? params.get("from")! : `${today.slice(0, 7)}-01`;
    const to = DATE.test(params.get("to") ?? "") ? params.get("to")! : today;
    return Response.json(await convoyReport(auth.user!, {
      from: from <= to ? from : to, to: from <= to ? to : from, convoyEquipmentId: Number(params.get("convoy")) || null,
      registeredBy: Number(params.get("driver")) || null, equipmentId: Number(params.get("equipment")) || null,
    }));
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.report]", error);
    return Response.json({ error: "Não foi possível gerar o relatório." }, { status: 500 });
  }
}
