import { getD1 } from "../../../../db";
import { getSessionUser } from "../../../../lib/auth";
import { loadHistoryEntries } from "../../../../lib/history-data";
import { calculatePlanState, levelPriority, type ControlType, type PlanTriggerMode } from "../../../../lib/maintenance-engine";
import { loadThresholds } from "../../../../lib/maintenance-data";
import { recalculateMaintenanceCycles } from "../../../../lib/maintenance-recalculation";
import { equipmentAccessResponse,requireEquipmentAccess } from "../../../../lib/front-scope";

type Row=Record<string,unknown>;
type Context={params:Promise<{token:string}>};

const numberOrNull=(value:unknown)=>value===null||value===undefined||value===""?null:Number(value);

export async function GET(request:Request,{params}:Context){
  try{
    const {token}=await params;
    if(!/^[a-zA-Z0-9-]{16,64}$/.test(token))return Response.json({error:"QR Code inválido."},{status:400});
    const d1=await getD1();
    const equipment=await d1.prepare(`SELECT id,prefix,type,brand,model,current_hours,current_km,control_type,status,updated_at
      FROM equipment WHERE qr_token=? LIMIT 1`).bind(token).first<Row>();
    if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});

    const equipmentId=Number(equipment.id);const user=await getSessionUser(request).catch(()=>null);if(user)await requireEquipmentAccess(d1,user,equipmentId,"OIL");
    await recalculateMaintenanceCycles(d1,{equipmentId,notify:false});
    const [planResult,thresholds,history]=await Promise.all([
      d1.prepare(`SELECT p.id,p.maintenance_type_id,t.name,t.category,p.interval_hours,p.interval_km,p.trigger_mode,
        p.last_hours,p.last_km,p.last_date,p.next_hours,p.next_km
        FROM maintenance_plans p INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
        WHERE p.equipment_id=? AND p.active=1 ORDER BY t.name`).bind(equipmentId).all<Row>(),
      loadThresholds(d1),
      loadHistoryEntries(d1),
    ]);

    const currentHours=Number(equipment.current_hours);const currentKm=Number(equipment.current_km);
    const plans=planResult.results.map((row)=>{
      const calculable={
        id:Number(row.id),intervalHours:numberOrNull(row.interval_hours),intervalKm:numberOrNull(row.interval_km),
        triggerMode:String(row.trigger_mode) as PlanTriggerMode,lastHours:numberOrNull(row.last_hours),lastKm:numberOrNull(row.last_km),
        nextHours:numberOrNull(row.next_hours),nextKm:numberOrNull(row.next_km),
      };
      return {id:calculable.id,maintenanceTypeId:Number(row.maintenance_type_id),name:String(row.name),category:String(row.category),
        lastDate:row.last_date===null?null:String(row.last_date),state:calculatePlanState(calculable,currentHours,currentKm,thresholds)};
    });
    const configured=plans.filter((plan)=>plan.state.configured);
    const worst=[...configured].sort((a,b)=>levelPriority(a.state.level)-levelPriority(b.state.level)||((a.state.health??100)-(b.state.health??100)))[0];
    const equipmentHistory=history
      .filter((item)=>item.equipmentId===equipmentId&&(item.kind==="MAINTENANCE"||item.kind==="IMPORTED"))
      .sort((a,b)=>new Date(b.date).getTime()-new Date(a.date).getTime())
      .slice(0,100)
      .map((item)=>({id:item.id,date:item.date,service:item.service,reading:item.newReading,unit:item.unit,responsible:item.responsible,workOrder:item.workOrder,kind:item.kind}));
    const control=String(equipment.control_type) as ControlType;
    return Response.json({
      generatedAt:new Date().toISOString(),
      equipment:{id:equipmentId,prefix:String(equipment.prefix),type:String(equipment.type),brand:String(equipment.brand),model:String(equipment.model),
        category:String(equipment.prefix).split("-")[0].toUpperCase(),control,currentHours,currentKm,updatedAt:String(equipment.updated_at),
        situation:worst?.state.label??"Sem histórico",tone:worst?.state.tone??"gray"},
      plans,history:equipmentHistory,
      viewer:{authenticated:Boolean(user),name:user?.name??null,canUpdateReading:Boolean(user?.permissions.includes("meter.create")),
        canRegisterMaintenance:Boolean(user?.permissions.includes("maintenance.create")),isAdmin:user?.profile==="ADMIN"},
    },{headers:{"Cache-Control":"no-store, private"}});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[qr.get] Falha ao carregar equipamento pelo QR Code",error);
    return Response.json({error:"Não foi possível consultar este equipamento agora."},{status:500});
  }
}
