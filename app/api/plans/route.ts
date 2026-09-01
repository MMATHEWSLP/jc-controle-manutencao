import { getD1, type D1PreparedStatementLike } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { alertMessage, calculatePlanState, type PlanTriggerMode } from "../../../lib/maintenance-engine";
import { loadEquipmentCore, loadPlansForEquipment, loadThresholds } from "../../../lib/maintenance-data";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { equipmentAccessResponse,requireEquipmentAccess } from "../../../lib/front-scope";

type InputPlan={maintenanceTypeId?:unknown;triggerMode?:unknown;interval?:unknown;oilType?:unknown;filterReference?:unknown;notes?:unknown};
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"equipment.edit_plan");if(auth.response)return auth.response;
  try{
    const body=await request.json() as {equipmentId?:unknown;plans?:InputPlan[]};const equipmentId=Number(body.equipmentId);
    if(!Number.isInteger(equipmentId)||equipmentId<=0)return Response.json({error:"Equipamento inválido."},{status:400});
    if(!Array.isArray(body.plans)||body.plans.length===0)return Response.json({error:"Informe pelo menos um item do plano."},{status:400});
    const d1=await getD1();await requireEquipmentAccess(d1,auth.user!,equipmentId,"OIL");const equipment=await loadEquipmentCore(d1,equipmentId);if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});
    const applicable=await d1.prepare(`SELECT t.id,t.name FROM equipment_maintenance_types emt INNER JOIN maintenance_types t ON t.id=emt.maintenance_type_id
      WHERE emt.equipment_id=? AND emt.applicable=1 AND t.active=1 AND t.category='OIL'`).bind(equipmentId).all() as {results:Array<{id:number;name:string}>};
    const applicableMap=new Map<number,string>(applicable.results.map((row:{id:number;name:string})=>[Number(row.id),String(row.name)]));
    const existingMap=new Map((await loadPlansForEquipment(d1,equipmentId)).map((plan)=>[plan.maintenanceTypeId,plan]));
    const thresholds=await loadThresholds(d1);const now=new Date().toISOString();const statements:D1PreparedStatementLike[]=[];const seen=new Set<number>();

    for(const raw of body.plans){
      const maintenanceTypeId=Number(raw.maintenanceTypeId);const triggerMode=clean(raw.triggerMode) as PlanTriggerMode;const interval=Number(raw.interval);
      if(!Number.isInteger(maintenanceTypeId)||!applicableMap.has(maintenanceTypeId))return Response.json({error:"Um dos itens não é aplicável a este equipamento."},{status:400});
      if(seen.has(maintenanceTypeId))return Response.json({error:"O mesmo item foi enviado mais de uma vez."},{status:400});seen.add(maintenanceTypeId);
      if(!["HOURS","KM"].includes(triggerMode))return Response.json({error:"Selecione controle por horas ou quilômetros."},{status:400});
      if(triggerMode==="HOURS"&&equipment.control_type==="KM")return Response.json({error:`${equipment.prefix} utiliza somente quilometragem.`},{status:400});
      if(triggerMode==="KM"&&equipment.control_type==="HOURS")return Response.json({error:`${equipment.prefix} utiliza somente horímetro.`},{status:400});
      if(!Number.isFinite(interval)||interval<=0)return Response.json({error:`Informe um intervalo maior que zero para ${applicableMap.get(maintenanceTypeId)}.`},{status:400});
      const existing=existingMap.get(maintenanceTypeId);const unit=triggerMode;
      const lastValue=unit==="KM"?(existing?.triggerMode==="KM"?existing.lastKm:null):(existing?.triggerMode==="HOURS"?existing.lastHours:null);
      const nextValue=lastValue===null?null:lastValue+interval;const intervalHours=unit==="HOURS"?interval:null;const intervalKm=unit==="KM"?interval:null;const lastHours=unit==="HOURS"?lastValue:null;const lastKm=unit==="KM"?lastValue:null;const nextHours=unit==="HOURS"?nextValue:null;const nextKm=unit==="KM"?nextValue:null;
      const state=calculatePlanState({id:existing?.id??0,intervalHours,intervalKm,triggerMode,lastHours,lastKm,nextHours,nextKm},equipment.current_hours,equipment.current_km,thresholds);
      const fingerprint=`PLAN:${equipmentId}:TYPE:${maintenanceTypeId}`;
      statements.push(d1.prepare(`INSERT INTO maintenance_plans
        (equipment_id,maintenance_type_id,interval_hours,interval_km,trigger_mode,last_hours,last_km,last_date,next_hours,next_km,oil_type,filter_reference,notes,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
        ON CONFLICT(equipment_id,maintenance_type_id) DO UPDATE SET interval_hours=excluded.interval_hours,interval_km=excluded.interval_km,
          trigger_mode=excluded.trigger_mode,last_hours=excluded.last_hours,last_km=excluded.last_km,last_date=COALESCE(maintenance_plans.last_date,excluded.last_date),
          next_hours=excluded.next_hours,next_km=excluded.next_km,oil_type=excluded.oil_type,filter_reference=excluded.filter_reference,
          notes=excluded.notes,active=1,updated_at=excluded.updated_at`)
        .bind(equipmentId,maintenanceTypeId,intervalHours,intervalKm,triggerMode,lastHours,lastKm,null,nextHours,nextKm,
          clean(raw.oilType)||null,clean(raw.filterReference)||null,clean(raw.notes)||null,now,now));
      statements.push(d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,updated_at=? WHERE equipment_id=?
        AND plan_id=(SELECT id FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=?) AND fingerprint<>? AND status<>'CLOSED'`)
        .bind(now,now,equipmentId,equipmentId,maintenanceTypeId,fingerprint));
      if(state.configured){
        statements.push(d1.prepare(`INSERT INTO alerts
          (equipment_id,plan_id,level,control_type,current_value,planned_value,remaining_value,overdue_value,maintenance_status,status,message,generated_at,fingerprint,created_at,updated_at)
          SELECT ?,id,?,?,?,?,?,?,?,'OPEN',?,?,?,?,? FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=?
          ON CONFLICT(fingerprint) DO UPDATE SET level=excluded.level,control_type=excluded.control_type,current_value=excluded.current_value,
            planned_value=excluded.planned_value,remaining_value=excluded.remaining_value,overdue_value=excluded.overdue_value,
            maintenance_status=excluded.maintenance_status,status='OPEN',message=excluded.message,generated_at=excluded.generated_at,
            viewed_at=NULL,closed_at=NULL,closed_by_maintenance_id=NULL,updated_at=excluded.updated_at`)
          .bind(equipmentId,state.level,state.unit,state.currentValue,state.nextValue!,state.remaining!,state.overdue,state.level,alertMessage(equipment.prefix,applicableMap.get(maintenanceTypeId)!,state),now,fingerprint,now,now,equipmentId,maintenanceTypeId));
      }
    }
    statements.push(d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(auth.user!.id,"EQUIPMENT",String(equipmentId),"ALTERAÇÃO DE PLANO",JSON.stringify([...existingMap.values()]),JSON.stringify(body.plans),now));
    await d1.batch(statements);
    await recalculateMaintenanceCycles(d1,{equipmentId,force:true});
    return Response.json({ok:true,equipmentId,itemsSaved:seen.size});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[plans.put] Falha ao salvar plano",error);
    return Response.json({error:"O plano não foi salvo. Nenhuma alteração incompleta foi mantida; tente novamente."},{status:500});
  }
}
