import { getD1, type D1DatabaseLike } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { loadHistoryEntries } from "../../../lib/history-data";
import { canonicalEquipmentPrefix } from "../../../lib/maintenance-history";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { allowedEquipmentIds,equipmentAccessResponse,isAdministrator,requireEquipmentAccess } from "../../../lib/front-scope";

type Row=Record<string,unknown>;

const clean=(value:unknown)=>typeof value==="string"?value.trim():"";
const numeric=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
const categoryOf=(prefix:string)=>canonicalEquipmentPrefix(prefix).split("-")[0];
const compatible=(control:string,unit:string)=>control==="HOURS_KM"||control===unit;
const performedAt=(value:unknown)=>{
  const raw=clean(value);if(!raw)return null;
  const parsed=new Date(raw.length===10?`${raw}T12:00:00`:raw);
  return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
};

async function recalculateAffected(d1:D1DatabaseLike,ids:Array<number|null|undefined>){
  for(const equipmentId of [...new Set(ids.filter((id):id is number=>Number.isInteger(id)&&Number(id)>0))]){
    await recalculateMaintenanceCycles(d1,{equipmentId,force:true});
  }
}

async function equipmentByPrefix(d1:D1DatabaseLike,prefix:string){
  return d1.prepare(`SELECT id,prefix,current_hours,current_km,control_type FROM equipment
    WHERE UPPER(REPLACE(REPLACE(REPLACE(TRIM(prefix),' ',''),'–','-'),'—','-'))=?`)
    .bind(canonicalEquipmentPrefix(prefix)).first<Row>();
}

export async function GET(request:Request) {
  const auth=await authorize(request,"maintenance.history");if(auth.response)return auth.response;
  try {
    const d1=await getD1();await recalculateMaintenanceCycles(d1,{notify:false});const allowed=await allowedEquipmentIds(d1,auth.user!,"OIL");
    const history=(await loadHistoryEntries(d1)).filter((item)=>item.equipmentId!==null?allowed.has(item.equipmentId):isAdministrator(auth.user!));
    return Response.json({ history });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return Response.json({ error:message.includes("no such table") ? "O histórico ainda está sendo preparado." : "Não foi possível carregar o histórico agora." }, { status:500 });
  }
}

export async function PUT(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"maintenance.edit");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const id=Number(body.id);const kind=clean(body.kind).toUpperCase();
    if(!Number.isInteger(id)||id<=0)return Response.json({error:"Registro do Histórico inválido."},{status:400});
    if(kind!=="MAINTENANCE"&&kind!=="IMPORTED")return Response.json({error:"Somente trocas de óleo podem ser editadas nesta tela."},{status:400});
    const rawDate=clean(body.performedAt);const date=performedAt(body.performedAt);
    if(kind==="MAINTENANCE"&&!date)return Response.json({error:"Informe uma data e hora válidas."},{status:400});
    if(kind==="IMPORTED"&&rawDate&&!date)return Response.json({error:"Informe uma data e hora válidas ou deixe o campo sem preenchimento."},{status:400});
    const reading=numeric(body.reading);if(reading===null||reading<0)return Response.json({error:"Informe uma leitura válida."},{status:400});
    const maintenanceTypeId=Number(body.maintenanceTypeId);
    if(!Number.isInteger(maintenanceTypeId)||maintenanceTypeId<=0)return Response.json({error:"Selecione o tipo de manutenção."},{status:400});
    const d1=await getD1();const now=new Date().toISOString();
    const maintenanceType=await d1.prepare(`SELECT id,name,description FROM maintenance_types WHERE id=? AND active=1`).bind(maintenanceTypeId).first<Row>();
    if(!maintenanceType)return Response.json({error:"Tipo de manutenção não encontrado."},{status:404});

    if(kind==="MAINTENANCE"){
      const current=await d1.prepare(`SELECT id,equipment_id,plan_id,maintenance_type_id,performed_at,hours,km,mechanic,work_order,cost,notes
        FROM maintenances WHERE id=?`).bind(id).first<Row>();
      if(!current)return Response.json({error:"Troca não encontrada no Histórico."},{status:404});
      await requireEquipmentAccess(d1,auth.user!,Number(current.equipment_id),"OIL");
      const equipmentId=Number(body.equipmentId);if(!Number.isInteger(equipmentId)||equipmentId<=0)return Response.json({error:"Selecione o equipamento."},{status:400});
      await requireEquipmentAccess(d1,auth.user!,equipmentId,"OIL");
      const equipment=await d1.prepare(`SELECT id,prefix,current_hours,current_km,control_type FROM equipment WHERE id=?`).bind(equipmentId).first<Row>();
      if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});
      await recalculateMaintenanceCycles(d1,{equipmentId,notify:false});
      const plan=await d1.prepare(`SELECT id,trigger_mode FROM maintenance_plans WHERE equipment_id=? AND maintenance_type_id=? AND active=1`)
        .bind(equipmentId,maintenanceTypeId).first<Row>();
      if(!plan)return Response.json({error:`${String(maintenanceType.name)} não possui plano para ${String(equipment.prefix)}.`},{status:400});
      const unit=String(plan.trigger_mode)==="KM"?"KM":String(plan.trigger_mode)==="HOURS"?"HOURS":"";
      if(!unit||!compatible(String(equipment.control_type),unit))return Response.json({error:"O tipo de medição desta troca não é compatível com o equipamento."},{status:400});
      const mechanic=clean(body.mechanic)||auth.user!.name;const workOrder=clean(body.workOrder).toUpperCase()||String(current.work_order);
      const cost=Math.max(0,numeric(body.cost)??0);const notes=clean(body.notes)||null;
      const duplicateOrder=await d1.prepare(`SELECT id FROM maintenances WHERE id<>? AND work_order=? AND maintenance_type_id=?`).bind(id,workOrder,maintenanceTypeId).first<Row>();
      if(duplicateOrder)return Response.json({error:"Esta OS já possui esse tipo de manutenção."},{status:409});
      const duplicateEvent=await d1.prepare(`SELECT id FROM maintenances WHERE id<>? AND equipment_id=? AND plan_id=? AND performed_at=?`).bind(id,equipmentId,Number(plan.id),date).first<Row>();
      if(duplicateEvent)return Response.json({error:"Já existe esta troca para o equipamento, item e data informados."},{status:409});
      const previous={...current};
      await d1.batch([
        d1.prepare(`UPDATE alerts SET closed_by_maintenance_id=NULL,updated_at=? WHERE closed_by_maintenance_id=?`).bind(now,id),
        d1.prepare(`UPDATE maintenances SET equipment_id=?,plan_id=?,maintenance_type_id=?,performed_at=?,hours=?,km=?,mechanic=?,work_order=?,cost=?,notes=?,updated_at=? WHERE id=?`)
          .bind(equipmentId,Number(plan.id),maintenanceTypeId,date,unit==="HOURS"?reading:null,unit==="KM"?reading:null,mechanic,workOrder,cost,notes,now,id),
        d1.prepare(`UPDATE maintenance_items SET description=?,unit_cost=?,updated_at=? WHERE maintenance_id=? AND item_type='OIL'`)
          .bind(String(maintenanceType.name),cost,now,id),
        d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
          .bind(auth.user!.id,"MAINTENANCE",String(id),"HISTÓRICO EDITADO",JSON.stringify(previous),JSON.stringify({equipmentId,maintenanceTypeId,performedAt:date,reading,unit,mechanic,workOrder,cost,notes}),now),
      ]);
      await recalculateAffected(d1,[Number(current.equipment_id),equipmentId]);
      return Response.json({ok:true,message:"Troca atualizada e planos recalculados."});
    }

    const current=await d1.prepare(`SELECT id,equipment_id,maintenance_type_id,prefix,service,reading_raw,reading_value,control_type,performed_at,source FROM imported_maintenance_history WHERE id=?`).bind(id).first<Row>();
    if(!current)return Response.json({error:"Registro importado não encontrado no Histórico."},{status:404});
    if(current.equipment_id!=null)await requireEquipmentAccess(d1,auth.user!,Number(current.equipment_id),"OIL");else if(!isAdministrator(auth.user!))return Response.json({error:"Você não possui acesso a este registro importado."},{status:403});
    const prefix=canonicalEquipmentPrefix(body.prefix);if(!prefix)return Response.json({error:"Informe o prefixo do equipamento."},{status:400});
    const unit=clean(body.unit).toUpperCase();if(unit!=="HOURS"&&unit!=="KM")return Response.json({error:"Selecione Horas ou KM."},{status:400});
    const config=await d1.prepare(`SELECT id,unit FROM maintenance_interval_configs WHERE category=? AND maintenance_type_id=? AND active=1`)
      .bind(categoryOf(prefix),maintenanceTypeId).first<Row>();
    if(!config)return Response.json({error:`Não existe intervalo configurado para ${categoryOf(prefix)} e ${String(maintenanceType.name)}.`},{status:400});
    if(String(config.unit)!==unit)return Response.json({error:`Esta manutenção deve ser controlada em ${String(config.unit)==="KM"?"KM":"horas"}.`},{status:400});
    const linkedEquipment=await equipmentByPrefix(d1,prefix);
    if(linkedEquipment)await requireEquipmentAccess(d1,auth.user!,Number(linkedEquipment.id),"OIL");
    if(linkedEquipment&&!compatible(String(linkedEquipment.control_type),unit))return Response.json({error:"A unidade selecionada não é compatível com o equipamento."},{status:400});
    const service=String(maintenanceType.description??maintenanceType.name);const readingRaw=String(reading);
    const duplicate=await d1.prepare(`SELECT id FROM imported_maintenance_history WHERE id<>? AND prefix=? AND service=? AND reading_raw=? AND performed_at IS NOT DISTINCT FROM ?`)
      .bind(id,prefix,service,readingRaw,date).first<Row>();
    if(duplicate)return Response.json({error:"Já existe um registro importado com esses mesmos dados."},{status:409});
    await d1.batch([
      d1.prepare(`UPDATE imported_maintenance_history SET equipment_id=?,maintenance_type_id=?,prefix=?,service=?,reading_raw=?,reading_value=?,control_type=?,performed_at=?,updated_at=? WHERE id=?`)
        .bind(linkedEquipment?Number(linkedEquipment.id):null,maintenanceTypeId,prefix,service,readingRaw,reading,unit,date,now,id),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(auth.user!.id,"IMPORTED_MAINTENANCE",String(id),"HISTÓRICO IMPORTADO EDITADO",JSON.stringify(current),JSON.stringify({prefix,service,reading,unit,performedAt:date}),now),
    ]);
    await recalculateAffected(d1,[Number(current.equipment_id),Number(linkedEquipment?.id)]);
    return Response.json({ok:true,message:"Registro importado atualizado e planos recalculados."});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[history.put] Falha ao editar Histórico",error);const message=error instanceof Error?error.message:"";
    if(message.includes("UNIQUE constraint"))return Response.json({error:"A alteração criaria uma troca duplicada no Histórico."},{status:409});
    return Response.json({error:"Não foi possível editar esta troca."},{status:500});
  }
}

export async function DELETE(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"maintenance.edit");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const id=Number(body.id);const kind=clean(body.kind).toUpperCase();
    if(!Number.isInteger(id)||id<=0)return Response.json({error:"Registro do Histórico inválido."},{status:400});
    if(kind!=="MAINTENANCE"&&kind!=="IMPORTED")return Response.json({error:"Somente trocas de óleo podem ser excluídas nesta tela."},{status:400});
    const d1=await getD1();const now=new Date().toISOString();
    if(kind==="MAINTENANCE"){
      const current=await d1.prepare(`SELECT id,equipment_id,plan_id,maintenance_type_id,performed_at,hours,km,mechanic,work_order,cost,notes FROM maintenances WHERE id=?`).bind(id).first<Row>();
      if(!current)return Response.json({error:"Troca não encontrada no Histórico."},{status:404});
      await requireEquipmentAccess(d1,auth.user!,Number(current.equipment_id),"OIL");
      await d1.batch([
        d1.prepare(`UPDATE alerts SET closed_by_maintenance_id=NULL,updated_at=? WHERE closed_by_maintenance_id=?`).bind(now,id),
        d1.prepare(`DELETE FROM maintenance_items WHERE maintenance_id=?`).bind(id),
        d1.prepare(`DELETE FROM maintenances WHERE id=?`).bind(id),
        d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
          .bind(auth.user!.id,"MAINTENANCE",String(id),"HISTÓRICO EXCLUÍDO",JSON.stringify(current),null,now),
      ]);
      await recalculateAffected(d1,[Number(current.equipment_id)]);
      return Response.json({ok:true,message:"Troca excluída e planos recalculados."});
    }
    const current=await d1.prepare(`SELECT id,equipment_id,maintenance_type_id,prefix,service,reading_raw,reading_value,control_type,performed_at,source FROM imported_maintenance_history WHERE id=?`).bind(id).first<Row>();
    if(!current)return Response.json({error:"Registro importado não encontrado no Histórico."},{status:404});
    if(current.equipment_id!=null)await requireEquipmentAccess(d1,auth.user!,Number(current.equipment_id),"OIL");else if(!isAdministrator(auth.user!))return Response.json({error:"Você não possui acesso a este registro importado."},{status:403});
    const linkedEquipment=await equipmentByPrefix(d1,String(current.prefix));
    await d1.batch([
      d1.prepare(`DELETE FROM imported_maintenance_history WHERE id=?`).bind(id),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(auth.user!.id,"IMPORTED_MAINTENANCE",String(id),"HISTÓRICO IMPORTADO EXCLUÍDO",JSON.stringify(current),null,now),
    ]);
    await recalculateAffected(d1,[Number(current.equipment_id),Number(linkedEquipment?.id)]);
    return Response.json({ok:true,message:"Registro importado excluído e planos recalculados."});
  }catch(error){
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[history.delete] Falha ao excluir Histórico",error);
    return Response.json({error:"Não foi possível excluir esta troca."},{status:500});
  }
}
