"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type ItemStatus = "PENDING" | "SENT" | "NOT_AVAILABLE";
type RequestStatus = "PENDING" | "IN_SEPARATION" | "SENT" | "PARTIALLY_SENT" | "NOT_FULFILLED" | "CANCELLED";
type RequestItem = { id:number; description:string; reference:string|null; quantityRequested:number; itemStatus:ItemStatus; itemStatusLabel:string; quantitySent:number|null; notes:string|null };
type MaterialRequest = {
  id:number; requestNumber:string; requesterId:number; requester:string;
  serviceFrontId:number|null; serviceFront:string; requestedAt:string; status:RequestStatus; statusLabel:string; notes:string|null;
  shippedBy:number|null; shippedByName:string|null; shippedAt:string|null; shipmentNotes:string|null;
  cancelledAt:string|null; cancelledBy:number|null; cancelledByName:string|null; cancelReason:string|null;
  reopenedAt:string|null; reopenedBy:number|null; reopenedByName:string|null;
  isActive:boolean; isOwnRequest?:boolean; canCancel?:boolean; canReopen?:boolean;
  items:RequestItem[];
};
type Front = { id:number; name:string; location:string|null; active:boolean };
type AuthUser = { name:string; permissions:string[] };
type HistoryEntry = { id:number; userId:number|null; userName:string|null; action:string; previousValue:string|null; newValue:string|null; occurredAt:string };
type Tab = "received" | "sent" | "history";

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const numberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:2});
const statusTone:Record<RequestStatus,string> = { PENDING:"gray", IN_SEPARATION:"yellow", SENT:"green", PARTIALLY_SENT:"orange", NOT_FULFILLED:"red", CANCELLED:"gray" };
const STATUS_OPTIONS:Array<{value:RequestStatus|"";label:string}> = [
  { value:"", label:"Todos" }, { value:"PENDING", label:"Pendente" }, { value:"IN_SEPARATION", label:"Em separação" },
  { value:"SENT", label:"Enviado" }, { value:"PARTIALLY_SENT", label:"Enviado parcialmente" }, { value:"NOT_FULFILLED", label:"Não atendido" }, { value:"CANCELLED", label:"Cancelada" },
];
const HISTORY_ACTION_LABELS:Record<string,string> = {
  MATERIAL_REQUEST_CREATED:"Solicitação criada", MATERIAL_REQUEST_ITEMS_UPDATED:"Progresso da separação salvo",
  MATERIAL_REQUEST_SHIPPED:"Envio confirmado", MATERIAL_REQUEST_CANCELLED:"Solicitação cancelada", MATERIAL_REQUEST_REOPENED:"Solicitação reaberta",
};
function itemsSummary(items:RequestItem[]) { const text=items.map((item)=>item.description).join(", "); return text.length>90 ? `${text.slice(0,90)}…` : text; }

export default function MaterialRequestsView({ authUser, flash }:{ authUser:AuthUser; flash:(message:string)=>void }) {
  const [tab,setTab]=useState<Tab>("sent");
  const initialized=useRef(false);
  const [requests,setRequests]=useState<MaterialRequest[]>([]);
  const [fronts,setFronts]=useState<Front[]>([]);
  const [canRequest,setCanRequest]=useState(false);
  const [canShip,setCanShip]=useState(false);
  const [canManage,setCanManage]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [frontFilter,setFrontFilter]=useState("");
  const [creating,setCreating]=useState(false);
  const [shipping,setShipping]=useState<MaterialRequest|null>(null);
  const [viewing,setViewing]=useState<MaterialRequest|null>(null);
  const [cancelling,setCancelling]=useState<MaterialRequest|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{requests:MaterialRequest[];canRequest:boolean;canShip:boolean;canManage:boolean}>("/api/material-requests"); setRequests(result.requests); setCanRequest(result.canRequest); setCanShip(result.canShip); setCanManage(result.canManage); if(!initialized.current){ initialized.current=true; if(result.canManage||result.canShip) setTab("received"); } }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as solicitações."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ if(tab!=="history") load(); },[load,tab]);
  useEffect(()=>{ api<{fronts:Front[]}>("/api/service-fronts").then((result)=>setFronts(result.fronts)).catch(()=>setFronts([])); },[]);

  const scoped=useMemo(()=>requests.filter((item)=>tab==="received" ? !item.isOwnRequest : item.isOwnRequest),[requests,tab]);
  const filtered=useMemo(()=>scoped.filter((item)=>{
    const key=query.trim().toLocaleLowerCase("pt-BR");
    if(key && ![item.requestNumber,item.requester,item.serviceFront,itemsSummary(item.items)].some((value)=>value.toLocaleLowerCase("pt-BR").includes(key)))return false;
    if(statusFilter && item.status!==statusFilter)return false;
    if(frontFilter && item.serviceFront!==frontFilter)return false;
    return true;
  }),[scoped,query,statusFilter,frontFilter]);
  const hasActiveFilters=Boolean(query||statusFilter||frontFilter);
  const clearFilters=useCallback(()=>{ setQuery(""); setStatusFilter(""); setFrontFilter(""); },[]);

  const exportPdf=(item:MaterialRequest,kind:"REQUEST"|"SHIPMENT")=>window.open(`/api/material-requests-pdf?id=${item.id}&kind=${kind}`,"_blank","noopener,noreferrer");

  async function reopen(item:MaterialRequest) {
    if(!window.confirm(`Reabrir a solicitação ${item.requestNumber}? Ela voltará para as solicitações ativas.`)) return;
    try{ const result=await api<{message:string}>(`/api/material-requests/${item.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"REOPEN" }) }); await load(); flash(result.message); }
    catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível reabrir a solicitação."); }
  }

  if(loading && tab!=="history" && requests.length===0) return <div className="page-loading"><span/><p>Carregando solicitações de materiais...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">FRENTE DE SERVIÇO · ALMOXARIFADO</p><h1>Solicitação de Materiais</h1><span>Pedidos internos de materiais, com separação e envio rastreáveis.</span></div>{canRequest && <div className="heading-actions"><button className="primary" onClick={()=>setCreating(true)}>＋ Nova solicitação</button></div>}</div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação de Materiais">
      {(canShip||canManage) && <button className={tab==="received"?"active":""} onClick={()=>setTab("received")}>Solicitações Recebidas</button>}
      <button className={tab==="sent"?"active":""} onClick={()=>setTab("sent")}>Solicitações Enviadas</button>
      <button className={tab==="history"?"active":""} onClick={()=>setTab("history")}>Histórico</button>
    </div>
    {tab==="history" ? <MaterialHistoryPanel canManage={canManage} fronts={fronts} openDetails={setViewing}/> : <>
      <article className="panel module-panel">
        <div className="module-filters-grid">
          <label className="page-search span-wide"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar pedido, solicitante, frente ou material..."/></label>
          <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}>{STATUS_OPTIONS.filter((option)=>option.value!=="CANCELLED").map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {canManage && <label>Frente<select value={frontFilter} onChange={(event)=>setFrontFilter(event.target.value)}><option value="">Todas</option>{fronts.map((front)=><option key={front.id}>{front.name}</option>)}</select></label>}
          {hasActiveFilters && <button type="button" className="secondary clear-filters" onClick={clearFilters}>Limpar filtros</button>}
        </div>
        <div className="material-card-grid">
          {filtered.map((item)=><MaterialCard key={item.id} item={item} canShip={canShip}
            openDetails={()=>setViewing(item)} openShip={()=>setShipping(item)} openCancel={()=>setCancelling(item)}
            exportRequestPdf={()=>exportPdf(item,"REQUEST")} exportShipmentPdf={()=>exportPdf(item,"SHIPMENT")}/>)}
        </div>
        {filtered.length===0 && <div className="empty-state">Nenhuma solicitação {tab==="received"?"recebida":"enviada"} encontrada.{hasActiveFilters && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div>}
      </article>
    </>}
    {creating && <CreateRequestModal authUser={authUser} fronts={fronts} close={()=>setCreating(false)} saved={async(message)=>{ setCreating(false); await load(); flash(message); }}/>}
    {shipping && <ShipmentModal item={shipping} close={()=>setShipping(null)} saved={async(message,confirmed)=>{ const target=shipping; setShipping(null); await load(); flash(message); if(confirmed && target) exportPdf(target,"SHIPMENT"); }}/>}
    {cancelling && <CancelRequestModal item={cancelling} close={()=>setCancelling(null)} saved={async(message)=>{ setCancelling(null); await load(); flash(message); }}/>}
    {viewing && <RequestDetailsModal item={viewing} onReopen={viewing.canReopen?()=>{ setViewing(null); reopen(viewing); }:undefined} close={()=>setViewing(null)}/>}
  </>;
}

function MaterialCard({ item, canShip, openDetails, openShip, openCancel, exportRequestPdf, exportShipmentPdf }:{
  item:MaterialRequest; canShip:boolean;
  openDetails:()=>void; openShip:()=>void; openCancel:()=>void; exportRequestPdf:()=>void; exportShipmentPdf:()=>void;
}) {
  const isTerminalShippable=item.status==="SENT"||item.status==="PARTIALLY_SENT"||item.status==="NOT_FULFILLED";
  return <article className={`material-card accent-${statusTone[item.status]}`}>
    <header className="task-card-head">
      <span className="task-card-id">{item.requestNumber}</span>
      <h3><button type="button" className="task-title-link" onClick={openDetails}>{item.serviceFront}</button></h3>
      <div className="task-card-badges"><span className={`status-pill ${statusTone[item.status]}`}>{item.statusLabel}</span></div>
    </header>
    <div className="task-card-body">
      <p className="material-card-route"><strong>{item.serviceFront}</strong> → Almoxarifado</p>
      <dl>
        <div><dt>Solicitante</dt><dd>{item.requester}</dd></div>
        <div><dt>Data</dt><dd>{formatDate(item.requestedAt)}</dd></div>
        <div><dt>Itens</dt><dd>{item.items.length} item(ns)</dd></div>
        {item.shippedByName && <div><dt>Enviado por</dt><dd>{item.shippedByName}</dd></div>}
      </dl>
      {item.items.length>0 && <p className="task-card-description">{itemsSummary(item.items)}</p>}
    </div>
    <footer className="task-card-footer">
      <button onClick={openDetails}>Ver detalhes</button>
      <button onClick={exportRequestPdf}>PDF pedido</button>
      {canShip && item.isActive && <button className="transfer-action" onClick={openShip}>Separar / Enviar</button>}
      {isTerminalShippable && <button onClick={exportShipmentPdf}>PDF envio</button>}
      {item.canCancel && <button className="danger-action" onClick={openCancel}>Cancelar</button>}
    </footer>
  </article>;
}

// Histórico de Materiais (seção 11) — só solicitações terminais (finalizadas/recusadas/canceladas),
// com seus próprios filtros. Consulta dedicada (`/api/material-requests/history`), separada da
// lista principal na API, não só por CSS/filtro visual.
function MaterialHistoryPanel({ canManage, fronts, openDetails }:{ canManage:boolean; fronts:Front[]; openDetails:(item:MaterialRequest)=>void }) {
  const [entries,setEntries]=useState<MaterialRequest[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [q,setQ]=useState("");
  const [status,setStatus]=useState("");
  const [frontId,setFrontId]=useState("");
  const [from,setFrom]=useState("");
  const [to,setTo]=useState("");

  const load=useCallback(async()=>{
    setLoading(true); setError("");
    const params=new URLSearchParams();
    if(q)params.set("q",q); if(status)params.set("status",status); if(frontId)params.set("frontId",frontId);
    if(from)params.set("from",from); if(to)params.set("to",to);
    try{ const result=await api<{ requests:MaterialRequest[] }>(`/api/material-requests/history?${params.toString()}`); setEntries(result.requests); }
    catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar o histórico."); }
    finally{ setLoading(false); }
  },[q,status,frontId,from,to]);
  useEffect(()=>{ load(); },[load]);
  const hasActiveFilters=Boolean(q||status||frontId||from||to);
  const clearFilters=useCallback(()=>{ setQ(""); setStatus(""); setFrontId(""); setFrom(""); setTo(""); },[]);

  return <article className="panel module-panel">
    <div className="module-filters-grid">
      <label className="page-search span-wide"><span>⌕</span><input value={q} onChange={(event)=>setQ(event.target.value)} placeholder="Pesquisar número, material ou usuário..."/></label>
      <label>Status<select value={status} onChange={(event)=>setStatus(event.target.value)}>{STATUS_OPTIONS.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {canManage && <label>Frente<select value={frontId} onChange={(event)=>setFrontId(event.target.value)}><option value="">Todas</option>{fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
      <div className="date-range"><label>De<input type="date" value={from} onChange={(event)=>setFrom(event.target.value)}/></label><label>Até<input type="date" value={to} onChange={(event)=>setTo(event.target.value)}/></label></div>
      {hasActiveFilters && <button type="button" className="secondary clear-filters" onClick={clearFilters}>Limpar filtros</button>}
    </div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    {loading ? <div className="page-loading"><span/><p>Carregando histórico...</p></div> : <div className="material-card-grid">
      {entries.map((item)=><article key={item.id} className={`material-card accent-${statusTone[item.status]}`}>
        <header className="task-card-head">
          <span className="task-card-id">{item.requestNumber}</span>
          <h3><button type="button" className="task-title-link" onClick={()=>openDetails(item)}>{item.serviceFront}</button></h3>
          <div className="task-card-badges"><span className={`status-pill ${statusTone[item.status]}`}>{item.statusLabel}</span></div>
        </header>
        <div className="task-card-body">
          <dl>
            <div><dt>Solicitante</dt><dd>{item.requester}</dd></div>
            <div><dt>Solicitado em</dt><dd>{formatDate(item.requestedAt)}</dd></div>
            <div><dt>Última atualização</dt><dd>{formatDate(item.shippedAt ?? item.cancelledAt ?? item.requestedAt)}</dd></div>
            {item.cancelReason && <div><dt>Motivo do cancelamento</dt><dd>{item.cancelReason}</dd></div>}
          </dl>
        </div>
        <footer className="task-card-footer"><button onClick={()=>openDetails(item)}>Ver linha do tempo</button></footer>
      </article>)}
    </div>}
    {!loading && entries.length===0 && <div className="empty-state">Nenhum registro encontrado para os filtros atuais.{hasActiveFilters && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div>}
  </article>;
}

type DraftItem = { clientId:string; description:string; quantityRequested:string; reference:string };

function CreateRequestModal({ authUser, fronts, close, saved }:{ authUser:AuthUser; fronts:Front[]; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [serviceFrontId,setServiceFrontId]=useState("");
  const [notes,setNotes]=useState("");
  const [items,setItems]=useState<DraftItem[]>([{ clientId:crypto.randomUUID(), description:"", quantityRequested:"", reference:"" }]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const addItem=()=>setItems([...items,{ clientId:crypto.randomUUID(), description:"", quantityRequested:"", reference:"" }]);
  const patchItem=(clientId:string,patch:Partial<DraftItem>)=>setItems(items.map((item)=>item.clientId===clientId?{ ...item, ...patch }:item));
  const removeItem=(clientId:string)=>setItems(items.filter((item)=>item.clientId!==clientId));

  async function submit(event:FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result=await api<{message:string}>("/api/material-requests",{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ serviceFrontId:Number(serviceFrontId), notes, items:items.map((item)=>({ description:item.description, quantityRequested:Number(item.quantityRequested), reference:item.reference })) }) });
      await saved(result.message);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível enviar a solicitação."); }
    finally { setBusy(false); }
  }

  return <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal" onSubmit={submit}>
    <header><div><p>SOLICITAÇÃO DE MATERIAIS</p><h2>Nova solicitação</h2><span>Liste os itens necessários para a frente de serviço.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="fleet-form-grid">
        <label>Solicitante<input value={authUser.name} readOnly/></label>
        <label className="span-2">Frente de serviço / Obra / Setor *<select required value={serviceFrontId} onChange={(event)=>setServiceFrontId(event.target.value)}><option value="" disabled>Selecione</option>{fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      </div>
      <section className="fleet-form-section">
        <div className="fleet-section-title"><h3>Itens solicitados</h3><button type="button" onClick={addItem}>＋ ADICIONAR ITEM</button></div>
        {items.map((item,index)=><div className="fleet-order-editor" key={item.clientId}>
          <header><b>Item {index+1}</b>{items.length>1 && <button type="button" onClick={()=>removeItem(item.clientId)}>Remover</button>}</header>
          <div className="fleet-form-grid">
            <label className="span-2">Descrição do item *<input required value={item.description} onChange={(event)=>patchItem(item.clientId,{ description:event.target.value })}/></label>
            <label>Quantidade solicitada *<input required type="number" min="0.01" step="0.01" value={item.quantityRequested} onChange={(event)=>patchItem(item.clientId,{ quantityRequested:event.target.value })}/></label>
            <label>Referência<input value={item.reference} onChange={(event)=>patchItem(item.clientId,{ reference:event.target.value })}/></label>
          </div>
        </div>)}
      </section>
      <label className="fleet-notes">Observações gerais<textarea value={notes} onChange={(event)=>setNotes(event.target.value)}/></label>
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"ENVIANDO...":"ENVIAR SOLICITAÇÃO"}</button></footer>
  </form></div>;
}

function ShipmentModal({ item, close, saved }:{ item:MaterialRequest; close:()=>void; saved:(message:string,confirmed:boolean)=>Promise<void> }) {
  const [statuses,setStatuses]=useState<Record<number,ItemStatus>>(()=>Object.fromEntries(item.items.map((row)=>[row.id,row.itemStatus])));
  const [quantities,setQuantities]=useState<Record<number,string>>(()=>Object.fromEntries(item.items.map((row)=>[row.id,String(row.quantitySent ?? row.quantityRequested)])));
  const [shipmentNotes,setShipmentNotes]=useState(item.shipmentNotes ?? "");
  const [busy,setBusy]=useState<"SAVE"|"CONFIRM"|null>(null);
  const [error,setError]=useState("");
  const allDecided=item.items.every((row)=>statuses[row.id]!=="PENDING");

  function mark(itemId:number,status:ItemStatus) { setStatuses((current)=>({ ...current, [itemId]:status })); }

  async function submit(confirm:boolean) {
    setBusy(confirm?"CONFIRM":"SAVE"); setError("");
    try {
      const payload={ confirm, shipmentNotes, items:item.items.map((row)=>({ id:row.id, itemStatus:statuses[row.id], quantitySent:statuses[row.id]==="SENT"?Number(quantities[row.id]):null })) };
      const result=await api<{message:string}>(`/api/material-requests/${item.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
      await saved(result.message,confirm);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível salvar o envio."); }
    finally { setBusy(null); }
  }

  return <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal">
    <header><div><p>SEPARAÇÃO E ENVIO</p><h2>{item.requestNumber} · {item.requester}</h2><span>{item.serviceFront} · Solicitado em {formatDate(item.requestedAt)}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <section className="fleet-form-section">
        <h3>Itens solicitados</h3>
        {item.items.map((row)=>{ const status=statuses[row.id]; return <div className="fleet-order-editor" key={row.id}>
          <header><b>{row.description}</b><span>Solicitado: {numberFormat.format(row.quantityRequested)}{row.reference?` · Ref.: ${row.reference}`:""}</span></header>
          <div className="fleet-form-grid">
            <label>Marcação<div className="fleet-check" style={{ display:"flex", gap:"6px" }}>
              <button type="button" className={status==="SENT"?"primary":"secondary"} onClick={()=>mark(row.id,"SENT")}>✓ Enviado / Tem</button>
              <button type="button" className={status==="NOT_AVAILABLE"?"primary":"secondary"} onClick={()=>mark(row.id,"NOT_AVAILABLE")}>✕ Não tem</button>
            </div></label>
            {status==="SENT" && <label>Quantidade enviada *<input type="number" min="0.01" step="0.01" value={quantities[row.id]} onChange={(event)=>setQuantities((current)=>({ ...current, [row.id]:event.target.value }))}/></label>}
          </div>
        </div>; })}
      </section>
      <label className="fleet-notes">Observações do envio<textarea value={shipmentNotes} onChange={(event)=>setShipmentNotes(event.target.value)}/></label>
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close}>Cancelar</button><button type="button" onClick={()=>submit(false)} disabled={busy!==null}>{busy==="SAVE"?"SALVANDO...":"SALVAR PROGRESSO"}</button><button type="button" className="primary" disabled={busy!==null || !allDecided} onClick={()=>submit(true)}>{busy==="CONFIRM"?"CONFIRMANDO...":"CONFIRMAR ENVIO"}</button></footer>
  </section></div>;
}

function CancelRequestModal({ item, close, saved }:{ item:MaterialRequest; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!reason.trim()) { setError("O motivo do cancelamento é obrigatório."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/material-requests/${item.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"CANCEL", cancelReason:reason }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível cancelar a solicitação."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">CANCELAR SOLICITAÇÃO</p><h2>{item.requestNumber}</h2><span>A solicitação irá para o Histórico. Informe o motivo.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Motivo do cancelamento *<textarea required value={reason} onChange={(event)=>setReason(event.target.value)}/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Voltar</button><button className="primary danger-action" disabled={busy}>{busy?"Cancelando...":"Confirmar cancelamento"}</button></div>
      </form>
    </section>
  </div>;
}

function RequestDetailsModal({ item, onReopen, close }:{ item:MaterialRequest; onReopen?:()=>void; close:()=>void }) {
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  useEffect(()=>{ api<{ history:HistoryEntry[] }>(`/api/material-requests/${item.id}`).then((result)=>setHistory(result.history)).catch(()=>setHistory([])); },[item.id]);
  return <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal">
    <header><div><p>DETALHES DO PEDIDO</p><h2>{item.requestNumber} · {item.requester}</h2><span>{item.serviceFront} · Solicitado em {formatDate(item.requestedAt)}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="fleet-current-banner"><span>Status do pedido</span><b className={`status-pill ${statusTone[item.status]}`}>{item.statusLabel}</b>{item.shippedByName && <small>Enviado por {item.shippedByName} em {formatDate(item.shippedAt)}</small>}{item.cancelledByName && <small>Cancelado por {item.cancelledByName} em {formatDate(item.cancelledAt)}</small>}</div>
      <div className="table-scroll"><table><thead><tr><th>Descrição</th><th>Qtd. solicitada</th><th>Referência</th><th>Status</th><th>Qtd. enviada</th></tr></thead><tbody>
        {item.items.map((row)=><tr key={row.id}><td>{row.description}</td><td>{numberFormat.format(row.quantityRequested)}</td><td>{row.reference ?? "—"}</td><td><span className={`status-pill ${row.itemStatus==="SENT"?"green":row.itemStatus==="NOT_AVAILABLE"?"red":"gray"}`}>{row.itemStatusLabel}</span></td><td>{row.quantitySent===null?"—":numberFormat.format(row.quantitySent)}</td></tr>)}
      </tbody></table></div>
      {item.notes && <p><strong>Observações:</strong> {item.notes}</p>}
      {item.shipmentNotes && <p><strong>Observações do envio:</strong> {item.shipmentNotes}</p>}
      {item.cancelReason && <p><strong>Motivo do cancelamento:</strong> {item.cancelReason}</p>}
      <p className="eyebrow">LINHA DO TEMPO</p>
      <div className="table-scroll"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th></tr></thead><tbody>
        {history.map((entry)=><tr key={entry.id}><td>{formatDate(entry.occurredAt)}</td><td>{entry.userName??"—"}</td><td>{HISTORY_ACTION_LABELS[entry.action]??entry.action}</td></tr>)}
      </tbody></table></div>
      {history.length===0 && <div className="empty-state">Nenhum registro de histórico.</div>}
    </div>
    <footer>{onReopen && <button type="button" className="secondary" onClick={onReopen}>Reabrir solicitação</button>}<button className="primary" onClick={close}>Fechar</button></footer>
  </section></div>;
}
