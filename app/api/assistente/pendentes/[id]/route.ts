import { campoDaOpcao, editarPendente, lerCampos, listarPendentes, removerPendentes } from "../../../../../lib/assistente/pendentes";
import { contextoPendentes, erroPendentes } from "../acesso";

type Context = { params: Promise<{ id: string }> };

const lerId = async (params: Context["params"]) => { const id = Number((await params).id); return Number.isInteger(id) && id > 0 ? id : null; };

// Edição no painel: mesmos campos da assistente (texto falado/digitado é localizado no cadastro) ou
// a escolha de uma das opções de uma pergunta ({ escolha: { campo, id } }).
export async function PATCH(request: Request, { params }: Context) {
  const { ctx, response } = await contextoPendentes(request, true);
  if (response) return response;
  const id = await lerId(params);
  if (!id) return Response.json({ error: "Item inválido." }, { status: 400 });
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    let campos = lerCampos(body);
    const escolha = body.escolha as { campo?: unknown; id?: unknown } | undefined;
    if (escolha && typeof escolha.campo === "string" && Number.isInteger(Number(escolha.id))) {
      const atual = (await listarPendentes(ctx)).itens.find((item) => item.id === id);
      if (!atual) return Response.json({ error: "Item não encontrado na sua lista." }, { status: 404 });
      campos = { ...campos, ...campoDaOpcao(atual.item, escolha.campo, Number(escolha.id)) };
    }
    return Response.json(await editarPendente(ctx, id, campos));
  } catch (error) { return erroPendentes(error, "editar"); }
}

export async function DELETE(request: Request, { params }: Context) {
  const { ctx, response } = await contextoPendentes(request, true);
  if (response) return response;
  const id = await lerId(params);
  if (!id) return Response.json({ error: "Item inválido." }, { status: 400 });
  try { return Response.json(await removerPendentes(ctx, [id])); }
  catch (error) { return erroPendentes(error, "remover"); }
}
