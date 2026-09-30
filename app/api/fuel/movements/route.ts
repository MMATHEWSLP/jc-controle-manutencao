import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelHistory, fuelHistorySummary, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters } from "../../../../lib/fuel";
import { createFuelMovement, FuelCreateError } from "../../../../lib/fuel-create";
import { thirdPartyErrorResponse } from "../../../../lib/third-parties";

const PAGE_SIZE = 50;

// Aba "Histórico": lançamentos das frentes em exibição (como origem ou como filial destino).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const filters = parseFuelFilters(params);
    const page = Math.max(1, Number(params.get("page")) || 1);
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    const scope = fuelScopeFronts(fronts.map((front) => front.id), frentesEmExibicao(user, request), filters.frontId);
    // Resumo e listagem com o mesmo filtro (o resumo conta todas as páginas).
    const [{ rows, total }, summary] = await Promise.all([fuelHistory(db, scope, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE), fuelHistorySummary(db, scope, filters)]);
    return Response.json({ movements: rows, total, page, pageSize: PAGE_SIZE, filters, summary });
  } catch (error) {
    console.error("[fuel.movements.get]", error);
    return Response.json({ error: "Não foi possível carregar o histórico de combustível agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.register");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    // Mesma função usada pela importação por planilha (lib/fuel-create.ts).
    const result = await createFuelMovement(await getDb(), auth.user!, body, { displayedFronts: frentesEmExibicao(auth.user!, request) });
    return Response.json(result.duplicate ? { id: result.id, duplicate: true, message: result.message } : { id: result.id, consumption: result.consumption, message: result.message }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof FuelCreateError) return Response.json({ error: error.message, ...error.data }, { status: error.status });
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[fuel.movements.post]", error);
    return Response.json({ error: "Não foi possível registrar o lançamento agora." }, { status: 500 });
  }
}
