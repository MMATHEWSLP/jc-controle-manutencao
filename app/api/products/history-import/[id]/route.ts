import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { HistoryImportError, revertHistoryImport } from "../../../../../lib/stock-history-import";

type Context = { params: Promise<{ id: string }> };

// Desfazer importação (só ADMIN): apaga as linhas do lote e devolve o saldo das que baixaram estoque.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Importação inválida." }, { status: 400 });
  try {
    const result = await revertHistoryImport(await getDb(), auth.user!, id);
    const parts = [`${result.movements.toLocaleString("pt-BR")} linha(s) removida(s)`];
    if (result.restoredProducts) parts.push(`saldo devolvido em ${result.restoredProducts} produto(s)`);
    if (result.deletedProducts) parts.push(`${result.deletedProducts} produto(s) criado(s) pelo lote excluído(s)`);
    if (result.keptProducts) parts.push(`${result.keptProducts} produto(s) criado(s) mantido(s) por já estarem em uso`);
    return Response.json({ ...result, message: `Importação #${id} desfeita: ${parts.join(", ")}.` });
  } catch (error) {
    if (error instanceof HistoryImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[products.history-import.revert]", error);
    return Response.json({ error: "Não foi possível desfazer a importação agora." }, { status: 500 });
  }
}
