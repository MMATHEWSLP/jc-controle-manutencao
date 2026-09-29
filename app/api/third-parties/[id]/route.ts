import { getDb } from "../../../../db";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { deleteThirdParty, thirdPartyErrorResponse, updateThirdParty } from "../../../../lib/third-parties";
import { parseThirdParty } from "../../../../lib/third-party-rules";

type Context = { params: Promise<{ id: string }> };
const readId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

// Editar ({...campos}) ou só ativar/inativar ({ active: true|false }).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Terceiro inválido." }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const onlyStatus = Object.keys(body).length === 1 && typeof body.active === "boolean";
    const parsed = onlyStatus ? null : parseThirdParty(body);
    if (parsed?.error) return Response.json({ error: parsed.error }, { status: 400 });
    await updateThirdParty(await getDb(), auth.user!, id, parsed?.value ?? null, typeof body.active === "boolean" ? body.active : undefined);
    return Response.json({ message: onlyStatus ? (body.active ? "Terceiro reativado." : "Terceiro inativado.") : "Terceiro atualizado." });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-parties.put]", error);
    return Response.json({ error: "Não foi possível atualizar o terceiro agora." }, { status: 500 });
  }
}

// Exclusão física só sem nenhuma movimentação (senão: inativar).
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "third_parties.manage");
  if (auth.response) return auth.response;
  const id = await readId(params);
  if (!id) return Response.json({ error: "Terceiro inválido." }, { status: 400 });
  try {
    await deleteThirdParty(await getDb(), auth.user!, id);
    return Response.json({ message: "Terceiro excluído." });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[third-parties.delete]", error);
    return Response.json({ error: "Não foi possível excluir o terceiro agora." }, { status: 500 });
  }
}
