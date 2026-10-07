import { getDb } from "../../../../../db";
import { authorize } from "../../../../../lib/auth";
import { canManageThirdParties, thirdPartyOptions } from "../../../../../lib/third-parties";

// Aprovação do comboio → CADASTRO PENDENTE: empresas, veículos e funcionários de terceiros (ativos)
// para o aprovador vincular. Não depende de fuel.view: quem só aprova o comboio também usa.
// canManage diz se ele também pode cadastrar ali mesmo (third_parties.manage).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    return Response.json({ parties: await thirdPartyOptions(await getDb()), canManage: canManageThirdParties(auth.user!) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[convoy.third-parties]", error);
    return Response.json({ error: "Não foi possível carregar os terceiros." }, { status: 500 });
  }
}
