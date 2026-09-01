import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { loadHistoryEntries } from "../../../lib/history-data";
import { createMaintenancePdf,formatPdfDate } from "../../../lib/pdf";
import { isAdministrator,requireEquipmentAccess,equipmentAccessResponse } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
const numberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});
function safeFilename(value:string){return value.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/-+/g,"-");}

export async function GET(request:Request){
  const auth=await authorize(request,"maintenance.history");if(auth.response)return auth.response;
  try{
    const url=new URL(request.url);const kind=url.searchParams.get("kind");const id=Number(url.searchParams.get("id"));
    if(!["MAINTENANCE","IMPORTED"].includes(kind??"")||!Number.isInteger(id)||id<=0)return Response.json({error:"Informe uma manutenção válida para exportar."},{status:400});
    const d1=await getD1();const history=await loadHistoryEntries(d1);const base=history.find((item)=>item.kind===kind&&item.sourceId===id);
    if(!base)return Response.json({error:"Registro de manutenção não encontrado."},{status:404});
    if(base.equipmentId!==null)await requireEquipmentAccess(d1,auth.user!,base.equipmentId,"OIL");else if(!isAdministrator(auth.user!))return Response.json({error:"Você não possui acesso a este registro."},{status:403});
    const services=base.kind==="MAINTENANCE"?history.filter((item)=>item.kind==="MAINTENANCE"&&item.equipmentId===base.equipmentId&&item.workOrder===base.workOrder&&item.date===base.date):[base];
    const equipment=base.equipmentId?await d1.prepare(`SELECT prefix,brand,model FROM equipment WHERE id=?`).bind(base.equipmentId).first<Row>():await d1.prepare(`SELECT prefix,brand,model FROM equipment WHERE UPPER(TRIM(prefix))=UPPER(TRIM(?)) LIMIT 1`).bind(base.prefix).first<Row>();
    const reading=base.hours!==null&&base.km!==null?`${numberFormat.format(base.hours)} h · ${numberFormat.format(base.km)} km`:`${numberFormat.format(base.newReading??0)} ${base.unit==="KM"?"km":"h"}`;
    const pdf=createMaintenancePdf({title:base.kind==="IMPORTED"?"Histórico importado":"Comprovante de manutenção",equipment:String(equipment?.prefix??base.prefix),category:base.category,brand:String(equipment?.brand??""),model:String(equipment?.model??""),date:formatPdfDate(base.date),reading,services:services.map((item)=>item.service),notes:base.notes??"Sem observações.",responsible:base.responsible,workOrder:base.workOrder,generatedAt:formatPdfDate(new Date().toISOString())});
    const filename=`manutencao-${safeFilename(base.prefix)}-${base.sourceId}.pdf`;
    return new Response(pdf,{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="${filename}"`,"Cache-Control":"private, no-store"}});
  }catch(error){const access=equipmentAccessResponse(error);if(access)return access;console.error("[maintenance-pdf.get]",error);return Response.json({error:"Não foi possível gerar o PDF desta manutenção."},{status:500});}
}
