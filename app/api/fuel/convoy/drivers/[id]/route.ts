import { assertSameOrigin, authorize, type SessionUser } from "../../../../../../lib/auth";
import { removeConvoyDriver, updateConvoyDriver } from "../../../../../../lib/convoy-drivers";
import { FieldOperatorError } from "../../../../../../lib/field-operators";

type Context = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Context, run: (actor: SessionUser, id: number, body: Record<string, unknown>) => Promise<string>) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "daily.field_operators"); if (auth.response) return auth.response;
  try {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Motorista inválido." }, { status: 400 });
    const body = request.method === "DELETE" ? {} : await request.json() as Record<string, unknown>;
    return Response.json({ ok: true, message: await run(auth.user!, id, body) });
  } catch (error) {
    if (error instanceof FieldOperatorError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.drivers.id]", error);
    return Response.json({ error: "Não foi possível salvar o motorista." }, { status: 500 });
  }
}

// Comboio, "também faz o Controle Diário", ativo/inativo e PIN novo (opcional).
export async function PUT(request: Request, context: Context) {
  return handle(request, context, async (actor, id, body) => {
    const { name } = await updateConvoyDriver(actor, id, body);
    return typeof body.code === "string" && body.code.trim() ? `${name} atualizado, com PIN novo.` : `${name} atualizado.`;
  });
}

// Deixa de ser motorista do comboio (o acesso de campo continua, só com o Controle Diário).
export async function DELETE(request: Request, context: Context) {
  return handle(request, context, async (actor, id) => `${(await removeConvoyDriver(actor, id)).name} não é mais motorista do comboio.`);
}
