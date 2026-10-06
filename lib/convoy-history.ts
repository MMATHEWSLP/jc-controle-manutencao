import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { getDb } from "../db";
import { convoyFuelRecords, equipment, users } from "../db/schema";

// Saídas aprovadas do comboio no Histórico do Combustível: foto (ícone de câmera), comboio, quem
// registrou e quem aprovou. Módulo separado de lib/convoy.ts para lib/fuel.ts não depender dele.
type Db = Awaited<ReturnType<typeof getDb>>;
const registrar = alias(users, "history_convoy_registrar");
const approver = alias(users, "history_convoy_approver");
const convoyEquipment = alias(equipment, "history_convoy_equipment");

export async function convoyInfoForMovements(db: Db, movementIds: number[]) {
  if (!movementIds.length) return new Map<number, { recordId: number; convoy: string | null; registeredBy: string | null; approvedBy: string | null; hasMeterPhoto: boolean; hasPumpPhoto: boolean; noPhoto: boolean }>();
  const rows = await db.select({
    movementId: convoyFuelRecords.fuelMovementId, recordId: convoyFuelRecords.id, convoy: convoyEquipment.prefix, registeredBy: registrar.name, approvedBy: approver.name,
    meter: convoyFuelRecords.meterPhotoKey, pump: convoyFuelRecords.pumpPhotoKey, noPhoto: convoyFuelRecords.noPhoto,
  }).from(convoyFuelRecords)
    .leftJoin(convoyEquipment, eq(convoyEquipment.id, convoyFuelRecords.convoyEquipmentId))
    .leftJoin(registrar, eq(registrar.id, convoyFuelRecords.registeredBy))
    .leftJoin(approver, eq(approver.id, convoyFuelRecords.approvedBy))
    .where(and(isNotNull(convoyFuelRecords.fuelMovementId), inArray(convoyFuelRecords.fuelMovementId, movementIds)))
    // Antes da migração 0051 a tabela não existe: o Histórico segue sem os dados do comboio.
    .catch(() => []);
  return new Map(rows.map((row) => [row.movementId!, { recordId: row.recordId, convoy: row.convoy, registeredBy: row.registeredBy, approvedBy: row.approvedBy, hasMeterPhoto: Boolean(row.meter), hasPumpPhoto: Boolean(row.pump), noPhoto: row.noPhoto }]));
}

