import type { D1DatabaseLike } from "../db";

type Row = Record<string, unknown>;

export type HistoryEntry = {
  id:string;
  sourceId:number;
  maintenanceId:number|null;
  maintenanceTypeId:number|null;
  kind:"MAINTENANCE"|"READING"|"IMPORTED";
  date:string;
  recordedAt:string;
  equipmentId:number|null;
  prefix:string;
  equipmentCategory:string;
  front:string|null;
  action:string;
  category:string;
  service:string;
  previousReading:number|null;
  newReading:number|null;
  hours:number|null;
  km:number|null;
  interval:number|null;
  nextReading:number|null;
  unit:"HOURS"|"KM";
  method:string;
  responsible:string;
  workOrder:string;
  notes:string|null;
  cost:number;
};

const numberOrNull=(value:unknown)=>value===null||value===undefined?null:Number(value);
const textOrNull=(value:unknown)=>value===null||value===undefined?null:String(value);
const asIso=(value:unknown)=>{
  if(value===null||value===undefined||value==="")return "";
  const raw=String(value??"");
  const date=new Date(raw.length===10?`${raw}T12:00:00Z`:raw);
  return Number.isNaN(date.getTime())?raw:date.toISOString();
};

export async function loadHistoryEntries(d1:D1DatabaseLike):Promise<HistoryEntry[]> {
  const [maintenanceResult,readingResult,importedResult]=await Promise.all([
    d1.prepare(`SELECT m.id,m.equipment_id,m.maintenance_type_id,m.performed_at,m.hours,m.km,m.mechanic,m.work_order,m.cost,m.notes,m.created_at,
      e.prefix,e.type AS equipment_category,e.control_type,t.name AS maintenance_name,t.category AS maintenance_category,
      p.trigger_mode,p.interval_hours,p.interval_km,COALESCE(m.mechanic,u.name,'Não informado') AS responsible,sf.name AS historical_front
      FROM maintenances m
      INNER JOIN equipment e ON e.id=m.equipment_id
      INNER JOIN maintenance_types t ON t.id=m.maintenance_type_id
      LEFT JOIN maintenance_plans p ON p.id=m.plan_id
      LEFT JOIN service_fronts sf ON sf.id=m.service_front_id
      LEFT JOIN users u ON u.id=m.created_by
      ORDER BY m.created_at DESC,m.id DESC LIMIT 2000`).all() as Promise<{results:Row[]}>,
    d1.prepare(`SELECT r.id,r.equipment_id,r.reading_date,r.hours,r.km,r.operator,r.notes,r.source,r.created_at,
      e.prefix,e.type AS equipment_category,e.control_type,COALESCE(r.operator,u.name,'Não informado') AS responsible,sf.name AS historical_front
      FROM meter_readings r INNER JOIN equipment e ON e.id=r.equipment_id
      LEFT JOIN service_fronts sf ON sf.id=r.service_front_id
      LEFT JOIN users u ON u.id=r.created_by
      ORDER BY r.created_at DESC,r.id DESC LIMIT 2000`).all() as Promise<{results:Row[]}>,
    d1.prepare(`SELECT h.id,h.prefix,h.service,h.reading_value,h.control_type,h.performed_at,h.source,h.import_type,h.notes,h.created_at,
      COALESCE(e.id,legacy_e.id) AS equipment_id,COALESCE(e.type,legacy_e.type) AS equipment_category,
      COALESCE(t.id,legacy_t.id) AS maintenance_type_id,c.category AS interval_category,c.interval_value,NULL AS historical_front
      FROM imported_maintenance_history h
      LEFT JOIN equipment e ON e.id=h.equipment_id
      LEFT JOIN equipment legacy_e ON h.equipment_id IS NULL
        AND UPPER(REPLACE(REPLACE(REPLACE(TRIM(legacy_e.prefix),' ',''),'–','-'),'—','-'))=UPPER(REPLACE(REPLACE(REPLACE(TRIM(h.prefix),' ',''),'–','-'),'—','-'))
      LEFT JOIN maintenance_types t ON t.id=h.maintenance_type_id
      LEFT JOIN maintenance_types legacy_t ON h.maintenance_type_id IS NULL AND LOWER(TRIM(legacy_t.description))=LOWER(TRIM(h.service))
      LEFT JOIN maintenance_interval_configs c ON c.maintenance_type_id=COALESCE(t.id,legacy_t.id) AND c.active=1 AND c.unit=h.control_type
        AND c.category=UPPER(CASE WHEN instr(h.prefix,'-')>0 THEN substr(h.prefix,1,instr(h.prefix,'-')-1) ELSE h.prefix END)
      ORDER BY h.created_at DESC,h.id DESC LIMIT 2000`).all() as Promise<{results:Row[]}>,
  ]);

  const maintenances:HistoryEntry[]=maintenanceResult.results.map((row)=>{
    const unit:string=String(row.trigger_mode)==="KM"||(!row.trigger_mode&&String(row.control_type)==="KM")?"KM":"HOURS";
    const reading=numberOrNull(unit==="KM"?row.km:row.hours);
    const interval=numberOrNull(unit==="KM"?row.interval_km:row.interval_hours);
    return {
      id:`M-${row.id}`,sourceId:Number(row.id),maintenanceId:Number(row.id),maintenanceTypeId:Number(row.maintenance_type_id),kind:"MAINTENANCE",date:asIso(row.performed_at),recordedAt:asIso(row.created_at),
      equipmentId:Number(row.equipment_id),prefix:String(row.prefix),equipmentCategory:String(row.equipment_category??"Sem categoria cadastrada"),
      front:textOrNull(row.historical_front),
      action:String(row.maintenance_name).toUpperCase().includes("FILTRO")?"TROCA DE FILTRO":"TROCA DE ÓLEO",
      category:String(row.maintenance_category),service:String(row.maintenance_name),previousReading:null,newReading:reading,hours:numberOrNull(row.hours),km:numberOrNull(row.km),
      interval,nextReading:reading!==null&&interval!==null?reading+interval:null,unit:unit as "HOURS"|"KM",method:"MANUAL",
      responsible:String(row.responsible),workOrder:String(row.work_order),notes:textOrNull(row.notes),cost:Number(row.cost??0),
    };
  });
  const readings:HistoryEntry[]=readingResult.results.map((row)=>{
    const unit:string=String(row.control_type)==="KM"?"KM":"HOURS";const source=String(row.source??"MANUAL");const method=source==="EXCEL_IMPORT"?"IMPORTAÇÃO EXCEL":source==="QR_CODE"?"QR CODE":source==="MAINTENANCE"?"MANUTENÇÃO":"MANUAL";
    return {
      id:`R-${row.id}`,sourceId:Number(row.id),maintenanceId:null,maintenanceTypeId:null,kind:"READING",date:asIso(row.reading_date),recordedAt:asIso(row.created_at),equipmentId:Number(row.equipment_id),prefix:String(row.prefix),equipmentCategory:String(row.equipment_category??"Sem categoria cadastrada"),
      front:textOrNull(row.historical_front),
      action:String(row.control_type)==="KM"?"ATUALIZAÇÃO DE KM":String(row.control_type)==="HOURS_KM"?"ATUALIZAÇÃO DE HORÍMETRO / KM":"ATUALIZAÇÃO DE HORÍMETRO",
      category:"LEITURA",service:`Leitura operacional · ${method}`,previousReading:null,newReading:numberOrNull(unit==="KM"?row.km:row.hours),hours:numberOrNull(row.hours),km:numberOrNull(row.km),interval:null,nextReading:null,
      unit:unit as "HOURS"|"KM",method,responsible:String(row.responsible),workOrder:"—",notes:textOrNull(row.notes),cost:0,
    };
  });
  const imported:HistoryEntry[]=importedResult.results.map((row)=>{
    const reading=numberOrNull(row.reading_value);const interval=numberOrNull(row.interval_value);
    return {
      id:`I-${row.id}`,sourceId:Number(row.id),maintenanceId:null,maintenanceTypeId:numberOrNull(row.maintenance_type_id),kind:"IMPORTED",date:asIso(row.performed_at),recordedAt:asIso(row.created_at),
      equipmentId:row.equipment_id===null||row.equipment_id===undefined?null:Number(row.equipment_id),prefix:String(row.prefix),equipmentCategory:String(row.equipment_category??"Sem categoria cadastrada"),
      front:textOrNull(row.historical_front),
      action:"TROCA DE ÓLEO",category:String(row.interval_category??String(row.prefix).split("-")[0]).toUpperCase(),service:String(row.service),
      previousReading:null,newReading:reading,hours:String(row.control_type)==="KM"?null:reading,km:String(row.control_type)==="KM"?reading:null,interval,nextReading:reading!==null&&interval!==null?reading+interval:null,
      unit:String(row.control_type)==="KM"?"KM":"HOURS",
      method:String(row.source)==="CONTROLE_DA_JANETE"?"IMPORTAÇÃO HISTÓRICA · CONTROLE DA JANETE":"IMPORTAÇÃO HISTÓRICA",
      responsible:String(row.source)==="CONTROLE_DA_JANETE"?"Controle da Janete":"Importado da planilha",
      workOrder:"—",notes:textOrNull(row.notes),cost:0,
    };
  });
  return [...maintenances,...readings,...imported].sort((a,b)=>new Date(b.recordedAt).getTime()-new Date(a.recordedAt).getTime()||new Date(b.date).getTime()-new Date(a.date).getTime());
}
