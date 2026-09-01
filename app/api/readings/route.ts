import { getD1, type D1PreparedStatementLike } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { loadEquipmentCore } from "../../../lib/maintenance-data";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { ReadingOperationError,saveReading,type ReadingSource } from "../../../lib/readings";
import { equipmentAccessResponse,requireEquipmentAccess } from "../../../lib/front-scope";

type Row=Record<string,unknown>;

function numeric(value:unknown){if(value===null||value===undefined||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}
function clean(value:unknown){return typeof value==="string"?value.trim():"";}
function sameReading(equipment:{current_hours:number;current_km:number;control_type:string},reading:Row){
  const hoursMatch=equipment.control_type==="KM"||(reading.hours!==null&&reading.hours!==undefined&&Math.abs(Number(reading.hours)-equipment.current_hours)<0.00001);
  const kmMatch=equipment.control_type==="HOURS"||(reading.km!==null&&reading.km!==undefined&&Math.abs(Number(reading.km)-equipment.current_km)<0.00001);
  return hoursMatch&&kmMatch;
}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"meter.create");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;
    const equipmentId=Number(body.equipmentId);const readingDate=clean(body.readingDate);const hours=numeric(body.hours);const km=numeric(body.km);
    const d1=await getD1();const access=await requireEquipmentAccess(d1,auth.user!,equipmentId,"OIL");
    const requestedSource=clean(body.source).toUpperCase();const source:ReadingSource=requestedSource==="QR_CODE"?"QR_CODE":"MANUAL";
    const result=await saveReading(d1,{equipmentId,readingDate,hours,km,operator:clean(body.operator),notes:clean(body.notes)||null,serviceFrontId:access.serviceFrontId,authorizeRegression:body.authorizeRegression===true,actor:{id:auth.user!.id,name:auth.user!.name,profile:auth.user!.profile},source});
    return Response.json({ok:true,...result});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    if(error instanceof ReadingOperationError)return Response.json({error:error.message,...(error.requiresConfirmation?{requiresConfirmation:true}:{})},{status:error.status});
    console.error("[readings.post] Falha ao registrar leitura",error);
    return Response.json({error:"A leitura não foi salva. Nenhuma alteração foi aplicada; tente novamente."},{status:500});
  }
}

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"meter.edit");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const id=Number(body.id);const readingDate=clean(body.readingDate);
    if(!Number.isInteger(id)||id<=0)return Response.json({error:"Registro de leitura inválido."},{status:400});
    if(!/^\d{4}-\d{2}-\d{2}/.test(readingDate))return Response.json({error:"Informe uma data válida para a leitura."},{status:400});
    const d1=await getD1();const current=await d1.prepare(`SELECT id,equipment_id,reading_date,hours,km,operator,notes,authorized_regression,created_by,created_at,updated_at FROM meter_readings WHERE id=?`).bind(id).first<Row>();
    if(!current)return Response.json({error:"Atualização de KM/horímetro não encontrada."},{status:404});
    const equipment=await loadEquipmentCore(d1,Number(current.equipment_id));if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});
    await requireEquipmentAccess(d1,auth.user!,equipment.id,"OIL");
    const requiresHours=equipment.control_type!=="KM";const requiresKm=equipment.control_type!=="HOURS";const hours=numeric(body.hours);const km=numeric(body.km);
    if(requiresHours&&(hours===null||hours<0))return Response.json({error:"Informe um horímetro válido."},{status:400});
    if(requiresKm&&(km===null||km<0))return Response.json({error:"Informe uma quilometragem válida."},{status:400});
    const latest=await d1.prepare(`SELECT id,hours,km FROM meter_readings WHERE equipment_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(equipment.id).first<Row>();
    const controlsCurrent=Number(latest?.id)===id&&sameReading(equipment,current);const nextHours=controlsCurrent&&requiresHours?hours!:equipment.current_hours;const nextKm=controlsCurrent&&requiresKm?km!:equipment.current_km;
    const regression=controlsCurrent&&((requiresHours&&nextHours<equipment.current_hours)||(requiresKm&&nextKm<equipment.current_km));
    if(regression){
      if(auth.user!.profile!=="ADMIN")return Response.json({error:"A correção reduziria a leitura atual. Somente um administrador pode autorizar."},{status:403});
      if(body.authorizeRegression!==true)return Response.json({error:"A correção reduzirá a leitura atual do equipamento. Confirme a correção administrativa para continuar.",requiresConfirmation:true},{status:409});
    }
    const operator=clean(body.operator)||auth.user!.name;const notes=clean(body.notes)||null;const now=new Date().toISOString();const statements:D1PreparedStatementLike[]=[
      d1.prepare(`UPDATE meter_readings SET reading_date=?,hours=?,km=?,operator=?,notes=?,authorized_regression=?,updated_at=? WHERE id=?`)
        .bind(readingDate,requiresHours?hours:null,requiresKm?km:null,operator,notes,regression||Number(current.authorized_regression)===1?1:0,now,id),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(auth.user!.id,"METER_READING",String(id),"LEITURA EDITADA",JSON.stringify(current),JSON.stringify({readingDate,hours:requiresHours?hours:null,km:requiresKm?km:null,operator,notes,currentReadingChanged:controlsCurrent}),now),
    ];
    if(controlsCurrent)statements.push(d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,updated_at=? WHERE id=?`).bind(nextHours,nextKm,now,equipment.id));
    await d1.batch(statements);await recalculateMaintenanceCycles(d1,{equipmentId:equipment.id,force:true});
    return Response.json({ok:true,equipmentId:equipment.id,hours:nextHours,km:nextKm,currentReadingChanged:controlsCurrent,message:controlsCurrent?"Leitura atualizada e sistema recalculado.":"Registro histórico atualizado. A leitura atual foi preservada porque este registro não corresponde ao valor atual do equipamento."});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[readings.put] Falha ao editar leitura",error);
    return Response.json({error:"Não foi possível editar esta atualização de KM/horímetro."},{status:500});
  }
}

export async function DELETE(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"meter.edit");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const id=Number(body.id);
    if(!Number.isInteger(id)||id<=0)return Response.json({error:"Registro de leitura inválido."},{status:400});
    const d1=await getD1();const current=await d1.prepare(`SELECT id,equipment_id,reading_date,hours,km,operator,notes,authorized_regression,created_by,created_at,updated_at FROM meter_readings WHERE id=?`).bind(id).first<Row>();
    if(!current)return Response.json({error:"Atualização de KM/horímetro não encontrada."},{status:404});
    const equipment=await loadEquipmentCore(d1,Number(current.equipment_id));if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});
    await requireEquipmentAccess(d1,auth.user!,equipment.id,"OIL");
    const latest=await d1.prepare(`SELECT id,hours,km FROM meter_readings WHERE equipment_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(equipment.id).first<Row>();
    const controlsCurrent=Number(latest?.id)===id&&sameReading(equipment,current);const previous=controlsCurrent?await d1.prepare(`SELECT id,hours,km FROM meter_readings WHERE equipment_id=? AND id<>? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(equipment.id,id).first<Row>():null;
    const nextHours=controlsCurrent&&previous&&equipment.control_type!=="KM"&&previous.hours!==null?Number(previous.hours):equipment.current_hours;
    const nextKm=controlsCurrent&&previous&&equipment.control_type!=="HOURS"&&previous.km!==null?Number(previous.km):equipment.current_km;
    const revertedToPrevious=controlsCurrent&&Boolean(previous);const currentReadingChanged=revertedToPrevious&&(nextHours!==equipment.current_hours||nextKm!==equipment.current_km);const now=new Date().toISOString();const statements:D1PreparedStatementLike[]=[
      d1.prepare(`DELETE FROM meter_readings WHERE id=?`).bind(id),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(auth.user!.id,"METER_READING",String(id),"LEITURA EXCLUÍDA",JSON.stringify(current),JSON.stringify({hours:nextHours,km:nextKm,currentReadingChanged,revertedToPrevious}),now),
    ];
    if(currentReadingChanged)statements.push(d1.prepare(`UPDATE equipment SET current_hours=?,current_km=?,updated_at=? WHERE id=?`).bind(nextHours,nextKm,now,equipment.id));
    await d1.batch(statements);await recalculateMaintenanceCycles(d1,{equipmentId:equipment.id,force:true});
    const message=revertedToPrevious?"Leitura excluída. O equipamento voltou para a atualização anterior e o sistema foi recalculado.":controlsCurrent&&!previous?"Leitura excluída. O valor atual foi mantido porque não existe atualização anterior registrada.":"Leitura histórica excluída. A leitura atual do equipamento foi preservada.";
    return Response.json({ok:true,equipmentId:equipment.id,hours:nextHours,km:nextKm,currentReadingChanged,revertedToPrevious,message});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[readings.delete] Falha ao excluir leitura",error);
    return Response.json({error:"Não foi possível excluir esta atualização de KM/horímetro."},{status:500});
  }
}
