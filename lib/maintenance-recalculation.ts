import type { D1DatabaseLike, D1PreparedStatementLike } from "../db";
import { buildAlertStatements, loadThresholds, type EquipmentCore, type PlanCore } from "./maintenance-data";
import type { ControlType, PlanTriggerMode } from "./maintenance-engine";
import { canonicalEquipmentPrefix, canonicalMaintenanceService, chooseLatestHistoryCandidate, maintenancePlanUnit, reconcileEquipmentMeasurement, type MaintenanceHistoryCandidate } from "./maintenance-history";
import { processAutomaticWhatsappAlerts } from "./whatsapp";

type Row=Record<string,unknown>;
type IntervalUnit="HOURS"|"KM";

type EquipmentRow=EquipmentCore;
type EquipmentReconciliationRow=EquipmentRow&{type:string};
type IntervalConfig={
  id:number;
  category:string;
  maintenanceTypeId:number;
  maintenanceName:string;
  maintenanceDescription:string;
  interval:number;
  unit:IntervalUnit;
};
const RECALCULATION_ENGINE_VERSION="history-date-association-v3";
const numberOrNull=(value:unknown)=>{
  if(value===null||value===undefined||value==="")return null;
  const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0?parsed:null;
};
const equipmentCategory=(prefix:string)=>canonicalEquipmentPrefix(prefix).split("-")[0];

function compatible(control:ControlType,unit:IntervalUnit){
  return control==="HOURS_KM"||control===unit;
}

async function batchInChunks(d1:D1DatabaseLike,statements:D1PreparedStatementLike[]){
  for(let index=0;index<statements.length;index+=75)await d1.batch(statements.slice(index,index+75));
}

async function signatureOf(value:unknown){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

async function reconcileEquipmentOperationalUnits(d1:D1DatabaseLike,equipmentId?:number){
  const statement=equipmentId
    ?d1.prepare(`SELECT id,prefix,type,current_hours,current_km,control_type FROM equipment WHERE id=?`).bind(equipmentId)
    :d1.prepare(`SELECT id,prefix,type,current_hours,current_km,control_type FROM equipment`);
  const result=await statement.all<Row>();const now=new Date().toISOString();const updates:D1PreparedStatementLike[]=[];
  for(const row of result.results){
    const currentHours=Number(row.current_hours),currentKm=Number(row.current_km),controlType=String(row.control_type) as ControlType;
    const reconciled=reconcileEquipmentMeasurement({prefix:row.prefix,type:row.type,controlType,currentHours,currentKm,previousControlType:controlType});
    if(!reconciled.changed)continue;
    updates.push(d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,control_type=?,updated_at=? WHERE id=?`)
      .bind(reconciled.currentHours,reconciled.currentKm,reconciled.controlType,now,Number(row.id)));
    updates.push(d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (NULL,?,?,?,?,?,?)`)
      .bind("EQUIPMENT",String(row.id),"UNIDADE OPERACIONAL RECONCILIADA",JSON.stringify({currentHours,currentKm,controlType}),JSON.stringify({currentHours:reconciled.currentHours,currentKm:reconciled.currentKm,controlType:reconciled.controlType}),now));
  }
  await batchInChunks(d1,updates);
}

export async function recalculateMaintenanceCycles(
  d1:D1DatabaseLike,
  options:{equipmentId?:number;force?:boolean;notify?:boolean}={},
){
  await reconcileEquipmentOperationalUnits(d1,options.equipmentId);
  const equipmentStatement=options.equipmentId
    ?d1.prepare(`SELECT id,prefix,type,current_hours,current_km,control_type FROM equipment WHERE id=? AND oil_change_enabled=1`).bind(options.equipmentId)
    :d1.prepare(`SELECT id,prefix,type,current_hours,current_km,control_type FROM equipment WHERE oil_change_enabled=1 ORDER BY id`);
  const realHistoryStatement=options.equipmentId
    ?d1.prepare(`SELECT equipment_id,maintenance_type_id,performed_at,hours,km FROM maintenances WHERE equipment_id=?`).bind(options.equipmentId)
    :d1.prepare(`SELECT equipment_id,maintenance_type_id,performed_at,hours,km FROM maintenances`);
  const existingPlanStatement=options.equipmentId
    ?d1.prepare(`SELECT equipment_id,maintenance_type_id,trigger_mode,interval_hours,interval_km FROM maintenance_plans WHERE equipment_id=?`).bind(options.equipmentId)
    :d1.prepare(`SELECT equipment_id,maintenance_type_id,trigger_mode,interval_hours,interval_km FROM maintenance_plans`);

  const applicableStatement=options.equipmentId
    ?d1.prepare(`SELECT emt.equipment_id,emt.maintenance_type_id FROM equipment_maintenance_types emt INNER JOIN maintenance_types t ON t.id=emt.maintenance_type_id WHERE emt.equipment_id=? AND emt.applicable=1 AND t.active=1 AND t.category='OIL'`).bind(options.equipmentId)
    :d1.prepare(`SELECT emt.equipment_id,emt.maintenance_type_id FROM equipment_maintenance_types emt INNER JOIN maintenance_types t ON t.id=emt.maintenance_type_id WHERE emt.applicable=1 AND t.active=1 AND t.category='OIL'`);
  const [equipmentResult,configResult,importedResult,realResult,applicableResult,existingPlanResult]=await Promise.all([
    equipmentStatement.all() as Promise<{results:Row[]}>,
    d1.prepare(`SELECT c.id,c.category,c.maintenance_type_id,c.interval_value,c.unit,t.name,t.description
      FROM maintenance_interval_configs c INNER JOIN maintenance_types t ON t.id=c.maintenance_type_id
      WHERE c.active=1 AND t.active=1 AND t.category='OIL' ORDER BY c.category,c.maintenance_type_id`).all() as Promise<{results:Row[]}>,
    d1.prepare(`SELECT id,equipment_id,maintenance_type_id,prefix,service,reading_value,control_type,performed_at FROM imported_maintenance_history WHERE reading_value IS NOT NULL`).all() as Promise<{results:Row[]}>,
    realHistoryStatement.all() as Promise<{results:Row[]}>,
    applicableStatement.all() as Promise<{results:Row[]}>,
    existingPlanStatement.all() as Promise<{results:Row[]}>,
  ]);

  const equipment:EquipmentReconciliationRow[]=equipmentResult.results.map((row)=>({
    id:Number(row.id),prefix:String(row.prefix),type:String(row.type),current_hours:Number(row.current_hours),current_km:Number(row.current_km),control_type:String(row.control_type) as ControlType,
  }));
  const configs:IntervalConfig[]=configResult.results.map((row)=>({
    id:Number(row.id),category:String(row.category),maintenanceTypeId:Number(row.maintenance_type_id),maintenanceName:String(row.name),
    maintenanceDescription:String(row.description),interval:Number(row.interval_value),unit:String(row.unit) as IntervalUnit,
  }));
  if(equipment.length===0||configs.length===0)return {recalculated:false,equipment:equipment.length,plans:0};

  const equipmentByPrefix=new Map(equipment.map((item)=>[canonicalEquipmentPrefix(item.prefix),item]));
  const equipmentById=new Map(equipment.map((item)=>[item.id,item]));
  const configByService=new Map<string,IntervalConfig>();
  for(const config of configs){
    configByService.set(`${config.category}:${canonicalMaintenanceService(config.maintenanceName)}`,config);
    configByService.set(`${config.category}:${canonicalMaintenanceService(config.maintenanceDescription)}`,config);
  }
  const configByType=new Map(configs.map((item)=>[`${item.category}:${item.maintenanceTypeId}`,item]));
  const existingPlans=new Map(existingPlanResult.results.map((row)=>[`${Number(row.equipment_id)}:${Number(row.maintenance_type_id)}`,{
    triggerMode:String(row.trigger_mode) as PlanTriggerMode,intervalHours:numberOrNull(row.interval_hours),intervalKm:numberOrNull(row.interval_km),
  }]));
  const latest=new Map<string,MaintenanceHistoryCandidate>();
  const associationStatements:D1PreparedStatementLike[]=[];

  for(const row of importedResult.results){
    const item=equipmentByPrefix.get(canonicalEquipmentPrefix(row.prefix))??equipmentById.get(Number(row.equipment_id));
    if(!item)continue;
    const serviceConfig=configByService.get(`${equipmentCategory(item.prefix)}:${canonicalMaintenanceService(row.service)}`);
    const storedConfig=configByType.get(`${equipmentCategory(item.prefix)}:${Number(row.maintenance_type_id)}`);
    const config=serviceConfig??storedConfig;
    const reading=numberOrNull(row.reading_value);const unit=String(row.control_type) as IntervalUnit;
    if(!config||reading===null||(unit!=="HOURS"&&unit!=="KM")||!compatible(item.control_type,unit))continue;
    if(Number(row.equipment_id)!==item.id||Number(row.maintenance_type_id)!==config.maintenanceTypeId){
      associationStatements.push(d1.prepare(`UPDATE imported_maintenance_history SET equipment_id=?,maintenance_type_id=?,updated_at=? WHERE id=?`)
        .bind(item.id,config.maintenanceTypeId,new Date().toISOString(),Number(row.id)));
    }
    const candidate:MaintenanceHistoryCandidate={equipmentId:item.id,maintenanceTypeId:config.maintenanceTypeId,performedAt:row.performed_at==null?null:String(row.performed_at),reading,sourcePriority:1,unit};
    const key=`${item.id}:${config.maintenanceTypeId}:${unit}`;latest.set(key,chooseLatestHistoryCandidate(latest.get(key),candidate));
  }
  await batchInChunks(d1,associationStatements);
  for(const row of realResult.results){
    const item=equipmentById.get(Number(row.equipment_id));if(!item)continue;
    const config=configByType.get(`${equipmentCategory(item.prefix)}:${Number(row.maintenance_type_id)}`);if(!config)continue;
    for(const unit of ["HOURS","KM"] as const){
      const reading=numberOrNull(unit==="KM"?row.km:row.hours);if(reading===null||!compatible(item.control_type,unit))continue;
      const candidate:MaintenanceHistoryCandidate={equipmentId:item.id,maintenanceTypeId:config.maintenanceTypeId,performedAt:row.performed_at==null?null:String(row.performed_at),reading,sourcePriority:2,unit};
      const key=`${item.id}:${config.maintenanceTypeId}:${unit}`;latest.set(key,chooseLatestHistoryCandidate(latest.get(key),candidate));
    }
  }

  const applicableKeys=new Set(applicableResult.results.map((row)=>`${Number(row.equipment_id)}:${Number(row.maintenance_type_id)}`));
  const targets=equipment.flatMap((item)=>configs
    .filter((config)=>config.category===equipmentCategory(item.prefix)&&compatible(item.control_type,config.unit)&&applicableKeys.has(`${item.id}:${config.maintenanceTypeId}`))
    .map((config)=>{
      const existing=existingPlans.get(`${item.id}:${config.maintenanceTypeId}`);
      const unit=maintenancePlanUnit(item.control_type,config.unit,existing?.triggerMode,existing?.intervalHours??null,existing?.intervalKm??null);
      const storedInterval=unit==="KM"?existing?.intervalKm:existing?.intervalHours;
      const interval=storedInterval!==null&&storedInterval!==undefined&&storedInterval>0?storedInterval:config.interval;
      return {equipment:item,config,unit,interval,candidate:latest.get(`${item.id}:${config.maintenanceTypeId}:${unit}`)};
    }));
  const stateKey=options.equipmentId?`EQUIPMENT:${options.equipmentId}`:"GLOBAL";
  const thresholds=await loadThresholds(d1);
  const signature=await signatureOf({engine:RECALCULATION_ENGINE_VERSION,thresholds,targets:targets.map(({equipment:item,config,unit,interval,candidate})=>({
    equipmentId:item.id,prefix:item.prefix,currentHours:item.current_hours,currentKm:item.current_km,control:item.control_type,
    configId:config.id,typeId:config.maintenanceTypeId,interval,unit,
    history:candidate?[candidate.performedAt,candidate.reading,candidate.sourcePriority]:null,applicable:true,
  }))});
  if(!options.force){
    const previous=await d1.prepare(`SELECT signature FROM maintenance_recalculation_state WHERE key=?`).bind(stateKey).first<{signature:string}>();
    if(previous?.signature===signature)return {recalculated:false,equipment:equipment.length,plans:targets.length};
  }

  const now=new Date().toISOString();
  if(options.equipmentId){
    await d1.prepare(`UPDATE maintenance_plans SET active=0,updated_at=? WHERE equipment_id=? AND NOT EXISTS (
      SELECT 1 FROM equipment_maintenance_types emt WHERE emt.equipment_id=maintenance_plans.equipment_id AND emt.maintenance_type_id=maintenance_plans.maintenance_type_id AND emt.applicable=1
    )`).bind(now,options.equipmentId).run();
    await d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,updated_at=? WHERE equipment_id=? AND status<>'CLOSED' AND plan_id IN (SELECT id FROM maintenance_plans WHERE active=0)`).bind(now,now,options.equipmentId).run();
  }else{
    await d1.prepare(`UPDATE maintenance_plans SET active=0,updated_at=? WHERE NOT EXISTS (
      SELECT 1 FROM equipment_maintenance_types emt WHERE emt.equipment_id=maintenance_plans.equipment_id AND emt.maintenance_type_id=maintenance_plans.maintenance_type_id AND emt.applicable=1
    )`).bind(now).run();
    await d1.prepare(`UPDATE alerts SET status='CLOSED',closed_at=?,updated_at=? WHERE status<>'CLOSED' AND plan_id IN (SELECT id FROM maintenance_plans WHERE active=0)`).bind(now,now).run();
  }
  const planStatements:D1PreparedStatementLike[]=[];
  for(const {equipment:item,config,unit,interval,candidate} of targets){
    const lastValue=candidate?.reading??null;const nextValue=lastValue===null?null:lastValue+interval;
    planStatements.push(d1.prepare(`INSERT INTO maintenance_plans
      (equipment_id,maintenance_type_id,interval_hours,interval_km,trigger_mode,last_hours,last_km,last_date,next_hours,next_km,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(equipment_id,maintenance_type_id) DO UPDATE SET
        interval_hours=excluded.interval_hours,interval_km=excluded.interval_km,trigger_mode=excluded.trigger_mode,
        last_hours=excluded.last_hours,last_km=excluded.last_km,last_date=excluded.last_date,
        next_hours=excluded.next_hours,next_km=excluded.next_km,
        active=1,updated_at=excluded.updated_at`)
      .bind(item.id,config.maintenanceTypeId,unit==="HOURS"?interval:null,unit==="KM"?interval:null,unit,
        unit==="HOURS"?lastValue:null,unit==="KM"?lastValue:null,candidate?.performedAt?.slice(0,10)??null,
        unit==="HOURS"?nextValue:null,unit==="KM"?nextValue:null,now,now));
  }
  await batchInChunks(d1,planStatements);

  const savedPlanStatement=options.equipmentId
    ?d1.prepare(`SELECT p.*,t.name AS maintenance_name FROM maintenance_plans p INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id INNER JOIN equipment e ON e.id=p.equipment_id WHERE p.active=1 AND e.oil_change_enabled=1 AND p.equipment_id=?`).bind(options.equipmentId)
    :d1.prepare(`SELECT p.*,t.name AS maintenance_name FROM maintenance_plans p INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id INNER JOIN equipment e ON e.id=p.equipment_id WHERE p.active=1 AND e.oil_change_enabled=1`);
  const savedPlans=await savedPlanStatement.all<Row>();
  const plansByEquipment=new Map<number,PlanCore[]>();
  for(const row of savedPlans.results){
    const equipmentId=Number(row.equipment_id),maintenanceTypeId=Number(row.maintenance_type_id);
    const plan:PlanCore={
      id:Number(row.id),equipmentId,maintenanceTypeId,maintenanceName:String(row.maintenance_name),active:Number(row.active),
      intervalHours:numberOrNull(row.interval_hours),intervalKm:numberOrNull(row.interval_km),triggerMode:String(row.trigger_mode) as PlanTriggerMode,
      lastHours:numberOrNull(row.last_hours),lastKm:numberOrNull(row.last_km),nextHours:numberOrNull(row.next_hours),nextKm:numberOrNull(row.next_km),
    };
    const list=plansByEquipment.get(equipmentId)??[];list.push(plan);plansByEquipment.set(equipmentId,list);
  }
  const alertStatements:D1PreparedStatementLike[]=[];
  for(const item of equipment)alertStatements.push(...buildAlertStatements(d1,item,plansByEquipment.get(item.id)??[],thresholds,now));
  await batchInChunks(d1,alertStatements);
  await d1.prepare(`INSERT INTO maintenance_recalculation_state (key,signature,recalculated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET signature=excluded.signature,recalculated_at=excluded.recalculated_at`).bind(stateKey,signature,now).run();
  if(options.notify!==false){try{await processAutomaticWhatsappAlerts(d1,{equipmentId:options.equipmentId});}
  catch(error){console.error("[maintenance.recalculation] Falha isolada ao processar alertas do WhatsApp",error);}}
  return {recalculated:true,equipment:equipment.length,plans:targets.length,withHistory:targets.filter((item)=>item.candidate).length};
}
