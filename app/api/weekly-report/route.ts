import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { canSeePendencias } from "../../../lib/pendencias";
import { siteUrl } from "../../../lib/site";
import { buildWeeklyReport } from "../../../lib/weekly-report";
import { previousWeek, weekOf, weeklyReportText } from "../../../lib/weekly-report-rules";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

// Resumo semanal (segunda a domingo) para ADMIN e GESTOR, nas frentes que a pessoa enxerga.
// ?semana=AAAA-MM-DD (qualquer dia da semana; padrão: a última semana completa) e ?frente=id.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  if (!canSeePendencias(auth.user!)) return Response.json({ error: "Somente administrador ou gestor vê o resumo semanal." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const day = params.get("semana") ?? "";
  const period = /^\d{4}-\d{2}-\d{2}$/.test(day) ? weekOf(day) : previousWeek(today());
  if (period.from > today()) return Response.json({ error: "A semana escolhida ainda não começou." }, { status: 400 });
  const frontId = Number(params.get("frente")) || null;
  try {
    const report = await buildWeeklyReport(await getD1(), auth.user!, period, frontId);
    return Response.json({ report, text: weeklyReportText(report, siteUrl()), canSend: auth.user!.profile === "ADMIN" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[weekly-report]", error);
    return Response.json({ error: "Não foi possível montar o resumo agora." }, { status: 500 });
  }
}
