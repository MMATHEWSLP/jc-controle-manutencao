"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- pré-visualização local (blob:) e fotos servidas por rota própria */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  emptyFueling, emptyTrip, MAX_FUELINGS, MAX_TRIPS, parseDecimal, readingLabel, resizeCards, validateDailyRecord,
  type DailyRecordDraft, type ProductionType, type ReadingUnit,
} from "../lib/daily-record-rules";
import { reportNetworkFailure } from "../lib/connectivity";
import { enqueue, listQueued, QUEUE_EVENT, removeQueued, syncQueue, type QueuedDailyRecord } from "../lib/offline-queue";
import { optimizePhoto } from "../lib/photo-client";

type EquipmentOption = { id:number; prefix:string; type:string; brand:string; model:string; serviceFrontId:number|null; front:string; readingUnit:ReadingUnit };
type Front = { id:number; name:string };
type Context = { equipment:EquipmentOption[]; fronts:Front[]; assignedEquipmentId:number|null; defaultServiceFrontId:number|null; userId:number; canRegister:boolean; canViewAll:boolean };
type LastReading = { value:number|null; unit:ReadingUnit; source:"DAILY_RECORD"|"EQUIPMENT"|"QUEUE"|null; date:string|null };
type RecordItem = {
  id:number; recordDate:string; prefix:string; operator:string; workedToday:boolean; noWorkReason:string|null; front:string|null; location:string|null;
  readingUnit:ReadingUnit; startReading:number|null; endReading:number|null; inactiveOrProblem:boolean; problemReason:string|null; hasProblemPhoto:boolean;
  hadProduction:boolean; productionType:ProductionType|null; hasProductionPhoto:boolean; notes:string|null;
  fuelings:Array<{number:number;liters:number;location:string}>; trips:Array<{number:number;logs:number;meters:number|null}>;
};
type Photo = { blob:Blob; url:string };
type Tab = "new" | "mine" | "all";

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
const numberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:2});
const unitSuffix=(unit:ReadingUnit)=>unit==="KM"?"km":"h";
const formatDay=(value:string|null)=>value?value.split("-").reverse().join("/"):"—";
function localToday() { const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`; }

function blankDraft(recordDate:string, equipmentId:number|null, serviceFrontId:number|null):DailyRecordDraft {
  return { recordDate, equipmentId, workedToday:true, noWorkReason:"", serviceFrontId, location:"", startReading:"", endReading:"",
    fuelingCount:"", fuelings:[], inactiveOrProblem:null, problemReason:"", hadProduction:null, productionType:null, tripCount:"", trips:[], notes:"",
    hasProblemPhoto:false, hasProductionPhoto:false };
}

export default function DailyControlView({ flash }:{ flash:(message:string)=>void }) {
  const [context,setContext]=useState<Context|null>(null);
  const [error,setError]=useState("");
  const [tab,setTab]=useState<Tab>("new");
  const load=useCallback(async()=>{ setError(""); try{ const result=await api<Context>("/api/daily-records/context"); setContext(result); if(!result.canRegister)setTab(result.canViewAll?"all":"mine"); }catch(problem){ setError(problem instanceof Error?problem.message:"Falha ao carregar."); } },[]);
  useEffect(()=>{ load(); },[load]);

  if(error) return <div className="operation-error"><span>!</span><div><strong>Falha ao carregar o Controle Diário</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>;
  if(!context) return <div className="page-loading"><span/><p>Carregando o Controle Diário...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">OPERAÇÃO · REGISTRO DO DIA</p><h1>Controle Diário</h1><span>Registro diário do equipamento: leituras, abastecimentos, problemas e produção.</span></div></div>
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação do Controle Diário">
      {context.canRegister && <button className={tab==="new"?"active":""} onClick={()=>setTab("new")}>Novo registro</button>}
      {context.canRegister && <button className={tab==="mine"?"active":""} onClick={()=>setTab("mine")}>Meus registros</button>}
      {context.canViewAll && <button className={tab==="all"?"active":""} onClick={()=>setTab("all")}>Todos os registros</button>}
    </div>
    {context.canRegister && <PendingQueue userId={context.userId}/>}
    {tab==="new" && context.canRegister ? <DailyForm context={context} flash={flash} onSent={()=>setTab("mine")}/> : <RecordsPanel scope={tab==="all"?"all":"mine"} equipment={context.equipment}/>}
  </>;
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------
function DailyForm({ context, flash, onSent }:{ context:Context; flash:(message:string)=>void; onSent:()=>void }) {
  const initialEquipment=context.equipment.find((item)=>item.id===context.assignedEquipmentId)??null;
  const [draft,setDraft]=useState<DailyRecordDraft>(()=>blankDraft(localToday(),initialEquipment?.id??null,initialEquipment?.serviceFrontId??context.defaultServiceFrontId));
  const [fromMemory,setFromMemory]=useState(Boolean(initialEquipment));
  const [lastReading,setLastReading]=useState<LastReading|null>(null);
  const [problemPhoto,setProblemPhoto]=useState<Photo|null>(null);
  const [productionPhoto,setProductionPhoto]=useState<Photo|null>(null);
  const [touched,setTouched]=useState<Set<string>>(new Set());
  const [showAll,setShowAll]=useState(false);
  const [reviewing,setReviewing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [submitError,setSubmitError]=useState("");
  const [readingNonce,setReadingNonce]=useState(0);
  const equipment=context.equipment.find((item)=>item.id===draft.equipmentId)??null;
  const unit=equipment?.readingUnit??"HOURS";

  const patch=useCallback((changes:Partial<DailyRecordDraft>)=>setDraft((current)=>({ ...current, ...changes })),[]);
  const touch=(field:string)=>setTouched((current)=>current.has(field)?current:new Set(current).add(field));

  // Autopreenche a leitura inicial sempre que o equipamento muda (o valor continua editável).
  useEffect(()=>{
    if(!draft.equipmentId){ setLastReading(null); return; }
    let cancelled=false;
    const equipmentId=draft.equipmentId;
    Promise.all([
      api<LastReading>(`/api/daily-records/last-reading?equipmentId=${equipmentId}`).catch(()=>null),
      listQueued(context.userId).catch(()=>[] as QueuedDailyRecord[]),
    ]).then(([fetched,queued])=>{
      // Registros ainda na fila do celular (sem internet) também contam como "última leitura".
      const pendingItem=queued.filter((item)=>item.summary.equipmentId===equipmentId&&item.summary.endReading!==null).sort((a,b)=>(b.summary.endReading??0)-(a.summary.endReading??0))[0];
      const result:LastReading|null=pendingItem&&(fetched?.value==null||pendingItem.summary.endReading!>fetched.value)
        ?{ value:pendingItem.summary.endReading, unit:fetched?.unit??"HOURS", source:"QUEUE", date:pendingItem.summary.recordDate }:fetched;
      if(cancelled)return; setLastReading(result);
      if(!result)return;
      setDraft((current)=>({ ...current, startReading:result.value===null?"":String(result.value).replace(".",",") }));
    });
    return ()=>{ cancelled=true; };
  },[draft.equipmentId,readingNonce,context.userId]);

  function selectEquipment(item:EquipmentOption) {
    if(item.id===draft.equipmentId)return;
    patch({ equipmentId:item.id, serviceFrontId:item.serviceFrontId??context.defaultServiceFrontId, startReading:"" });
    setFromMemory(false);
    // Troca de máquina: atualiza a "memória" para os próximos registros.
    api("/api/daily-records/assignment",{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ equipmentId:item.id }) }).catch(()=>undefined);
  }

  const setPhoto=(kind:"problem"|"production",photo:Photo|null)=>{
    const [current,setter]=kind==="problem"?[problemPhoto,setProblemPhoto]:[productionPhoto,setProductionPhoto];
    if(current)URL.revokeObjectURL(current.url);
    setter(photo);
  };

  const validation=useMemo(()=>validateDailyRecord({ ...draft, hasProblemPhoto:Boolean(problemPhoto), hasProductionPhoto:Boolean(productionPhoto) },localToday()),[draft,problemPhoto,productionPhoto]);
  const errorFor=(field:string)=>(showAll||touched.has(field))?validation.errors[field]:undefined;
  const pending=Object.values(validation.errors);

  function resetAfterSend() {
    setPhoto("problem",null); setPhoto("production",null);
    setDraft(blankDraft(localToday(),draft.equipmentId,draft.serviceFrontId));
    setTouched(new Set()); setShowAll(false); setReviewing(false); setFromMemory(true); setReadingNonce((value)=>value+1);
    onSent();
  }

  async function send() {
    if(!validation.value)return;
    setBusy(true); setSubmitError("");
    const payload=JSON.stringify(draft);
    const problemBlob=draft.workedToday&&draft.inactiveOrProblem&&problemPhoto?problemPhoto.blob:null;
    const productionBlob=draft.workedToday&&draft.hadProduction&&productionPhoto?productionPhoto.blob:null;
    // Sem sinal: guarda no celular (com as fotos) e envia sozinho quando a internet voltar.
    const saveOnPhone=async()=>{
      reportNetworkFailure();
      await enqueue({ userId:context.userId, payload, problemPhoto:problemBlob, productionPhoto:productionBlob,
        summary:{ prefix:equipment?.prefix??"", recordDate:draft.recordDate, equipmentId:draft.equipmentId, endReading:draft.workedToday?parseDecimal(draft.endReading):null } });
      flash("Sem internet: registro salvo no celular. Ele será enviado automaticamente quando o sinal voltar.");
      resetAfterSend();
    };
    try {
      const form=new FormData();
      form.set("payload",payload);
      if(problemBlob)form.set("problemPhoto",problemBlob,"problema.webp");
      if(productionBlob)form.set("productionPhoto",productionBlob,"producao.webp");
      let response:Response;
      // Não confia em navigator.onLine (no iPhone ele diz "online" mesmo em modo avião): tenta
      // enviar e, se a rede falhar ou demorar demais (sinal fraco), guarda no celular.
      const controller=new AbortController(); const timer=window.setTimeout(()=>controller.abort(),45_000);
      try { response=await fetch("/api/daily-records",{ method:"POST", body:form, signal:controller.signal }); }
      catch {
        try { await saveOnPhone(); }
        catch { throw new Error("Sem internet e não foi possível guardar no celular. Libere o armazenamento do navegador e tente de novo."); }
        return;
      }
      finally { window.clearTimeout(timer); }
      const result=await response.json().catch(()=>({})) as { message?:string; error?:string };
      if(!response.ok)throw new Error(result.error??"Não foi possível enviar o registro.");
      flash(result.message??"Controle Diário enviado.");
      resetAfterSend();
    } catch(problem) { setSubmitError(problem instanceof Error?problem.message:"Não foi possível enviar o registro."); setReviewing(false); }
    finally { setBusy(false); }
  }

  const worked=draft.workedToday;
  return <div className="daily-form">
    <section className="panel daily-card">
      <header className="daily-card-head"><h3>Identificação</h3><span>Operador: registro vinculado ao seu login</span></header>
      <div className="fleet-form-grid">
        <Field label="Data do registro *" error={errorFor("recordDate")}><input type="date" value={draft.recordDate} max={localToday()} onChange={(event)=>patch({ recordDate:event.target.value })} onBlur={()=>touch("recordDate")}/></Field>
        <Field group label="Equipamento (Frota) *" className="span-2" error={errorFor("equipmentId")} hint={fromMemory&&equipment?"Último equipamento que você usou — troque só se mudou de máquina.":undefined}>
          <EquipmentPicker options={context.equipment} selected={equipment} onSelect={selectEquipment} onBlur={()=>touch("equipmentId")}/>
        </Field>
      </div>
      <label className="daily-toggle">
        <input type="checkbox" role="switch" checked={worked} onChange={(event)=>patch({ workedToday:event.target.checked })}/>
        <span className="daily-switch" aria-hidden="true"/>
        <span><strong>O equipamento trabalhou hoje?</strong><small>{worked?"Sim — preencha a operação do dia.":"Não — informe só o motivo."}</small></span>
      </label>
      <Reveal open={!worked}>
        <Field label="Motivo por não ter trabalhado *" error={errorFor("noWorkReason")}><textarea rows={3} value={draft.noWorkReason} onChange={(event)=>patch({ noWorkReason:event.target.value })} onBlur={()=>touch("noWorkReason")} placeholder="Ex.: chuva, aguardando peça, sem frente liberada..."/></Field>
      </Reveal>
    </section>

    <Reveal open={worked}>
      <section className="panel daily-card">
        <header className="daily-card-head"><h3>Operação</h3></header>
        <div className="fleet-form-grid">
          <Field label="Frente de serviço *" error={errorFor("serviceFrontId")}><select value={draft.serviceFrontId??""} onChange={(event)=>patch({ serviceFrontId:event.target.value?Number(event.target.value):null })} onBlur={()=>touch("serviceFrontId")}><option value="">Selecione</option>{context.fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></Field>
          <Field label="Localização *" className="span-2" error={errorFor("location")}><input value={draft.location} onChange={(event)=>patch({ location:event.target.value })} onBlur={()=>touch("location")} placeholder="Fazenda, talhão, pátio..."/></Field>
          <Field label={`${readingLabel(unit)} inicial *`} error={errorFor("startReading")} hint={lastReading?.value!=null?`Sugerido: última leitura ${numberFormat.format(lastReading.value)} ${unitSuffix(unit)}${lastReading.date?` (${formatDay(lastReading.date)})`:""}. Pode alterar.`:undefined}>
            <input inputMode="decimal" value={draft.startReading} onChange={(event)=>patch({ startReading:event.target.value })} onBlur={()=>touch("startReading")}/>
          </Field>
          <Field label={`${readingLabel(unit)} final *`} error={errorFor("endReading")} hint={(()=>{ const start=parseDecimal(draft.startReading),end=parseDecimal(draft.endReading); return start!==null&&end!==null&&end>=start?`Trabalhado no dia: ${numberFormat.format(end-start)} ${unitSuffix(unit)}`:undefined; })()}>
            <input inputMode="decimal" value={draft.endReading} onChange={(event)=>patch({ endReading:event.target.value })} onBlur={()=>touch("endReading")}/>
          </Field>
        </div>
      </section>

      <section className="panel daily-card">
        <header className="daily-card-head"><h3>Abastecimentos</h3></header>
        <div className="fleet-form-grid">
          <Field label="Quantos abastecimentos foram feitos?" error={errorFor("fuelingCount")}>
            <input inputMode="numeric" value={draft.fuelingCount} placeholder="0" onChange={(event)=>{ const value=event.target.value.replace(/\D/g,"").slice(0,2); setDraft((current)=>({ ...current, fuelingCount:value, fuelings:resizeCards(current.fuelings,value,emptyFueling,MAX_FUELINGS) })); }} onBlur={()=>touch("fuelingCount")}/>
          </Field>
        </div>
        {draft.fuelings.map((item,index)=><div className="fleet-order-editor daily-reveal" key={index}>
          <header><b>Abastecimento {index+1}</b></header>
          <div className="fleet-form-grid">
            <Field label="Litros *" error={errorFor(`fuelings.${index}.liters`)}><input inputMode="decimal" value={item.liters} onChange={(event)=>setDraft((current)=>({ ...current, fuelings:current.fuelings.map((fueling,position)=>position===index?{ ...fueling, liters:event.target.value }:fueling) }))} onBlur={()=>touch(`fuelings.${index}.liters`)}/></Field>
            <Field label="Local / posto *" className="span-2" error={errorFor(`fuelings.${index}.location`)}><input value={item.location} onChange={(event)=>setDraft((current)=>({ ...current, fuelings:current.fuelings.map((fueling,position)=>position===index?{ ...fueling, location:event.target.value }:fueling) }))} onBlur={()=>touch(`fuelings.${index}.location`)} placeholder="Comboio, posto, tanque da frente..."/></Field>
          </div>
        </div>)}
      </section>

      <section className="panel daily-card">
        <header className="daily-card-head"><h3>Inativo ou com problema?</h3></header>
        <YesNo value={draft.inactiveOrProblem} onChange={(value)=>{ patch({ inactiveOrProblem:value }); touch("inactiveOrProblem"); }} error={errorFor("inactiveOrProblem")}/>
        <Reveal open={draft.inactiveOrProblem===true}>
          <div className="fleet-order-editor">
            <Field label="Motivo *" error={errorFor("problemReason")}><textarea rows={3} value={draft.problemReason} onChange={(event)=>patch({ problemReason:event.target.value })} onBlur={()=>touch("problemReason")} placeholder="Descreva o problema ou o motivo da inatividade"/></Field>
            <PhotoField label="Foto do problema (opcional)" photo={problemPhoto} onChange={(photo)=>setPhoto("problem",photo)}/>
          </div>
        </Reveal>
      </section>

      <section className="panel daily-card">
        <header className="daily-card-head"><h3>Teve produção?</h3></header>
        <YesNo value={draft.hadProduction} onChange={(value)=>{ patch({ hadProduction:value }); touch("hadProduction"); }} error={errorFor("hadProduction")}/>
        <Reveal open={draft.hadProduction===true}>
          <div className="fleet-order-editor">
            <Field group label="Tipo de produção *" error={errorFor("productionType")}>
              <div className="daily-segmented" role="radiogroup">{(["BALDEIO","PORTO"] as const).map((type)=><button type="button" role="radio" aria-checked={draft.productionType===type} key={type} className={draft.productionType===type?"active":""} onClick={()=>{ patch({ productionType:type }); touch("productionType"); }}>{type==="BALDEIO"?"Baldeio":"Porto"}</button>)}</div>
            </Field>
            <Reveal open={draft.productionType!==null}>
              <div className="fleet-form-grid">
                <Field label="Quantidade de viagens *" error={errorFor("tripCount")}>
                  <input inputMode="numeric" value={draft.tripCount} onChange={(event)=>{ const value=event.target.value.replace(/\D/g,"").slice(0,2); setDraft((current)=>({ ...current, tripCount:value, trips:resizeCards(current.trips,value,emptyTrip,MAX_TRIPS) })); }} onBlur={()=>touch("tripCount")}/>
                </Field>
              </div>
              <div className="daily-trip-grid">
                {draft.trips.map((trip,index)=><div className="daily-trip daily-reveal" key={index}>
                  <b>Viagem {index+1}</b>
                  <Field label="Quantidade de toras *" error={errorFor(`trips.${index}.logs`)}><input inputMode="numeric" value={trip.logs} onChange={(event)=>setDraft((current)=>({ ...current, trips:current.trips.map((item,position)=>position===index?{ ...item, logs:event.target.value.replace(/\D/g,"") }:item) }))} onBlur={()=>touch(`trips.${index}.logs`)}/></Field>
                  {draft.productionType==="PORTO" && <Field label="Metragem *" error={errorFor(`trips.${index}.meters`)}><input inputMode="decimal" value={trip.meters} onChange={(event)=>setDraft((current)=>({ ...current, trips:current.trips.map((item,position)=>position===index?{ ...item, meters:event.target.value }:item) }))} onBlur={()=>touch(`trips.${index}.meters`)}/></Field>}
                </div>)}
              </div>
              <PhotoField label={draft.productionType==="PORTO"?"Foto da produção *":"Foto da ficha do baldeio *"} photo={productionPhoto} onChange={(photo)=>{ setPhoto("production",photo); touch("productionPhoto"); }} error={errorFor("productionPhoto")}/>
            </Reveal>
          </div>
        </Reveal>
      </section>
    </Reveal>

    <section className="panel daily-card">
      <Field label="Observações (opcional)"><textarea rows={2} value={draft.notes} onChange={(event)=>patch({ notes:event.target.value })}/></Field>
      {submitError && <div className="fleet-form-error">! {submitError}</div>}
      <div className="daily-submit">
        {pending.length>0 ? <button type="button" className="daily-pending" onClick={()=>setShowAll(true)}>{pending.length} item(ns) pendente(s){showAll?`: ${pending.slice(0,3).join(" · ")}${pending.length>3?" …":""}`:" — toque para ver"}</button> : <span className="daily-ready">✓ Tudo preenchido</span>}
        <button type="button" className="primary" disabled={!validation.value||busy} onClick={()=>setReviewing(true)}>{worked?"Revisar e Enviar":"Revisar e Enviar registro"}</button>
      </div>
    </section>

    {reviewing && validation.value && <ReviewModal draft={draft} equipment={equipment} fronts={context.fronts} unit={unit} problemPhoto={problemPhoto} productionPhoto={productionPhoto} busy={busy} close={()=>setReviewing(false)} confirm={send}/>}
  </div>;
}

// `group`: para controles compostos (busca com lista, botões Sim/Não) — um <label> envolvendo
// vários elementos interativos redirecionaria o clique para o primeiro deles.
function Field({ label, error, hint, className, group, children }:{ label:string; error?:string; hint?:string; className?:string; group?:boolean; children:ReactNode }) {
  const props={ className:`daily-field ${className??""} ${error?"has-error":""}` };
  const content=<><span>{label}</span>{children}{error?<small className="daily-error">{error}</small>:hint?<small className="daily-hint">{hint}</small>:null}</>;
  return group ? <div role="group" aria-label={label} {...props}>{content}</div> : <label {...props}>{content}</label>;
}

// Expande suavemente os campos condicionais (sem popup); nada é montado enquanto fechado.
function Reveal({ open, children }:{ open:boolean; children:ReactNode }) {
  return open ? <div className="daily-reveal">{children}</div> : null;
}

function YesNo({ value, onChange, error }:{ value:boolean|null; onChange:(value:boolean)=>void; error?:string }) {
  return <div className="daily-yesno"><div className="daily-segmented" role="radiogroup">
    <button type="button" role="radio" aria-checked={value===true} className={value===true?"active":""} onClick={()=>onChange(true)}>Sim</button>
    <button type="button" role="radio" aria-checked={value===false} className={value===false?"active":""} onClick={()=>onChange(false)}>Não</button>
  </div>{error && <small className="daily-error">{error}</small>}</div>;
}

const describeEquipment=(item:EquipmentOption)=>`${item.prefix} · ${item.type}${item.model?` ${item.model}`:""}`;

function EquipmentPicker({ options, selected, onSelect, onBlur }:{ options:EquipmentOption[]; selected:EquipmentOption|null; onSelect:(item:EquipmentOption)=>void; onBlur:()=>void }) {
  const [query,setQuery]=useState(selected?describeEquipment(selected):"");
  const [open,setOpen]=useState(false);
  const wrapper=useRef<HTMLDivElement>(null);
  useEffect(()=>{ if(!open)setQuery(selected?describeEquipment(selected):""); },[selected,open]);
  const filtered=useMemo(()=>{ const key=query.trim().toLocaleLowerCase("pt-BR"); const typing=!selected||query!==describeEquipment(selected); return (typing&&key?options.filter((item)=>`${item.prefix} ${item.type} ${item.brand} ${item.model} ${item.front}`.toLocaleLowerCase("pt-BR").includes(key)):options).slice(0,60); },[options,query,selected]);
  return <div className="daily-picker" ref={wrapper} onBlur={(event)=>{ if(!wrapper.current?.contains(event.relatedTarget as Node)){ setOpen(false); onBlur(); } }}>
    <input value={query} placeholder="Buscar por prefixo, tipo ou modelo..." onFocus={(event)=>{ setOpen(true); event.target.select(); }} onChange={(event)=>{ setQuery(event.target.value); setOpen(true); }}/>
    {open && <ul role="listbox">{filtered.map((item)=><li key={item.id}><button type="button" className={item.id===selected?.id?"active":""} onMouseDown={(event)=>event.preventDefault()} onClick={()=>{ onSelect(item); setQuery(describeEquipment(item)); setOpen(false); }}><strong>{item.prefix}</strong><span>{item.type} {item.brand} {item.model}</span><small>{item.front}</small></button></li>)}{filtered.length===0 && <li className="daily-picker-empty">Nenhum equipamento encontrado.</li>}</ul>}
  </div>;
}

function PhotoField({ label, photo, onChange, error }:{ label:string; photo:Photo|null; onChange:(photo:Photo|null)=>void; error?:string }) {
  const input=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState("");
  async function handle(file:File|undefined) {
    if(!file)return; setBusy(true); setProblem("");
    try { const blob=await optimizePhoto(file); onChange({ blob, url:URL.createObjectURL(blob) }); }
    catch(failure) { setProblem(failure instanceof Error?failure.message:"Não foi possível usar esta foto."); }
    finally { setBusy(false); if(input.current)input.current.value=""; }
  }
  return <div className={`daily-photo ${error?"has-error":""}`}>
    <span>{label}</span>
    {photo ? <div className="daily-photo-preview"><img src={photo.url} alt={label}/><div><button type="button" className="secondary" onClick={()=>input.current?.click()}>Trocar foto</button><button type="button" className="secondary" onClick={()=>onChange(null)}>Remover</button></div></div>
      : <button type="button" className="daily-photo-empty" disabled={busy} onClick={()=>input.current?.click()}>{busy?"Otimizando foto...":"📷 Tirar ou escolher foto"}</button>}
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(event)=>handle(event.target.files?.[0])}/>
    {(problem||error) && <small className="daily-error">{problem||error}</small>}
  </div>;
}

function ReviewModal({ draft, equipment, fronts, unit, problemPhoto, productionPhoto, busy, close, confirm }:{
  draft:DailyRecordDraft; equipment:EquipmentOption|null; fronts:Front[]; unit:ReadingUnit; problemPhoto:Photo|null; productionPhoto:Photo|null; busy:boolean; close:()=>void; confirm:()=>void;
}) {
  const start=parseDecimal(draft.startReading),end=parseDecimal(draft.endReading);
  const count=Number(draft.fuelingCount||0),trips=draft.trips.slice(0,Number(draft.tripCount||0));
  const rows:Array<[string,ReactNode]>=[["Data",formatDay(draft.recordDate)],["Equipamento",equipment?`${equipment.prefix} · ${equipment.type} ${equipment.model}`:"—"],["Trabalhou hoje?",draft.workedToday?"Sim":"Não"]];
  if(!draft.workedToday)rows.push(["Motivo",draft.noWorkReason.trim()]);
  else {
    rows.push(["Frente de serviço",fronts.find((front)=>front.id===draft.serviceFrontId)?.name??"—"],["Localização",draft.location.trim()],
      [`${readingLabel(unit)} inicial → final`,`${numberFormat.format(start??0)} → ${numberFormat.format(end??0)} ${unitSuffix(unit)} (${numberFormat.format((end??0)-(start??0))} ${unitSuffix(unit)})`],
      ["Abastecimentos",count?draft.fuelings.slice(0,count).map((item,index)=>`${index+1}) ${numberFormat.format(parseDecimal(item.liters)??0)} L — ${item.location.trim()}`).join("; "):"Nenhum"],
      ["Inativo ou com problema?",draft.inactiveOrProblem?`Sim — ${draft.problemReason.trim()}${problemPhoto?" (com foto)":""}`:"Não"],
      ["Produção",draft.hadProduction?`${draft.productionType==="PORTO"?"Porto":"Baldeio"} — ${trips.length} viagem(ns), ${trips.reduce((total,trip)=>total+Number(trip.logs||0),0)} tora(s)${draft.productionType==="PORTO"?`, ${numberFormat.format(trips.reduce((total,trip)=>total+(parseDecimal(trip.meters)??0),0))} m`:""}`:"Não"]);
  }
  if(draft.notes.trim())rows.push(["Observações",draft.notes.trim()]);
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review" role="dialog" aria-modal="true">
    <header><div><p>CONTROLE DIÁRIO</p><h2>Revise antes de enviar</h2><span>Depois de enviado, o registro não pode ser editado por aqui.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body"><dl className="daily-review-list">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {productionPhoto && draft.workedToday && draft.hadProduction && <img className="daily-review-photo" src={productionPhoto.url} alt="Foto da produção"/>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Voltar e editar</button><button type="button" className="primary" onClick={confirm} disabled={busy}>{busy?"ENVIANDO...":"CONFIRMAR ENVIO"}</button></footer>
  </div></div>;
}

// Registros guardados no celular aguardando internet (e os que o servidor recusou).
function PendingQueue({ userId }:{ userId:number }) {
  const [items,setItems]=useState<QueuedDailyRecord[]>([]);
  const [syncing,setSyncing]=useState(false);
  const [retryMessage,setRetryMessage]=useState("");
  useEffect(()=>{
    const refresh=()=>{ listQueued(userId).then(setItems).catch(()=>setItems([])); };
    refresh(); window.addEventListener(QUEUE_EVENT,refresh);
    return ()=>window.removeEventListener(QUEUE_EVENT,refresh);
  },[userId]);
  if(!items.length)return null;
  async function retry(){
    setSyncing(true); setRetryMessage("");
    try{ await syncQueue(); const left=await listQueued(userId); if(left.some((item)=>item.status==="PENDING"))setRetryMessage("Ainda sem conexão com o servidor. O envio acontece sozinho quando o sinal voltar."); }
    finally { setSyncing(false); }
  }
  return <section className="panel daily-queue">
    {items.some((item)=>item.status==="PENDING")
      ? <header><div><strong>Guardados no celular</strong><span>Serão enviados automaticamente quando houver internet.</span></div><button type="button" className="secondary" disabled={syncing} onClick={retry}>{syncing?"Enviando...":"Enviar agora"}</button></header>
      : <header><div><strong>Registros não enviados</strong><span>O servidor recusou estes registros. Confira o motivo e descarte.</span></div></header>}
    {retryMessage && <p className="daily-queue-note">{retryMessage}</p>}
    <ul>{items.map((item)=><li key={item.id} className={item.status==="ERROR"?"error":""}>
      <strong>{item.summary.prefix}</strong><span>{formatDay(item.summary.recordDate)}</span>
      {item.status==="ERROR"?<><small>Não enviado: {item.error}</small><button type="button" className="danger-action" onClick={()=>{ if(window.confirm("Descartar este registro guardado no celular?"))removeQueued(item.id); }}>Descartar</button></>:<small>Aguardando envio</small>}
    </li>)}</ul>
  </section>;
}

// ---------------------------------------------------------------------------
// Registros enviados
// ---------------------------------------------------------------------------
function RecordsPanel({ scope, equipment }:{ scope:"mine"|"all"; equipment:EquipmentOption[] }) {
  const [records,setRecords]=useState<RecordItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [from,setFrom]=useState(()=>{ const date=new Date(); date.setDate(date.getDate()-30); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; });
  const [to,setTo]=useState(localToday());
  const [equipmentId,setEquipmentId]=useState("");
  const load=useCallback(async()=>{
    setLoading(true); setError("");
    const params=new URLSearchParams({ scope, from, to }); if(equipmentId)params.set("equipmentId",equipmentId);
    try { setRecords((await api<{records:RecordItem[]}>(`/api/daily-records?${params.toString()}`)).records); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Falha ao carregar."); }
    finally { setLoading(false); }
  },[scope,from,to,equipmentId]);
  useEffect(()=>{ load(); },[load]);
  // Quando a fila do celular envia registros, a lista se atualiza sozinha.
  useEffect(()=>{ window.addEventListener(QUEUE_EVENT,load); return ()=>window.removeEventListener(QUEUE_EVENT,load); },[load]);
  return <article className="panel module-panel">
    <div className="module-filters-grid">
      <label>De<input type="date" value={from} onChange={(event)=>setFrom(event.target.value)}/></label>
      <label>Até<input type="date" value={to} onChange={(event)=>setTo(event.target.value)}/></label>
      <label>Equipamento<select value={equipmentId} onChange={(event)=>setEquipmentId(event.target.value)}><option value="">Todos</option>{equipment.map((item)=><option key={item.id} value={item.id}>{item.prefix}</option>)}</select></label>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {loading ? <div className="page-loading"><span/><p>Carregando registros...</p></div> : <div className="daily-records">
      {records.map((record)=><article key={record.id} className={`daily-record ${record.workedToday?(record.inactiveOrProblem?"warn":"ok"):"off"}`}>
        <header><strong>{record.prefix}</strong><span>{formatDay(record.recordDate)}</span><span className={`status-pill ${record.workedToday?(record.inactiveOrProblem?"orange":"green"):"gray"}`}>{record.workedToday?(record.inactiveOrProblem?"Com problema":"Trabalhou"):"Não trabalhou"}</span></header>
        <dl>
          {scope==="all" && <div><dt>Operador</dt><dd>{record.operator}</dd></div>}
          {!record.workedToday ? <div className="wide"><dt>Motivo</dt><dd>{record.noWorkReason}</dd></div> : <>
            <div><dt>Frente / local</dt><dd>{record.front??"—"} · {record.location}</dd></div>
            <div><dt>{readingLabel(record.readingUnit)}</dt><dd>{numberFormat.format(record.startReading??0)} → {numberFormat.format(record.endReading??0)} {unitSuffix(record.readingUnit)}</dd></div>
            <div><dt>Abastecimentos</dt><dd>{record.fuelings.length?record.fuelings.map((item)=>`${numberFormat.format(item.liters)} L (${item.location})`).join(", "):"Nenhum"}</dd></div>
            {record.inactiveOrProblem && <div className="wide"><dt>Problema</dt><dd>{record.problemReason}{record.hasProblemPhoto && <> · <a href={`/api/daily-records/${record.id}/photo?kind=problem`} target="_blank" rel="noreferrer">ver foto</a></>}</dd></div>}
            {record.hadProduction && <div className="wide"><dt>Produção ({record.productionType==="PORTO"?"Porto":"Baldeio"})</dt><dd>{record.trips.map((trip)=>`V${trip.number}: ${trip.logs} tora(s)${trip.meters!==null?` / ${numberFormat.format(trip.meters)} m`:""}`).join(" · ")}{record.hasProductionPhoto && <> · <a href={`/api/daily-records/${record.id}/photo?kind=production`} target="_blank" rel="noreferrer">ver foto</a></>}</dd></div>}
          </>}
          {record.notes && <div className="wide"><dt>Observações</dt><dd>{record.notes}</dd></div>}
        </dl>
      </article>)}
      {records.length===0 && <div className="empty-state">Nenhum registro no período.</div>}
    </div>}
  </article>;
}
