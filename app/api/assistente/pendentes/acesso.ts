import { getDb } from "../../../../db";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { canUseAssistant } from "../../../../lib/assistant-config";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { PendenteError } from "../../../../lib/assistente/pendentes";

// Acesso comum das rotas de Lançamentos pendentes: usuário logado e liberado no Assistente JC.
// A lista é sempre a do próprio usuário (as funções filtram por user_id).
export async function contextoPendentes(request: Request, mutacao: boolean) {
  if (mutacao && !assertSameOrigin(request)) return { response: Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 }) };
  const auth = await authorize(request);
  if (auth.response) return { response: auth.response };
  const user = auth.user!;
  if (!canUseAssistant(user)) return { response: Response.json({ error: "O Assistente JC não está liberado para o seu perfil." }, { status: 403 }) };
  return { ctx: { db: await getDb(), user, displayed: frentesEmExibicao(user, request) } };
}

export function erroPendentes(error: unknown, contexto: string) {
  if (error instanceof PendenteError) return Response.json({ error: error.message }, { status: error.status });
  console.error(`[assistente.pendentes.${contexto}]`, error);
  return Response.json({ error: "Não foi possível atualizar os lançamentos pendentes agora." }, { status: 500 });
}
