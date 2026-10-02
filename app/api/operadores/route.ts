import { getDb } from "../../../db";
import { authorize } from "../../../lib/auth";
import { listarOperadores } from "../../../lib/operadores";

// Usuários > Operadores: acessos de operador (perfil CAMPO) das frentes que a pessoa enxerga, com
// status (ativo / bloqueado por tentativas / desativado) e último acesso.
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators");
  if (auth.response) return auth.response;
  try { return Response.json(await listarOperadores(await getDb(), auth.user!)); }
  catch (error) {
    console.error("[operadores.get]", error);
    return Response.json({ error: "Não foi possível carregar os operadores agora." }, { status: 500 });
  }
}
