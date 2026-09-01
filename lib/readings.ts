import type { D1DatabaseLike,D1PreparedStatementLike } from "../db";
import { buildAlertStatements,loadEquipmentCore,loadPlansForEquipment,loadThresholds } from "./maintenance-data";
import { recalculateMaintenanceCycles } from "./maintenance-recalculation";

export type ReadingSource="MANUAL"|"EXCEL_IMPORT"|"QR_CODE"|"MAINTENANCE";
export type SaveReadingInput={equipmentId:number;readingDate:string;hours:number|null;km:number|null;operator:string;notes:string|null;serviceFrontId?:number|null;authorizeRegression?:boolean;actor:{id:number;name:string;profile:string};source:ReadingSource};

export class ReadingOperationError extends Error{
  status:number;requiresConfirmation:boolean;
  constructor(message:string,status=400,requiresConfirmation=false){super(message);this.name="ReadingOperationError";this.status=status;this.requiresConfirmation=requiresConfirmation;}
}

export async function saveReading(d1:D1DatabaseLike,input:SaveReadingInput){
  if(!Number.isInteger(input.equipmentId)||input.equipmentId<=0)throw new ReadingOperationError("Selecione um equipamento válido.");
  if(!/^\d{4}-\d{2}-\d{2}/.test(input.readingDate))throw new ReadingOperationError("Informe uma data válida para a leitura.");
  const equipment=await loadEquipmentCore(d1,input.equipmentId);if(!equipment)throw new ReadingOperationError("Equipamento não encontrado.",404);
  await recalculateMaintenanceCycles(d1,{equipmentId:input.equipmentId,notify:false});
  const requiresHours=equipment.control_type!=="KM",requiresKm=equipment.control_type!=="HOURS";
  if(requiresHours&&(input.hours===null||!Number.isFinite(input.hours)||input.hours<0))throw new ReadingOperationError("Informe um horímetro válido.");
  if(requiresKm&&(input.km===null||!Number.isFinite(input.km)||input.km<0))throw new ReadingOperationError("Informe uma quilometragem válida.");
  const nextHours=requiresHours?input.hours!:equipment.current_hours,nextKm=requiresKm?input.km!:equipment.current_km;
  const hoursRegression=requiresHours&&nextHours<equipment.current_hours,kmRegression=requiresKm&&nextKm<equipment.current_km;
  if(hoursRegression||kmRegression){
    if(input.actor.profile!=="ADMIN")throw new ReadingOperationError("A nova leitura é inferior à atual. Somente um administrador pode autorizar essa correção.",403);
    if(input.authorizeRegression!==true)throw new ReadingOperationError("A leitura informada é inferior à atual. Confirme a correção administrativa para continuar.",409,true);
  }
  if(nextHours===equipment.current_hours&&nextKm===equipment.current_km)throw new ReadingOperationError("Informe uma leitura diferente da atual.");
  const [plans,thresholds]=await Promise.all([loadPlansForEquipment(d1,input.equipmentId),loadThresholds(d1)]);const now=new Date().toISOString();const operator=input.operator.trim()||input.actor.name;const notes=input.notes?.trim()||null;
  const updatedEquipment={...equipment,current_hours:nextHours,current_km:nextKm};const statements:D1PreparedStatementLike[]=[
    d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,updated_at=? WHERE id=?`).bind(nextHours,nextKm,now,input.equipmentId),
    d1.prepare(`INSERT INTO meter_readings (equipment_id,reading_date,hours,km,operator,service_front_id,notes,source,authorized_regression,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.equipmentId,input.readingDate,requiresHours?nextHours:null,requiresKm?nextKm:null,operator,input.serviceFrontId??null,notes,input.source,hoursRegression||kmRegression?1:0,input.actor.id,now,now),
    d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(input.actor.id,"EQUIPMENT",String(input.equipmentId),equipment.control_type==="KM"?"ATUALIZAÇÃO DE KM":equipment.control_type==="HOURS_KM"?"ATUALIZAÇÃO DE HORÍMETRO / KM":"ATUALIZAÇÃO DE HORÍMETRO",JSON.stringify({hours:equipment.current_hours,km:equipment.current_km}),JSON.stringify({hours:nextHours,km:nextKm,operator,notes,source:input.source}),now),
    ...buildAlertStatements(d1,updatedEquipment,plans,thresholds,now),
  ];
  await d1.batch(statements);await recalculateMaintenanceCycles(d1,{equipmentId:input.equipmentId,force:true});
  return {equipmentId:input.equipmentId,hours:nextHours,km:nextKm,hoursUsed:nextHours-equipment.current_hours,kmUsed:nextKm-equipment.current_km,alertsRecalculated:plans.length};
}
