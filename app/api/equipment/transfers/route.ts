import { getD1 } from "../../../../db";
import { assertSameOrigin,authorize } from "../../../../lib/auth";
import { allowedEquipmentIds,equipmentAccessResponse,requireEquipmentAccess } from "../../../../lib/front-scope";
import { transferEquipment,TransferError } from "../../../../lib/equipment-transfer";

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
    const result=await transferEquipment(d1,auth.user!.id,{equipmentId,newServiceFrontId,expectedFrontId,note:clean(body.note)||null});
    return Response.json({message:result.message,transfer:{...result.transfer,responsible:auth.user!.name}});
  }catch(error){const access=equipmentAccessResponse(error);if(access)return access;if(error instanceof TransferError)return Response.json({error:error.message},{status:error.status});const message=error instanceof Error?error.message:"";if(message.includes("EQUIPMENT_FRONT_CHANGED"))return Response.json({error:"A frente atual do equipamento mudou. Atualize a lista e tente novamente."},{status:409});console.error("[equipment-transfers.post]",error);return Response.json({error:"A transferência não foi concluída. Nenhuma alteração parcial foi mantida."},{status:500});}
}
