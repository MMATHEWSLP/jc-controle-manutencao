"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type ItemStatus = "PENDING" | "SENT" | "NOT_AVAILABLE";
type RequestStatus = "PENDING" | "IN_SEPARATION" | "SENT" | "PARTIALLY_SENT" | "NOT_FULFILLED";
type RequestItem = { id:number; description:string; reference:string|null; quantityRequested:number; itemStatus:ItemStatus; itemStatusLabel:string; quantitySent:number|null; notes:string|null };
type MaterialRequest = {
  id:number; requestNumber:string; requesterId:number; requester:string;
  serviceFrontId:number|null; serviceFront:string; requestedAt:string; status:RequestStatus; statusLabel:string; notes:string|null;
  shippedBy:number|null; shippedByName:string|null; shippedAt:string|null; shipmentNotes:string|null;
  items:RequestItem[];
};
type Front = { id:number; name:string; location:string|null; active:boolean };
type AuthUser = { name:string; permissions:string[] };

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const numberFormat=new Intl.NumberFormat("pt-BR",{maximumFractionDigits:2});
const statusTone:Record<RequestStatus,string> = { PENDING:"gray", IN_SEPARATION:"yellow", SENT:"green", PARTIALLY_SENT:"orange", NOT_FULFILLED:"red" };
const isTerminal=(status:RequestStatus)=>status==="SENT"||status==="NOT_FULFILLED";

export default function MaterialRequestsView({ authUser, flash }:{ authUser:AuthUser; flash:(message:string)=>void }) {
  const [requests,setRequests]=useState<MaterialRequest[]>([]);
  const [fronts,setFronts]=useState<Front[]>([]);
  const [canRequest,setCanRequest]=useState(false);
  const [canShip,setCanShip]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [frontFilter,setFrontFilter]=useState("");
  const [creating,setCreating]=useState(false);
  const [shipping,setShipping]=useState<MaterialRequest|null>(null);
  const [viewing,setViewing]=useState<MaterialRequest|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{requests:MaterialRequest[];canRequest:boolean;canShip:boolean}>("/api/material-requests"); setRequests(result.requests); setCanRequest(result.canRequest); setCanShip(result.canShip); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as solicitações."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ api<{fronts:Front[]}>("/api/service-fronts").then((result)=>setFronts(result.fronts)).catch(()=>setFronts([])); },[]);

  const filtered=useMemo(()=>requests.filter((item)=>{
    const key=query.trim().toLocaleLowerCase("pt-BR");
    if(key && ![item.requestNumber,item.requester,item.serviceFront].some((value)=>value.toLocaleLowerCase("pt-BR").includes(key)))return false;
    if(statusFilter && item.status!==statusFilter)return false;
    if(frontFilter && item.serviceFront!==frontFilter)return false;
    return true;
  }),[requests,query,statusFilter,frontFilter]);

  const exportPdf=(item:MaterialRequest,kind:"REQUEST"|"SHIPMENT")=>window.open(`/api/material-requests-pdf?id=${item.id}&kind=${kind}`,"_blank","noopener,noreferrer");

  if(loading && requests.length===0) return <div className="page-loading"><span/><p>Carregando solicitações de materiais...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">FRENTE DE SERVIÇO · ALMOXARIFADO</p><h1>Solicitação de Materiais</h1><span>Pedidos internos de materiais, com separação e envio rastreáveis.</span></div>{canRequest && <div className="heading-actions"><button className="primary" onClick={()=>setCreating(true)}>＋ Nova solicitação</button></div>}</div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <article className="panel module-panel">
      <div className="equipment-management-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar pedido, solicitante ou frente..."/></label>
        <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">Todos</option><option value="PENDING">Pendente</option><option value="IN_SEPARATION">Em separação</option><option value="SENT">Enviado</option><option value="PARTIALLY_SENT">Enviado parcialmente</option><option value="NOT_FULFILLED">Não atendido</option></select></label>
        <label>Frente<select value={frontFilter} onChange={(event)=>setFrontFilter(event.target.value)}><option value="">Todas</option>{fronts.map((front)=><option key={front.id}>{front.name}</option>)}</select></label>
      </div>
      <div className="table-scroll"><table><thead><tr><th>Pedido</th><th>Solicitante</th><th>Frente</th><th>Data</th><th>Itens</th><th>Status</th><th>Ações</th></tr></thead><tbody>
        {filtered.map((item)=><tr key={item.id}>
          <td><strong>{item.requestNumber}</strong></td>
          <td>{item.requester}</td>
          <td>{item.serviceFront}</td>
          <td>{formatDate(item.requestedAt)}</td>
          <td>{item.items.length}</td>
          <td><span className={`status-pill ${statusTone[item.status]}`}>{item.statusLabel}</span></td>
          <td><div className="equipment-row-actions">
            <button onClick={()=>setViewing(item)}>Ver</button>
            <button onClick={()=>exportPdf(item,"REQUEST")}>PDF pedido</button>
            {canShip && !isTerminal(item.status) && <button className="transfer-action" onClick={()=>setShipping(item)}>Separar / Enviar</button>}
            {isTerminal(item.status) || item.status==="PARTIALLY_SENT" ? <button onClick={()=>exportPdf(item,"SHIPMENT")}>PDF envio</button> : null}
          </div></td>
        </tr>)}
      </tbody></table>{filtered.length===0 && <div className="empty-state">Nenhuma solicitação encontrada.</div>}</div>
    </article>
    {creating && <CreateRequestModal authUser={authUser} fronts={fronts} close={()=>setCreating(false)} saved={async(message)=>{ setCreating(false); await load(); flash(message); }}/>}
    {shipping && <ShipmentModal item={shipping} close={()=>setShipping(null)} saved={async(message,confirmed)=>{ const target=shipping; setShipping(null); await load(); flash(message); if(confirmed && target) exportPdf(target,"SHIPMENT"); }}/>}
    {viewing && <RequestDetailsModal item={viewing} close={()=>setViewing(null)}/>}
  </>;
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

function RequestDetailsModal({ item, close }:{ item:MaterialRequest; close:()=>void }) {
  return <div className="fleet-modal-backdrop" role="presentation"><section className="fleet-modal">
    <header><div><p>DETALHES DO PEDIDO</p><h2>{item.requestNumber} · {item.requester}</h2><span>{item.serviceFront} · Solicitado em {formatDate(item.requestedAt)}</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="fleet-current-banner"><span>Status do pedido</span><b className={`status-pill ${statusTone[item.status]}`}>{item.statusLabel}</b>{item.shippedByName && <small>Enviado por {item.shippedByName} em {formatDate(item.shippedAt)}</small>}</div>
      <div className="table-scroll"><table><thead><tr><th>Descrição</th><th>Qtd. solicitada</th><th>Referência</th><th>Status</th><th>Qtd. enviada</th></tr></thead><tbody>
        {item.items.map((row)=><tr key={row.id}><td>{row.description}</td><td>{numberFormat.format(row.quantityRequested)}</td><td>{row.reference ?? "—"}</td><td><span className={`status-pill ${row.itemStatus==="SENT"?"green":row.itemStatus==="NOT_AVAILABLE"?"red":"gray"}`}>{row.itemStatusLabel}</span></td><td>{row.quantitySent===null?"—":numberFormat.format(row.quantitySent)}</td></tr>)}
      </tbody></table></div>
      {item.notes && <p><strong>Observações:</strong> {item.notes}</p>}
      {item.shipmentNotes && <p><strong>Observações do envio:</strong> {item.shipmentNotes}</p>}
    </div>
    <footer><button className="primary" onClick={close}>Fechar</button></footer>
  </section></div>;
}
