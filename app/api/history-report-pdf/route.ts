import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { loadHistoryEntries } from "../../../lib/history-data";
import { createCategorizedMaintenanceReportPdf,formatPdfDate,type CategorizedReportItem,type ReportStatus } from "../../../lib/pdf";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { allowedEquipmentIds,isAdministrator } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
const validStatuses=new Set<ReportStatus>(["OK","WARNING","NEAR","OVERDUE"]);
const validKinds=new Set(["MAINTENANCE","READING","IMPORTED"]);
const statusLabels:Record<ReportStatus,string>={OK:"Normal",WARNING:"Perto de vencer",NEAR:"Urgente",OVERDUE:"Vencido"};
const kindLabels:Record<string,string>={MAINTENANCE:"Manutenções",READING:"Leituras",IMPORTED:"Importados"};

function list(search:URLSearchParams,key:string){return [...new Set(search.getAll(key).map((value)=>value.trim()).filter(Boolean))];}
function periodLabel(from:string,to:string){if(from&&to)return `${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")}`;if(from)return `A partir de ${from.split("-").reverse().join("/")}`;if(to)return `Até ${to.split("-").reverse().join("/")}`;return "Todo o período disponível";}

export async function GET(request:Request){
  const auth=await authorize(request,"maintenance.history");if(auth.response)return auth.response;
  try{
    const url=new URL(request.url);const categories=list(url.searchParams,"category");const fronts=list(url.searchParams,"front");const equipmentIds=list(url.searchParams,"equipment").map(Number).filter((id)=>Number.isInteger(id)&&id>0);
    const statuses=list(url.searchParams,"status").filter((value):value is ReportStatus=>validStatuses.has(value as ReportStatus));const kinds=list(url.searchParams,"kind").filter((value)=>validKinds.has(value));
    const from=url.searchParams.get("from")?.trim()??"";const to=url.searchParams.get("to")?.trim()??"";const query=(url.searchParams.get("q")??"").trim().toLocaleLowerCase("pt-BR");
    const d1=await getD1();await recalculateMaintenanceCycles(d1,{notify:false});
    const [rawHistory,statusResult,allowed]=await Promise.all([
      loadHistoryEntries(d1),
      d1.prepare(`SELECT p.equipment_id,p.maintenance_type_id,a.level FROM alerts a INNER JOIN maintenance_plans p ON p.id=a.plan_id WHERE a.status='OPEN' AND p.active=1`).all<Row>(),
      allowedEquipmentIds(d1,auth.user!,"OIL"),
    ]);
    const history=rawHistory.filter((item)=>item.equipmentId!==null?allowed.has(item.equipmentId):isAdministrator(auth.user!));
    const statusByCycle=new Map<string,ReportStatus>();for(const row of statusResult.results)statusByCycle.set(`${row.equipment_id}:${row.maintenance_type_id}`,String(row.level) as ReportStatus);
    const categorySet=new Set(categories);const frontSet=new Set(fronts);const equipmentSet=new Set(equipmentIds);const statusSet=new Set(statuses);const kindSet=new Set(kinds);
    const filtered=history.filter((item)=>{
      const currentStatus=item.equipmentId&&item.maintenanceTypeId?statusByCycle.get(`${item.equipmentId}:${item.maintenanceTypeId}`)??null:null;const itemDay=item.date.slice(0,10);
      if(frontSet.size&&(!item.front||!frontSet.has(item.front)))return false;if(categorySet.size&&!categorySet.has(item.equipmentCategory))return false;if(equipmentSet.size&&(!item.equipmentId||!equipmentSet.has(item.equipmentId)))return false;if(kindSet.size&&!kindSet.has(item.kind))return false;
      if(statusSet.size&&(!currentStatus||!statusSet.has(currentStatus)))return false;if(from&&itemDay<from)return false;if(to&&itemDay>to)return false;
      if(query&&![item.prefix,item.equipmentCategory,item.action,item.category,item.service,item.responsible,item.workOrder].some((value)=>value.toLocaleLowerCase("pt-BR").includes(query)))return false;
      return true;
    });
    const items:CategorizedReportItem[]=filtered.map((item)=>({category:item.equipmentCategory,equipmentKey:String(item.equipmentId??item.prefix),prefix:item.prefix,equipment:"",front:item.front??"Frente não registrada",date:formatPdfDate(item.date),primary:item.action,secondary:item.service,status:item.equipmentId&&item.maintenanceTypeId?statusByCycle.get(`${item.equipmentId}:${item.maintenanceTypeId}`)??null:null,unit:item.unit,currentValue:item.newReading,plannedValue:item.nextReading,differenceValue:null,responsible:item.responsible}));
    const equipmentLabels=equipmentIds.length?[...new Set(history.filter((item)=>item.equipmentId&&equipmentSet.has(item.equipmentId)).map((item)=>item.prefix))].join(", "):"Todos";
    const kindLabel=kinds.length?kinds.map((kind)=>kindLabels[kind]).join(", "):"Todas as ações";const selectedStatusLabel=statuses.length?statuses.map((status)=>statusLabels[status]).join(", "):"Todos / sem status";
    const now=new Date();const pdf=createCategorizedMaintenanceReportPdf({title:"Relatório do Histórico de Manutenção",kind:"HISTORY",items,generatedAt:formatPdfDate(now.toISOString()),filters:{period:periodLabel(from,to),status:selectedStatusLabel,categories:categories.length?categories.join(", "):"Todas as categorias",other:`Frentes: ${fronts.length?fronts.join(", "):"Todas"} · Ações: ${kindLabel} · Equipamentos: ${equipmentLabels}${query?` · Pesquisa: ${query}`:""}`}});
    return new Response(pdf,{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="relatorio-historico-${now.toISOString().slice(0,10)}.pdf"`,"Cache-Control":"private, no-store"}});
  }catch(error){console.error("[history-report-pdf.get]",error);return Response.json({error:"Não foi possível gerar o relatório do Histórico."},{status:500});}
}
