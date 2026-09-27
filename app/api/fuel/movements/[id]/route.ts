import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { auditLogs, fuelMovements, fuelTypes, serviceFronts } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { fuelEquipmentContext, resolveResponsible, fuelLocalDay, fuelVisibleFronts, readFuelMovementBody } from "../../../../../lib/fuel";
import { validateFuelMovement } from "../../../../../lib/fuel-rules";

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
    const problem = validateFuelMovement({ ...input, serviceFrontId: requestedFront }, equipment, fuelLocalDay());
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const now = new Date().toISOString();
    const next = { ...input, serviceFrontId: requestedFront, destinationFrontId: input.movementType === "TRANSFERENCIA" ? input.destinationFrontId ?? requestedFront : null, meterUnit: equipment && input.meterReading !== null ? (equipment.controlType === "KM" ? "KM" as const : "HOURS" as const) : null, updatedAt: now };
    await db.update(fuelMovements).set(next).where(eq(fuelMovements.id, current.id));
    await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_MOVEMENT", entityId: String(current.id), action: "LANÇAMENTO DE COMBUSTÍVEL EDITADO", previousValue: JSON.stringify(current), newValue: JSON.stringify(next) });
    return Response.json({ message: "Lançamento atualizado." });
  } catch (error) {
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
    await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_MOVEMENT", entityId: String(current.id), action: "LANÇAMENTO DE COMBUSTÍVEL EXCLUÍDO", previousValue: JSON.stringify(current) });
    return Response.json({ message: "Lançamento excluído." });
  } catch (error) {
    console.error("[fuel.movements.delete]", error);
    return Response.json({ error: "Não foi possível excluir o lançamento agora." }, { status: 500 });
  }
}
