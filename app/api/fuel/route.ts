import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { serviceFronts } from "../../../db/schema";
import { frentesEmExibicao, seesMultipleFronts } from "../../../lib/active-front";
import { authorize } from "../../../lib/auth";
import { activeFuelTypes, fuelBalances, fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, monthStart, resolveFuelFront } from "../../../lib/fuel";

// Cards de saldo do topo do módulo e os dados de apoio do formulário. Os cards NÃO seguem o filtro
// do Histórico: saldo atual acumulado + entradas/saídas do mês corrente, separados em Frente e Porto.
// Escopo = frente(s) do seletor global ∩ frentes que a pessoa enxerga.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const today = fuelLocalDay();
    const period = { from: monthStart(today), to: today };
    const db = await getDb();
    const [types, fronts, destinationFronts] = await Promise.all([
      activeFuelTypes(db), fuelVisibleFronts(db, user),
      db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name)),
    ]);
    const visibleIds = fronts.map((front) => front.id);
    const displayed = frentesEmExibicao(user, request);
    const scope = fuelScopeFronts(visibleIds, displayed, null);
    const balances = await fuelBalances(db, scope, period.from, period.to);
    const frontName = new Map(fronts.map((front) => [front.id, front.name]));
    return Response.json({
      today,
      period,
      fuelTypes: types,
      fronts,
      // Filial destino da transferência: qualquer frente ativa, mesmo fora das que a pessoa enxerga.
      destinationFronts,
      scopeFrontIds: scope,
      allFronts: displayed === "ALL",
      multiFront: seesMultipleFronts(user) && visibleIds.length > 1,
      defaultFrontId: resolveFuelFront(visibleIds, undefined, displayed, user),
      balances: types.map((type) => {
        const balance = balances.get(type.id);
        const empty = { balance: 0, entries: 0, exits: 0 };
        const locations = (value?: { byLocation: Record<"FRENTE" | "PORTO", typeof empty> }) => ({ FRENTE: value?.byLocation.FRENTE ?? empty, PORTO: value?.byLocation.PORTO ?? empty });
        return {
          fuelTypeId: type.id, code: type.code, name: type.name, unit: type.unit,
          balance: balance?.balance ?? 0, entries: balance?.entries ?? 0, exits: balance?.exits ?? 0,
          byLocation: locations(balance),
          byFront: scope.map((id) => {
            const front = balance?.byFront.get(id);
            return { serviceFrontId: id, name: frontName.get(id) ?? "—", balance: front?.balance ?? 0, entries: front?.entries ?? 0, exits: front?.exits ?? 0, byLocation: locations(front) };
          }),
        };
      }),
    });
  } catch (error) {
    console.error("[fuel.get]", error);
    return Response.json({ error: "Não foi possível carregar os saldos de combustível agora." }, { status: 500 });
  }
}
