import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { PersonnelImportError, undoImport } from "../../../../../lib/personnel-import";

export const maxDuration = 300;
type Context = { params: Promise<{ id: string }> };

// Desfazer importação: apaga o que o lote criou e devolve o valor anterior do que ele alterou.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    return Response.json(await undoImport(auth.user!, Number((await params).id)));
  } catch (error) {
    if (error instanceof PersonnelImportError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[personnel-import.undo]", error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "erro");
    return Response.json({ error: "Não foi possível desfazer a importação agora." }, { status: 500 });
  }
}
