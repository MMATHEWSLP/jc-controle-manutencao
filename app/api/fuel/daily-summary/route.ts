import { getDb } from "../../../../db";
import { fuelDailySettings } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelLocalDay, fuelVisibleFronts } from "../../../../lib/fuel";
import { DAILY_EXIT_KIND_LABELS, dailySettings, fuelDailySummary } from "../../../../lib/fuel-daily";
import { brDay, DAILY_LOCATION_LABELS, litersMessage, type DailyLocation } from "../../../../lib/fuel-daily-rules";
import { createFuelDailySummaryPdf, formatPdfDate } from "../../../../lib/pdf";

// Resumo do dia (Combustível → Histórico): ?data=AAAA-MM-DD&frontId=&fuelTypeId=&estoque=FRENTE|PORTO|TODOS
// devolve o resumo + a mensagem do WhatsApp; com &formato=pdf devolve o PDF das saídas do dia.
// Os dois usam a mesma consulta (lib/fuel-daily.ts). PUT (ADMIN) salva os textos da mensagem da frente.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATIONS: DailyLocation[] = ["FRENTE", "PORTO", "TODOS"];

export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const date = DATE.test(params.get("data") ?? "") ? params.get("data")! : fuelLocalDay();
    const frontId = Number(params.get("frontId"));
    const fuelTypeId = Number(params.get("fuelTypeId"));
    const location = (LOCATIONS as string[]).includes(params.get("estoque") ?? "") ? params.get("estoque") as DailyLocation : "FRENTE";
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    if (!fronts.some((front) => front.id === frontId)) return Response.json({ error: "Escolha uma frente que o seu usuário enxerga." }, { status: 400 });
    if (!(fuelTypeId > 0)) return Response.json({ error: "Escolha o combustível." }, { status: 400 });
    const summary = await fuelDailySummary(db, { date, frontId, fuelTypeId, location });
    if (params.get("formato") !== "pdf") return Response.json({ ...summary, canEditSettings: user.profile === "ADMIN" });

    const t = summary.totals;
    const cards = [
      { label: "Saldo anterior", value: litersMessage(t.previous), tone: "gray" as const },
      ...(t.entries > 0 ? [{ label: "Entrada", value: litersMessage(t.entries), tone: "green" as const }] : []),
      ...(t.transfersIn > 0 ? [{ label: "Transf. recebida", value: litersMessage(t.transfersIn), tone: "blue" as const }] : []),
      ...(t.transfersOut > 0 ? [{ label: "Transf. enviada", value: litersMessage(t.transfersOut), tone: "blue" as const }] : []),
      ...(t.adjustments !== 0 ? [{ label: "Ajuste de saldo", value: litersMessage(t.adjustments), tone: "gray" as const }] : []),
      { label: "Consumo", value: litersMessage(t.consumption), tone: "red" as const },
      { label: "Saldo final", value: litersMessage(t.final), tone: t.final < 0 ? "red" as const : "green" as const },
    ];
    const reading = (row: (typeof summary.exits)[number]) => row.reading === null ? "—" : `${row.reading.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${row.readingUnit === "KM" ? "km" : "h"}`;
    const pdf = createFuelDailySummaryPdf({
      frontName: summary.front.name, date: brDay(date), fuelName: summary.fuel.name, locationLabel: DAILY_LOCATION_LABELS[location],
      generatedAt: formatPdfDate(new Date().toISOString()), generatedBy: user.name, cards,
      transfers: summary.transfers.map((transfer) => ({
        direction: transfer.direction === "ENVIADA" ? "Enviada" : "Recebida", liters: litersMessage(transfer.liters),
        place: `${transfer.direction === "ENVIADA" ? "para" : "de"} ${transfer.place}`, responsible: transfer.responsible ?? "—", notes: transfer.notes ?? "—",
      })),
      rows: summary.exits.map((row) => [row.equipment, row.plate ?? "—", DAILY_EXIT_KIND_LABELS[row.kind], row.company ?? "—", litersMessage(row.liters), reading(row), row.responsible ?? "—", row.notes ?? "—"]),
      totalLiters: litersMessage(summary.exitsLiters), count: summary.exits.length,
    });
    const name = `resumo-combustivel-${summary.front.name.replace(/[^\w-]+/g, "-")}-${date}.pdf`;
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[fuel.daily-summary]", error);
    return Response.json({ error: "Não foi possível gerar o resumo do dia agora." }, { status: 500 });
  }
}

// Textos da mensagem por frente (só ADMIN). Vazio = volta ao padrão.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente o administrador altera a mensagem do resumo." }, { status: 403 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const frontId = Number(body.frontId);
    const clean = (value: unknown) => String(value ?? "").trim().slice(0, 200);
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, auth.user!);
    if (!fronts.some((front) => front.id === frontId)) return Response.json({ error: "Frente inválida." }, { status: 400 });
    const defaults = await dailySettings(db, -1);
    const values = { greeting: clean(body.greeting), title: clean(body.title) || defaults.title, balanceLabel: clean(body.balanceLabel) || defaults.balanceLabel, updatedBy: auth.user!.id, updatedAt: new Date().toISOString() };
    await db.insert(fuelDailySettings).values({ serviceFrontId: frontId, ...values }).onConflictDoUpdate({ target: fuelDailySettings.serviceFrontId, set: values });
    return Response.json({ settings: await dailySettings(db, frontId), message: "Mensagem da frente salva." });
  } catch (error) {
    console.error("[fuel.daily-summary.settings]", error);
    return Response.json({ error: "Não foi possível salvar a configuração." }, { status: 500 });
  }
}
