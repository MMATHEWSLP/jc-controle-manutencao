import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { fuelMovements, fuelTypes, serviceFronts } from "../../../../db/schema";
import { frentesEmExibicao } from "../../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { fuelEquipmentContext, resolveResponsible, fuelHistory, fuelHistorySummary, fuelLocalDay, fuelScopeFronts, fuelVisibleFronts, parseFuelFilters, readFuelMovementBody, readThirdPartyFuelFields, resolveFuelFront } from "../../../../lib/fuel";
import { validateFuelMovement } from "../../../../lib/fuel-rules";
import { isUniqueViolation, readClientRequestId } from "../../../../lib/client-request";
import { consumptionByMovement, prepareThirdPartyFuel, refreshVehicleLastReading, thirdPartyErrorResponse } from "../../../../lib/third-parties";

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
    // Resumo e listagem com o mesmo filtro (o resumo conta todas as páginas).
    const [{ rows, total }, summary] = await Promise.all([fuelHistory(db, scope, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE), fuelHistorySummary(db, scope, filters)]);
    return Response.json({ movements: rows, total, page, pageSize: PAGE_SIZE, filters, summary });
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
    const clientRequestId = readClientRequestId(body.clientRequestId);
    const alreadySent = async () => clientRequestId ? (await (await getDb()).select({ id: fuelMovements.id }).from(fuelMovements).where(eq(fuelMovements.clientRequestId, clientRequestId)).limit(1))[0] ?? null : null;
    const duplicate = (id: number) => Response.json({ id, duplicate: true, message: "Este lançamento já tinha sido registrado." });
    const previous = await alreadySent();
    if (previous) return duplicate(previous.id);
    const parsed = readFuelMovementBody(body);
    let input: typeof parsed;
    try { input = { ...parsed, ...(await resolveResponsible(await getDb(), parsed.responsibleEmployeeId, parsed.responsible)) }; }
    catch { return Response.json({ error: "Funcionário responsável não encontrado." }, { status: 400 }); }
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
    // Saída para terceiro: empresa e veículo vêm do cadastro de Terceiros (com leitura, tanque cheio,
    // capacidade do tanque e consumo conferidos); os textos livres antigos são preenchidos a partir dele.
    let thirdPartyFields: Awaited<ReturnType<typeof prepareThirdPartyFuel>> | null = null;
    if (input.thirdParty) {
      const fields = readThirdPartyFuelFields(body);
      if (!fields.thirdPartyId) return Response.json({ error: "Escolha a empresa/pessoa no cadastro de terceiros." }, { status: 400 });
      thirdPartyFields = await prepareThirdPartyFuel(db, user, {
        ...fields, thirdPartyId: fields.thirdPartyId, mode: input.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "GERAL", quantity: input.quantity,
        movementDate: input.movementDate, notes: input.notes, editingId: null, current: null,
      });
      input = { ...input, providerCompany: thirdPartyFields.providerCompany, providerEquipment: thirdPartyFields.providerEquipment, thirdPartyDescription: thirdPartyFields.thirdPartyDescription };
    }
    const problem = validateFuelMovement({ ...input, serviceFrontId }, equipment, fuelLocalDay());
    if (problem) return Response.json({ error: problem }, { status: 400 });
    let created: { id: number };
    try {
      [created] = await db.insert(fuelMovements).values({
        ...input, serviceFrontId, clientRequestId,
        // Frente ↔ Porto da mesma frente: o destino é a própria frente.
        destinationFrontId: input.movementType === "TRANSFERENCIA" ? input.destinationFrontId ?? serviceFrontId : null,
        meterUnit: equipment && input.meterReading !== null ? (equipment.controlType === "KM" ? "KM" : "HOURS") : null,
        ...(thirdPartyFields ?? {}),
        createdBy: user.id,
      }).returning({ id: fuelMovements.id });
    } catch (error) {
      const again = isUniqueViolation(error) ? await alreadySent() : null;
      if (again) return duplicate(again.id);
      throw error;
    }
    await refreshVehicleLastReading(db, thirdPartyFields?.thirdPartyVehicleId);
    // Resumo para a mensagem de sucesso: quem recebeu, litros e o consumo calculado (mesma conta do Histórico).
    const vehicleId = thirdPartyFields?.thirdPartyVehicleId ?? null;
    const consumption = vehicleId ? (await consumptionByMovement(db, [vehicleId])).get(created.id) ?? null : null;
    const who = thirdPartyFields ? (thirdPartyFields.providerEquipment ?? thirdPartyFields.thirdPartyDescription ?? "terceiro") : equipment?.prefix ?? null;
    const summary = [
      input.movementType === "ENTRADA" ? "Entrada" : input.movementType === "TRANSFERENCIA" ? "Transferência" : "Saída",
      who, `${input.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`,
      vehicleId ? consumption ? `consumo ${consumption.value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${consumption.unit}` : thirdPartyFields?.fullTank === false ? "tanque parcial (consumo no próximo tanque cheio)" : "sem consumo (primeiro tanque cheio do veículo)" : null,
    ].filter(Boolean).join(" · ");
    return Response.json({ id: created.id, consumption, message: `Lançamento registrado: ${summary}${thirdPartyFields?.consumptionOutlier ? " — marcado como fora da média de consumo" : ""}.` }, { status: 201 });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[fuel.movements.post]", error);
    return Response.json({ error: "Não foi possível registrar o lançamento agora." }, { status: 500 });
  }
}
