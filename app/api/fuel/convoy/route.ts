import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { approveConvoyBatch, CONVOY_LIST_LIMIT, ConvoyError, convoySettings, listConvoyRecords, parseConvoyListFilters } from "../../../../lib/convoy";
import { getDb } from "../../../../db";

// Aba "Aprovação do comboio": lista com as etiquetas (SEM FOTO, leitura menor, salto alto,
// litragem alta, foto diverge), leitura digitada × última leitura e consumo estimado.
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const filters = parseConvoyListFilters(new URL(request.url).searchParams);
    const [records, settings] = await Promise.all([listConvoyRecords(auth.user!, filters), convoySettings(await getDb())]);
    return Response.json({ records, settings, canConfigure: auth.user!.profile === "ADMIN", limit: filters.limit ?? CONVOY_LIST_LIMIT });
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.list]", error);
    return Response.json({ error: "Não foi possível carregar os abastecimentos do comboio." }, { status: 500 });
  }
}

// Aprovar em lote (só itens sem etiqueta de alerta).
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.convoy_approve");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as { action?: string; ids?: unknown };
    if (body.action !== "approve_batch" || !Array.isArray(body.ids)) return Response.json({ error: "Pedido inválido." }, { status: 400 });
    const ids = [...new Set(body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100);
    return Response.json(await approveConvoyBatch(auth.user!, ids));
  } catch (error) {
    if (error instanceof ConvoyError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[convoy.batch]", error);
    return Response.json({ error: "Não foi possível aprovar agora." }, { status: 500 });
  }
}
