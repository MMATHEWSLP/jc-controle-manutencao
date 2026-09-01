import { alertMessage, calculatePlanState, type AlertThresholds, type CalculablePlan, type ControlType, type PlanTriggerMode } from "./maintenance-engine";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../db";

export type EquipmentCore = {
  id:number;prefix:string;current_hours:number;current_km:number;control_type:ControlType;
};

export type PlanCore = CalculablePlan & {
  equipmentId:number;
  maintenanceTypeId:number;
  maintenanceName:string;
  active:number;
};

const defaultThresholds:AlertThresholds={
  alertaHorasAmareloFim:100,
  alertaHorasLaranjaFim:50,
  alertaKmAmareloFim:2000,
  alertaKmLaranjaFim:1000,
  urgencyPercent:20,
};

function numberOrNull(value:unknown) {
  if(value===null||value===undefined||value==="")return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:null;
}

export async function loadThresholds(d1:D1DatabaseLike):Promise<AlertThresholds> {
  const row=await d1.prepare(`SELECT
    alerta_horas_amarelo_fim AS alertaHorasAmareloFim,
    alerta_horas_laranja_fim AS alertaHorasLaranjaFim,
    alerta_km_amarelo_fim AS alertaKmAmareloFim,
    alerta_km_laranja_fim AS alertaKmLaranjaFim,
    urgency_percent AS urgencyPercent
    FROM system_settings WHERE id=1`).first<Record<string,unknown>>();
  if(!row)return defaultThresholds;
  return {
    alertaHorasAmareloFim:Number(row.alertaHorasAmareloFim??defaultThresholds.alertaHorasAmareloFim),
    alertaHorasLaranjaFim:Number(row.alertaHorasLaranjaFim??defaultThresholds.alertaHorasLaranjaFim),
    alertaKmAmareloFim:Number(row.alertaKmAmareloFim??defaultThresholds.alertaKmAmareloFim),
    alertaKmLaranjaFim:Number(row.alertaKmLaranjaFim??defaultThresholds.alertaKmLaranjaFim),
    urgencyPercent:Number(row.urgencyPercent??defaultThresholds.urgencyPercent),
  };
}

export async function loadEquipmentCore(d1:D1DatabaseLike,equipmentId:number) {
  const row=await d1.prepare(`SELECT id,prefix,current_hours,current_km,control_type FROM equipment WHERE id=?`).bind(equipmentId).first<EquipmentCore>();
  return row??null;
}

export async function loadPlansForEquipment(d1:D1DatabaseLike,equipmentId:number):Promise<PlanCore[]> {
  const result=await d1.prepare(`SELECT
    p.id,p.equipment_id AS equipmentId,p.maintenance_type_id AS maintenanceTypeId,
    t.name AS maintenanceName,p.interval_hours AS intervalHours,p.interval_km AS intervalKm,
    p.trigger_mode AS triggerMode,p.last_hours AS lastHours,p.last_km AS lastKm,
    p.next_hours AS nextHours,p.next_km AS nextKm,p.active
    FROM maintenance_plans p
    INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
    WHERE p.equipment_id=? AND p.active=1`).bind(equipmentId).all<Record<string,unknown>>();
  return result.results.map((row:Record<string,unknown>)=>({
    id:Number(row.id),equipmentId:Number(row.equipmentId),maintenanceTypeId:Number(row.maintenanceTypeId),maintenanceName:String(row.maintenanceName),
    intervalHours:numberOrNull(row.intervalHours),intervalKm:numberOrNull(row.intervalKm),triggerMode:String(row.triggerMode) as PlanTriggerMode,
    lastHours:numberOrNull(row.lastHours),lastKm:numberOrNull(row.lastKm),nextHours:numberOrNull(row.nextHours),nextKm:numberOrNull(row.nextKm),active:Number(row.active),
  }));
}

export function buildAlertStatements(
  d1:D1DatabaseLike,
  equipment:EquipmentCore,
  plans:PlanCore[],
  thresholds:AlertThresholds,
  now:string,
) {
  const statements:D1PreparedStatementLike[]=[];
  for(const plan of plans){
    const fingerprint=`PLAN:${equipment.id}:${plan.id}`;
    const state=calculatePlanState(plan,equipment.current_hours,equipment.current_km,thresholds);
    statements.push(d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,updated_at=?
      WHERE equipment_id=? AND plan_id=? AND fingerprint<>? AND status<>'CLOSED'`).bind(now,now,equipment.id,plan.id,fingerprint));
    if(!state.configured||state.remaining===null||state.nextValue===null){
      statements.push(d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,updated_at=? WHERE fingerprint=? AND status<>'CLOSED'`).bind(now,now,fingerprint));
      continue;
    }
    statements.push(d1.prepare(`INSERT INTO alerts
      (equipment_id,plan_id,level,control_type,current_value,planned_value,remaining_value,overdue_value,maintenance_status,status,message,generated_at,fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        level=excluded.level,control_type=excluded.control_type,current_value=excluded.current_value,
        planned_value=excluded.planned_value,remaining_value=excluded.remaining_value,overdue_value=excluded.overdue_value,
        maintenance_status=excluded.maintenance_status,status='OPEN',message=excluded.message,generated_at=excluded.generated_at,
        viewed_at=NULL,closed_at=NULL,closed_by_maintenance_id=NULL,updated_at=excluded.updated_at`)
      .bind(equipment.id,plan.id,state.level,state.unit,state.currentValue,state.nextValue,state.remaining,state.overdue,state.level,
        alertMessage(equipment.prefix,plan.maintenanceName,state),now,fingerprint,now,now));
  }
  return statements;
}
