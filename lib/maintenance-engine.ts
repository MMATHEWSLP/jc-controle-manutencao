export type ControlType = "HOURS" | "KM" | "HOURS_KM";
export type PlanTriggerMode = "HOURS" | "KM" | "TIME" | "HOURS_OR_TIME" | "KM_OR_TIME";
export type MaintenanceLevel = "OK" | "WARNING" | "NEAR" | "OVERDUE";

export type AlertThresholds = {
  alertaHorasAmareloFim:number;
  alertaHorasLaranjaFim:number;
  alertaKmAmareloFim:number;
  alertaKmLaranjaFim:number;
  urgencyPercent:number;
};

export type CalculablePlan = {
  id:number;
  intervalHours:number|null;
  intervalKm:number|null;
  triggerMode:PlanTriggerMode;
  lastHours:number|null;
  lastKm:number|null;
  nextHours:number|null;
  nextKm:number|null;
};

export type PlanState = {
  configured:boolean;
  unit:"HOURS"|"KM";
  unitLabel:"h"|"km";
  currentValue:number;
  lastValue:number|null;
  interval:number|null;
  nextValue:number|null;
  remaining:number|null;
  overdue:number;
  used:number|null;
  health:number|null;
  level:MaintenanceLevel;
  label:"Normal"|"Atenção"|"Urgente"|"Vencido"|"Sem plano"|"Sem histórico";
  tone:"green"|"yellow"|"orange"|"red"|"critical"|"gray";
};

function finiteOrNull(value:number|null|undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function planUnit(plan:Pick<CalculablePlan,"triggerMode"|"intervalHours"|"intervalKm">):"HOURS"|"KM" {
  if (plan.triggerMode === "KM" || plan.triggerMode === "KM_OR_TIME") return "KM";
  if (plan.triggerMode === "HOURS" || plan.triggerMode === "HOURS_OR_TIME") return "HOURS";
  return finiteOrNull(plan.intervalKm) !== null ? "KM" : "HOURS";
}

export function calculatePlanState(
  plan:CalculablePlan,
  currentHours:number,
  currentKm:number,
  thresholds:AlertThresholds,
):PlanState {
  const unit=planUnit(plan);
  const currentValue=unit==="KM"?currentKm:currentHours;
  const interval=finiteOrNull(unit==="KM"?plan.intervalKm:plan.intervalHours);
  const lastValue=finiteOrNull(unit==="KM"?plan.lastKm:plan.lastHours);
  const storedNext=finiteOrNull(unit==="KM"?plan.nextKm:plan.nextHours);
  const nextValue=storedNext ?? (interval!==null&&lastValue!==null?lastValue+interval:null);
  const configured=interval!==null&&interval>0&&nextValue!==null;
  if(!configured){
    const label=interval!==null&&interval>0?"Sem histórico":"Sem plano";
    return {configured:false,unit,unitLabel:unit==="KM"?"km":"h",currentValue,lastValue,interval,nextValue:null,remaining:null,overdue:0,used:null,health:null,level:"OK",label,tone:"gray"};
  }

  const remaining=nextValue-currentValue;
  const overdue=Math.max(0,currentValue-nextValue);
  const used=lastValue===null?null:Math.max(0,currentValue-lastValue);
  const health=Math.max(0,Math.min(100,Math.round((remaining/interval)*100)));
  const warning=unit==="KM"?thresholds.alertaKmAmareloFim:thresholds.alertaHorasAmareloFim;
  const urgencyLimit=interval*(Math.max(0,thresholds.urgencyPercent)/100);
  if(remaining<0&&overdue>urgencyLimit)return {configured:true,unit,unitLabel:unit==="KM"?"km":"h",currentValue,lastValue,interval,nextValue,remaining,overdue,used,health,level:"NEAR",label:"Urgente",tone:"critical"};
  if(remaining<0)return {configured:true,unit,unitLabel:unit==="KM"?"km":"h",currentValue,lastValue,interval,nextValue,remaining,overdue,used,health,level:"OVERDUE",label:"Vencido",tone:"red"};
  if(remaining<=warning)return {configured:true,unit,unitLabel:unit==="KM"?"km":"h",currentValue,lastValue,interval,nextValue,remaining,overdue,used,health,level:"WARNING",label:"Atenção",tone:"yellow"};
  return {configured:true,unit,unitLabel:unit==="KM"?"km":"h",currentValue,lastValue,interval,nextValue,remaining,overdue,used,health,level:"OK",label:"Normal",tone:"green"};
}

export function alertMessage(prefix:string,maintenanceName:string,state:PlanState) {
  if(!state.configured||state.remaining===null||state.nextValue===null)return state.interval!==null&&state.interval>0
    ?`${prefix} · ${maintenanceName}: última troca não informada no Histórico.`
    :`${prefix} · ${maintenanceName}: plano ainda não configurado.`;
  const formatter=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});
  if(state.level==="NEAR")return `${prefix} · ${maintenanceName} urgente — vencida há ${formatter.format(state.overdue)} ${state.unitLabel}.`;
  if(state.level==="OVERDUE")return `${prefix} · ${maintenanceName} vencida há ${formatter.format(state.overdue)} ${state.unitLabel}.`;
  return `${prefix} · ${maintenanceName}: faltam ${formatter.format(state.remaining)} ${state.unitLabel}.`;
}

export function levelPriority(level:MaintenanceLevel) {
  return level==="NEAR"?0:level==="OVERDUE"?1:level==="WARNING"?2:3;
}
