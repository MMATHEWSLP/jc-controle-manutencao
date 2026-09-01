import { getD1 } from "../../../../db";
import { assertSameOrigin,authorize } from "../../../../lib/auth";
import { allowedEquipmentIds,equipmentAccessResponse,requireEquipmentAccess } from "../../../../lib/front-scope";

type Row=Record<string,unknown>;
const clean=(value:unknown)=>typeof value==="string"?value.trim():"";

export async function GET(request:Request){
  const auth=await authorize(request,"equipment.view");if(auth.response)return auth.response;
  try{
    const d1=await getD1();const allowed=await allowedEquipmentIds(d1,auth.user!,"MANAGEMENT");const requested=Number(new URL(request.url).searchParams.get("equipmentId"));
    if(Number.isInteger(requested)&&requested>0)await requireEquipmentAccess(d1,auth.user!,requested,"MANAGEMENT");
    const result=await d1.prepare(`SELECT tr.id,tr.equipment_id,e.prefix,tr.previous_service_front_id,tr.new_service_front_id,
      previous.name AS previous_front,next.name AS new_front,tr.transferred_at,tr.note,u.name AS responsible
      FROM equipment_transfers tr INNER JOIN equipment e ON e.id=tr.equipment_id
      LEFT JOIN service_fronts previous ON previous.id=tr.previous_service_front_id
      INNER JOIN service_fronts next ON next.id=tr.new_service_front_id
      INNER JOIN users u ON u.id=tr.transferred_by ORDER BY tr.transferred_at DESC,tr.created_at DESC`).all<Row>();
    const transfers=result.results.filter((row)=>allowed.has(Number(row.equipment_id))&&(!Number.isInteger(requested)||requested<=0||Number(row.equipment_id)===requested)).map((row)=>({
      id:String(row.id),equipmentId:Number(row.equipment_id),prefix:String(row.prefix),previousServiceFrontId:row.previous_service_front_id==null?null:Number(row.previous_service_front_id),
      newServiceFrontId:Number(row.new_service_front_id),previousFront:row.previous_front==null?"Sem frente definida":String(row.previous_front),newFront:String(row.new_front),
      transferredAt:String(row.transferred_at),note:row.note==null?null:String(row.note),responsible:String(row.responsible),
    }));
    return Response.json({transfers});
  }catch(error){const access=equipmentAccessResponse(error);if(access)return access;console.error("[equipment-transfers.get]",error);return Response.json({error:"Não foi possível carregar o histórico de transferências."},{status:500});}
}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});
  const auth=await authorize(request,"equipment.transfer");if(auth.response)return auth.response;
  try{
    const body=await request.json() as Record<string,unknown>;const equipmentId=Number(body.equipmentId);const newServiceFrontId=Number(body.newServiceFrontId);const expectedFrontId=body.currentServiceFrontId==null?null:Number(body.currentServiceFrontId);
    if(!Number.isInteger(equipmentId)||equipmentId<=0||!Number.isInteger(newServiceFrontId)||newServiceFrontId<=0)return Response.json({error:"Selecione o equipamento e a nova frente."},{status:400});
    const d1=await getD1();await requireEquipmentAccess(d1,auth.user!,equipmentId,"MANAGEMENT");
    const [equipment,front]=await Promise.all([
      d1.prepare(`SELECT e.id,e.prefix,e.service_front_id,sf.name AS current_front FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE e.id=?`).bind(equipmentId).first<Row>(),
      d1.prepare(`SELECT id,name FROM service_fronts WHERE id=? AND active=1`).bind(newServiceFrontId).first<Row>(),
    ]);
    if(!equipment)return Response.json({error:"Equipamento não encontrado."},{status:404});if(!front)return Response.json({error:"A frente de destino não existe ou está inativa."},{status:400});
    const currentFrontId=equipment.service_front_id==null?null:Number(equipment.service_front_id);const currentFront=equipment.current_front==null?"Sem frente definida":String(equipment.current_front);
    if(expectedFrontId!==null&&expectedFrontId!==currentFrontId)return Response.json({error:"A frente atual do equipamento mudou. Atualize a lista antes de transferir."},{status:409});
    if(currentFrontId===newServiceFrontId)return Response.json({error:`O equipamento já pertence à frente ${String(front.name)}.`},{status:409});
    const now=new Date().toISOString();const transferId=crypto.randomUUID();const note=clean(body.note)||null;
    await d1.batch([
      d1.prepare(`INSERT INTO equipment_transfers (id,equipment_id,previous_service_front_id,new_service_front_id,transferred_at,transferred_by,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(transferId,equipmentId,currentFrontId,newServiceFrontId,now,auth.user!.id,note,now,now),
      d1.prepare(`UPDATE equipment SET service_front_id=?,updated_at=? WHERE id=? AND service_front_id IS NOT DISTINCT FROM ?`).bind(newServiceFrontId,now,equipmentId,currentFrontId),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(auth.user!.id,"EQUIPMENT",String(equipmentId),"EQUIPMENT_TRANSFERRED",JSON.stringify({serviceFrontId:currentFrontId,front:currentFront}),JSON.stringify({serviceFrontId:newServiceFrontId,front:String(front.name),note}),now),
    ]);
    return Response.json({message:`${String(equipment.prefix)} transferido de ${currentFront} para ${String(front.name)}.`,transfer:{id:transferId,equipmentId,previousServiceFrontId:currentFrontId,newServiceFrontId,previousFront:currentFront,newFront:String(front.name),transferredAt:now,responsible:auth.user!.name,note}});
  }catch(error){const access=equipmentAccessResponse(error);if(access)return access;const message=error instanceof Error?error.message:"";if(message.includes("EQUIPMENT_FRONT_CHANGED"))return Response.json({error:"A frente atual do equipamento mudou. Atualize a lista e tente novamente."},{status:409});console.error("[equipment-transfers.post]",error);return Response.json({error:"A transferência não foi concluída. Nenhuma alteração parcial foi mantida."},{status:500});}
}
