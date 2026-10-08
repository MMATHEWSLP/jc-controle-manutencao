import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { canSeeReport } from "../../../lib/reports-catalog";
import { siteUrl } from "../../../lib/site";
import { buildWeeklyReport } from "../../../lib/weekly-report";
import { previousWeek, weekOf, weeklyReportText } from "../../../lib/weekly-report-rules";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());

// Resumo semanal (segunda a domingo) e resumo mensal (RELATÓRIOS → Resumos), nas frentes que a pessoa
// enxerga. ?semana=AAAA-MM-DD (qualquer dia da semana; padrão: a última semana completa) ou
// ?mes=AAAA-MM (o mês inteiro; o mês corrente vai até hoje), e ?frente=id.
function monthPeriod(month: string, day: string) {
  const last = new Date(`${month}-01T12:00:00Z`); last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const to = last.toISOString().slice(0, 10);
  return { from: `${month}-01`, to: to > day ? day : to };
}
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const month = /^\d{4}-\d{2}$/.test(params.get("mes") ?? "") ? params.get("mes")! : null;
  if (!canSeeReport(auth.user!, month ? "resumo-mensal" : "resumo-semanal")) return Response.json({ error: `Você não tem acesso ao resumo ${month ? "mensal" : "semanal"}.` }, { status: 403 });
  const day = params.get("semana") ?? "";
  const period = month ? monthPeriod(month, today()) : /^\d{4}-\d{2}-\d{2}$/.test(day) ? weekOf(day) : previousWeek(today());
  if (period.from > today()) return Response.json({ error: month ? "O mês escolhido ainda não começou." : "A semana escolhida ainda não começou." }, { status: 400 });
  const frontId = Number(params.get("frente")) || null;
  try {
    const report = await buildWeeklyReport(await getD1(), auth.user!, period, frontId);
    return Response.json({ report, text: weeklyReportText(report, siteUrl(), month ? "Resumo mensal" : "Resumo semanal"), canSend: !month && auth.user!.profile === "ADMIN" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[weekly-report]", error);
    return Response.json({ error: "Não foi possível montar o resumo agora." }, { status: 500 });
  }
}
