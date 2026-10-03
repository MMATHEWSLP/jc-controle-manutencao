import { authorize } from "../../../../lib/auth";
import { opcoesOperadores } from "../../../../lib/daily-import";
import { canManage } from "../../../../lib/daily-records";

// Funcionários de campo para vincular o operador de um registro (Histórico → Corrigir).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (!canManage(auth.user!)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  return Response.json({ operadores: await opcoesOperadores() });
}
