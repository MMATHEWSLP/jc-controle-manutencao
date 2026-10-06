import { getDb } from "../../../../db";
import { fuelDailySettings } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelCosts, fuelLocalDay, fuelVisibleFronts } from "../../../../lib/fuel";
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
    // Valor do diesel: custo médio ponderado do estoque no momento de cada saída (mesma conta do Histórico).
    const costs = await fuelCosts(db);
    const exitCost = (id: number) => costs.get(id)?.cost ?? null;
    const priced = summary.exits.filter((row) => exitCost(row.id) !== null);
    const totalCost = Math.round(priced.reduce((sum, row) => sum + exitCost(row.id)!, 0) * 100) / 100;
    const pricedLiters = priced.reduce((sum, row) => sum + row.liters, 0);
    const withoutPrice = summary.exits.length - priced.length;
    // R$ com 2 casas; o valor do litro aceita até 4 (6,38 · 6,4125).
    const brl = (value: number, maxDigits = 2) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
    const cards = [
      { label: "Saldo anterior", value: litersMessage(t.previous), tone: "gray" as const },
      ...(t.entries > 0 ? [{ label: "Entrada", value: litersMessage(t.entries), tone: "green" as const }] : []),
      ...(t.transfersIn > 0 ? [{ label: "Transf. recebida", value: litersMessage(t.transfersIn), tone: "blue" as const }] : []),
      ...(t.transfersOut > 0 ? [{ label: "Transf. enviada", value: litersMessage(t.transfersOut), tone: "blue" as const }] : []),
      ...(t.adjustments !== 0 ? [{ label: "Ajuste de saldo", value: litersMessage(t.adjustments), tone: "gray" as const }] : []),
      { label: "Consumo", value: litersMessage(t.consumption), tone: "red" as const },
      ...(priced.length ? [{ label: "Custo do consumo", value: brl(totalCost), tone: "red" as const,
        detail: `${brl(totalCost / pricedLiters, 4)}/L${withoutPrice ? ` · ${withoutPrice} saída(s) sem valor` : ""}` }] : []),
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
      rows: summary.exits.map((row) => [row.equipment, DAILY_EXIT_KIND_LABELS[row.kind], row.company ?? "—", litersMessage(row.liters), costs.get(row.id)?.unitCost == null ? "—" : brl(costs.get(row.id)!.unitCost!, 4), exitCost(row.id) === null ? "sem valor" : brl(exitCost(row.id)!), reading(row), row.responsible ?? "—", row.notes ?? "—"]),
      pendingNotice: summary.convoyPending.liters > 0 ? `Comboio: ${litersMessage(summary.convoyPending.liters)} pendentes de aprovação neste dia (${summary.convoyPending.count} registro(s)) — não entram nas saídas nem no saldo.` : null,
      totalLiters: litersMessage(summary.exitsLiters), totalValue: priced.length ? brl(totalCost) : undefined,
      averagePrice: priced.length ? brl(totalCost / pricedLiters, 4) : undefined, withoutPrice, count: summary.exits.length,
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
