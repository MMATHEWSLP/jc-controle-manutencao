import { getDb } from "../../../db";
import { frentesVisiveis } from "../../../lib/access";
import { frentesEmExibicao } from "../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { createStockExit, listStockExits, parseStockExit } from "../../../lib/stock-exits";
import { stockErrorResponse } from "../../../lib/stock";
import { listStockMovements } from "../../../lib/stock-history";
import { isIsoDay } from "../../../lib/stock-options";

const positive = (value: string | null) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; };

// Histórico da Movimentação: saídas de estoque (Movimentação e peças de O.S. fechadas) com filtros
// por veículo, funcionário, departamento, produto e período.
export async function GET(request: Request) {
  const auth = await authorize(request, "stock.exits_view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const from = url.searchParams.get("de"); const to = url.searchParams.get("ate");
    const filters = {
      equipmentId: positive(url.searchParams.get("equipamento")), employeeId: positive(url.searchParams.get("funcionario")),
      departmentId: positive(url.searchParams.get("departamento")),
      thirdPartyId: positive(url.searchParams.get("terceiro")), thirdPartyVehicleId: positive(url.searchParams.get("veiculoTerceiro")),
      productId: positive(url.searchParams.get("produto")), from: isIsoDay(from) ? from : null, to: isIsoDay(to) ? to : null,
    };
    if (filters.from && filters.to && filters.from > filters.to) return Response.json({ error: "O período inicial não pode ser depois do final." }, { status: 400 });
    const db = await getDb();
    const visible = frentesVisiveis(user);
    const displayed = frentesEmExibicao(user, request);
    const fronts = displayed === "ALL" ? visible : displayed;
    const [movements, exits] = await Promise.all([
      listStockMovements(db, { ...filters, fronts, sources: ["STOCK_EXIT", "WORK_ORDER"], exitsOnly: true, closedWorkOrdersOnly: true, limit: 1000 }),
      listStockExits(db, user, { ...filters, limit: 100 }),
    ]);
    return Response.json({
      movements, exits, canCreate: user.permissions.includes("stock.exits_create"), canCancel: user.permissions.includes("stock.exits_cancel"),
    });
  } catch (error) {
    console.error("[stock-exits.get]", error);
    return Response.json({ error: "Não foi possível carregar a movimentação." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "stock.exits_create");
  if (auth.response) return auth.response;
  try {
    const input = parseStockExit(await request.json() as Record<string, unknown>);
    const created = await createStockExit(await getDb(), auth.user!, input);
    return Response.json({ ...created, message: `Saída ${created.number} lançada e estoque atualizado.` }, { status: 201 });
  } catch (error) {
    const stock = stockErrorResponse(error); if (stock) return stock;
    console.error("[stock-exits.post]", error);
    return Response.json({ error: "Não foi possível lançar a saída agora." }, { status: 500 });
  }
}
