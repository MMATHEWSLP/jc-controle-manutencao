import { authorize } from "../../../../../lib/auth";
import { listHistoryOperators } from "../../../../../lib/daily-history";
import { canRegister, canViewAll } from "../../../../../lib/daily-records";

// Opções do filtro "Colaborador": quem já tem registro lançado (no escopo do usuário).
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  if (!canRegister(user) && !canViewAll(user)) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try { return Response.json({ operators: await listHistoryOperators(user) }); }
  catch (error) { console.error("[daily-records.history.operators]", error); return Response.json({ error: "Não foi possível carregar os colaboradores." }, { status: 500 }); }
}
