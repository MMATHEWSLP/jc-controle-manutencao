import { eq } from "drizzle-orm";
import { getD1, getDb } from "../../../../../db";
import { auditLogs, equipment } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { equipmentAccessResponse, requireEquipmentAccess } from "../../../../../lib/front-scope";

// Marcar/desmarcar equipamento como vendido. Vendido sai da frota ativa (listas operacionais), mas
// nada é apagado: manutenções, trocas de óleo, movimentações, O.S. etc. continuam no histórico, e a
// marcação pode ser desfeita (DELETE) se tiver sido um engano.
type Context = { params: Promise<{ id: string }> };

const isIsoDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

async function prepare(request: Request, context: Context) {
  if (!assertSameOrigin(request)) return { response: Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 }) };
  const auth = await authorize(request, "equipment.edit");
  if (auth.response) return { response: auth.response };
  const equipmentId = Number((await context.params).id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) return { response: Response.json({ error: "Equipamento inválido." }, { status: 400 }) };
  await requireEquipmentAccess(await getD1(), auth.user!, equipmentId, "MANAGEMENT");
  const db = await getDb();
  const row = (await db.select({ id: equipment.id, prefix: equipment.prefix, soldAt: equipment.soldAt, soldNotes: equipment.soldNotes }).from(equipment).where(eq(equipment.id, equipmentId)).limit(1))[0];
  if (!row) return { response: Response.json({ error: "Equipamento não encontrado." }, { status: 404 }) };
  return { user: auth.user!, db, row };
}

export async function POST(request: Request, context: Context) {
  try {
    const ready = await prepare(request, context);
    if (ready.response) return ready.response;
    const { user, db, row } = ready;
    if (row.soldAt) return Response.json({ error: `${row.prefix} já está marcado como vendido.` }, { status: 409 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const soldAt = typeof body.soldAt === "string" && body.soldAt.trim() ? body.soldAt.trim() : new Date().toISOString().slice(0, 10);
    if (!isIsoDay(soldAt)) return Response.json({ error: "Informe uma data de venda válida." }, { status: 400 });
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(equipment).set({ soldAt, soldBy: user.id, soldNotes: notes, updatedAt: now }).where(eq(equipment.id, row.id));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "EQUIPMENT", entityId: String(row.id), action: "MARCADO COMO VENDIDO",
        previousValue: null, newValue: JSON.stringify({ soldAt, notes }), occurredAt: now });
    });
    return Response.json({ message: `${row.prefix} marcado como vendido. O histórico foi preservado.` });
  } catch (error) {
    const access = equipmentAccessResponse(error); if (access) return access;
    console.error("[equipment.sold.post]", error);
    return Response.json({ error: "Não foi possível marcar o equipamento como vendido agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const ready = await prepare(request, context);
    if (ready.response) return ready.response;
    const { user, db, row } = ready;
    if (!row.soldAt) return Response.json({ error: `${row.prefix} não está marcado como vendido.` }, { status: 409 });
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.update(equipment).set({ soldAt: null, soldBy: null, soldNotes: null, updatedAt: now }).where(eq(equipment.id, row.id));
      await tx.insert(auditLogs).values({ userId: user.id, entityType: "EQUIPMENT", entityId: String(row.id), action: "VENDA DESFEITA",
        previousValue: JSON.stringify({ soldAt: row.soldAt, notes: row.soldNotes }), newValue: null, occurredAt: now });
    });
    return Response.json({ message: `${row.prefix} voltou para a frota ativa.` });
  } catch (error) {
    const access = equipmentAccessResponse(error); if (access) return access;
    console.error("[equipment.sold.delete]", error);
    return Response.json({ error: "Não foi possível desfazer a venda agora." }, { status: 500 });
  }
}
