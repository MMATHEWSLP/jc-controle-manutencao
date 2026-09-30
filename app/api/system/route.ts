import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { calculatePlanState, levelPriority, summarizeEquipmentHealth, type ControlType, type PlanTriggerMode } from "../../../lib/maintenance-engine";
import { loadThresholds } from "../../../lib/maintenance-data";
import { loadHistoryEntries } from "../../../lib/history-data";
import { recalculateMaintenanceIfStale } from "../../../lib/maintenance-recalculation";
import { allowedEquipmentIds,isAdministrator } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
const n=(value:unknown)=>value===null||value===undefined?null:Number(value);
const text=(value:unknown)=>value===null||value===undefined?null:String(value);

function formatReading(hours:number,km:number,control:ControlType){
  if(control==="KM")return `${km.toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;
  if(control==="HOURS_KM")return `${hours.toLocaleString("pt-BR",{maximumFractionDigits:1})} h · ${km.toLocaleString("pt-BR",{maximumFractionDigits:1})} km`;
  return `${hours.toLocaleString("pt-BR",{maximumFractionDigits:1})} h`;
}

export async function GET(request:Request){
  const auth=await authorize(request);if(auth.response)return auth.response;
  try{
    const d1=await getD1();
    await recalculateMaintenanceIfStale(d1);
    const [equipmentResult,applicableResult,typeResult,planResult,readingResult,rawHistory,thresholds,allowedIds]=await Promise.all([
      d1.prepare(`SELECT e.id,e.code,e.prefix,e.type,e.brand,e.model,e.year,e.serial_number,e.chassis,e.identification_type,e.plate,e.qr_token,e.photo_key,
        e.service_front_id,e.oil_change_enabled,e.current_hours,e.current_km,e.control_type,e.status,e.notes,e.equipment_model_id,e.created_at,e.updated_at,sf.name AS front,
        (SELECT MAX(r.reading_date) FROM meter_readings r WHERE r.equipment_id=e.id) AS last_reading_date
        FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE e.oil_change_enabled=1 AND e.sold_at IS NULL ORDER BY e.sort_key`).all() as Promise<{results:Row[]}>,
      d1.prepare(`SELECT emt.equipment_id,t.id AS type_id,t.name,t.category FROM equipment_maintenance_types emt
        INNER JOIN maintenance_types t ON t.id=emt.maintenance_type_id WHERE emt.applicable=1 AND t.active=1 AND t.category='OIL' ORDER BY t.name`).all() as Promise<{results:Row[]}>,
      d1.prepare(`SELECT id,name,category FROM maintenance_types WHERE active=1 AND category='OIL' ORDER BY name`).all() as Promise<{results:Row[]}>,
      d1.prepare(`SELECT p.*,t.name AS maintenance_name,t.category AS maintenance_category FROM maintenance_plans p
        INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id WHERE p.active=1 ORDER BY t.name`).all() as Promise<{results:Row[]}>,
      // Uso médio por dia de cada equipamento: primeira e última leitura do último ano (por unidade),
      // calculado no banco — antes vinha das 1.000 leituras mais recentes da frota inteira.
      d1.prepare(`SELECT equipment_id,unit,first_date,first_value,last_date,last_value FROM (
          SELECT equipment_id,unit,reading_date,value,
            first_value(reading_date) OVER w AS first_date,first_value(value) OVER w AS first_value,
            last_value(reading_date) OVER w AS last_date,last_value(value) OVER w AS last_value,
            row_number() OVER (PARTITION BY equipment_id,unit ORDER BY reading_date,id) AS position,count(*) OVER (PARTITION BY equipment_id,unit) AS total
          FROM (SELECT id,equipment_id,reading_date,'HOURS' AS unit,hours AS value FROM meter_readings WHERE hours IS NOT NULL
                UNION ALL SELECT id,equipment_id,reading_date,'KM',km FROM meter_readings WHERE km IS NOT NULL) r
          WHERE reading_date>=to_char(now()-interval '365 days','YYYY-MM-DD')
          WINDOW w AS (PARTITION BY equipment_id,unit ORDER BY reading_date,id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
        ) x WHERE position=1 AND total>=2`).all() as Promise<{results:Row[]}>,
      loadHistoryEntries(d1),
      loadThresholds(d1),
      allowedEquipmentIds(d1,auth.user!,"OIL"),
    ]);
    const history=rawHistory.filter((item)=>item.equipmentId!==null?allowedIds.has(item.equipmentId):isAdministrator(auth.user!));

    const applicableMap=new Map<number,Array<{id:number;name:string;category:string}>>();
    for(const row of applicableResult.results){
      const equipmentId=Number(row.equipment_id);const list=applicableMap.get(equipmentId)??[];
      list.push({id:Number(row.type_id),name:String(row.name),category:String(row.category)});applicableMap.set(equipmentId,list);
    }
    const rawPlanMap=new Map<number,Row[]>();
    for(const row of planResult.results){const equipmentId=Number(row.equipment_id);const list=rawPlanMap.get(equipmentId)??[];list.push(row);rawPlanMap.set(equipmentId,list);}

    const usageByEquipment=new Map<string,Row>();
    for(const row of readingResult.results)usageByEquipment.set(`${Number(row.equipment_id)}:${String(row.unit)}`,row);
    const dailyAverage=(equipmentId:number,unit:"HOURS"|"KM")=>{
      const row=usageByEquipment.get(`${equipmentId}:${unit}`);
      if(!row)return 0;
      const days=Math.max(1,(new Date(String(row.last_date)).getTime()-new Date(String(row.first_date)).getTime())/86400000);
      return Math.max(0,(Number(row.last_value)-Number(row.first_value))/days);
    };

    const allPlanStates:Array<Record<string,unknown>>=[];
    const equipment=equipmentResult.results.filter((row)=>allowedIds.has(Number(row.id))).map((row)=>{
      const id=Number(row.id);const currentHours=Number(row.current_hours);const currentKm=Number(row.current_km);const controlType=String(row.control_type) as ControlType;
      const rawPlans=rawPlanMap.get(id)??[];
      const plans=rawPlans.map((plan)=>{
        const calculable={id:Number(plan.id),intervalHours:n(plan.interval_hours),intervalKm:n(plan.interval_km),triggerMode:String(plan.trigger_mode) as PlanTriggerMode,
          lastHours:n(plan.last_hours),lastKm:n(plan.last_km),nextHours:n(plan.next_hours),nextKm:n(plan.next_km)};
        const state=calculatePlanState(calculable,currentHours,currentKm,thresholds);
        const average=state.configured?dailyAverage(id,state.unit):0;
        const estimatedDays=average>0&&state.remaining!==null&&state.remaining>0?Math.ceil(state.remaining/average):null;
        const serialized={id:calculable.id,equipmentId:id,maintenanceTypeId:Number(plan.maintenance_type_id),name:String(plan.maintenance_name),category:String(plan.maintenance_category),
          triggerMode:calculable.triggerMode,intervalHours:calculable.intervalHours,intervalKm:calculable.intervalKm,intervalDays:n(plan.interval_days),
          lastHours:calculable.lastHours,lastKm:calculable.lastKm,lastDate:text(plan.last_date),lastIsGenericDate:Number(plan.last_is_generic_date)===1,nextHours:calculable.nextHours,nextKm:calculable.nextKm,nextDate:text(plan.next_date),
          oilType:text(plan.oil_type),filterReference:text(plan.filter_reference),notes:text(plan.notes),state,estimatedDays};
        allPlanStates.push({...serialized,prefix:String(row.prefix),equipment:`${row.brand} ${row.model}`,equipmentCategory:String(row.type),front:text(row.front)??"Sem frente"});
        return serialized;
      });
      const health=summarizeEquipmentHealth(plans.map((plan)=>({name:plan.name,state:plan.state})));
      const statusMap:Record<string,string>={ACTIVE:"Ativo",STOPPED:"Parado",MAINTENANCE:"Em manutenção",INACTIVE:"Inativo"};
      return {id,code:String(row.code),prefix:String(row.prefix),type:String(row.type),brand:String(row.brand),model:String(row.model),year:n(row.year),
        qrToken:text(row.qr_token),photoKey:text(row.photo_key),serviceFrontId:n(row.service_front_id),oilChangeEnabled:Number(row.oil_change_enabled)===1,notes:text(row.notes),equipmentModelId:n(row.equipment_model_id),
        serial:text(row.serial_number)??"",chassis:text(row.chassis),identificationType:String(row.identification_type),identificationValue:String(row.identification_type)==="CHASSIS"?text(row.chassis):text(row.serial_number),
        plate:text(row.plate),front:text(row.front)??"Sem frente",hours:currentHours,km:currentKm,control:controlType,status:statusMap[String(row.status)]??String(row.status),
        reading:formatReading(currentHours,currentKm,controlType),lastReadingAt:text(row.last_reading_date),health:health.health,situation:health.situation,tone:health.tone,
        healthCounts:health.counts,overduePlans:health.overduePlans,
        applicableMaintenanceTypes:applicableMap.get(id)??[],plans,createdAt:String(row.created_at),updatedAt:String(row.updated_at)};
    });

    allPlanStates.sort((a,b)=>levelPriority((a.state as {level:"OK"|"WARNING"|"NEAR"|"OVERDUE"}).level)-levelPriority((b.state as {level:"OK"|"WARNING"|"NEAR"|"OVERDUE"}).level));
    const currentStatusByCycle=new Map<string,string>();for(const plan of allPlanStates)currentStatusByCycle.set(`${plan.equipmentId}:${plan.maintenanceTypeId}`,(plan.state as {level:string}).level);
    const historyWithStatus=history.map((item)=>({...item,currentStatus:item.equipmentId&&item.maintenanceTypeId?currentStatusByCycle.get(`${item.equipmentId}:${item.maintenanceTypeId}`)??null:null}));
    const readingHistory=historyWithStatus.filter((item)=>item.kind==="READING");
    const statusCounts={normal:0,attention:0,urgent:0,overdue:0,unconfigured:0};
    for(const plan of allPlanStates){const state=plan.state as {configured:boolean;level:string};if(!state.configured)statusCounts.unconfigured++;else if(state.level==="OVERDUE")statusCounts.overdue++;else if(state.level==="NEAR")statusCounts.urgent++;else if(state.level==="WARNING")statusCounts.attention++;else statusCounts.normal++;}
    const now=Date.now();const recentMaintenances=history.filter((item)=>item.kind==="MAINTENANCE"&&now-new Date(item.date).getTime()<=30*86400000).length;
    return Response.json({
      generatedAt:new Date().toISOString(),equipment,maintenanceTypes:typeResult.results.map((row)=>({id:Number(row.id),name:String(row.name),category:String(row.category)})),
      alerts:allPlanStates.filter((plan)=>(plan.state as {configured:boolean}).configured),history:historyWithStatus,readings:readingHistory,
      dashboard:{equipmentTotal:equipment.length,active:equipment.filter((item)=>item.status==="Ativo").length,stopped:equipment.filter((item)=>item.status!=="Ativo").length,
        fronts:new Set(equipment.map((item)=>item.front)).size,...statusCounts,due7:allPlanStates.filter((plan)=>{const days=plan.estimatedDays as number|null;return days!==null&&days<=7;}).length,
        due30:allPlanStates.filter((plan)=>{const days=plan.estimatedDays as number|null;return days!==null&&days<=30;}).length,recentMaintenances},
    });
  }catch(error){
    console.error("[system.get] Falha ao carregar dados operacionais",error);
    return Response.json({error:"Não foi possível carregar os dados do sistema. Verifique o banco e tente novamente."},{status:500});
  }
}
