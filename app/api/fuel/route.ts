import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { serviceFronts } from "../../../db/schema";
import { frentesEmExibicao, seesMultipleFronts } from "../../../lib/active-front";
import { authorize } from "../../../lib/auth";
import { activeFuelTypes, fuelBalances, fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters, resolveFuelFront } from "../../../lib/fuel";

// Cards de saldo do topo do módulo (saldo atual + entradas/saídas do período) e os dados de apoio
// do formulário. Escopo = frente(s) do seletor global ∩ frentes que a pessoa enxerga.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const filters = parseFuelFilters(new URL(request.url).searchParams);
    const db = await getDb();
    const [types, fronts, destinationFronts] = await Promise.all([
      activeFuelTypes(db), fuelVisibleFronts(db, user),
      db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name)),
    ]);
    const visibleIds = fronts.map((front) => front.id);
    const displayed = frentesEmExibicao(user, request);
    const scope = fuelScopeFronts(visibleIds, displayed, filters.frontId);
    const balances = await fuelBalances(db, scope, filters.from, filters.to);
    const frontName = new Map(fronts.map((front) => [front.id, front.name]));
    return Response.json({
      today: fuelLocalDay(),
      period: { from: filters.from, to: filters.to },
      fuelTypes: types,
      fronts,
      // Filial destino da transferência: qualquer frente ativa, mesmo fora das que a pessoa enxerga.
      destinationFronts,
      scopeFrontIds: scope,
      allFronts: displayed === "ALL" && !filters.frontId,
      multiFront: seesMultipleFronts(user) && visibleIds.length > 1,
      defaultFrontId: resolveFuelFront(visibleIds, undefined, displayed, user),
      balances: types.map((type) => {
        const balance = balances.get(type.id);
        return {
          fuelTypeId: type.id, code: type.code, name: type.name, unit: type.unit,
          balance: balance?.balance ?? 0, entries: balance?.entries ?? 0, exits: balance?.exits ?? 0,
          byFront: scope.map((id) => ({ serviceFrontId: id, name: frontName.get(id) ?? "—", ...(balance?.byFront.get(id) ?? { balance: 0, entries: 0, exits: 0 }) })),
        };
      }),
    });
  } catch (error) {
    console.error("[fuel.get]", error);
    return Response.json({ error: "Não foi possível carregar os saldos de combustível agora." }, { status: 500 });
  }
}
