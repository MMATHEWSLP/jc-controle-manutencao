import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { FuelImportError, revertFuelImport } from "../../../../../lib/fuel-import";

type Context = { params: Promise<{ id: string }> };

// Desfazer importação (só ADMIN): reverte saldo e leituras do lote.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Importação inválida." }, { status: 400 });
  try {
    const result = await revertFuelImport(await getDb(), auth.user!, id);
    return Response.json({ ...result, message: `Importação desfeita: ${result.movements} lançamento(s) removido(s)${result.equipment ? ` e a leitura de ${result.equipment} equipamento(s) restaurada` : ""}.` });
  } catch (error) {
    if (error instanceof FuelImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[fuel.import.revert]", error);
    return Response.json({ error: "Não foi possível desfazer a importação agora." }, { status: 500 });
  }
}
