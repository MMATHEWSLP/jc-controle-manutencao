import type { D1DatabaseLike } from "../db";

// Transferência de equipamento entre frentes — fonte única usada pela tela de transferência
// (app/api/equipment/transfers) e pela aprovação de solicitações de mudança de frente do
// Controle Diário. Grava equipment_transfers (histórico), atualiza a frente e registra auditoria.
type Row = Record<string, unknown>;

export class TransferError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function transferEquipment(d1: D1DatabaseLike, actorId: number, input: { equipmentId: number; newServiceFrontId: number; expectedFrontId: number | null; note: string | null }) {
  const { equipmentId, newServiceFrontId, expectedFrontId, note } = input;
  const [equipment, front] = await Promise.all([
    d1.prepare(`SELECT e.id,e.prefix,e.service_front_id,sf.name AS current_front FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE e.id=?`).bind(equipmentId).first<Row>(),
    d1.prepare(`SELECT id,name FROM service_fronts WHERE id=? AND active=1`).bind(newServiceFrontId).first<Row>(),
  ]);
  if (!equipment) throw new TransferError("Equipamento não encontrado.", 404);
  if (!front) throw new TransferError("A frente de destino não existe ou está inativa.", 400);
  const currentFrontId = equipment.service_front_id == null ? null : Number(equipment.service_front_id);
  const currentFront = equipment.current_front == null ? "Sem frente definida" : String(equipment.current_front);
  if (expectedFrontId !== null && expectedFrontId !== currentFrontId) throw new TransferError("A frente atual do equipamento mudou. Atualize a lista antes de transferir.", 409);
  if (currentFrontId === newServiceFrontId) throw new TransferError(`O equipamento já pertence à frente ${String(front.name)}.`, 409);
  const now = new Date().toISOString(); const transferId = crypto.randomUUID();
  await d1.batch([
    d1.prepare(`INSERT INTO equipment_transfers (id,equipment_id,previous_service_front_id,new_service_front_id,transferred_at,transferred_by,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(transferId, equipmentId, currentFrontId, newServiceFrontId, now, actorId, note, now, now),
    d1.prepare(`UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS NOT DISTINCT FROM ?`).bind(newServiceFrontId, now, equipmentId, currentFrontId),
    d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(actorId, "EQUIPMENT", String(equipmentId), "EQUIPMENT_TRANSFERRED", JSON.stringify({ serviceFrontId: currentFrontId, front: currentFront }), JSON.stringify({ serviceFrontId: newServiceFrontId, front: String(front.name), note }), now),
  ]);
  return {
    message: `${String(equipment.prefix)} transferido de ${currentFront} para ${String(front.name)}.`,
    transfer: { id: transferId, equipmentId, previousServiceFrontId: currentFrontId, newServiceFrontId, previousFront: currentFront, newFront: String(front.name), transferredAt: now, note },
  };
}
