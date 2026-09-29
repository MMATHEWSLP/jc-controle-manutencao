import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { serviceFronts } from "../../../db/schema";
import { activeFuelTypes } from "../../../lib/fuel";
import { frentesVisiveis } from "../../../lib/access";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { canManageThirdParties, canViewThirdParties, createThirdParty, listThirdParties, thirdPartyErrorResponse, thirdPartyOptions } from "../../../lib/third-parties";
import { parseThirdParty } from "../../../lib/third-party-rules";

// Cadastro de Terceiros. GET ?opcoes=1 devolve só os ativos (com veículos ativos) para os selects do
// Combustível e da Movimentação; sem ele, a lista completa do cadastro com filtros e médias.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canViewThirdParties(user)) return Response.json({ error: "Você não possui permissão para consultar terceiros." }, { status: 403 });
  try {
    const db = await getDb();
    const params = new URL(request.url).searchParams;
    if (params.get("opcoes") === "1") return Response.json({ thirdParties: await thirdPartyOptions(db), canManage: canManageThirdParties(user) });
    const active = params.get("situacao");
    const [list, fuelTypes, fronts] = await Promise.all([
      listThirdParties(db, { q: (params.get("q") ?? "").trim(), kind: params.get("tipo") || null, active: active === "INACTIVE" || active === "ALL" ? active : "ACTIVE" }, frentesVisiveis(user)),
      activeFuelTypes(db),
      db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name)),
    ]);
    return Response.json({ thirdParties: list, fuelTypes, fronts, canManage: canManageThirdParties(user) });
  } catch (error) {
    console.error("[third-parties.get]", error);
    return Response.json({ error: "Não foi possível carregar os terceiros agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  try {
    const parsed = parseThirdParty(await request.json() as Record<string, unknown>);
    if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
    const id = await createThirdParty(await getDb(), auth.user!, parsed.value!);
    return Response.json({ id, message: `${parsed.value!.name} cadastrado.` }, { status: 201 });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-parties.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o terceiro agora." }, { status: 500 });
  }
}
