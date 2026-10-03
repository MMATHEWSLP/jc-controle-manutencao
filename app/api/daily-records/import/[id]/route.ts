import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { DailyImportError, desfazerImportacao, finalizarImportacao, importarBloco } from "../../../../../lib/daily-import";

type Context = { params: Promise<{ id: string }> };

// { acao: "bloco", bloco: n } grava até 500 linhas; { acao: "finalizar" } sobe as leituras e
// recalcula ciclos/alertas; { acao: "desfazer" } apaga o lote e devolve as leituras.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Lote inválido." }, { status: 400 });
  try {
    const body = await request.json() as { acao?: string; bloco?: unknown };
    if (body.acao === "bloco") return Response.json(await importarBloco(auth.user!, id, Math.max(0, Number(body.bloco) || 0)));
    if (body.acao === "finalizar") return Response.json(await finalizarImportacao(auth.user!, id));
    if (body.acao === "desfazer") return Response.json(await desfazerImportacao(auth.user!, id));
    return Response.json({ error: "Ação inválida." }, { status: 400 });
  } catch (error) {
    if (error instanceof DailyImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[daily-import.lote]", error instanceof Error ? error.message : error);
    return Response.json({ error: "Não foi possível concluir agora. Tente de novo: o que já foi gravado não se repete." }, { status: 500 });
  }
}
