import { getD1,type D1DatabaseLike } from "../../../db";
import { assertSameOrigin,authorize } from "../../../lib/auth";
import { ReadingOperationError,saveReading } from "../../../lib/readings";
import { allowedEquipmentIds } from "../../../lib/front-scope";

type Row=Record<string,unknown>;
type RawImportRow={rowNumber:unknown;equipment:unknown;reading:unknown;readingRaw:unknown;responsible:unknown;readingDate?:unknown;notes?:unknown;front?:unknown};
type PreviewStatus="READY"|"WARNING"|"ERROR";
type PreviewRow={rowNumber:number;equipmentInput:string;equipmentId:number|null;prefix:string;equipment:string;reading:number|null;readingRaw:string;unit:"HOURS"|"KM"|"HOURS_KM"|null;currentReading:number|null;responsible:string;readingDate:string|null;notes:string;front:string;serviceFrontId:number|null;status:PreviewStatus;code:string;message:string;ready:boolean};

const clean=(value:unknown)=>typeof value==="string"?value.trim():String(value??"").trim();
const normalized=(value:unknown)=>clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]/g,"");
const numberOrNull=(value:unknown)=>{if(value===null||value===undefined||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
const isoOrNull=(value:unknown)=>{const raw=clean(value);if(!raw)return null;const date=new Date(raw);return Number.isNaN(date.getTime())?null:date.toISOString();};

function invalid(base:Partial<PreviewRow>,status:PreviewStatus,code:string,message:string,ready=false):PreviewRow{return {rowNumber:Number(base.rowNumber??0),equipmentInput:String(base.equipmentInput??""),equipmentId:base.equipmentId??null,prefix:base.prefix??"—",equipment:base.equipment??"Não identificado",reading:base.reading??null,readingRaw:base.readingRaw??"",unit:base.unit??null,currentReading:base.currentReading??null,responsible:base.responsible??"",readingDate:base.readingDate??null,notes:base.notes??"",front:base.front??"",serviceFrontId:base.serviceFrontId??null,status,code,message,ready};}

async function analyzeRows(d1:D1DatabaseLike,rawRows:RawImportRow[],allowed:Set<number>){
  const [equipmentResult,userResult,frontResult]=await Promise.all([
    d1.prepare(`SELECT id,prefix,type,brand,model,current_hours,current_km,control_type,status,service_front_id FROM equipment ORDER BY prefix`).all<Row>(),
    d1.prepare(`SELECT name,username FROM users WHERE status='ACTIVE'`).all<Row>(),
    d1.prepare(`SELECT id,name FROM service_fronts WHERE active=1`).all<Row>(),
  ]);
  const equipmentByKey=new Map<string,Row[]>();for(const equipment of equipmentResult.results){if(!allowed.has(Number(equipment.id)))continue;const key=normalized(equipment.prefix),items=equipmentByKey.get(key)??[];items.push(equipment);equipmentByKey.set(key,items);}
  const responsibleKeys=new Set<string>();for(const user of userResult.results){responsibleKeys.add(normalized(user.name));responsibleKeys.add(normalized(user.username));}
  const frontByKey=new Map(frontResult.results.map((front)=>[normalized(front.name),front]));const inputCounts=new Map<string,number>();for(const row of rawRows){const key=normalized(row.equipment);inputCounts.set(key,(inputCounts.get(key)??0)+1);}
  return rawRows.map((raw,index):PreviewRow=>{
    const rowNumber=Math.max(1,Number(raw.rowNumber)||index+2),equipmentInput=clean(raw.equipment),reading=numberOrNull(raw.reading),readingRaw=clean(raw.readingRaw)||clean(raw.reading),responsible=clean(raw.responsible),readingDate=isoOrNull(raw.readingDate),notes=clean(raw.notes),front=clean(raw.front);const key=normalized(equipmentInput);const matches=equipmentByKey.get(key)??[];
    const base={rowNumber,equipmentInput,reading,readingRaw,responsible,readingDate,notes,front};
    if(!equipmentInput)return invalid(base,"ERROR","EQUIPMENT_EMPTY","Equipamento não informado.");
    if(matches.length===0)return invalid(base,"ERROR","EQUIPMENT_NOT_FOUND","Equipamento não encontrado na base completa.");
    if(matches.length>1)return invalid(base,"WARNING","EQUIPMENT_AMBIGUOUS","Mais de um equipamento corresponde a este prefixo. Revise a linha.");
    const equipment=matches[0],unit=String(equipment.control_type) as "HOURS"|"KM"|"HOURS_KM",currentReading=unit==="KM"?Number(equipment.current_km):unit==="HOURS"?Number(equipment.current_hours):null;const serviceFront=front?frontByKey.get(normalized(front)):null;
    const resolved={...base,equipmentId:Number(equipment.id),prefix:String(equipment.prefix),equipment:`${String(equipment.brand)} ${String(equipment.model)}`.trim(),unit,currentReading,serviceFrontId:Number(equipment.service_front_id)||null};
    if(inputCounts.get(key)!==1)return invalid(resolved,"WARNING","DUPLICATE_IN_FILE","Equipamento duplicado no arquivo. Nenhuma das linhas duplicadas será atualizada.");
    if(String(equipment.status)!=="ACTIVE")return invalid(resolved,"ERROR","EQUIPMENT_INACTIVE","Equipamento inativo, parado ou em manutenção.");
    if(unit==="HOURS_KM")return invalid(resolved,"WARNING","DUAL_CONTROL","Este equipamento controla horas e KM; uma única coluna LEITURA não define qual valor atualizar.");
    if(reading===null||reading<0)return invalid(resolved,"ERROR","INVALID_READING","Leitura inválida. Use somente um valor numérico válido.");
    if(!responsible)return invalid(resolved,"ERROR","RESPONSIBLE_EMPTY","Responsável não informado.");
    if(reading<currentReading!)return invalid(resolved,"WARNING","READING_REGRESSION","Leitura inferior à atual. A linha foi bloqueada por segurança.");
    if(reading===currentReading)return invalid(resolved,"WARNING","READING_UNCHANGED","A leitura é igual à atual; não há atualização para realizar.");
    if(front&&!serviceFront)return invalid(resolved,"WARNING","FRONT_NOT_FOUND","Frente não identificada; a leitura está pronta e manterá a frente atual.",true);
    if(serviceFront&&Number(serviceFront.id)!==Number(equipment.service_front_id))return invalid(resolved,"WARNING","FRONT_MISMATCH","A frente informada diverge da frente atual do equipamento. Revise a linha.");
    if(!responsibleKeys.has(normalized(responsible)))return invalid(resolved,"WARNING","RESPONSIBLE_UNIDENTIFIED","Responsável não cadastrado; o nome será mantido como texto.",true);
    return invalid(resolved,"READY","READY","Pronto para importar.",true);
  });
}

function summary(rows:PreviewRow[]){return {total:rows.length,ready:rows.filter((row)=>row.ready).length,warnings:rows.filter((row)=>row.status==="WARNING").length,errors:rows.filter((row)=>row.status==="ERROR").length,blocked:rows.filter((row)=>!row.ready).length};}

export async function POST(request:Request){
  if(!assertSameOrigin(request))return Response.json({error:"Origem da solicitação não autorizada."},{status:403});const auth=await authorize(request,"meter.create");if(auth.response)return auth.response;
  try{
    const body=await request.json() as {action?:unknown;fileName?:unknown;rows?:RawImportRow[]};const action=clean(body.action).toUpperCase(),fileName=clean(body.fileName).slice(0,180)||"leituras.xlsx";const rawRows=Array.isArray(body.rows)?body.rows.slice(0,1000):[];
    if(!rawRows.length)return Response.json({error:"O arquivo não possui linhas para analisar."},{status:400});if((body.rows?.length??0)>1000)return Response.json({error:"Importe no máximo 1.000 linhas por arquivo."},{status:400});
    const d1=await getD1();const preview=await analyzeRows(d1,rawRows,await allowedEquipmentIds(d1,auth.user!,"OIL"));if(action==="ANALYZE")return Response.json({fileName,rows:preview,summary:summary(preview)});
    if(action!=="CONFIRM")return Response.json({error:"Ação de importação inválida."},{status:400});
    const ready=preview.filter((row)=>row.ready&&row.equipmentId&&row.unit!=="HOURS_KM"&&row.reading!==null);const results:Array<{row:PreviewRow;ok:boolean;error?:string}>=[];
    for(let offset=0;offset<ready.length;offset+=8){const chunk=ready.slice(offset,offset+8);results.push(...await Promise.all(chunk.map(async(row)=>{try{await saveReading(d1,{equipmentId:row.equipmentId!,readingDate:row.readingDate??new Date().toISOString(),hours:row.unit==="HOURS"?row.reading:null,km:row.unit==="KM"?row.reading:null,operator:row.responsible,notes:row.notes||`Importado do arquivo ${fileName}`,serviceFrontId:row.serviceFrontId,authorizeRegression:false,actor:{id:auth.user!.id,name:auth.user!.name,profile:auth.user!.profile},source:"EXCEL_IMPORT"});return {row,ok:true};}catch(error){return {row,ok:false,error:error instanceof ReadingOperationError?error.message:"Falha inesperada ao salvar esta linha."};}})));
    }
    const runtimeErrors=results.filter((result)=>!result.ok).map((result)=>({...result.row,status:"ERROR" as const,code:"SAVE_ERROR",message:result.error??"Falha ao salvar.",ready:false}));const blocked=preview.filter((row)=>!row.ready);const errors=[...blocked,...runtimeErrors];const updated=results.filter((result)=>result.ok).length,skipped=blocked.filter((row)=>row.status==="WARNING").length,errorCount=blocked.filter((row)=>row.status==="ERROR").length+runtimeErrors.length;const now=new Date().toISOString();
    await d1.batch([
      d1.prepare(`INSERT INTO reading_imports (file_name,imported_by,total_rows,ready_rows,updated_rows,skipped_rows,error_rows,errors_json,imported_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(fileName,auth.user!.id,preview.length,ready.length,updated,skipped,errorCount,JSON.stringify(errors.map((row)=>({rowNumber:row.rowNumber,equipment:row.equipmentInput,reading:row.readingRaw,error:row.message}))),now,now,now),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at) VALUES (?,?,?,?,?,?,?)`).bind(auth.user!.id,"READING_IMPORT",`${now}:${fileName}`,"IMPORTAÇÃO EXCEL",null,JSON.stringify({fileName,total:preview.length,ready:ready.length,updated,skipped,errors:errorCount}),now),
    ]);
    return Response.json({ok:true,fileName,updated,skipped,errors:errorCount,total:preview.length,errorRows:errors});
  }catch(error){console.error("[reading-imports.post]",error);return Response.json({error:"Não foi possível processar a importação. Nenhuma linha incompleta foi aplicada."},{status:500});}
}
