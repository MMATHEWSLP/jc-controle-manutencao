"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Image from "next/image";
import styles from "./qr-page.module.css";

type PlanState={configured:boolean;unit:"HOURS"|"KM";unitLabel:"h"|"km";currentValue:number;lastValue:number|null;interval:number|null;nextValue:number|null;remaining:number|null;overdue:number;health:number|null;level:"OK"|"WARNING"|"NEAR"|"OVERDUE";label:string;tone:string};
type QrPlan={id:number;maintenanceTypeId:number;name:string;category:string;lastDate:string|null;state:PlanState};
type QrHistory={id:string;date:string;service:string;reading:number|null;unit:"HOURS"|"KM";responsible:string;workOrder:string;kind:"MAINTENANCE"|"IMPORTED"};
type QrData={generatedAt:string;equipment:{id:number;prefix:string;type:string;brand:string;model:string;category:string;control:"HOURS"|"KM"|"HOURS_KM";currentHours:number;currentKm:number;updatedAt:string;situation:string;tone:string};plans:QrPlan[];history:QrHistory[];viewer:{authenticated:boolean;name:string|null;canUpdateReading:boolean;canRegisterMaintenance:boolean;isAdmin:boolean}};

const statusLabels:Record<PlanState["level"],string>={OK:"NORMAL",WARNING:"PRÓXIMA TROCA",NEAR:"URGENTE",OVERDUE:"VENCIDA"};
const formatNumber=(value:number|null|undefined)=>value===null||value===undefined?"—":value.toLocaleString("pt-BR",{maximumFractionDigits:1});
const formatDate=(value:string,withTime=false)=>{if(!value)return "Sem data";const date=new Date(value);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",withTime?{dateStyle:"short",timeStyle:"short"}:{dateStyle:"short"}).format(date);};
const localDateTime=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
const friendlyName=(value:string)=>value.replace(/^TROCA DE ÓLEO (DO|DA|DOS|DAS) /," ").replace(/^TROCA (DO|DA|DOS|DAS) /," ").trim();

async function fetchJson<T>(url:string,options?:RequestInit){
  const response=await fetch(url,{cache:"no-store",...options});let data:Record<string,unknown>={};
  try{data=await response.json() as Record<string,unknown>;}catch{/* resposta inválida tratada abaixo */}
  if(!response.ok)throw Object.assign(new Error(String(data.error??"Não foi possível concluir a operação.")),{data,status:response.status});
  return data as T;
}

export default function QrEquipmentPage({token}:{token:string}){
  const [data,setData]=useState<QrData|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [notice,setNotice]=useState("");
  const [action,setAction]=useState<"reading"|"maintenance"|null>(null);const [selected,setSelected]=useState<number[]>([]);const [busy,setBusy]=useState(false);const [formError,setFormError]=useState("");const [showAllHistory,setShowAllHistory]=useState(false);
  const load=useCallback(async()=>{setError("");try{setData(await fetchJson<QrData>(`/api/qr/${encodeURIComponent(token)}`));}catch(problem){setError(problem instanceof Error?problem.message:"Não foi possível carregar o equipamento.");}finally{setLoading(false);}},[token]);
  useEffect(()=>{load();const timer=window.setInterval(load,60000);return()=>window.clearInterval(timer);},[load]);
  const reading=useMemo(()=>data?(data.equipment.control==="KM"?data.equipment.currentKm:data.equipment.currentHours):0,[data]);
  const unit=data?.equipment.control==="KM"?"km":"h";
  const historyRows=data?.history.slice(0,showAllHistory?100:6)??[];
  const flash=(message:string)=>{setNotice(message);window.setTimeout(()=>setNotice(""),3500);};

  async function saveReading(event:FormEvent<HTMLFormElement>,authorized=false){
    event.preventDefault();if(!data)return;setBusy(true);setFormError("");const form=new FormData(event.currentTarget);
    const payload={equipmentId:data.equipment.id,readingDate:form.get("readingDate"),hours:data.equipment.control!=="KM"?form.get("reading"):undefined,km:data.equipment.control==="KM"?form.get("reading"):undefined,operator:data.viewer.name,notes:"Atualização realizada pela página do QR Code",source:"QR_CODE",authorizeRegression:authorized};
    try{await fetchJson("/api/readings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});await load();setAction(null);flash("Leitura atualizada e manutenções recalculadas.");}
    catch(problem){const typed=problem as Error&{data?:{requiresConfirmation?:boolean}};if(typed.data?.requiresConfirmation&&data.viewer.isAdmin&&window.confirm(`${typed.message}\n\nConfirmar como administrador?`)){setBusy(false);return saveReading(event,true);}setFormError(typed.message);}
    finally{setBusy(false);}
  }

  async function saveMaintenance(event:FormEvent<HTMLFormElement>,authorized=false){
    event.preventDefault();if(!data)return;if(!selected.length){setFormError("Selecione pelo menos uma manutenção realizada.");return;}setBusy(true);setFormError("");const form=new FormData(event.currentTarget);
    const payload={equipmentId:data.equipment.id,planIds:selected,performedAt:form.get("performedAt"),hours:data.equipment.control!=="KM"?form.get("reading"):undefined,km:data.equipment.control==="KM"?form.get("reading"):undefined,workOrder:form.get("workOrder"),cost:0,notes:"Troca registrada pela página do QR Code",authorizeRegression:authorized};
    try{await fetchJson("/api/maintenance",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});await load();setSelected([]);setAction(null);flash("Troca registrada no Histórico e novo ciclo iniciado.");}
    catch(problem){const typed=problem as Error&{data?:{requiresConfirmation?:boolean}};if(typed.data?.requiresConfirmation&&data.viewer.isAdmin&&window.confirm(`${typed.message}\n\nConfirmar como administrador?`)){setBusy(false);return saveMaintenance(event,true);}setFormError(typed.message);}
    finally{setBusy(false);}
  }

  if(loading)return <main className={styles.page}><div className={styles.loading}><span/>Carregando situação atual...</div></main>;
  if(error||!data)return <main className={styles.page}><section className={styles.errorCard}><strong>Não foi possível abrir este QR Code</strong><p>{error}</p><button onClick={load}>Tentar novamente</button></section></main>;
  return <main className={styles.page}>
    <header className={styles.topbar}><div className={styles.brand}><Image src="/jc-florestais-logo.png" alt="JC Florestais" width={113} height={51} priority unoptimized onError={(event)=>{event.currentTarget.style.display="none";}}/><div><strong>MANUTENÇÃO</strong><small>Gestão preventiva em tempo real</small></div></div><button onClick={load}>↻ Atualizar</button></header>
    <section className={styles.hero}><div><span className={styles.category}>{data.equipment.category}</span><h1>{data.equipment.prefix}</h1><p>{data.equipment.type} · {data.equipment.brand} {data.equipment.model}</p></div><div className={`${styles.overall} ${styles[data.equipment.tone]}`}><i/>{data.equipment.situation.toUpperCase()}</div></section>
    <section className={styles.readingCard}><div><span>{data.equipment.control==="KM"?"QUILOMETRAGEM ATUAL":"HORÍMETRO ATUAL"}</span><strong>{formatNumber(reading)} {unit}</strong></div><div><span>UNIDADE</span><strong>{data.equipment.control==="KM"?"QUILÔMETROS":"HORAS"}</strong></div><div><span>ÚLTIMA ATUALIZAÇÃO</span><strong>{formatDate(data.equipment.updatedAt,true)}</strong></div></section>
    <div className={styles.sectionHead}><div><span>SITUAÇÃO PREVENTIVA</span><h2>Trocas e manutenções</h2></div><small>Atualizado diretamente do banco em {formatDate(data.generatedAt,true)}</small></div>
    <section className={styles.planGrid}>{data.plans.map((plan)=>{const overdue=plan.state.level==="OVERDUE"||plan.state.level==="NEAR";return <article className={`${styles.planCard} ${styles[plan.state.tone]}`} key={plan.id}><div className={styles.planTitle}><span>{friendlyName(plan.name).slice(0,2)}</span><div><small>MANUTENÇÃO</small><h3>{friendlyName(plan.name)}</h3></div><b>{plan.state.configured?statusLabels[plan.state.level]:"SEM HISTÓRICO"}</b></div><dl><div><dt>Última troca</dt><dd>{formatNumber(plan.state.lastValue)} {plan.state.unitLabel}</dd></div><div><dt>Intervalo</dt><dd>{formatNumber(plan.state.interval)} {plan.state.unitLabel}</dd></div><div><dt>Próxima troca</dt><dd>{formatNumber(plan.state.nextValue)} {plan.state.unitLabel}</dd></div><div><dt>Leitura atual</dt><dd>{formatNumber(plan.state.currentValue)} {plan.state.unitLabel}</dd></div></dl><div className={styles.remaining}><span>{plan.state.level==="NEAR"?"URGENTE — VENCIDA HÁ":overdue?"VENCIDA HÁ":"FALTAM"}</span><strong>{formatNumber(overdue?plan.state.overdue:plan.state.remaining)} {plan.state.unitLabel}</strong></div></article>;})}</section>
    {data.plans.length===0&&<div className={styles.empty}>Nenhuma manutenção está configurada para este equipamento.</div>}
    <section className={styles.actions}><div><span>ATUALIZAÇÃO PELO CELULAR</span><h2>Ações autorizadas</h2><p>A consulta é pública. Alterações exigem usuário e permissão no sistema.</p></div>{data.viewer.authenticated?<div className={styles.actionButtons}>{data.viewer.canUpdateReading&&<button onClick={()=>{setAction(action==="reading"?null:"reading");setFormError("");}}>Atualizar KM/horímetro</button>}{data.viewer.canRegisterMaintenance&&<button className={styles.primaryAction} onClick={()=>{setAction(action==="maintenance"?null:"maintenance");setFormError("");}}>Registrar troca de óleo</button>}{!data.viewer.canUpdateReading&&!data.viewer.canRegisterMaintenance&&<small>Seu usuário não possui permissão para alterar este equipamento.</small>}</div>:<a className={styles.loginLink} href={`/?next=${encodeURIComponent(`/equipamento/qr/${token}`)}`}>Entrar para atualizar</a>}</section>
    {action==="reading"&&<form className={styles.mobileForm} onSubmit={saveReading}><h3>Atualizar leitura atual</h3><p>Leitura atual: <strong>{formatNumber(reading)} {unit}</strong></p><label>Nova leitura<div><input name="reading" type="number" min="0" step="0.1" defaultValue={reading} required/><span>{unit}</span></div></label><label>Data e hora<input name="readingDate" type="datetime-local" defaultValue={localDateTime()} required/></label>{formError&&<div className={styles.formError}>{formError}</div>}<div className={styles.formActions}><button type="button" onClick={()=>setAction(null)}>Cancelar</button><button className={styles.primaryAction} disabled={busy}>{busy?"Salvando...":"Salvar e recalcular"}</button></div></form>}
    {action==="maintenance"&&<form className={styles.mobileForm} onSubmit={saveMaintenance}><h3>Registrar troca de óleo</h3><p>Selecione um ou mais itens realizados.</p><div className={styles.checkList}>{data.plans.filter((plan)=>plan.state.interval!==null).map((plan)=><label className={selected.includes(plan.id)?styles.checked:""} key={plan.id}><input type="checkbox" checked={selected.includes(plan.id)} onChange={()=>setSelected((current)=>current.includes(plan.id)?current.filter((id)=>id!==plan.id):[...current,plan.id])}/><span><strong>{friendlyName(plan.name)}</strong><small>Próxima: {formatNumber(plan.state.nextValue)} {plan.state.unitLabel}</small></span></label>)}</div><label>Leitura no momento da troca<div><input name="reading" type="number" min="0" step="0.1" defaultValue={reading} required/><span>{unit}</span></div></label><label>Data e hora<input name="performedAt" type="datetime-local" defaultValue={localDateTime()} required/></label><label>Número da OS <small>(opcional)</small><input name="workOrder" placeholder="Gerado automaticamente se vazio"/></label>{formError&&<div className={styles.formError}>{formError}</div>}<div className={styles.formActions}><button type="button" onClick={()=>setAction(null)}>Cancelar</button><button className={styles.primaryAction} disabled={busy}>{busy?"Registrando...":"Confirmar troca"}</button></div></form>}
    <section className={styles.history}><div className={styles.sectionHead}><div><span>RASTREABILIDADE</span><h2>Histórico de manutenções</h2></div></div><div className={styles.historyList}>{historyRows.map((item)=><article key={item.id}><div><strong>{friendlyName(item.service)}</strong><span>{formatDate(item.date)} · {item.kind==="IMPORTED"?"Importado":item.responsible}</span></div><b>{formatNumber(item.reading)} {item.unit==="KM"?"km":"h"}</b></article>)}</div>{data.history.length===0&&<div className={styles.empty}>Nenhuma troca registrada no Histórico.</div>}{data.history.length>6&&<button className={styles.fullHistory} onClick={()=>setShowAllHistory(!showAllHistory)}>{showAllHistory?"Mostrar últimas trocas":"Ver histórico completo"}</button>}</section>
    <footer className={styles.footer}>Dados consultados em tempo real · Atualize a página para conferir novas leituras e trocas.</footer>{notice&&<div className={styles.toast}>✓ {notice}</div>}
  </main>;
}
