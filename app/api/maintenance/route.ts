import { getD1, type D1PreparedStatementLike } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { alertMessage, calculatePlanState } from "../../../lib/maintenance-engine";
import { loadEquipmentCore, loadPlansForEquipment, loadThresholds } from "../../../lib/maintenance-data";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { equipmentAccessResponse,requireEquipmentAccess } from "../../../lib/front-scope";

const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const numeric=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"maintenance.create");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const equipmentId=Number(body.equipmentId);
    const selectedIds=Array.isArray(body.planIds)?[...new Set(body.planIds.map(Number).filter((id)=>Number.isInteger(id)&&id>0))]:[];
    if(!Number.isInteger(equipmentId)||equipmentId<=0)return Response.json({error:"Selecione um equipamento válido."},{status:400});
    if(selectedIds.length===0)return Response.json({error:"Selecione pelo menos um item de manutenção."},{status:400});
    const performedRaw=clean(body.performedAt);if(!performedRaw)return Response.json({error:"Informe a data e a hora da manutenção."},{status:400});
    const performedDate=new Date(performedRaw.length===10?`${performedRaw}T12:00:00`:performedRaw);
    if(Number.isNaN(performedDate.getTime()))return Response.json({error:"Informe uma data e hora válidas."},{status:400});
    const performedAt=performedDate.toISOString();const d1=await getD1();const access=await requireEquipmentAccess(d1,auth.user!,equipmentId,"OIL");const equipment=await loadEquipmentCore(d1,equipmentId);
    if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});
    await recalculateMaintenanceCycles(d1,{equipmentId,notify:false});
    const plans=await loadPlansForEquipment(d1,equipmentId);const selected=plans.filter((plan)=>selectedIds.includes(plan.id));
    if(selected.length!==selectedIds.length)return Response.json({error:"Um dos planos selecionados não pertence a este equipamento ou está inativo."},{status:400});
    for(const plan of selected){
      const interval=plan.triggerMode==="KM"?plan.intervalKm:plan.intervalHours;
      if(interval===null||interval<=0)return Response.json({error:`Configure o intervalo de ${plan.maintenanceName} antes de registrar a troca.`},{status:400});
    }
    const existingEvent=await d1.prepare(`SELECT id,plan_id,work_order FROM maintenances WHERE equipment_id=? AND performed_at=? ORDER BY id`)
      .bind(equipmentId,performedAt).all() as {results:Array<{id:number;plan_id:number|null;work_order:string}>};
    const alreadySaved=existingEvent.results.filter((row)=>row.plan_id!==null&&selectedIds.includes(Number(row.plan_id)));
    if(alreadySaved.length===selectedIds.length){
      return Response.json({ok:true,duplicate:true,equipmentId,maintenanceCount:alreadySaved.length,maintenanceIds:alreadySaved.map((row)=>row.id),
        historyIds:alreadySaved.map((row)=>`M-${row.id}`),workOrder:alreadySaved[0]?.work_order??"",message:"Esta troca já estava registrada; nenhum dado foi duplicado."});
    }
    if(alreadySaved.length>0)return Response.json({error:"Parte desta troca já existe no Histórico. Revise os itens selecionados antes de continuar."},{status:409});
    const hours=numeric(body.hours);const km=numeric(body.km);const requiresHours=equipment.control_type!=="KM";const requiresKm=equipment.control_type!=="HOURS";
    if(requiresHours&&(hours===null||hours<0))return Response.json({error:"Informe o horímetro no momento da troca."},{status:400});
    if(requiresKm&&(km===null||km<0))return Response.json({error:"Informe a quilometragem no momento da troca."},{status:400});
    const nextHours=requiresHours?hours!:equipment.current_hours;const nextKm=requiresKm?km!:equipment.current_km;
    const regression=(requiresHours&&nextHours<equipment.current_hours)||(requiresKm&&nextKm<equipment.current_km);
    if(regression){
      if(auth.user!.profile!=="ADMIN")return Response.json({error:"A leitura da manutenção é inferior à leitura atual. Somente o administrador pode autorizar esse registro."},{status:403});
      if(body.authorizeRegression!==true)return Response.json({error:"A leitura é inferior à atual. Confirme a correção administrativa para continuar.",requiresConfirmation:true},{status:409});
    }
    const now=new Date().toISOString();const workOrder=clean(body.workOrder).toUpperCase()||`MAN-${now.slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const notes=clean(body.notes)||null;const mechanic=clean(body.mechanic)||auth.user!.name;const cost=Math.max(0,numeric(body.cost)??0);const thresholds=await loadThresholds(d1);
    const updatedEquipment={...equipment,current_hours:Math.max(equipment.current_hours,nextHours),current_km:Math.max(equipment.current_km,nextKm)};
    const statements:D1PreparedStatementLike[]=[];
    if(updatedEquipment.current_hours!==equipment.current_hours||updatedEquipment.current_km!==equipment.current_km){
      statements.push(d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,updated_at=? WHERE id=?`).bind(updatedEquipment.current_hours,updatedEquipment.current_km,now,equipmentId));
      statements.push(d1.prepare(`INSERT INTO meter_readings (equipment_id,reading_date,hours,km,operator,service_front_id,notes,source,authorized_regression,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(equipmentId,performedAt,requiresHours?nextHours:null,requiresKm?nextKm:null,mechanic,access.serviceFrontId,"Leitura registrada junto com a manutenção","MAINTENANCE",regression?1:0,auth.user!.id,now,now));
    }
    for(const plan of selected){
      const unit=plan.triggerMode==="KM"?"KM":"HOURS";const reading=unit==="KM"?nextKm:nextHours;const interval=unit==="KM"?plan.intervalKm!:plan.intervalHours!;
      const nextValue=reading+interval;const nextPlan={...plan,lastHours:unit==="HOURS"?reading:null,lastKm:unit==="KM"?reading:null,nextHours:unit==="HOURS"?nextValue:null,nextKm:unit==="KM"?nextValue:null};
      const state=calculatePlanState(nextPlan,updatedEquipment.current_hours,updatedEquipment.current_km,thresholds);const fingerprint=`PLAN:${equipmentId}:TYPE:${plan.maintenanceTypeId}`;
      statements.push(d1.prepare(`INSERT INTO maintenances (equipment_id,service_front_id,plan_id,maintenance_type_id,performed_at,hours,km,mechanic,work_order,cost,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(equipmentId,access.serviceFrontId,plan.id,plan.maintenanceTypeId,performedAt,requiresHours?nextHours:null,requiresKm?nextKm:null,mechanic,workOrder,cost,notes,auth.user!.id,now,now));
      statements.push(d1.prepare(`INSERT INTO maintenance_items (maintenance_id,description,item_type,quantity,unit,unit_cost,created_at,updated_at)
        SELECT id,?,'OIL',1,'SERVIÇO',?,?,? FROM maintenances WHERE work_order=? AND maintenance_type_id=?`)
        .bind(plan.maintenanceName,cost,now,now,workOrder,plan.maintenanceTypeId));
      statements.push(d1.prepare(`UPDATE maintenance_plans SET last_hours=?,last_km=?,last_date=?,next_hours=?,next_km=?,updated_at=? WHERE id=?`)
        .bind(nextPlan.lastHours,nextPlan.lastKm,performedAt.slice(0,10),nextPlan.nextHours,nextPlan.nextKm,now,plan.id));
      statements.push(d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,closed_by_maintenance_id=(SELECT id FROM maintenances WHERE work_order=? AND maintenance_type_id=?),updated_at=?
        WHERE equipment_id=? AND plan_id=? AND status<>'CLOSED'`).bind(now,workOrder,plan.maintenanceTypeId,now,equipmentId,plan.id));
      statements.push(d1.prepare(`INSERT INTO alerts
        (equipment_id,plan_id,level,control_type,current_value,planned_value,remaining_value,overdue_value,maintenance_status,status,message,generated_at,fingerprint,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET level=excluded.level,control_type=excluded.control_type,current_value=excluded.current_value,
          planned_value=excluded.planned_value,remaining_value=excluded.remaining_value,overdue_value=excluded.overdue_value,
          maintenance_status=excluded.maintenance_status,status='OPEN',message=excluded.message,generated_at=excluded.generated_at,
          viewed_at=NULL,closed_at=NULL,closed_by_maintenance_id=NULL,updated_at=excluded.updated_at`)
        .bind(equipmentId,plan.id,state.level,state.unit,state.currentValue,state.nextValue!,state.remaining!,state.overdue,state.level,
          alertMessage(equipment.prefix,plan.maintenanceName,state),now,fingerprint,now,now));
    }
    statements.push(d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(auth.user!.id,"EQUIPMENT",String(equipmentId),"TROCA DE ÓLEO",JSON.stringify({hours:equipment.current_hours,km:equipment.current_km}),
        JSON.stringify({hours:nextHours,km:nextKm,planIds:selectedIds,workOrder,performedAt,notes}),now));
    await d1.batch(statements);
    await recalculateMaintenanceCycles(d1,{equipmentId,force:true});
    const inserted=await d1.prepare(`SELECT id FROM maintenances WHERE equipment_id=? AND work_order=? ORDER BY id`).bind(equipmentId,workOrder).all() as {results:Array<{id:number}>};
    return Response.json({ok:true,duplicate:false,equipmentId,maintenanceCount:selected.length,maintenanceIds:inserted.results.map((row)=>row.id),
      historyIds:inserted.results.map((row)=>`M-${row.id}`),workOrder,nextCycles:selected.map((plan)=>({planId:plan.id,name:plan.maintenanceName}))},{status:201});
  }catch(error){
    const accessError=equipmentAccessResponse(error);if(accessError)return accessError;
    console.error("[maintenance.post] Falha ao registrar manutenção",error);
    const message=error instanceof Error?error.message:"";
    if(message.includes("maintenances_equipment_plan_performed_unique"))return Response.json({error:"Esta troca já foi registrada no Histórico. Nenhum lançamento duplicado foi criado."},{status:409});
    if(message.includes("UNIQUE constraint"))return Response.json({error:"Esta OS já possui um dos itens selecionados. Use outra OS ou revise o lançamento."},{status:409});
    return Response.json({error:"A manutenção não foi salva. A transação foi desfeita para evitar dados incompletos."},{status:500});
  }
}
