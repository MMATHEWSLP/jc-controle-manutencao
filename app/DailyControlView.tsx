"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- pré-visualização local (blob:) e fotos servidas por rota própria */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  checkReading, emptyFueling, emptyTrip, MAX_FUELINGS, MAX_TRIPS, OPERATOR_NAME_MAX, parseDecimal, readingLabel, resizeCards, validateDailyRecord,
  type DailyRecordDraft, type ProductionType, type ReadingCheck, type ReadingHistory, type ReadingUnit,
} from "../lib/daily-record-rules";
import { reportNetworkFailure } from "../lib/connectivity";
import { enqueue, listQueued, QUEUE_EVENT, removeQueued, syncQueue, type QueuedDailyRecord } from "../lib/offline-queue";
import { optimizePhoto } from "../lib/photo-client";
import { FieldOperatorsPanel, FrontRequestsPanel } from "./DailyAdminPanels";
import DailyHistoryPanel, { clearHistoryUrl, isHistoryUrl } from "./DailyHistoryPanel";

type EquipmentOption = { id:number; prefix:string; code:string; plate:string|null; type:string; brand:string; model:string; serviceFrontId:number|null; front:string; readingUnit:ReadingUnit };
export type CurrentUser = { name:string; jobTitle:string|null; profileLabel:string; frontName:string|null };
type Front = { id:number; name:string };
type Context = { equipment:EquipmentOption[]; fronts:Front[]; assignedEquipmentId:number|null; defaultServiceFrontId:number|null; userId:number; canRegister:boolean; canViewAll:boolean; canManage:boolean; canFieldOperators:boolean; canFrontRequests:boolean; manualOperator:boolean };
type LastReading = { value:number|null; unit:ReadingUnit; source:"DAILY_RECORD"|"EQUIPMENT"|"QUEUE"|null; date:string|null; history?:ReadingHistory|null };
type RecordItem = {
  id:number; recordDate:string; equipmentId:number; serviceFrontId:number|null; userId:number; prefix:string; operator:string;
  // Lançamento manual: operator = nome digitado; launchedBy = conta que lançou (auditoria).
  manualEntry:boolean; operatorName:string|null; launchedBy:string; workedToday:boolean; noWorkReason:string|null; front:string|null; location:string|null;
  readingUnit:ReadingUnit; startReading:number|null; endReading:number|null; inactiveOrProblem:boolean; problemReason:string|null; hasProblemPhoto:boolean;
  hadProduction:boolean; productionType:ProductionType|null; hasProductionPhoto:boolean; notes:string|null;
  officialServiceFrontId:number|null; frontRequestStatus:"PENDING"|"APPROVED"|"REJECTED"|null;
  fuelings:Array<{number:number;liters:number;reading:number|null;location:string|null}>; trips:Array<{number:number;logs:number;meters:number|null}>;
};
type Photo = { blob:Blob; url:string };
type Tab = "new" | "mine" | "history" | "fronts" | "operators";

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
const numberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:2});
const unitSuffix=(unit:ReadingUnit)=>unit==="KM"?"km":"h";
// Abastecimentos novos mostram a leitura; os antigos (antes da troca do campo) mostram o local/posto.
const fuelingPlace=(item:{reading:number|null;location:string|null},unit:ReadingUnit)=>item.reading!==null?`${readingLabel(unit)} ${numberFormat.format(item.reading)}`:item.location??"—";
const formatDay=(value:string|null)=>value?value.split("-").reverse().join("/"):"—";
function localToday() { const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`; }

function blankDraft(recordDate:string, equipmentId:number|null, serviceFrontId:number|null):DailyRecordDraft {
  return { recordDate, equipmentId, workedToday:true, noWorkReason:"", serviceFrontId, location:"", startReading:"", endReading:"",
    fuelingCount:"", fuelings:[], inactiveOrProblem:null, problemReason:"", hadProduction:null, productionType:null, tripCount:"", trips:[], notes:"",
    hasProblemPhoto:false, hasProductionPhoto:false, operatorName:"" };
}

export default function DailyControlView({ flash, currentUser, activeFrontId=null }:{ flash:(message:string)=>void; currentUser:CurrentUser; activeFrontId?:number|null }) {
  const [context,setContext]=useState<Context|null>(null);
  const [error,setError]=useState("");
  // Link/recarga com os filtros do Histórico na URL abre direto nele.
  const [tab,setTab]=useState<Tab>(()=>isHistoryUrl()?"history":"new");
  // Registro aberto para edição (somente com a permissão "daily.manage").
  const [editing,setEditing]=useState<RecordItem|null>(null);
  const load=useCallback(async()=>{ setError(""); try{ const result=await api<Context>("/api/daily-records/context"); setContext(result); if(!result.canViewAll)clearHistoryUrl(); if(result.canViewAll&&isHistoryUrl())setTab("history"); else if(!result.canRegister)setTab(result.canViewAll?"history":result.canFrontRequests?"fronts":result.canFieldOperators?"operators":"mine"); else setTab((current)=>current==="history"?"new":current); }catch(problem){ setError(problem instanceof Error?problem.message:"Falha ao carregar."); } },[]);
  useEffect(()=>{ load(); },[load]);
  // Contador de solicitações de frente pendentes (para quem aprova).
  const [pendingFronts,setPendingFronts]=useState(0);
  const loadPendingFronts=useCallback(()=>{ api<{pending:number}>("/api/daily-records/front-requests?count=1").then((result)=>setPendingFronts(result.pending)).catch(()=>undefined); },[]);
  useEffect(()=>{ if(context?.canFrontRequests)loadPendingFronts(); },[context,loadPendingFronts]);
  const go=(next:Tab)=>{ setEditing(null); setTab(next); if(next!=="history")clearHistoryUrl(); };
  // Editar a partir do Histórico: busca o registro completo (abastecimentos, viagens, fotos).
  const editFromHistory=useCallback(async(recordId:number)=>{ const result=await api<{record:RecordItem}>(`/api/daily-records/${recordId}`); setEditing(result.record); window.scrollTo({ top:0, behavior:"smooth" }); },[]);

  if(error) return <div className="operation-error"><span>!</span><div><strong>Falha ao carregar o Controle Diário</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>;
  if(!context) return <div className="page-loading"><span/><p>Carregando o Controle Diário...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">OPERAÇÃO · REGISTRO DO DIA</p><h1>Controle Diário</h1><span>Registro diário do equipamento: leituras, abastecimentos, problemas e produção.</span></div></div>
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação do Controle Diário">
      {context.canRegister && <button className={tab==="new"?"active":""} onClick={()=>go("new")}>Novo registro</button>}
      {context.canRegister && <button className={tab==="mine"?"active":""} onClick={()=>go("mine")}>Meus registros</button>}
      {context.canViewAll && <button className={tab==="history"?"active":""} onClick={()=>go("history")}>Histórico de registros</button>}
      {context.canFrontRequests && <button className={tab==="fronts"?"active":""} onClick={()=>go("fronts")}>Solicitações de frente{pendingFronts>0 && <b className="nav-badge">{pendingFronts}</b>}</button>}
      {context.canFieldOperators && <button className={tab==="operators"?"active":""} onClick={()=>go("operators")}>Funcionários de campo</button>}
    </div>
    {context.canRegister && <PendingQueue userId={context.userId}/>}
    {editing ? <DailyForm key={`edit-${editing.id}`} context={context} currentUser={currentUser} flash={flash} editing={editing} onSent={()=>setEditing(null)} onCancel={()=>setEditing(null)}/>
      : tab==="new" && context.canRegister ? <DailyForm context={context} currentUser={currentUser} flash={flash} onSent={()=>setTab("mine")}/>
      : tab==="fronts" && context.canFrontRequests ? <FrontRequestsPanel flash={flash} onChanged={loadPendingFronts}/>
      : tab==="operators" && context.canFieldOperators ? <FieldOperatorsPanel fronts={context.fronts} flash={flash}/>
      : tab==="history" && context.canViewAll ? <DailyHistoryPanel fronts={context.fronts} onEdit={editFromHistory} defaultFrontId={activeFrontId}/>
      : <RecordsPanel equipment={context.equipment} canManage={context.canManage} flash={flash} onEdit={setEditing}/>}
  </>;
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------
function draftFromRecord(record:RecordItem):DailyRecordDraft {
  const decimal=(value:number|null)=>value===null?"":String(value).replace(".",",");
  return {
    recordDate:record.recordDate, equipmentId:record.equipmentId, workedToday:record.workedToday, noWorkReason:record.noWorkReason??"",
    serviceFrontId:record.serviceFrontId, location:record.location??"", startReading:decimal(record.startReading), endReading:decimal(record.endReading),
    fuelingCount:record.fuelings.length?String(record.fuelings.length):"", fuelings:record.fuelings.map((item)=>({ liters:decimal(item.liters), reading:decimal(item.reading) })),
    inactiveOrProblem:record.workedToday?record.inactiveOrProblem:null, problemReason:record.problemReason??"",
    hadProduction:record.workedToday?record.hadProduction:null, productionType:record.productionType,
    tripCount:record.trips.length?String(record.trips.length):"", trips:record.trips.map((trip)=>({ logs:String(trip.logs), meters:decimal(trip.meters) })),
    notes:record.notes??"", hasProblemPhoto:record.hasProblemPhoto, hasProductionPhoto:record.hasProductionPhoto, operatorName:record.operatorName??"",
  };
}

// `editing`: abre um registro já enviado para correção (somente "daily.manage"). Nesse modo não
// há memória de equipamento, sugestão de leitura nem fila offline — editar exige internet.
function DailyForm({ context, currentUser, flash, onSent, editing, onCancel }:{ context:Context; currentUser:CurrentUser; flash:(message:string)=>void; onSent:()=>void; editing?:RecordItem; onCancel?:()=>void }) {
  const initialEquipment=editing?null:context.equipment.find((item)=>item.id===context.assignedEquipmentId)??null;
  const [draft,setDraft]=useState<DailyRecordDraft>(()=>editing?draftFromRecord(editing):blankDraft(localToday(),initialEquipment?.id??null,initialEquipment?.serviceFrontId??context.defaultServiceFrontId));
  const [fromMemory,setFromMemory]=useState(Boolean(initialEquipment));
  // Sugestões do nome do operador (lançamento manual) vindas do cadastro de Funcionários — evita o
  // mesmo nome digitado de jeitos diferentes. Continua aceitando nome livre.
  const [employeeOptions,setEmployeeOptions]=useState<string[]>([]);
  const operatorQuery=(draft.operatorName??"").trim();
  useEffect(()=>{ if(operatorQuery.length<2)return; const timer=window.setTimeout(()=>{ const params=new URLSearchParams({ q:operatorQuery }); if(draft.serviceFrontId)params.set("serviceFrontId",String(draft.serviceFrontId)); api<{ employees:Array<{ name:string }> }>(`/api/employees/lookup?${params.toString()}`).then((result)=>setEmployeeOptions(result.employees.map((item)=>item.name))).catch(()=>setEmployeeOptions([])); },300); return ()=>window.clearTimeout(timer); },[operatorQuery,draft.serviceFrontId]);
  // Fotos já gravadas no registro em edição (mantidas até o usuário remover ou trocar).
  const [keepProblemPhoto,setKeepProblemPhoto]=useState(Boolean(editing?.hasProblemPhoto));
  const [keepProductionPhoto,setKeepProductionPhoto]=useState(Boolean(editing?.hasProductionPhoto));
  const [lastReading,setLastReading]=useState<LastReading|null>(null);
  const [problemPhoto,setProblemPhoto]=useState<Photo|null>(null);
  const [productionPhoto,setProductionPhoto]=useState<Photo|null>(null);
  const [touched,setTouched]=useState<Set<string>>(new Set());
  const [showAll,setShowAll]=useState(false);
  const [reviewing,setReviewing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [submitError,setSubmitError]=useState("");
  const [readingNonce,setReadingNonce]=useState(0);
  // Aviso de leitura fora do plausível vindo do servidor (caso ele calcule diferente da tela).
  const [serverReadingWarning,setServerReadingWarning]=useState<string|null>(null);
  // "Mudar frente": o operador informa outra frente para este registro; vira uma solicitação
  // para ADMIN/GESTOR aprovar — o cadastro do equipamento só muda depois da aprovação.
  const [frontChangeOpen,setFrontChangeOpen]=useState(false);
  const [frontChangeRequested,setFrontChangeRequested]=useState(false);
  const [frontChangeReason,setFrontChangeReason]=useState("");
  const equipment=context.equipment.find((item)=>item.id===draft.equipmentId)??null;
  const unit=equipment?.readingUnit??"HOURS";

  const patch=useCallback((changes:Partial<DailyRecordDraft>)=>setDraft((current)=>({ ...current, ...changes })),[]);
  const touch=(field:string)=>setTouched((current)=>current.has(field)?current:new Set(current).add(field));

  // Autopreenche a leitura inicial sempre que o equipamento muda (o valor continua editável).
  useEffect(()=>{
    if(editing||!draft.equipmentId){ setLastReading(null); return; }
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
  },[draft.equipmentId,readingNonce,context.userId,editing]);

  function selectEquipment(item:EquipmentOption) {
    if(item.id===draft.equipmentId)return;
    patch({ equipmentId:item.id, serviceFrontId:item.serviceFrontId??context.defaultServiceFrontId, ...(editing?{}:{ startReading:"" }) });
    setFrontChangeOpen(false); setFrontChangeRequested(false); setFrontChangeReason("");
    setFromMemory(false);
    if(editing)return;
    // Troca de máquina: atualiza a "memória" para os próximos registros.
    api("/api/daily-records/assignment",{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ equipmentId:item.id }) }).catch(()=>undefined);
  }

  const setPhoto=(kind:"problem"|"production",photo:Photo|null)=>{
    const [current,setter]=kind==="problem"?[problemPhoto,setProblemPhoto]:[productionPhoto,setProductionPhoto];
    if(current)URL.revokeObjectURL(current.url);
    setter(photo);
  };

  // Lançamento manual (login que não é de campo): o nome do operador é obrigatório. Na edição,
  // vale a marcação do próprio registro.
  const manualOperator=editing?editing.manualEntry:context.manualOperator;
  const validation=useMemo(()=>validateDailyRecord({ ...draft, hasProblemPhoto:Boolean(problemPhoto)||keepProblemPhoto, hasProductionPhoto:Boolean(productionPhoto)||keepProductionPhoto },localToday(),{ manualOperator }),[draft,problemPhoto,productionPhoto,keepProblemPhoto,keepProductionPhoto,manualOperator]);
  const errorFor=(field:string)=>(showAll||touched.has(field))?validation.errors[field]:undefined;
  const pending=Object.values(validation.errors);
  const readingCheck=useMemo<ReadingCheck|null>(()=>{
    if(!draft.workedToday)return null;
    const check=checkReading({ unit, start:parseDecimal(draft.startReading), end:parseDecimal(draft.endReading), lastDate:lastReading?.date??null, recordDate:draft.recordDate, history:lastReading?.history??null });
    return serverReadingWarning&&check.level!=="INVALID"?{ ...check, level:"HIGH", message:serverReadingWarning }:check;
  },[draft.workedToday,draft.startReading,draft.endReading,draft.recordDate,unit,lastReading,serverReadingWarning]);

  function resetAfterSend() {
    setPhoto("problem",null); setPhoto("production",null);
    setDraft(blankDraft(localToday(),draft.equipmentId,equipment?.serviceFrontId??draft.serviceFrontId));
    setTouched(new Set()); setShowAll(false); setReviewing(false); setFromMemory(true); setReadingNonce((value)=>value+1); setServerReadingWarning(null);
    setFrontChangeOpen(false); setFrontChangeRequested(false); setFrontChangeReason("");
    onSent();
  }

  async function saveEdit(confirmUnusualReading:boolean) {
    if(!editing||!validation.value)return;
    setBusy(true); setSubmitError("");
    try {
      const form=new FormData();
      form.set("payload",JSON.stringify({ ...draft, confirmUnusualReading, keepProblemPhoto, keepProductionPhoto }));
      if(draft.workedToday&&draft.inactiveOrProblem&&problemPhoto)form.set("problemPhoto",problemPhoto.blob,"problema.webp");
      if(draft.workedToday&&draft.hadProduction&&productionPhoto)form.set("productionPhoto",productionPhoto.blob,"producao.webp");
      let response:Response;
      try { response=await fetch(`/api/daily-records/${editing.id}`,{ method:"PUT", body:form }); }
      catch { throw new Error("Sem conexão com a internet. Para editar um registro é preciso estar conectado."); }
      const result=await response.json().catch(()=>({})) as { message?:string; error?:string; requiresConfirmation?:boolean };
      if(response.status===400&&result.requiresConfirmation){ setServerReadingWarning(result.error??"Leitura fora do normal. Confira o valor."); return; }
      if(!response.ok)throw new Error(result.error??"Não foi possível salvar a alteração.");
      setPhoto("problem",null); setPhoto("production",null); setReviewing(false);
      flash(result.message??"Registro atualizado.");
      onSent();
    } catch(problem) { setSubmitError(problem instanceof Error?problem.message:"Não foi possível salvar a alteração."); setReviewing(false); }
    finally { setBusy(false); }
  }

  async function send(confirmUnusualReading:boolean) {
    if(editing)return saveEdit(confirmUnusualReading);
    if(!validation.value)return;
    setBusy(true); setSubmitError("");
    const payload=JSON.stringify({ ...draft, confirmUnusualReading, frontChangeRequested:frontChangeRequested&&draft.serviceFrontId!==equipment?.serviceFrontId, frontChangeReason });
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
      const result=await response.json().catch(()=>({})) as { message?:string; error?:string; requiresConfirmation?:boolean };
      if(response.status===400&&result.requiresConfirmation){ setServerReadingWarning(result.error??"Leitura fora do normal. Confira o valor."); return; }
      if(!response.ok)throw new Error(result.error??"Não foi possível enviar o registro.");
      flash(result.message??"Controle Diário enviado.");
      resetAfterSend();
    } catch(problem) { setSubmitError(problem instanceof Error?problem.message:"Não foi possível enviar o registro."); setReviewing(false); }
    finally { setBusy(false); }
  }

  const worked=draft.workedToday;
  return <div className="daily-form">
    <section className="panel daily-card">
      {editing
        ? <header className="daily-card-head daily-editing-head"><div><h3>Editando registro</h3><span>{editing.prefix} · {formatDay(editing.recordDate)} · {editing.manualEntry?`operador ${editing.operator} · lançado por ${editing.launchedBy}`:`lançado por ${editing.operator}`}</span></div>{onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar edição</button>}</header>
        : manualOperator ? null : <IdentityCard user={currentUser}/>}
      {manualOperator && <div className="daily-manual-operator">
        <div className="daily-manual-operator-head"><em className="daily-manual-tag">Lançamento manual</em><span>{editing?`Lançado pela conta ${editing.launchedBy}.`:`Você (${currentUser.name}) está lançando em nome de outra pessoa — fica registrado que esta conta fez o lançamento.`}</span></div>
        <Field label="Nome do operador *" error={errorFor("operatorName")}><input value={draft.operatorName??""} maxLength={OPERATOR_NAME_MAX} list="daily-employee-options" onChange={(event)=>patch({ operatorName:event.target.value })} onBlur={()=>touch("operatorName")} placeholder="Nome completo de quem operou o equipamento (sugestões do cadastro de Funcionários)" autoComplete="off"/><datalist id="daily-employee-options">{employeeOptions.map((name)=><option key={name} value={name}/>)}</datalist></Field>
      </div>}
      <div className="fleet-form-grid">
        <Field label="Data do registro *" error={errorFor("recordDate")}><input type="date" value={draft.recordDate} max={localToday()} onChange={(event)=>patch({ recordDate:event.target.value })} onBlur={()=>touch("recordDate")}/></Field>
        <Field group label="Equipamento (Frota) *" className="span-2" error={errorFor("equipmentId")} hint={fromMemory&&equipment?"Último equipamento que você usou — troque só se mudou de máquina.":undefined}>
          <EquipmentPicker options={context.equipment} selected={equipment} onSelect={(item)=>{ selectEquipment(item); touch("equipmentId"); }}/>
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
          {editing||!equipment?.serviceFrontId
            ? <Field label="Frente de serviço *" error={errorFor("serviceFrontId")}><select value={draft.serviceFrontId??""} onChange={(event)=>patch({ serviceFrontId:event.target.value?Number(event.target.value):null })} onBlur={()=>touch("serviceFrontId")}><option value="">Selecione</option>{context.fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></Field>
            : <Field group label="Frente de serviço *" error={errorFor("serviceFrontId")} hint={frontChangeRequested&&draft.serviceFrontId!==equipment.serviceFrontId?`Cadastro do equipamento continua em ${equipment.front} até um gestor aprovar.`:undefined}>
                <div className="daily-front">
                  <strong>{context.fronts.find((front)=>front.id===draft.serviceFrontId)?.name??equipment.front}</strong>
                  {frontChangeRequested&&draft.serviceFrontId!==equipment.serviceFrontId ? <span className="daily-front-pending">Aguardando aprovação</span> : <small>Frente cadastrada do equipamento</small>}
                  {!frontChangeOpen && <button type="button" className="secondary" onClick={()=>setFrontChangeOpen(true)}>{frontChangeRequested?"Alterar":"Mudar frente"}</button>}
                </div>
              </Field>}
          <Field label="Localização *" className="span-2" error={errorFor("location")}><input value={draft.location} onChange={(event)=>patch({ location:event.target.value })} onBlur={()=>touch("location")} placeholder="Fazenda, talhão, pátio..."/></Field>
          <Field label={`${readingLabel(unit)} inicial *`} error={errorFor("startReading")} hint={lastReading?.value!=null?`Sugerido: última leitura ${numberFormat.format(lastReading.value)} ${unitSuffix(unit)}${lastReading.date?` (${formatDay(lastReading.date)})`:""}. Pode alterar.`:undefined}>
            <input inputMode="decimal" value={draft.startReading} onChange={(event)=>patch({ startReading:event.target.value })} onBlur={()=>touch("startReading")}/>
          </Field>
          <Field label={`${readingLabel(unit)} final *`} error={readingCheck?.level==="INVALID"?undefined:errorFor("endReading")}>
            <input inputMode="decimal" value={draft.endReading} onChange={(event)=>{ patch({ endReading:event.target.value }); setServerReadingWarning(null); }} onBlur={()=>touch("endReading")}/>
          </Field>
        </div>
        {readingCheck?.worked!=null && <ReadingSummary check={readingCheck} unit={unit} start={parseDecimal(draft.startReading)} end={parseDecimal(draft.endReading)} lastReading={lastReading}/>}
        {frontChangeOpen && equipment && <div className="fleet-order-editor daily-reveal daily-front-change">
          <header><b>O equipamento não está em {equipment.front}?</b></header>
          <p>Escolha a frente onde ele está. O seu registro já sai com a frente nova; o cadastro do equipamento só muda quando um gestor aprovar.</p>
          <div className="fleet-form-grid">
            <label className="daily-field">Frente onde o equipamento está *<select value={frontChangeRequested?String(draft.serviceFrontId??""):""} onChange={(event)=>{ const id=Number(event.target.value); if(!id)return; patch({ serviceFrontId:id }); setFrontChangeRequested(id!==equipment.serviceFrontId); }}><option value="">Selecione</option>{context.fronts.filter((front)=>front.id!==equipment.serviceFrontId).map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
            <label className="daily-field span-2">Observação (opcional)<input value={frontChangeReason} maxLength={300} onChange={(event)=>setFrontChangeReason(event.target.value)} placeholder="Ex.: veio transferido na segunda-feira"/></label>
          </div>
          <div className="daily-front-actions">
            <button type="button" className="secondary" onClick={()=>{ patch({ serviceFrontId:equipment.serviceFrontId }); setFrontChangeRequested(false); setFrontChangeReason(""); setFrontChangeOpen(false); }}>Manter {equipment.front}</button>
            <button type="button" className="primary" disabled={!frontChangeRequested} onClick={()=>setFrontChangeOpen(false)}>Usar a frente nova</button>
          </div>
        </div>}
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
            <Field label={`${readingLabel(unit)} *`} error={errorFor(`fuelings.${index}.reading`)}><input inputMode="decimal" value={item.reading} onChange={(event)=>setDraft((current)=>({ ...current, fuelings:current.fuelings.map((fueling,position)=>position===index?{ ...fueling, reading:event.target.value }:fueling) }))} onBlur={()=>touch(`fuelings.${index}.reading`)} placeholder={`Leitura no abastecimento (${unitSuffix(unit)})`}/></Field>
          </div>
        </div>)}
      </section>

      <section className="panel daily-card">
        <header className="daily-card-head"><h3>Inativo ou com problema?</h3></header>
        <YesNo value={draft.inactiveOrProblem} onChange={(value)=>{ patch({ inactiveOrProblem:value }); touch("inactiveOrProblem"); }} error={errorFor("inactiveOrProblem")}/>
        <Reveal open={draft.inactiveOrProblem===true}>
          <div className="fleet-order-editor">
            <Field label="Motivo *" error={errorFor("problemReason")}><textarea rows={3} value={draft.problemReason} onChange={(event)=>patch({ problemReason:event.target.value })} onBlur={()=>touch("problemReason")} placeholder="Descreva o problema ou o motivo da inatividade"/></Field>
            <PhotoField label="Foto do problema (opcional)" photo={problemPhoto} existingUrl={editing&&keepProblemPhoto?`/api/daily-records/${editing.id}/photo?kind=problem`:null} onRemoveExisting={()=>setKeepProblemPhoto(false)} onChange={(photo)=>{ setPhoto("problem",photo); if(photo)setKeepProblemPhoto(false); }}/>
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
              <PhotoField label={draft.productionType==="PORTO"?"Foto da produção *":"Foto da ficha do baldeio *"} photo={productionPhoto} existingUrl={editing&&keepProductionPhoto?`/api/daily-records/${editing.id}/photo?kind=production`:null} onRemoveExisting={()=>setKeepProductionPhoto(false)} onChange={(photo)=>{ setPhoto("production",photo); if(photo)setKeepProductionPhoto(false); touch("productionPhoto"); }} error={errorFor("productionPhoto")}/>
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
        <button type="button" className="primary" disabled={!validation.value||busy} onClick={()=>setReviewing(true)}>{editing?"Revisar e Salvar alteração":worked?"Revisar e Enviar":"Revisar e Enviar registro"}</button>
      </div>
    </section>

    {reviewing && validation.value && <ReviewModal manualOperator={manualOperator} draft={draft} equipment={equipment} fronts={context.fronts} unit={unit} readingCheck={readingCheck} lastReading={lastReading} problemPhoto={problemPhoto} productionPhoto={productionPhoto} busy={busy} close={()=>setReviewing(false)} confirm={send}/>}
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

// Busca: ignora acentos, maiúsculas, espaços, pontos e hífens ("cm19", "CM-19" e "axor" acham o CM-19).
const searchKey=(value:string|null|undefined)=>String(value??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[\s.\-_/]+/g,"");
const controlLabel=(unit:ReadingUnit)=>unit==="KM"?"KM":"Horímetro";

function IdentityCard({ user }:{ user:CurrentUser }) {
  const initials=user.name.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]).join("").toUpperCase();
  return <div className="daily-identity"><b>{initials}</b><div><strong>{user.name}</strong><span>{[user.jobTitle??user.profileLabel,user.frontName].filter(Boolean).join(" · ")}</span></div></div>;
}

// Campo do equipamento: mostra o escolhido (com botão para trocar) e abre a busca por lupa.
function EquipmentPicker({ options, selected, onSelect }:{ options:EquipmentOption[]; selected:EquipmentOption|null; onSelect:(item:EquipmentOption)=>void }) {
  const [open,setOpen]=useState(false);
  return <>
    {selected
      ? <div className="daily-equipment-card"><div><strong>{selected.prefix}</strong><span>{[selected.brand,selected.model].filter(Boolean).join(" ")||selected.type} · {controlLabel(selected.readingUnit)}</span><small>{selected.front}</small></div>
          <button type="button" className="daily-search-button" onClick={()=>setOpen(true)} aria-label="Pesquisar outro equipamento"><span aria-hidden="true">⌕</span> Trocar</button></div>
      : <button type="button" className="daily-search-trigger" onClick={()=>setOpen(true)}><span aria-hidden="true">⌕</span>Pesquisar equipamento por prefixo, código, modelo ou placa...</button>}
    {open && <EquipmentSearchModal options={options} selectedId={selected?.id??null} close={()=>setOpen(false)} onSelect={(item)=>{ onSelect(item); setOpen(false); }}/>}
  </>;
}

function EquipmentSearchModal({ options, selectedId, close, onSelect }:{ options:EquipmentOption[]; selectedId:number|null; close:()=>void; onSelect:(item:EquipmentOption)=>void }) {
  const [query,setQuery]=useState("");
  const [cursor,setCursor]=useState(0);
  const listRef=useRef<HTMLUListElement>(null);
  const sorted=useMemo(()=>[...options].sort((a,b)=>a.prefix.localeCompare(b.prefix,"pt-BR",{ numeric:true, sensitivity:"base" })),[options]);
  const results=useMemo(()=>{ const key=searchKey(query); return key?sorted.filter((item)=>[item.prefix,item.code,item.brand,item.model,item.plate,item.type].some((field)=>searchKey(field).includes(key))):sorted; },[sorted,query]);
  useEffect(()=>{ setCursor(0); },[query]);
  useEffect(()=>{ listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block:"nearest" }); },[cursor]);
  function onKey(event:React.KeyboardEvent<HTMLInputElement>) {
    if(event.key==="ArrowDown"){ event.preventDefault(); setCursor((value)=>Math.min(value+1,results.length-1)); }
    else if(event.key==="ArrowUp"){ event.preventDefault(); setCursor((value)=>Math.max(value-1,0)); }
    else if(event.key==="Enter"){ event.preventDefault(); if(results[cursor])onSelect(results[cursor]); }
    else if(event.key==="Escape"){ event.preventDefault(); close(); }
  }
  // Janela presa ao topo da tela: no celular a lista fica acima do teclado, nunca escondida por ele.
  return <div className="daily-search-backdrop" role="presentation" onMouseDown={(event)=>{ if(event.target===event.currentTarget)close(); }}>
    <div className="daily-search-modal" role="dialog" aria-modal="true" aria-label="Pesquisar equipamento">
      <div className="daily-search-bar"><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={(event)=>setQuery(event.target.value)} onKeyDown={onKey} placeholder="Prefixo, código, modelo ou placa" autoComplete="off" enterKeyHint="search"/><button type="button" onClick={close} aria-label="Fechar">×</button></div>
      <ul ref={listRef} role="listbox">
        {results.map((item,index)=><li key={item.id} data-index={index}><button type="button" role="option" aria-selected={index===cursor} className={`${index===cursor?"cursor":""} ${item.id===selectedId?"selected":""}`} onMouseEnter={()=>setCursor(index)} onClick={()=>onSelect(item)}>
          <strong>{item.prefix}</strong><span>{[item.code!==item.prefix?item.code:null,[item.brand,item.model].filter(Boolean).join(" ")||item.type,item.plate,item.front].filter(Boolean).join(" · ")}</span>
        </button></li>)}
        {results.length===0 && <li className="daily-picker-empty">Nenhum equipamento encontrado para &quot;{query}&quot;.</li>}
      </ul>
    </div>
  </div>;
}

function PhotoField({ label, photo, onChange, error, existingUrl, onRemoveExisting }:{ label:string; photo:Photo|null; onChange:(photo:Photo|null)=>void; error?:string; existingUrl?:string|null; onRemoveExisting?:()=>void }) {
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
      : existingUrl ? <div className="daily-photo-preview"><img src={existingUrl} alt={label}/><div><button type="button" className="secondary" onClick={()=>input.current?.click()}>Trocar foto</button><button type="button" className="secondary" onClick={()=>onRemoveExisting?.()}>Remover</button></div></div>
      : <button type="button" className="daily-photo-empty" disabled={busy} onClick={()=>input.current?.click()}>{busy?"Otimizando foto...":"📷 Tirar ou escolher foto"}</button>}
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(event)=>handle(event.target.files?.[0])}/>
    {(problem||error) && <small className="daily-error">{problem||error}</small>}
  </div>;
}

// Cálculo do trabalhado no período, com cor conforme a regra de leitura plausível.
function ReadingSummary({ check, unit, start, end, lastReading, big }:{ check:ReadingCheck; unit:ReadingUnit; start:number|null; end:number|null; lastReading:LastReading|null; big?:boolean }) {
  const suffix=unitSuffix(unit);
  const tone=check.level==="INVALID"?"invalid":check.level==="HIGH"||check.level==="LOW"?"high":check.level==="ZERO"?"zero":"ok";
  return <div className={`daily-reading-check ${tone} ${big?"big":""}`} role={check.level==="OK"?undefined:"alert"}>
    <dl>
      <div><dt>{lastReading?.value!=null?"Última leitura":"Leitura inicial"}</dt><dd>{lastReading?.value!=null?<>{numberFormat.format(lastReading.value)} {suffix}{lastReading.date?<small> · em {formatDay(lastReading.date)}</small>:null}</>:<>{numberFormat.format(start??0)} {suffix}</>}</dd></div>
      {lastReading?.value!=null && start!==null && start!==lastReading.value && <div><dt>Inicial informada</dt><dd>{numberFormat.format(start)} {suffix}</dd></div>}
      <div><dt>Leitura de hoje</dt><dd>{numberFormat.format(end??0)} {suffix}</dd></div>
      <div className="total"><dt>Trabalhado</dt><dd>{numberFormat.format(check.worked??0)} {suffix}{check.days>1&&check.perDay!==null?<small> ({check.days} dias · média {numberFormat.format(check.perDay)} {suffix}/dia)</small>:null}</dd></div>
    </dl>
    {lastReading?.value==null && <p>Primeira leitura deste equipamento — sem comparação.</p>}
    {check.message && <p>{check.message}</p>}
  </div>;
}

function ReviewModal({ manualOperator, draft, equipment, fronts, unit, readingCheck, lastReading, problemPhoto, productionPhoto, busy, close, confirm }:{
  manualOperator:boolean; draft:DailyRecordDraft; equipment:EquipmentOption|null; fronts:Front[]; unit:ReadingUnit; readingCheck:ReadingCheck|null; lastReading:LastReading|null;
  problemPhoto:Photo|null; productionPhoto:Photo|null; busy:boolean; close:()=>void; confirm:(confirmUnusualReading:boolean)=>void;
}) {
  // Leitura fora do plausível: exige um segundo toque em "Confirmar mesmo assim".
  const unusual=readingCheck?.level==="HIGH"||readingCheck?.level==="LOW";
  const [armed,setArmed]=useState(false);
  const start=parseDecimal(draft.startReading),end=parseDecimal(draft.endReading);
  const count=Number(draft.fuelingCount||0),trips=draft.trips.slice(0,Number(draft.tripCount||0));
  const rows:Array<[string,ReactNode]>=[...(manualOperator?[["Operador",<>{(draft.operatorName??"").trim()} <em className="daily-manual-tag">Lançamento manual</em></>] as [string,ReactNode]]:[]),["Data",formatDay(draft.recordDate)],["Equipamento",equipment?`${equipment.prefix} · ${equipment.type} ${equipment.model}`:"—"],["Trabalhou hoje?",draft.workedToday?"Sim":"Não"]];
  if(!draft.workedToday)rows.push(["Motivo",draft.noWorkReason.trim()]);
  else {
    rows.push(["Frente de serviço",fronts.find((front)=>front.id===draft.serviceFrontId)?.name??"—"],["Localização",draft.location.trim()],
      [`${readingLabel(unit)} inicial → final`,`${numberFormat.format(start??0)} → ${numberFormat.format(end??0)} ${unitSuffix(unit)} (${numberFormat.format((end??0)-(start??0))} ${unitSuffix(unit)})`],
      ["Abastecimentos",count?draft.fuelings.slice(0,count).map((item,index)=>`${index+1}) ${numberFormat.format(parseDecimal(item.liters)??0)} L — ${readingLabel(unit)} ${numberFormat.format(parseDecimal(item.reading)??0)}`).join("; "):"Nenhum"],
      ["Inativo ou com problema?",draft.inactiveOrProblem?`Sim — ${draft.problemReason.trim()}${problemPhoto?" (com foto)":""}`:"Não"],
      ["Produção",draft.hadProduction?`${draft.productionType==="PORTO"?"Porto":"Baldeio"} — ${trips.length} viagem(ns), ${trips.reduce((total,trip)=>total+Number(trip.logs||0),0)} tora(s)${draft.productionType==="PORTO"?`, ${numberFormat.format(trips.reduce((total,trip)=>total+(parseDecimal(trip.meters)??0),0))} m`:""}`:"Não"]);
  }
  if(draft.notes.trim())rows.push(["Observações",draft.notes.trim()]);
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review" role="dialog" aria-modal="true">
    <header><div><p>CONTROLE DIÁRIO</p><h2>Revise antes de enviar</h2><span>Depois de enviado, o registro não pode ser editado por aqui.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      {readingCheck?.worked!=null && <ReadingSummary big check={readingCheck} unit={unit} start={parseDecimal(draft.startReading)} end={parseDecimal(draft.endReading)} lastReading={lastReading}/>}
      <dl className="daily-review-list">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {productionPhoto && draft.workedToday && draft.hadProduction && <img className="daily-review-photo" src={productionPhoto.url} alt="Foto da produção"/>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Voltar e editar</button>{unusual
      ? <button type="button" className={`primary daily-confirm-unusual ${armed?"armed":""}`} disabled={busy} onClick={()=>{ if(armed)confirm(true); else setArmed(true); }}>{busy?"ENVIANDO...":armed?"TOQUE DE NOVO PARA ENVIAR":"CONFIRMAR MESMO ASSIM"}</button>
      : <button type="button" className="primary" onClick={()=>confirm(false)} disabled={busy}>{busy?"ENVIANDO...":"CONFIRMAR ENVIO"}</button>}</footer>
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
function RecordsPanel({ equipment, canManage, flash, onEdit }:{ equipment:EquipmentOption[]; canManage:boolean; flash:(message:string)=>void; onEdit:(record:RecordItem)=>void }) {
  const [deleting,setDeleting]=useState<RecordItem|null>(null);
  const [records,setRecords]=useState<RecordItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [from,setFrom]=useState(()=>{ const date=new Date(); date.setDate(date.getDate()-30); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; });
  const [to,setTo]=useState(localToday());
  const [equipmentId,setEquipmentId]=useState("");
  const load=useCallback(async()=>{
    setLoading(true); setError("");
    const params=new URLSearchParams({ scope:"mine", from, to }); if(equipmentId)params.set("equipmentId",equipmentId);
    try { setRecords((await api<{records:RecordItem[]}>(`/api/daily-records?${params.toString()}`)).records); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Falha ao carregar."); }
    finally { setLoading(false); }
  },[from,to,equipmentId]);
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
          {record.manualEntry && <div><dt>Operador</dt><dd>{record.operator} <em className="daily-manual-tag">Lançamento manual</em></dd></div>}
          {!record.workedToday ? <div className="wide"><dt>Motivo</dt><dd>{record.noWorkReason}</dd></div> : <>
            <div><dt>Frente / local</dt><dd>{record.front??"—"} · {record.location}{record.frontRequestStatus==="PENDING" && <span className="daily-front-pending small">Aguardando aprovação</span>}</dd></div>
            <div><dt>{readingLabel(record.readingUnit)}</dt><dd>{numberFormat.format(record.startReading??0)} → {numberFormat.format(record.endReading??0)} {unitSuffix(record.readingUnit)}</dd></div>
            <div><dt>Abastecimentos</dt><dd>{record.fuelings.length?record.fuelings.map((item)=>`${numberFormat.format(item.liters)} L (${fuelingPlace(item,record.readingUnit)})`).join(", "):"Nenhum"}</dd></div>
            {record.inactiveOrProblem && <div className="wide"><dt>Problema</dt><dd>{record.problemReason}{record.hasProblemPhoto && <> · <a href={`/api/daily-records/${record.id}/photo?kind=problem`} target="_blank" rel="noreferrer">ver foto</a></>}</dd></div>}
            {record.hadProduction && <div className="wide"><dt>Produção ({record.productionType==="PORTO"?"Porto":"Baldeio"})</dt><dd>{record.trips.map((trip)=>`V${trip.number}: ${trip.logs} tora(s)${trip.meters!==null?` / ${numberFormat.format(trip.meters)} m`:""}`).join(" · ")}{record.hasProductionPhoto && <> · <a href={`/api/daily-records/${record.id}/photo?kind=production`} target="_blank" rel="noreferrer">ver foto</a></>}</dd></div>}
          </>}
          {record.notes && <div className="wide"><dt>Observações</dt><dd>{record.notes}</dd></div>}
        </dl>
        {canManage && <footer className="daily-record-actions"><button type="button" className="secondary" onClick={()=>onEdit(record)}>Editar</button><button type="button" className="danger-action" onClick={()=>setDeleting(record)}>Excluir</button></footer>}
      </article>)}
      {records.length===0 && <div className="empty-state">Nenhum registro no período.</div>}
    </div>}
    {deleting && <DeleteRecordModal record={deleting} close={()=>setDeleting(null)} deleted={async(message)=>{ setDeleting(null); flash(message); await load(); }}/>}
  </article>;
}

function DeleteRecordModal({ record, close, deleted }:{ record:RecordItem; close:()=>void; deleted:(message:string)=>Promise<void> }) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function remove() {
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/daily-records/${record.id}`,{ method:"DELETE" }); await deleted(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível excluir."); }
    finally { setBusy(false); }
  }
  return <div className="fleet-modal-backdrop" role="presentation"><div className="fleet-modal daily-review" role="dialog" aria-modal="true">
    <header><div><p>CONTROLE DIÁRIO</p><h2>Excluir registro?</h2><span>Esta ação não pode ser desfeita. Fica registrado no histórico de auditoria quem excluiu.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body"><dl className="daily-review-list">
      <div><dt>Equipamento</dt><dd>{record.prefix}</dd></div>
      <div><dt>Data</dt><dd>{formatDay(record.recordDate)}</dd></div>
      <div><dt>Operador</dt><dd>{record.operator}{record.manualEntry && <> <em className="daily-manual-tag">Lançamento manual</em></>}</dd></div>
      {record.workedToday ? <div><dt>{readingLabel(record.readingUnit)}</dt><dd>{numberFormat.format(record.startReading??0)} → {numberFormat.format(record.endReading??0)} {unitSuffix(record.readingUnit)}</dd></div> : <div><dt>Motivo</dt><dd>{record.noWorkReason}</dd></div>}
    </dl>{error && <div className="fleet-form-error">! {error}</div>}</div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button type="button" className="primary daily-danger" onClick={remove} disabled={busy}>{busy?"EXCLUINDO...":"EXCLUIR REGISTRO"}</button></footer>
  </div></div>;
}
