import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { auditLogs, fuelMovements, fuelTypes, serviceFronts } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { fuelEquipmentContext, resolveResponsible, fuelLocalDay, fuelVisibleFronts, readFuelMovementBody, readThirdPartyFuelFields } from "../../../../../lib/fuel";
import { validateFuelMovement } from "../../../../../lib/fuel-rules";
import { prepareThirdPartyFuel, refreshVehicleLastReading, thirdPartyErrorResponse } from "../../../../../lib/third-parties";

type Context = { params: Promise<{ id: string }> };

async function loadEditable(request: Request, params: Context["params"]) {
  const auth = await authorize(request, "fuel.manage");
  if (auth.response) return { response: auth.response } as const;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return { response: Response.json({ error: "Lançamento inválido." }, { status: 400 }) } as const;
  const db = await getDb();
  const current = (await db.select().from(fuelMovements).where(and(eq(fuelMovements.id, id), isNull(fuelMovements.deletedAt))).limit(1))[0];
  if (!current) return { response: Response.json({ error: "Lançamento não encontrado." }, { status: 404 }) } as const;
  const visibleIds = (await fuelVisibleFronts(db, auth.user!)).map((front) => front.id);
  if (!visibleIds.includes(current.serviceFrontId)) return { response: Response.json({ error: "Você não tem acesso à frente deste lançamento." }, { status: 403 }) } as const;
  return { db, user: auth.user!, current, visibleIds } as const;
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const loaded = await loadEditable(request, params);
  if ("response" in loaded) return loaded.response;
  const { db, user, current, visibleIds } = loaded;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = readFuelMovementBody(body);
    let input: typeof parsed;
    try { input = { ...parsed, ...(await resolveResponsible(await getDb(), parsed.responsibleEmployeeId, parsed.responsible)) }; }
    catch { return Response.json({ error: "Funcionário responsável não encontrado." }, { status: 400 }); }
    const requestedFront = Number(body.serviceFrontId) || current.serviceFrontId;
    if (!visibleIds.includes(requestedFront)) return Response.json({ error: "Você não tem acesso à frente escolhida." }, { status: 403 });
    const fuelType = (await db.select({ id: fuelTypes.id }).from(fuelTypes).where(eq(fuelTypes.id, input.fuelTypeId)).limit(1))[0];
    if (!fuelType) return Response.json({ error: "Escolha um tipo de combustível válido." }, { status: 400 });
    if (input.destinationFrontId && !(await db.select({ id: serviceFronts.id }).from(serviceFronts).where(eq(serviceFronts.id, input.destinationFrontId)).limit(1))[0])
      return Response.json({ error: "Filial destino inválida." }, { status: 400 });
    const equipment = input.equipmentId ? await fuelEquipmentContext(db, input.equipmentId) : null;
    // Lançamento da carga de histórico: correção sem os campos obrigatórios dos lançamentos novos.
    const historical = current.importSource !== null;
    // Saída para terceiro do cadastro. Lançamento antigo (só texto livre, sem terceiro do cadastro)
    // continua editável como era, enquanto ninguém escolhe um terceiro para ele.
    const fields = readThirdPartyFuelFields(body);
    let thirdPartyFields: Awaited<ReturnType<typeof prepareThirdPartyFuel>> | null = null;
    if (input.thirdParty && (fields.thirdPartyId || current.thirdPartyId)) {
      if (!fields.thirdPartyId) return Response.json({ error: "Escolha a empresa/pessoa no cadastro de terceiros." }, { status: 400 });
      thirdPartyFields = await prepareThirdPartyFuel(db, user, {
        ...fields, thirdPartyId: fields.thirdPartyId, mode: input.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "GERAL", quantity: input.quantity,
        movementDate: input.movementDate, notes: input.notes, editingId: current.id, current,
      });
      input = { ...input, providerCompany: thirdPartyFields.providerCompany, providerEquipment: thirdPartyFields.providerEquipment, thirdPartyDescription: thirdPartyFields.thirdPartyDescription };
    }
    const problem = validateFuelMovement({ ...input, serviceFrontId: requestedFront }, equipment, fuelLocalDay(), { historical });
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const now = new Date().toISOString();
    // Origem conferida: marcada no formulário, ou implícita quando a pessoa muda Frente/Porto.
    const originConfirmed = historical && typeof body.originConfirmed === "boolean" ? body.originConfirmed || input.stockLocation !== current.stockLocation : current.originConfirmed;
    // Veículo pendente sai quando o veículo é informado (ou o lançamento deixa de ser saída da frota).
    const vehiclePending = current.vehiclePending && input.movementType === "SAIDA" && !input.thirdParty && !input.equipmentId;
    const next = {
      ...input, serviceFrontId: requestedFront, destinationFrontId: input.movementType === "TRANSFERENCIA" ? input.destinationFrontId ?? requestedFront : null, meterUnit: equipment && input.meterReading !== null ? (equipment.controlType === "KM" ? "KM" as const : "HOURS" as const) : null, originConfirmed, vehiclePending,
      thirdPartyId: null, thirdPartyVehicleId: null, fullTank: true, consumptionOutlier: false, readingException: false,
      ...(thirdPartyFields ?? {}), updatedAt: now,
    };
    await db.update(fuelMovements).set(next).where(eq(fuelMovements.id, current.id));
    await refreshVehicleLastReading(db, current.thirdPartyVehicleId);
    if (next.thirdPartyVehicleId !== current.thirdPartyVehicleId) await refreshVehicleLastReading(db, next.thirdPartyVehicleId);
    await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_MOVEMENT", entityId: String(current.id), action: "LANÇAMENTO DE COMBUSTÍVEL EDITADO", previousValue: JSON.stringify(current), newValue: JSON.stringify(next) });
    return Response.json({ message: "Lançamento atualizado." });
  } catch (error) {
    const known = thirdPartyErrorResponse(error); if (known) return known;
    console.error("[fuel.movements.put]", error);
    return Response.json({ error: "Não foi possível atualizar o lançamento agora." }, { status: 500 });
  }
}

// Exclusão lógica: o lançamento some do saldo e do histórico, mas continua no banco para auditoria.
export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const loaded = await loadEditable(request, params);
  if ("response" in loaded) return loaded.response;
  const { db, user, current } = loaded;
  try {
    const now = new Date().toISOString();
    await db.update(fuelMovements).set({ deletedAt: now, deletedBy: user.id, updatedAt: now }).where(eq(fuelMovements.id, current.id));
    await refreshVehicleLastReading(db, current.thirdPartyVehicleId);
    await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_MOVEMENT", entityId: String(current.id), action: "LANÇAMENTO DE COMBUSTÍVEL EXCLUÍDO", previousValue: JSON.stringify(current) });
    return Response.json({ message: "Lançamento excluído." });
  } catch (error) {
    console.error("[fuel.movements.delete]", error);
    return Response.json({ error: "Não foi possível excluir o lançamento agora." }, { status: 500 });
  }
}
