import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelScopeFronts, fuelVisibleFronts } from "../../../../lib/fuel";
import { isFuelLocation } from "../../../../lib/fuel-rules";
import { calculatedBalanceAt, createMeasurement, listMeasurements, listTanks, readMeasurementBody, summarizeMeasurements, tankErrorResponse } from "../../../../lib/fuel-tanks";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Conciliação do tanque: histórico das medições (?de&ate&combustivel&frente) com o resumo por
// estoque, ou a prévia do saldo do sistema para o formulário (?previa=1&frente&local&combustivel&data).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const url = new URL(request.url);
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    if (url.searchParams.get("previa") === "1") {
      const frontId = Number(url.searchParams.get("frente")), fuelTypeId = Number(url.searchParams.get("combustivel"));
      const location = url.searchParams.get("local"), day = url.searchParams.get("data") ?? "";
      if (!visible.includes(frontId) || !isFuelLocation(location) || !DAY.test(day) || !(fuelTypeId > 0)) return Response.json({ error: "Escolha frente, local, combustível e data." }, { status: 400 });
      return Response.json({ calculated: await calculatedBalanceAt(db, frontId, location, fuelTypeId, day) });
    }
    const frontFilter = Number(url.searchParams.get("frente")) || null;
    const scope = fuelScopeFronts(visible, frentesEmExibicao(auth.user!, request), frontFilter);
    const from = url.searchParams.get("de"), to = url.searchParams.get("ate");
    const rows = await listMeasurements(db, scope, { from: from && DAY.test(from) ? from : null, to: to && DAY.test(to) ? to : null, fuelTypeId: Number(url.searchParams.get("combustivel")) || null });
    return Response.json({ measurements: rows, summary: summarizeMeasurements(rows), tanks: await listTanks(db, visible) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[fuel.measurements.get]", error);
    return Response.json({ error: "Não foi possível carregar as medições agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.register");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const visible = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
    const result = await createMeasurement(db, auth.user!, visible, readMeasurementBody(await request.json() as Record<string, unknown>));
    const liters = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
    const verdict = result.status === "OK" ? "dentro da tolerância" : result.status === "PERDA" ? `faltam ${liters(-result.difference)}` : `sobram ${liters(result.difference)}`;
    return Response.json({ ...result, message: `Medição registrada: ${liters(result.measured)} no tanque × ${liters(result.calculated)} no sistema — ${verdict}.${result.adjustmentMovementId ? " Saldo do sistema ajustado para o medido." : ""}` });
  } catch (error) {
    const known = tankErrorResponse(error); if (known) return known;
    console.error("[fuel.measurements.post]", error);
    return Response.json({ error: "Não foi possível registrar a medição agora." }, { status: 500 });
  }
}
