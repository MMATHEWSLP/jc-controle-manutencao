import { getD1 } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { siteUrl } from "../../../../lib/site";
import { buildWeeklyReport, systemUser } from "../../../../lib/weekly-report";
import { previousWeek, weekOf, weeklyReportText, weeklySummaryLine } from "../../../../lib/weekly-report-rules";
import { getWhatsappConfiguration, getWhatsappCronSecret, sendWhatsappWeeklyReport } from "../../../../lib/whatsapp";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
const br = (day: string) => day.split("-").reverse().join("/");

// Envia o resumo semanal (todas as frentes) pelo WhatsApp aos destinatários marcados.
//  - Agendado (GitHub Actions, segunda de manhã): Authorization: Bearer WHATSAPP_CRON_SECRET; manda a
//    semana anterior uma vez só por destinatário.
//  - Manual (tela, só ADMIN): body { semana }; pode reenviar.
export async function POST(request: Request) {
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const configured = await getWhatsappCronSecret();
  const scheduled = Boolean(supplied && configured && supplied === configured);
  let createdBy: number | null = null;
  let day: string | null = null;
  if (!scheduled) {
    if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
    const auth = await authorize(request);
    if (auth.response) return auth.response;
    if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente administrador envia o resumo pelo WhatsApp." }, { status: 403 });
    createdBy = auth.user!.id;
    const body = await request.json().catch(() => ({})) as { semana?: unknown };
    day = typeof body.semana === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.semana) ? body.semana : null;
  }
  const period = day ? weekOf(day) : previousWeek(today());
  try {
    const d1 = await getD1();
    // Sem WhatsApp configurado o agendamento não é erro (o workflow não fica vermelho toda segunda).
    const configuration = await getWhatsappConfiguration(d1);
    if (!configuration.connected) {
      const message = "WhatsApp ainda não configurado: o resumo não foi enviado. Configure a conexão na tela do WhatsApp.";
      return scheduled ? Response.json({ ok: false, period, message }) : Response.json({ error: message }, { status: 409 });
    }
    // Modo manual escolhido na tela do WhatsApp: o agendamento não usa a API (o texto fica em
    // Equipamentos → Resumo semanal → Copiar texto). O botão "Enviar pelo WhatsApp" continua valendo.
    if (scheduled && configuration.settings.sendMode === "MANUAL") return Response.json({ ok: false, period, message: "WhatsApp em modo manual: o resumo não foi enviado automaticamente." });
    const report = await buildWeeklyReport(d1, systemUser(), period);
    const link = siteUrl();
    const result = await sendWhatsappWeeklyReport(d1, {
      text: weeklyReportText(report, link), summaryLine: weeklySummaryLine(report), periodLabel: `${br(period.from)} a ${br(period.to)}`, link,
      weekKey: scheduled ? period.from : null, createdBy,
    });
    const message = result.recipients === 0 ? "Nenhum destinatário marcado para receber o resumo semanal (WhatsApp → destinatários)."
      : `Resumo enviado para ${result.sent} de ${result.recipients} destinatário(s)${result.skipped ? `; ${result.skipped} já tinha(m) recebido esta semana` : ""}${result.failed ? `; ${result.failed} falhou(aram) — veja o histórico do WhatsApp` : ""}.`;
    return Response.json({ ok: true, period, message, ...result });
  } catch (error) {
    console.error("[weekly-report.send]", error);
    return Response.json({ error: error instanceof Error ? error.message : "Não foi possível enviar o resumo agora." }, { status: 500 });
  }
}
