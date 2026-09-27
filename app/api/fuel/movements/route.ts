import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { fuelMovements, fuelTypes, serviceFronts } from "../../../../db/schema";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelEquipmentContext, fuelHistory, fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters, readFuelMovementBody, resolveFuelFront } from "../../../../lib/fuel";
import { validateFuelMovement } from "../../../../lib/fuel-rules";

const PAGE_SIZE = 50;

// Aba "Histórico": lançamentos das frentes em exibição (como origem ou como filial destino).
export async function GET(request: Request) {
  const auth = await authorize(request, "fuel.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const params = new URL(request.url).searchParams;
    const filters = parseFuelFilters(params);
    const page = Math.max(1, Number(params.get("page")) || 1);
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    const scope = fuelScopeFronts(fronts.map((front) => front.id), frentesEmExibicao(user, request), filters.frontId);
    const { rows, total } = await fuelHistory(db, scope, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return Response.json({ movements: rows, total, page, pageSize: PAGE_SIZE, filters });
  } catch (error) {
    console.error("[fuel.movements.get]", error);
    return Response.json({ error: "Não foi possível carregar o histórico de combustível agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fuel.register");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const body = (await request.json()) as Record<string, unknown>;
    const input = readFuelMovementBody(body);
    const db = await getDb();
    const fronts = await fuelVisibleFronts(db, user);
    const visibleIds = fronts.map((front) => front.id);
    if (visibleIds.length === 0) return Response.json({ error: "Seu usuário não está vinculado a nenhuma frente de serviço." }, { status: 403 });
    const serviceFrontId = resolveFuelFront(visibleIds, body.serviceFrontId, frentesEmExibicao(user, request), user);
    if (!serviceFrontId) return Response.json({ error: "Escolha a frente de serviço do lançamento." }, { status: 400 });
    // Filial destino pode ser qualquer frente ativa (mesmo uma que a pessoa não enxerga).
    if (input.destinationFrontId && !(await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(eq(serviceFronts.id, input.destinationFrontId), eq(serviceFronts.active, true))).limit(1))[0])
      return Response.json({ error: "Filial destino inválida." }, { status: 400 });
    const fuelType = (await db.select({ id: fuelTypes.id }).from(fuelTypes).where(and(eq(fuelTypes.id, input.fuelTypeId), eq(fuelTypes.active, true))).limit(1))[0];
    if (!fuelType) return Response.json({ error: "Escolha um tipo de combustível válido." }, { status: 400 });
    const equipment = input.equipmentId ? await fuelEquipmentContext(db, input.equipmentId) : null;
    const problem = validateFuelMovement({ ...input, serviceFrontId }, equipment, fuelLocalDay());
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const [created] = await db.insert(fuelMovements).values({
      ...input, serviceFrontId,
      meterUnit: equipment && input.meterReading !== null ? (equipment.controlType === "KM" ? "KM" : "HOURS") : null,
      createdBy: user.id,
    }).returning({ id: fuelMovements.id });
    return Response.json({ id: created.id, message: "Lançamento de combustível registrado." }, { status: 201 });
  } catch (error) {
    console.error("[fuel.movements.post]", error);
    return Response.json({ error: "Não foi possível registrar o lançamento agora." }, { status: 500 });
  }
}
