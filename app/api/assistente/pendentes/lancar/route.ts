import { lancarPendentes, podeLancarPendentes } from "../../../../../lib/assistente/pendentes";
import { contextoPendentes, erroPendentes } from "../acesso";

export const maxDuration = 300;

// "Lançar tudo" → "Confirmar": a ÚNICA rota que grava os lançamentos pendentes no sistema. Só com
// { confirmar: true } (enviado pelo botão Confirmar do resumo final) e só para os perfis liberados
// (ASSISTANT_LAUNCH_PROFILES, padrão ADMIN e GESTOR). A assistente não tem acesso a esta rota.
export async function POST(request: Request) {
  const { ctx, response } = await contextoPendentes(request, true);
  if (response) return response;
  if (!podeLancarPendentes(ctx.user)) return Response.json({ error: "Só ADMIN e GESTOR podem usar o “Lançar tudo”." }, { status: 403 });
  try {
    const body = (await request.json().catch(() => ({}))) as { confirmar?: unknown; ids?: unknown };
    if (body.confirmar !== true) return Response.json({ error: "Confirme o lançamento no resumo final." }, { status: 400 });
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0) : undefined;
    return Response.json(await lancarPendentes(ctx, ids));
  } catch (error) { return erroPendentes(error, "lancar"); }
}
