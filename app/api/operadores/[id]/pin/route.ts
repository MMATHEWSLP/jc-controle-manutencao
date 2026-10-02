import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { OperadorError, pdfDeUmAcesso, redefinirPin } from "../../../../../lib/operadores";

type Context = { params: Promise<{ id: string }> };

// Redefinir PIN (ADMIN/GESTOR): gera um PIN novo, mostrado UMA vez nesta resposta (com o PDF para
// imprimir). O antigo deixa de valer, as sessões abertas caem e o bloqueio por tentativas zera.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators");
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (user.profile !== "ADMIN" && user.profile !== "GESTOR") return Response.json({ error: "Só ADMIN e GESTOR redefinem o PIN." }, { status: 403 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Operador inválido." }, { status: 400 });
  try {
    const acesso = await redefinirPin(await getDb(), user, id);
    return Response.json({ message: `PIN de ${acesso.nome} redefinido.`, acessoOperador: { ...acesso, pdfBase64: pdfDeUmAcesso(acesso, user.name, "PIN redefinido") } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OperadorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[operadores.pin]", error);
    return Response.json({ error: "Não foi possível redefinir o PIN agora." }, { status: 500 });
  }
}
