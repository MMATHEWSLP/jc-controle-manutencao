import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { canSeeFleetCosts, fleetCostReport } from "../../../lib/fleet-costs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

// Custo e consumo por equipamento no período (?de=AAAA-MM-DD&ate=AAAA-MM-DD&frente=ID). ADMIN/GESTOR.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!canSeeFleetCosts(auth.user!)) return Response.json({ error: "Somente administrador ou gestor vê custos por equipamento." }, { status: 403 });
  const url = new URL(request.url);
  const to = DAY.test(url.searchParams.get("ate") ?? "") ? url.searchParams.get("ate")! : today();
  const defaultFrom = new Date(`${to}T12:00:00Z`); defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 89);
  const from = DAY.test(url.searchParams.get("de") ?? "") ? url.searchParams.get("de")! : defaultFrom.toISOString().slice(0, 10);
  if (from > to) return Response.json({ error: "A data inicial precisa ser antes da final." }, { status: 400 });
  const frontId = Number(url.searchParams.get("frente")) || null;
  try {
    return Response.json(await fleetCostReport(await getD1(), auth.user!, { from, to, frontId }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[fleet-costs]", error);
    return Response.json({ error: "Não foi possível calcular os custos agora." }, { status: 500 });
  }
}
