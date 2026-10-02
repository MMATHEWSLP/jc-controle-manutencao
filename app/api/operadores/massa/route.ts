import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { criarAcessosEmMassa, previaCriacaoEmMassa } from "../../../../lib/operadores";

export const maxDuration = 300;

// Prévia (não grava): quantos acessos serão criados, por frente e por função, e quem ficou de fora.
export async function GET(request: Request) {
  const auth = await authorize(request, "daily.field_operators");
  if (auth.response) return auth.response;
  try { return Response.json(await previaCriacaoEmMassa(await getDb(), auth.user!)); }
  catch (error) {
    console.error("[operadores.massa.get]", error);
    return Response.json({ error: "Não foi possível montar a prévia agora." }, { status: 500 });
  }
}

// Cria os acessos pendentes (ADMIN/GESTOR, com { confirmar: true }) e devolve o PDF com os PINs —
// o único momento em que eles aparecem.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators");
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (user.profile !== "ADMIN" && user.profile !== "GESTOR") return Response.json({ error: "Só ADMIN e GESTOR criam acessos de operador." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { confirmar?: unknown };
  if (body.confirmar !== true) return Response.json({ error: "Confirme a criação dos acessos." }, { status: 400 });
  try { return Response.json(await criarAcessosEmMassa(await getDb(), user), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    console.error("[operadores.massa.post]", error);
    return Response.json({ error: "Não foi possível criar os acessos agora." }, { status: 500 });
  }
}
