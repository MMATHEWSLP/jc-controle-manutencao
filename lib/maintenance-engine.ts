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

const quantityFormatter=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:1});

// Texto do saldo de um plano — usado por igual no card do equipamento, na
// ficha, na aba Plano de Manutenção, na Central de Alertas, no Dashboard e
// nos PDFs, para que a mesma combinação de leitura/última troca/intervalo
// nunca produza um texto diferente em telas diferentes.
export function planBalanceText(state:PlanState):string {
  if(state.interval===null)return "—";
  if(!Number.isFinite(state.currentValue))return "Leitura atual necessária";
  if(!state.configured||state.lastValue===null||state.nextValue===null||state.remaining===null)return "Histórico sem leitura suficiente para calcular";
  if(state.remaining>0)return `Faltam ${quantityFormatter.format(state.remaining)} ${state.unitLabel}`;
  if(state.remaining===0)return "Troca no limite atual";
  return `Vencida há ${quantityFormatter.format(Math.abs(state.remaining))} ${state.unitLabel}`;
}

export type EquipmentSituation="Vencido"|"Próximo"|"Em dia"|"Dados pendentes"|"Sem plano";
export type OverduePlanSummary={name:string;nextValue:number|null;overdue:number;unitLabel:"h"|"km"};
export type EquipmentHealthSummary={
  situation:EquipmentSituation;
  tone:"red"|"critical"|"yellow"|"green"|"pending"|"gray";
  health:number|null;
  counts:{normal:number;attention:number;overdue:number;pending:number};
  overduePlans:OverduePlanSummary[];
};

// Resumo de saúde preventiva do EQUIPAMENTO (card externo e quadro "Saúde
// preventiva" da ficha), calculado sempre a partir do PIOR estado entre os
// planos configurados — nunca de uma média, para que vencimento e urgência
// nunca fiquem escondidos atrás de planos que estão em dia:
//   1) Vencido        — existe ao menos um plano NEAR (urgente) ou OVERDUE;
//   2) Próximo        — nenhum vencido, mas existe algum WARNING;
//   3) Em dia         — todos os planos calculáveis (com histórico e
//                        intervalo) estão OK; a % de saúde é a do pior
//                        plano OK (mais próximo do limite, health mais baixo);
//   4) Dados pendentes — nenhum plano calculável, mas existe algum com
//                        intervalo configurado e sem histórico suficiente;
//   5) Sem plano      — não há nenhum plano com intervalo configurado.
// A % de saúde exibida é sempre a do plano usado para decidir o status
// (o mais crítico), nunca uma média entre planos — assim ela nunca contradiz
// o rótulo mostrado ao lado. Quando o status é "Dados pendentes" ou
// "Sem plano" não existe saldo numérico para mostrar, então health=null.
export function summarizeEquipmentHealth(plans:Array<{name:string;state:PlanState}>):EquipmentHealthSummary {
  const overdue=plans.filter(({state})=>state.level==="OVERDUE"||state.level==="NEAR");
  const attention=plans.filter(({state})=>state.level==="WARNING");
  const normal=plans.filter(({state})=>state.configured&&state.level==="OK");
  const pending=plans.filter(({state})=>!state.configured&&state.label==="Sem histórico");
  const counts={normal:normal.length,attention:attention.length,overdue:overdue.length,pending:pending.length};

  if(overdue.length>0){
    const sorted=[...overdue].sort((a,b)=>levelPriority(a.state.level)-levelPriority(b.state.level)||b.state.overdue-a.state.overdue);
    const worst=sorted[0].state;
    return {situation:"Vencido",tone:worst.tone as EquipmentHealthSummary["tone"],health:worst.health,counts,
      overduePlans:sorted.map(({name,state})=>({name,nextValue:state.nextValue,overdue:state.overdue,unitLabel:state.unitLabel}))};
  }
  if(attention.length>0){
    const worst=[...attention].sort((a,b)=>(a.state.remaining??0)-(b.state.remaining??0))[0].state;
    return {situation:"Próximo",tone:"yellow",health:worst.health,counts,overduePlans:[]};
  }
  if(normal.length>0){
    const worst=[...normal].sort((a,b)=>(a.state.health??100)-(b.state.health??100))[0].state;
    return {situation:"Em dia",tone:"green",health:worst.health,counts,overduePlans:[]};
  }
  if(pending.length>0)return {situation:"Dados pendentes",tone:"pending",health:null,counts,overduePlans:[]};
  return {situation:"Sem plano",tone:"gray",health:null,counts,overduePlans:[]};
}

// Vocabulário de status usado no detalhamento por plano da ficha (aba Plano
// de Manutenção). Deriva sempre do mesmo PlanState centralizado — nunca
// recalcula nada, só traduz o resultado já calculado para os rótulos
// pedidos nessa tela (Em dia/Próxima/Urgente/No limite/Vencida/Sem
// histórico/Dados insuficientes).
export function planDetailStatus(state:PlanState):{label:string;tone:string} {
  if(!state.configured)return state.label==="Sem histórico"?{label:"Sem histórico",tone:"gray"}:{label:"Dados insuficientes",tone:"gray"};
  if(state.level==="NEAR")return {label:"Urgente",tone:"critical"};
  if(state.level==="OVERDUE")return {label:"Vencida",tone:"red"};
  if(state.level==="WARNING")return {label:state.remaining===0?"No limite":"Próxima",tone:"yellow"};
  return {label:"Em dia",tone:"green"};
}

// Ordem exigida na ficha: vencidas (mais críticas primeiro) → urgentes/
// próximas → no limite → em dia → sem histórico/dados insuficientes.
export function planSortRank(state:PlanState) {
  if(state.level==="NEAR")return 0;
  if(state.level==="OVERDUE")return 1;
  if(state.level==="WARNING")return state.remaining===0?2:3;
  if(state.configured&&state.level==="OK")return 4;
  return 5;
}
