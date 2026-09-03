"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "NOT_DONE";
type TaskNode = {
  id:number; parentTaskId:number|null; title:string; description:string|null;
  assigneeId:number|null; assigneeName:string|null;
  urgency:Urgency; urgencyLabel:string; dueDate:string; status:TaskStatus; statusLabel:string;
  createdBy:number|null; createdByName:string|null;
  completedAt:string|null; completedBy:number|null; completionNote:string|null;
  notDoneAt:string|null; notDoneBy:number|null; notDoneReason:string|null;
  overdue:boolean; dueSoon:boolean;
  progressPercent:number|null; totalDescendants:number; completedDescendants:number;
  canEdit:boolean; canReassign:boolean; canDelete:boolean; canComplete:boolean; canMarkNotDone:boolean;
  children:TaskNode[];
};
type AssignableUser = { id:number; name:string };
type AuthUser = { name:string; permissions:string[] };
type HistoryEntry = { id:number; userId:number|null; userName:string|null; action:string; previousValue:string|null; newValue:string|null; occurredAt:string };
type TaskDetail = TaskNode & { createdAt:string; updatedAt:string };

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string) { if(!value)return "—"; const date=new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(date); }
function formatDateTime(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const urgencyTone:Record<Urgency,string> = { LOW:"green", MEDIUM:"yellow", HIGH:"orange", URGENT:"red" };
const statusTone:Record<TaskStatus,string> = { TODO:"gray", IN_PROGRESS:"yellow", DONE:"green", NOT_DONE:"red" };
const HISTORY_ACTION_LABELS:Record<string,string> = { TASK_CREATED:"Tarefa criada", TASK_UPDATED:"Dados atualizados", TASK_REASSIGNED:"Responsável alterado", TASK_COMPLETED:"Concluída", TASK_NOT_DONE:"Marcada como não realizada", TASK_DELETED:"Excluída" };

function flattenTree(nodes:TaskNode[]):TaskNode[] { return nodes.flatMap((node)=>[node,...flattenTree(node.children)]); }
function matchesFilters(node:TaskNode,query:string,urgency:string,status:string,overdueOnly:boolean) {
  if(overdueOnly && !node.overdue) return false;
  if(urgency && node.urgency!==urgency) return false;
  if(status && node.status!==status) return false;
  if(query) { const key=query.toLocaleLowerCase("pt-BR"); const haystack=`${node.title} ${node.assigneeName??""}`.toLocaleLowerCase("pt-BR"); if(!haystack.includes(key)) return false; }
  return true;
}
function nodeMatches(node:TaskNode,predicate:(node:TaskNode)=>boolean):boolean { return predicate(node) || node.children.some((child)=>nodeMatches(child,predicate)); }

export default function TasksView({ flash }:{ authUser:AuthUser; flash:(message:string)=>void }) {
  const [tree,setTree]=useState<TaskNode[]>([]);
  const [assignableUsers,setAssignableUsers]=useState<AssignableUser[]>([]);
  const [canCreate,setCanCreate]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [urgencyFilter,setUrgencyFilter]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [overdueOnly,setOverdueOnly]=useState(false);
  const [collapsed,setCollapsed]=useState<Set<number>>(new Set());
  const [modal,setModal]=useState<{ item:TaskNode|null; presetParentId:number|null }|null>(null);
  const [completing,setCompleting]=useState<TaskNode|null>(null);
  const [notDoing,setNotDoing]=useState<TaskNode|null>(null);
  const [viewingId,setViewingId]=useState<number|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{ tasks:TaskNode[]; assignableUsers:AssignableUser[]; canCreate:boolean }>("/api/tasks"); setTree(result.tasks); setAssignableUsers(result.assignableUsers); setCanCreate(result.canCreate); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as tarefas."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);

  const flatTasks=useMemo(()=>flattenTree(tree),[tree]);
  const predicate=useCallback((node:TaskNode)=>matchesFilters(node,query,urgencyFilter,statusFilter,overdueOnly),[query,urgencyFilter,statusFilter,overdueOnly]);
  const visibleRoots=useMemo(()=>tree.filter((root)=>nodeMatches(root,predicate)),[tree,predicate]);
  const overdueCount=useMemo(()=>flatTasks.filter((node)=>node.overdue).length,[flatTasks]);

  function toggleCollapse(id:number) { setCollapsed((current)=>{ const next=new Set(current); if(next.has(id))next.delete(id); else next.add(id); return next; }); }
  async function removeTask(node:TaskNode) {
    if(!window.confirm(`Excluir a tarefa "${node.title}"? Esta ação registra quem excluiu e não pode ser desfeita pela interface.`)) return;
    try{ const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"DELETE" }); await load(); flash(result.message); }catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível excluir a tarefa."); }
  }

  if(loading && tree.length===0) return <div className="page-loading"><span/><p>Carregando tarefas...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">GESTÃO DE EQUIPE</p><h1>Tarefas</h1><span>Visibilidade por hierarquia: cada um só vê tarefas em que é responsável, criador ou superior do responsável.{overdueCount>0?` ${overdueCount} tarefa(s) atrasada(s) visível(is) para você.`:""}</span></div>{canCreate && <div className="heading-actions"><button className="primary" onClick={()=>setModal({ item:null, presetParentId:null })}>＋ Nova tarefa</button></div>}</div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <article className="panel module-panel">
      <div className="equipment-management-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar tarefa ou responsável..."/></label>
        <label>Urgência<select value={urgencyFilter} onChange={(event)=>setUrgencyFilter(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">Todos</option><option value="TODO">Pendente</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option><option value="NOT_DONE">Não realizada</option></select></label>
        <label className="fleet-check"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/> Somente atrasadas</label>
      </div>
      <div className="task-tree">
        {visibleRoots.map((root)=><TaskRow key={root.id} node={root} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse}
          openEdit={(node)=>setModal({ item:node, presetParentId:null })} openCreateChild={(node)=>setModal({ item:null, presetParentId:node.id })}
          openComplete={setCompleting} openNotDone={setNotDoing} openDetails={(node)=>setViewingId(node.id)} remove={removeTask} canCreate={canCreate}/>)}
        {visibleRoots.length===0 && <div className="empty-state">Nenhuma tarefa encontrada.</div>}
      </div>
    </article>
    {modal && <TaskModal item={modal.item} presetParentId={modal.presetParentId} assignableUsers={assignableUsers} flatTasks={flatTasks} close={()=>setModal(null)} saved={async(message)=>{ setModal(null); await load(); flash(message); }}/>}
    {completing && <CompleteModal node={completing} close={()=>setCompleting(null)} saved={async(message)=>{ setCompleting(null); await load(); flash(message); }}/>}
    {notDoing && <NotDoneModal node={notDoing} close={()=>setNotDoing(null)} saved={async(message)=>{ setNotDoing(null); await load(); flash(message); }}/>}
    {viewingId!==null && <TaskDetailModal id={viewingId} close={()=>setViewingId(null)}/>}
  </>;
}

function TaskRow({ node, depth, collapsed, toggleCollapse, openEdit, openCreateChild, openComplete, openNotDone, openDetails, remove, canCreate }:{
  node:TaskNode; depth:number; collapsed:Set<number>; toggleCollapse:(id:number)=>void;
  openEdit:(node:TaskNode)=>void; openCreateChild:(node:TaskNode)=>void; openComplete:(node:TaskNode)=>void; openNotDone:(node:TaskNode)=>void;
  openDetails:(node:TaskNode)=>void; remove:(node:TaskNode)=>void; canCreate:boolean;
}) {
  const isCollapsed=collapsed.has(node.id);
  const rowClass=`task-row ${node.overdue?"overdue":node.dueSoon?"due-soon":""}`.trim();
  return <>
    <div className={rowClass} style={{ paddingLeft:`${depth*22}px` }}>
      {node.children.length>0 ? <button type="button" className="task-toggle" onClick={()=>toggleCollapse(node.id)} aria-label={isCollapsed?"Expandir":"Recolher"}>{isCollapsed?"▸":"▾"}</button> : <span className="task-toggle-spacer"/>}
      <div className="task-main">
        <div className="task-title-line"><button type="button" className="task-title-link" onClick={()=>openDetails(node)}><strong className={node.status==="DONE"?"task-done":""}>{node.title}</strong></button><span className={`status-pill ${urgencyTone[node.urgency]}`}>{node.urgencyLabel}</span><span className={`status-pill ${statusTone[node.status]}`}>{node.statusLabel}</span></div>
        <div className="task-meta">
          <span>Responsável: {node.assigneeName??"—"}</span>
          <span>Criado por: {node.createdByName??"—"}</span>
          <span className={node.overdue?"danger-text":node.dueSoon?"warning-text":""}>Prazo: {formatDate(node.dueDate)}{node.overdue?" · Atrasada":node.dueSoon?" · Vence em breve":""}</span>
          {node.progressPercent!==null && <span>{node.progressPercent}% concluído ({node.completedDescendants}/{node.totalDescendants})</span>}
        </div>
      </div>
      <div className="equipment-row-actions">
        {node.canComplete && <button className="primary" onClick={()=>openComplete(node)}>Concluir</button>}
        {node.canMarkNotDone && <button onClick={()=>openNotDone(node)}>Não realizar</button>}
        {canCreate && node.canEdit && <button onClick={()=>openCreateChild(node)}>+ Subtarefa</button>}
        {node.canEdit && <button onClick={()=>openEdit(node)}>Editar</button>}
        {node.canDelete && <button className="danger-action" onClick={()=>remove(node)}>Excluir</button>}
      </div>
    </div>
    {!isCollapsed && node.children.map((child)=><TaskRow key={child.id} node={child} depth={depth+1} collapsed={collapsed} toggleCollapse={toggleCollapse} openEdit={openEdit} openCreateChild={openCreateChild} openComplete={openComplete} openNotDone={openNotDone} openDetails={openDetails} remove={remove} canCreate={canCreate}/>)}
  </>;
}

function TaskModal({ item, presetParentId, assignableUsers, flatTasks, close, saved }:{
  item:TaskNode|null; presetParentId:number|null; assignableUsers:AssignableUser[]; flatTasks:TaskNode[]; close:()=>void; saved:(message:string)=>Promise<void>;
}) {
  const [title,setTitle]=useState(item?.title ?? "");
  const [description,setDescription]=useState(item?.description ?? "");
  const [assigneeId,setAssigneeId]=useState(item?.assigneeId ? String(item.assigneeId) : "");
  const [urgency,setUrgency]=useState<Urgency>(item?.urgency ?? "MEDIUM");
  const [dueDate,setDueDate]=useState(item?.dueDate ?? "");
  const [status,setStatus]=useState<TaskStatus>(item?.status ?? "TODO");
  const [parentTaskId,setParentTaskId]=useState(item?.parentTaskId ? String(item.parentTaskId) : presetParentId ? String(presetParentId) : "");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const lockParent=presetParentId!==null && !item;
  const parentOptions=flatTasks.filter((task)=>task.id!==item?.id);

  async function submit(event:FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    if(!assigneeId) { setError("Selecione um responsável para a tarefa."); setBusy(false); return; }
    try {
      const payload={ title, description, assigneeId, urgency, dueDate, status, parentTaskId:parentTaskId || null };
      const result=item
        ? await api<{message:string}>(`/api/tasks/${item.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) })
        : await api<{message:string}>("/api/tasks",{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
      await saved(result.message);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível salvar a tarefa."); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">TAREFAS</p><h2>{item?"Editar tarefa":"Nova tarefa"}</h2><span>O criador é definido automaticamente pelo sistema e não pode ser alterado.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Título da tarefa *<input required value={title} onChange={(event)=>setTitle(event.target.value)}/></label>
        <label className="full">Descrição<textarea value={description} onChange={(event)=>setDescription(event.target.value)}/></label>
        <label>Tarefa pai<select disabled={lockParent} value={parentTaskId} onChange={(event)=>setParentTaskId(event.target.value)}><option value="">Nenhuma (tarefa principal)</option>{parentOptions.map((task)=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label>Responsável *<select required value={assigneeId} onChange={(event)=>setAssigneeId(event.target.value)}><option value="" disabled>Selecione</option>{assignableUsers.map((user)=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label>Nível de urgência<select value={urgency} onChange={(event)=>setUrgency(event.target.value as Urgency)}><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Prazo de entrega *<input required type="date" value={dueDate} onChange={(event)=>setDueDate(event.target.value)}/></label>
        <label>Status<select value={status} onChange={(event)=>setStatus(event.target.value as TaskStatus)}><option value="TODO">Pendente</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option><option value="NOT_DONE">Não realizada</option></select></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Salvando...":"Salvar tarefa"}</button></div>
      </form>
    </section>
  </div>;
}

function CompleteModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!note.trim()) { setError("A observação da conclusão é obrigatória."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"COMPLETE", completionNote:note }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível concluir a tarefa."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">CONCLUIR TAREFA</p><h2>{node.title}</h2><span>Confirme a conclusão e descreva o que foi feito.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Observação da conclusão *<textarea required value={note} onChange={(event)=>setNote(event.target.value)} placeholder="Descreva como a tarefa foi concluída."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Confirmando...":"Confirmar conclusão"}</button></div>
      </form>
    </section>
  </div>;
}

function NotDoneModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!reason.trim()) { setError("A justificativa é obrigatória."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"NOT_DONE", notDoneReason:reason }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível registrar a não realização."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">NÃO REALIZAR TAREFA</p><h2>{node.title}</h2><span>Confirme e justifique por que a tarefa não será realizada.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Justificativa *<textarea required value={reason} onChange={(event)=>setReason(event.target.value)} placeholder="Explique o motivo."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Confirmando...":"Confirmar"}</button></div>
      </form>
    </section>
  </div>;
}

function TaskDetailModal({ id, close }:{ id:number; close:()=>void }) {
  const [detail,setDetail]=useState<TaskDetail|null>(null);
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  useEffect(()=>{ let cancelled=false; setLoading(true); setError(""); api<{task:TaskDetail;history:HistoryEntry[]}>(`/api/tasks/${id}`).then((result)=>{ if(cancelled)return; setDetail(result.task); setHistory(result.history); }).catch((problem)=>{ if(!cancelled)setError(problem instanceof Error?problem.message:"Não foi possível carregar a tarefa."); }).finally(()=>{ if(!cancelled)setLoading(false); }); return ()=>{ cancelled=true; }; },[id]);
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal task-detail-modal">
      <header><div><p className="eyebrow">DETALHES DA TAREFA</p><h2>{detail?.title ?? "Carregando..."}</h2><span>Histórico completo de alterações desta tarefa.</span></div><button onClick={close}>×</button></header>
      <div className="modal-form">
        {loading && <p className="full">Carregando...</p>}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        {detail && <>
          <div className="full"><p>{detail.description || "Sem descrição."}</p></div>
          <div><span>Responsável</span><strong>{detail.assigneeName??"—"}</strong></div>
          <div><span>Criado por</span><strong>{detail.createdByName??"—"}</strong></div>
          <div><span>Prazo</span><strong>{formatDate(detail.dueDate)}</strong></div>
          <div><span>Status</span><strong>{detail.statusLabel}</strong></div>
          {detail.completionNote && <div className="full"><span>Observação da conclusão ({formatDateTime(detail.completedAt)})</span><p>{detail.completionNote}</p></div>}
          {detail.notDoneReason && <div className="full"><span>Justificativa de não realização ({formatDateTime(detail.notDoneAt)})</span><p>{detail.notDoneReason}</p></div>}
          <div className="full">
            <p className="eyebrow">HISTÓRICO</p>
            <div className="table-scroll"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th></tr></thead><tbody>
              {history.map((entry)=><tr key={entry.id}><td>{formatDateTime(entry.occurredAt)}</td><td>{entry.userName??"—"}</td><td>{HISTORY_ACTION_LABELS[entry.action]??entry.action}</td></tr>)}
            </tbody></table></div>
            {history.length===0 && <div className="empty-state">Nenhum registro de histórico.</div>}
          </div>
        </>}
      </div>
      <div className="modal-footer" style={{ padding:"13px 20px" }}><button className="primary" onClick={close}>Fechar</button></div>
    </section>
  </div>;
}
