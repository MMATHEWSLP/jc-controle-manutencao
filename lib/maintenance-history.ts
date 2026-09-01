import type { ControlType, PlanTriggerMode } from "./maintenance-engine";

export type MaintenanceHistoryCandidate={
  equipmentId:number;
  maintenanceTypeId:number;
  performedAt:string|null;
  reading:number;
  sourcePriority:number;
  unit:"HOURS"|"KM";
};

function normalizedText(value:unknown){
  return String(value??"")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toUpperCase()
    .replace(/[_–—-]+/g," ")
    .replace(/[^A-Z0-9 ]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}

export function canonicalEquipmentPrefix(value:unknown){
  return String(value??"")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toUpperCase()
    .trim()
    .replace(/[–—_]+/g,"-")
    .replace(/\s+/g,"")
    .replace(/-+/g,"-");
}

export function canonicalMaintenanceService(value:unknown){
  const normalized=normalizedText(value)
    .replace(/^TROCA DE OLEO (DO|DA|DOS|DAS|DE) /,"")
    .replace(/^TROCA DO OLEO (DO|DA|DOS|DAS|DE) /,"")
    .replace(/^TROCA (DO|DA|DOS|DAS|DE) /,"")
    .replace(/^OLEO (DO|DA|DOS|DAS|DE) /,"")
    .trim();
  if(normalized.includes("DIFERENCIAL")&&normalized.includes("DIANTEIR"))return "DIFERENCIAL DIANTEIRO";
  if(normalized.includes("DIFERENCIAL")&&normalized.includes("TRASEIR"))return "DIFERENCIAL TRASEIRO";
  if(normalized.includes("COMANDO")&&normalized.includes("FINAL"))return "COMANDO FINAL";
  if((normalized.includes("CAIXA")&&normalized.includes("REDU"))||normalized==="REDUTOR")return "CAIXA DE REDUCAO";
  if((normalized.includes("CAIXA")&&normalized.includes("MARCH"))||normalized.includes("CAMBIO"))return "CAIXA DE MARCHA";
  if(normalized.includes("TRANSMISSAO"))return "TRANSMISSAO";
  if(normalized.includes("HIDRAUL"))return "HIDRAULICO";
  if(normalized.includes("MOTOR"))return "MOTOR";
  return normalized;
}

function historyTime(value:string|null){
  if(!value)return 0;
  const parsed=new Date(value.length===10?`${value}T12:00:00Z`:value).getTime();
  return Number.isFinite(parsed)?parsed:0;
}

export function chooseLatestHistoryCandidate(current:MaintenanceHistoryCandidate|undefined,next:MaintenanceHistoryCandidate){
  if(!current)return next;
  const currentTime=historyTime(current.performedAt),nextTime=historyTime(next.performedAt);
  const dateDelta=nextTime-currentTime;
  if(dateDelta>0)return next;
  if(dateDelta<0)return current;
  if(next.reading>current.reading)return next;
  if(next.reading<current.reading)return current;
  return next.sourcePriority>current.sourcePriority?next:current;
}

export function reconcileEquipmentMeasurement(input:{
  prefix:unknown;
  type:unknown;
  controlType:ControlType;
  currentHours:number;
  currentKm:number;
  previousControlType?:ControlType|null;
}){
  const prefix=canonicalEquipmentPrefix(input.prefix);
  const type=normalizedText(input.type);
  const prefixRequiresKm=prefix.startsWith("CM-");
  const operationalKmTruck=type.includes("CAMINHAO")&&input.currentKm>0&&input.currentHours<=0;
  if(!prefixRequiresKm&&!operationalKmTruck)return {...input,changed:false};
  const mustMoveReading=input.controlType!=="KM"||Boolean(input.previousControlType&&input.previousControlType!=="KM");
  const currentKm=mustMoveReading&&input.currentHours>0?input.currentHours:input.currentKm;
  return {...input,controlType:"KM" as const,currentHours:mustMoveReading?0:input.currentHours,currentKm,changed:input.controlType!=="KM"||mustMoveReading};
}

export function maintenancePlanUnit(control:ControlType,configuredUnit:"HOURS"|"KM",storedMode:PlanTriggerMode|undefined,storedHours:number|null,storedKm:number|null){
  if(control==="HOURS"||control==="KM")return control;
  if(storedMode==="HOURS"&&storedHours!==null&&storedHours>0)return "HOURS";
  if(storedMode==="KM"&&storedKm!==null&&storedKm>0)return "KM";
  return configuredUnit;
}
