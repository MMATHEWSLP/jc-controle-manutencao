import { getDb } from "../../../../../db";
import { frentesVisiveis } from "../../../../../lib/access";
import { authorize } from "../../../../../lib/auth";
import { listStockMovements } from "../../../../../lib/stock-history";

type Context = { params: Promise<{ id: string }> };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Aba Histórico do produto: todas as entradas e saídas dele nas frentes que a pessoa enxerga, com o
// número do lançamento de origem (PED-/SAI-/OS-/SOL- ou ajuste).
export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const productId = Number((await params).id);
  if (!Number.isInteger(productId) || productId <= 0) return Response.json({ error: "Produto inválido." }, { status: 400 });
  try {
    const url = new URL(request.url);
    const from = url.searchParams.get("de"); const to = url.searchParams.get("ate");
    const rows = await listStockMovements(await getDb(), {
      productId, fronts: frentesVisiveis(auth.user!), limit: 1000,
      from: from && DATE.test(from) ? from : null, to: to && DATE.test(to) ? to : null,
    });
    return Response.json({ movements: rows });
  } catch (error) {
    console.error("[products.movements]", error);
    return Response.json({ error: "Não foi possível carregar o histórico do produto." }, { status: 500 });
  }
}
