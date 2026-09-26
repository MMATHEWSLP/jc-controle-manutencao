"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type FormEvent } from "react";

// Painéis de gestão do Controle Diário: aprovação de mudança de frente (daily.front_requests)
// e cadastro de funcionários de campo (daily.field_operators).
type Front = { id:number; name:string };
type FrontRequest = {
  id:number; equipmentId:number; prefix:string; equipmentType:string; model:string; currentFront:string; requestedFront:string|null;
  reason:string|null; requestedBy:string; requestedAt:string; status:"PENDING"|"APPROVED"|"REJECTED"; reviewedBy:string|null; reviewedAt:string|null; reviewNote:string|null;
};
type FieldOperator = { id:number; name:string; jobTitle:string|null; active:boolean; serviceFrontIds:number[]; lastAccessAt:string|null };

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
const jsonInit=(method:string,body:unknown):RequestInit=>({ method, headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
function formatDateTime(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const statusLabel={ PENDING:"Pendente", APPROVED:"Aprovada", REJECTED:"Recusada" } as const;
const statusTone={ PENDING:"orange", APPROVED:"green", REJECTED:"gray" } as const;

// ---------------------------------------------------------------------------
// Solicitações de mudança de frente
// ---------------------------------------------------------------------------
export function FrontRequestsPanel({ flash, onChanged }:{ flash:(message:string)=>void; onChanged:()=>void }) {
  const [status,setStatus]=useState<"PENDING"|"ALL">("PENDING");
  const [requests,setRequests]=useState<FrontRequest[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [rejecting,setRejecting]=useState<FrontRequest|null>(null);
  const [busyId,setBusyId]=useState<number|null>(null);
  const load=useCallback(async()=>{
    setLoading(true); setError("");
    try { setRequests((await api<{requests:FrontRequest[]}>(`/api/daily-records/front-requests?status=${status}`)).requests); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Falha ao carregar."); }
    finally { setLoading(false); }
  },[status]);
  useEffect(()=>{ load(); },[load]);

  async function review(item:FrontRequest, action:"APPROVE"|"REJECT", note:string) {
    setBusyId(item.id); setError("");
    try { const result=await api<{message:string}>(`/api/daily-records/front-requests/${item.id}`,jsonInit("POST",{ action, note })); flash(result.message); setRejecting(null); await load(); onChanged(); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível concluir."); }
    finally { setBusyId(null); }
  }

  return <article className="panel module-panel">
    <div className="module-filters-grid">
      <label>Mostrar<select value={status} onChange={(event)=>setStatus(event.target.value as "PENDING"|"ALL")}><option value="PENDING">Pendentes</option><option value="ALL">Todas (inclui analisadas)</option></select></label>
    </div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {loading ? <div className="page-loading"><span/><p>Carregando solicitações...</p></div> : <div className="daily-records">
      {requests.map((item)=><article key={item.id} className={`daily-record ${item.status==="PENDING"?"warn":item.status==="APPROVED"?"ok":"off"}`}>
        <header><strong>{item.prefix}</strong><span>{formatDateTime(item.requestedAt)}</span><span className={`status-pill ${statusTone[item.status]}`}>{statusLabel[item.status]}</span></header>
        <p className="daily-front-route"><span>{item.currentFront}</span><b>→</b><strong>{item.requestedFront??"—"}</strong></p>
        <dl>
          <div><dt>Pedido por</dt><dd>{item.requestedBy}</dd></div>
          <div><dt>Equipamento</dt><dd>{item.equipmentType} {item.model}</dd></div>
          {item.reason && <div className="wide"><dt>Observações</dt><dd className="daily-pre">{item.reason}</dd></div>}
          {item.status!=="PENDING" && <div className="wide"><dt>Analisado por</dt><dd>{item.reviewedBy} · {formatDateTime(item.reviewedAt)}{item.reviewNote?` — ${item.reviewNote}`:""}</dd></div>}
        </dl>
        {item.status==="PENDING" && <footer className="daily-record-actions">
          <button type="button" className="danger-action" disabled={busyId===item.id} onClick={()=>setRejecting(item)}>Recusar</button>
          <button type="button" className="primary" disabled={busyId===item.id} onClick={()=>review(item,"APPROVE","")}>{busyId===item.id?"Aplicando...":"Aprovar e transferir"}</button>
        </footer>}
      </article>)}
      {requests.length===0 && <div className="empty-state">{status==="PENDING"?"Nenhuma solicitação pendente.":"Nenhuma solicitação registrada."}</div>}
    </div>}
    {rejecting && <RejectModal item={rejecting} busy={busyId===rejecting.id} close={()=>setRejecting(null)} confirm={(note)=>review(rejecting,"REJECT",note)}/>}
  </article>;
}

function RejectModal({ item, busy, close, confirm }:{ item:FrontRequest; busy:boolean; close:()=>void; confirm:(note:string)=>void }) {
  const [note,setNote]=useState("");
  return <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal daily-review" onSubmit={(event)=>{ event.preventDefault(); confirm(note); }}>
    <header><div><p>SOLICITAÇÃO DE FRENTE</p><h2>Recusar mudança do {item.prefix}?</h2><span>O equipamento continua em {item.currentFront}.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body"><label className="daily-field">Motivo da recusa *<textarea rows={3} value={note} onChange={(event)=>setNote(event.target.value)} placeholder="Ex.: o equipamento voltou para a frente original"/></label></div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary daily-danger" disabled={busy||note.trim().length<5}>{busy?"RECUSANDO...":"RECUSAR"}</button></footer>
  </form></div>;
}

// ---------------------------------------------------------------------------
// Funcionários de campo (login por nome + código)
// ---------------------------------------------------------------------------
export function FieldOperatorsPanel({ fronts, flash }:{ fronts:Front[]; flash:(message:string)=>void }) {
  const [operators,setOperators]=useState<FieldOperator[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [editing,setEditing]=useState<FieldOperator|"new"|null>(null);
  const [query,setQuery]=useState("");
  const load=useCallback(async()=>{
    setLoading(true); setError("");
    try { setOperators((await api<{operators:FieldOperator[]}>("/api/field-operators")).operators); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Falha ao carregar."); }
    finally { setLoading(false); }
  },[]);
  useEffect(()=>{ load(); },[load]);
  const frontName=(id:number)=>fronts.find((front)=>front.id===id)?.name??`Frente ${id}`;
  const key=query.trim().toLocaleLowerCase("pt-BR");
  const visible=operators.filter((item)=>!key||item.name.toLocaleLowerCase("pt-BR").includes(key)||(item.jobTitle??"").toLocaleLowerCase("pt-BR").includes(key));

  return <article className="panel module-panel">
    <div className="daily-operators-head">
      <div><strong>Funcionários com acesso de campo</strong><span>Entram escolhendo o nome e digitando o código, e só veem o Controle Diário. O código nunca aparece de novo depois de salvo: entregue-o pessoalmente.</span></div>
      <button type="button" className="primary" onClick={()=>setEditing("new")}>＋ Novo funcionário</button>
    </div>
    <div className="module-filters-grid"><label className="page-search span-wide"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar por nome ou função..."/></label></div>
    {error && <div className="fleet-form-error">! {error}</div>}
    {loading ? <div className="page-loading"><span/><p>Carregando funcionários...</p></div> : <div className="daily-records">
      {visible.map((item)=><article key={item.id} className={`daily-record ${item.active?"ok":"off"}`}>
        <header><strong>{item.name}</strong><span/><span className={`status-pill ${item.active?"green":"gray"}`}>{item.active?"Ativo":"Inativo"}</span></header>
        <dl>
          <div><dt>Função</dt><dd>{item.jobTitle??"—"}</dd></div>
          <div><dt>Frentes</dt><dd>{item.serviceFrontIds.map(frontName).join(", ")||"—"}</dd></div>
          <div className="wide"><dt>Último acesso</dt><dd>{formatDateTime(item.lastAccessAt)}</dd></div>
        </dl>
        <footer className="daily-record-actions"><button type="button" className="secondary" onClick={()=>setEditing(item)}>Editar / trocar código</button></footer>
      </article>)}
      {visible.length===0 && <div className="empty-state">Nenhum funcionário de campo cadastrado.</div>}
    </div>}
    {editing && <OperatorModal item={editing==="new"?null:editing} fronts={fronts} close={()=>setEditing(null)} saved={async(message)=>{ setEditing(null); flash(message); await load(); }}/>}
  </article>;
}

function OperatorModal({ item, fronts, close, saved }:{ item:FieldOperator|null; fronts:Front[]; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [name,setName]=useState(item?.name??"");
  const [jobTitle,setJobTitle]=useState(item?.jobTitle??"");
  const [code,setCode]=useState("");
  const [frontIds,setFrontIds]=useState<number[]>(item?.serviceFrontIds??[]);
  const [active,setActive]=useState(item?.active??true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const body={ name, jobTitle, code, serviceFrontIds:frontIds, active };
      const result=item?await api<{message:string}>(`/api/field-operators/${item.id}`,jsonInit("PUT",body)):await api<{message:string}>("/api/field-operators",jsonInit("POST",body));
      await saved(result.message);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  const toggleFront=(id:number)=>setFrontIds((current)=>current.includes(id)?current.filter((value)=>value!==id):[...current,id]);
  return <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal daily-review" onSubmit={submit}>
    <header><div><p>ACESSO DE CAMPO</p><h2>{item?"Editar funcionário":"Novo funcionário de campo"}</h2><span>Login sem senha: nome + código numérico de 4 a 8 dígitos.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
    <div className="fleet-modal-body">
      <div className="fleet-form-grid">
        <label className="daily-field span-2">Nome completo *<input value={name} onChange={(event)=>setName(event.target.value)} placeholder="Ex.: JOÃO DA SILVA" autoCapitalize="characters"/></label>
        <label className="daily-field">Função *<input value={jobTitle} onChange={(event)=>setJobTitle(event.target.value)} placeholder="Ex.: Operador de Baldeio"/></label>
        <label className="daily-field">{item?"Novo código (deixe vazio para manter)":"Código de acesso *"}<input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={code} onChange={(event)=>setCode(event.target.value.replace(/\D/g,"").slice(0,8))} placeholder="4 a 8 números"/></label>
        <label className="daily-field"><span>Situação</span><select value={active?"1":"0"} onChange={(event)=>setActive(event.target.value==="1")}><option value="1">Ativo (pode entrar)</option><option value="0">Inativo (acesso bloqueado)</option></select></label>
      </div>
      <fieldset className="daily-front-checks"><legend>Frentes em que trabalha *</legend>{fronts.map((front)=><label key={front.id}><input type="checkbox" checked={frontIds.includes(front.id)} onChange={()=>toggleFront(front.id)}/>{front.name}</label>)}</fieldset>
      <p className="daily-security-note">⚠ Sem senha, quem souber o nome e o código entra no lugar do funcionário. Não use datas de nascimento nem números óbvios (1234, 0000). Após 5 tentativas erradas o acesso fica bloqueado por 15 minutos.</p>
      {error && <div className="fleet-form-error">! {error}</div>}
    </div>
    <footer><button type="button" onClick={close} disabled={busy}>Cancelar</button><button className="primary" disabled={busy}>{busy?"SALVANDO...":"SALVAR"}</button></footer>
  </form></div>;
}
