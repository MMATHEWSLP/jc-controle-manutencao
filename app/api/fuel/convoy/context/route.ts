import { getDb } from "../../../../../db";
import { authorize } from "../../../../../lib/auth";
import { activeFuelTypes, fuelVisibleFronts } from "../../../../../lib/fuel";

// Apoio do setor ABASTECIMENTOS (aprovação): frentes que a pessoa enxerga e combustíveis ativos.
// Não depende de fuel.view: quem só aprova o comboio também usa.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const [fuelTypes, fronts] = await Promise.all([activeFuelTypes(db), fuelVisibleFronts(db, auth.user!)]);
    return Response.json({ fronts: fronts.map((front) => ({ id: front.id, name: front.name })), fuelTypes: fuelTypes.map((type) => ({ id: type.id, name: type.name })) });
  } catch (error) { console.error("[convoy.context]", error); return Response.json({ error: "Não foi possível carregar as frentes." }, { status: 500 }); }
}
