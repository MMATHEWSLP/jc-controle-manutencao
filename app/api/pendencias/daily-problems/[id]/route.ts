import { getD1 } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { canSeePendencias, resolverProblemaDiario } from "../../../../../lib/pendencias";

type Context = { params: Promise<{ id: string }> };

// Pendências → "Problemas relatados no Controle Diário" → Resolver.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (!canSeePendencias(auth.user!)) return Response.json({ error: "Somente administrador ou gestor resolve pendências." }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Problema inválido." }, { status: 400 });
  try {
    const body = await request.json().catch(() => ({})) as { nota?: unknown };
    const result = await resolverProblemaDiario(await getD1(), auth.user!, id, typeof body.nota === "string" ? body.nota : "");
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true, message: "Problema marcado como resolvido." });
  } catch (error) {
    console.error("[pendencias.daily-problems]", error);
    return Response.json({ error: "Não foi possível resolver agora." }, { status: 500 });
  }
}
