import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { createCategorizedMaintenanceReportPdf,formatPdfDate,type CategorizedReportItem,type ReportStatus } from "../../../lib/pdf";
import { recalculateMaintenanceCycles } from "../../../lib/maintenance-recalculation";
import { allowedEquipmentIds } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
const validStatuses=new Set<ReportStatus>(["OK","WARNING","NEAR","OVERDUE"]);
const validUnits=new Set(["HOURS","KM"]);
const statusLabels:Record<ReportStatus,string>={OK:"Normal",WARNING:"Perto de vencer",NEAR:"Urgente",OVERDUE:"Vencido"};

function list(search:URLSearchParams,key:string){return [...new Set(search.getAll(key).map((value)=>value.trim()).filter(Boolean))];}
function day(value:unknown){const raw=String(value??"");const parsed=new Date(raw);return Number.isNaN(parsed.getTime())?raw.slice(0,10):parsed.toISOString().slice(0,10);}
function periodLabel(from:string,to:string){if(from&&to)return `${from.split("-").reverse().join("/")} a ${to.split("-").reverse().join("/")}`;if(from)return `A partir de ${from.split("-").reverse().join("/")}`;if(to)return `Até ${to.split("-").reverse().join("/")}`;return "Situação atual da Central de Alertas";}
function numeric(value:unknown){if(value===null||value===undefined||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}

export async function GET(request:Request){
  const auth=await authorize(request,"alerts.view");if(auth.response)return auth.response;
  try{
    const url=new URL(request.url);const categories=list(url.searchParams,"category");const fronts=list(url.searchParams,"front");const equipmentIds=list(url.searchParams,"equipment").map(Number).filter((id)=>Number.isInteger(id)&&id>0);
    const statuses=list(url.searchParams,"status").filter((value):value is ReportStatus=>validStatuses.has(value as ReportStatus));
    const units=list(url.searchParams,"unit").filter((value)=>validUnits.has(value));const from=url.searchParams.get("from")?.trim()??"";const to=url.searchParams.get("to")?.trim()??"";const query=(url.searchParams.get("q")??"").trim().toLocaleLowerCase("pt-BR");
    const d1=await getD1();await recalculateMaintenanceCycles(d1,{notify:false});
    const [result,allowed]=await Promise.all([d1.prepare(`SELECT a.id,a.level,a.control_type,a.current_value,a.planned_value,a.remaining_value,a.overdue_value,a.generated_at,p.last_hours,p.last_km,
      e.id AS equipment_id,e.prefix,e.type AS equipment_category,e.brand,e.model,COALESCE(sf.name,'Sem frente') AS front,t.name AS maintenance_name
      FROM alerts a
      INNER JOIN equipment e ON e.id=a.equipment_id
      LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
      INNER JOIN maintenance_plans p ON p.id=a.plan_id
      INNER JOIN maintenance_types t ON t.id=p.maintenance_type_id
      INNER JOIN equipment_maintenance_types emt ON emt.equipment_id=p.equipment_id AND emt.maintenance_type_id=p.maintenance_type_id
      WHERE a.status='OPEN' AND p.active=1 AND emt.applicable=1 AND e.oil_change_enabled=1
      ORDER BY e.type,e.prefix,t.name`).all<Row>(),allowedEquipmentIds(d1,auth.user!,"OIL")]);
    const categorySet=new Set(categories);const frontSet=new Set(fronts);const equipmentSet=new Set(equipmentIds);const statusSet=new Set(statuses);const unitSet=new Set(units);
    const scoped=result.results.filter((row)=>allowed.has(Number(row.equipment_id)));const filtered=scoped.filter((row)=>{
      const category=String(row.equipment_category??"Sem categoria cadastrada");const status=String(row.level) as ReportStatus;const unit=String(row.control_type);const generatedDay=day(row.generated_at);
      if(frontSet.size&&!frontSet.has(String(row.front)))return false;if(categorySet.size&&!categorySet.has(category))return false;if(equipmentSet.size&&!equipmentSet.has(Number(row.equipment_id)))return false;
      if(statusSet.size&&!statusSet.has(status))return false;if(unitSet.size&&!unitSet.has(unit))return false;if(from&&generatedDay<from)return false;if(to&&generatedDay>to)return false;
      if(query&&!`${row.prefix} ${row.brand} ${row.model} ${row.front} ${row.maintenance_name} ${category}`.toLocaleLowerCase("pt-BR").includes(query))return false;
      return true;
    });
    const items:CategorizedReportItem[]=filtered.map((row)=>{
      const status=String(row.level) as ReportStatus;const unit=String(row.control_type) as "HOURS"|"KM";
      const remaining=numeric(row.remaining_value);const overdue=numeric(row.overdue_value);
      const hasExpired=status==="OVERDUE"||status==="NEAR";
      return {category:String(row.equipment_category??"Sem categoria cadastrada"),equipmentKey:String(row.equipment_id),prefix:String(row.prefix),equipment:`${String(row.brand??"")} ${String(row.model??"")}`.trim()||"Não informado",front:String(row.front),date:formatPdfDate(String(row.generated_at)),primary:String(row.maintenance_name),secondary:"",status,unit,currentValue:numeric(row.current_value),lastValue:numeric(unit==="KM"?row.last_km:row.last_hours),plannedValue:numeric(row.planned_value),differenceValue:hasExpired&&overdue!==null?-Math.abs(overdue):remaining===null?null:Math.max(0,remaining),responsible:""};
    });
    const selectedStatusLabel=statuses.length?statuses.map((status)=>statusLabels[status]).join(", "):"Todos";
    const onlyExpired=statuses.length>0&&statuses.every((status)=>status==="OVERDUE"||status==="NEAR");
    const title=onlyExpired?"Relatório de Manutenções Vencidas":statuses.length===1&&statuses[0]==="WARNING"?"Relatório de Manutenções Perto de Vencer":"Relatório da Central de Alertas";
    const equipmentLabels=equipmentIds.length?[...new Set(scoped.filter((row)=>equipmentSet.has(Number(row.equipment_id))).map((row)=>String(row.prefix)))].join(", "):"Todos";
    const unitLabels=units.length?units.map((unit)=>unit==="KM"?"KM":"Horas").join(", "):"Todas";
    const now=new Date();const pdf=createCategorizedMaintenanceReportPdf({title,kind:"ALERTS",items,generatedAt:formatPdfDate(now.toISOString()),filters:{period:periodLabel(from,to),status:selectedStatusLabel,categories:categories.length?categories.join(", "):"Todas as categorias",other:`Frentes: ${fronts.length?fronts.join(", "):"Todas"} · Equipamentos: ${equipmentLabels} · Unidades: ${unitLabels}${query?` · Pesquisa: ${query}`:""}`}});
    const suffix=onlyExpired?"vencidas":statuses.length===1&&statuses[0]==="WARNING"?"perto-de-vencer":"alertas";
    return new Response(pdf,{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="relatorio-${suffix}-${now.toISOString().slice(0,10)}.pdf"`,"Cache-Control":"private, no-store"}});
  }catch(error){console.error("[alerts-report-pdf.get]",error);return Response.json({error:"Não foi possível gerar o relatório da Central de Alertas."},{status:500});}
}
