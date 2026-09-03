"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";
type TaskNode = {
  id:number; parentTaskId:number|null; title:string; description:string|null;
  assigneeId:number|null; assigneeName:string|null;
  urgency:Urgency; urgencyLabel:string; dueDate:string; status:TaskStatus; statusLabel:string;
  createdBy:number|null; createdByName:string|null; completedAt:string|null;
  contextOnly:boolean; editable:boolean; overdue:boolean; dueSoon:boolean;
  progressPercent:number|null; totalDescendants:number; completedDescendants:number;
  children:TaskNode[];
};
type AssignableUser = { id:number; name:string };
type AuthUser = { name:string; permissions:string[] };

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string) { if(!value)return "—"; const date=new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(date); }
const urgencyTone:Record<Urgency,string> = { LOW:"green", MEDIUM:"yellow", HIGH:"orange", URGENT:"red" };

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
  const [canEdit,setCanEdit]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [urgencyFilter,setUrgencyFilter]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [overdueOnly,setOverdueOnly]=useState(false);
  const [collapsed,setCollapsed]=useState<Set<number>>(new Set());
  const [modal,setModal]=useState<{ item:TaskNode|null; presetParentId:number|null }|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{ tasks:TaskNode[]; assignableUsers:AssignableUser[]; canCreate:boolean; canEdit:boolean }>("/api/tasks"); setTree(result.tasks); setAssignableUsers(result.assignableUsers); setCanCreate(result.canCreate); setCanEdit(result.canEdit); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as tarefas."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);

  const flatTasks=useMemo(()=>flattenTree(tree),[tree]);
  const predicate=useCallback((node:TaskNode)=>matchesFilters(node,query,urgencyFilter,statusFilter,overdueOnly),[query,urgencyFilter,statusFilter,overdueOnly]);
  const visibleRoots=useMemo(()=>tree.filter((root)=>nodeMatches(root,predicate)),[tree,predicate]);
  const overdueCount=useMemo(()=>flatTasks.filter((node)=>node.overdue).length,[flatTasks]);

  function toggleCollapse(id:number) { setCollapsed((current)=>{ const next=new Set(current); if(next.has(id))next.delete(id); else next.add(id); return next; }); }
  async function toggleDone(node:TaskNode) { try{ await api(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ status:node.status==="DONE"?"TODO":"DONE" }) }); await load(); }catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível atualizar a tarefa."); } }
  async function remove(node:TaskNode) { try{ const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"DELETE" }); await load(); flash(result.message); }catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível excluir a tarefa."); } }

  if(loading && tree.length===0) return <div className="page-loading"><span/><p>Carregando tarefas...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">GESTÃO DE EQUIPE</p><h1>Tarefas</h1><span>Hierarquia de tarefas, urgência e prazos de entrega.{overdueCount>0?` ${overdueCount} tarefa(s) atrasada(s).`:""}</span></div>{canCreate && <div className="heading-actions"><button className="primary" onClick={()=>setModal({ item:null, presetParentId:null })}>＋ Nova tarefa</button></div>}</div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <article className="panel module-panel">
      <div className="equipment-management-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar tarefa ou responsável..."/></label>
        <label>Urgência<select value={urgencyFilter} onChange={(event)=>setUrgencyFilter(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">Todos</option><option value="TODO">A fazer</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option></select></label>
        <label className="fleet-check"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/> Somente atrasadas</label>
      </div>
      <div className="task-tree">
        {visibleRoots.map((root)=><TaskRow key={root.id} node={root} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse} openEdit={(node)=>setModal({ item:node, presetParentId:null })} openCreateChild={(node)=>setModal({ item:null, presetParentId:node.id })} remove={remove} toggleDone={toggleDone} canCreate={canCreate} canEdit={canEdit}/>)}
        {visibleRoots.length===0 && <div className="empty-state">Nenhuma tarefa encontrada.</div>}
      </div>
    </article>
    {modal && <TaskModal item={modal.item} presetParentId={modal.presetParentId} assignableUsers={assignableUsers} flatTasks={flatTasks} close={()=>setModal(null)} saved={async(message)=>{ setModal(null); await load(); flash(message); }}/>}
  </>;
}

function TaskRow({ node, depth, collapsed, toggleCollapse, openEdit, openCreateChild, remove, toggleDone, canCreate, canEdit }:{
  node:TaskNode; depth:number; collapsed:Set<number>; toggleCollapse:(id:number)=>void;
  openEdit:(node:TaskNode)=>void; openCreateChild:(node:TaskNode)=>void; remove:(node:TaskNode)=>void; toggleDone:(node:TaskNode)=>void;
  canCreate:boolean; canEdit:boolean;
}) {
  const isCollapsed=collapsed.has(node.id);
  const rowClass=`task-row ${node.overdue?"overdue":node.dueSoon?"due-soon":""} ${node.contextOnly?"context-only":""}`.trim();
  return <>
    <div className={rowClass} style={{ paddingLeft:`${depth*22}px` }}>
      {node.children.length>0 ? <button type="button" className="task-toggle" onClick={()=>toggleCollapse(node.id)} aria-label={isCollapsed?"Expandir":"Recolher"}>{isCollapsed?"▸":"▾"}</button> : <span className="task-toggle-spacer"/>}
      <input type="checkbox" className="task-check" checked={node.status==="DONE"} disabled={!canEdit || !node.editable} onChange={()=>toggleDone(node)}/>
      <div className="task-main">
        <div className="task-title-line"><strong className={node.status==="DONE"?"task-done":""}>{node.title}</strong><span className={`status-pill ${urgencyTone[node.urgency]}`}>{node.urgencyLabel}</span>{node.contextOnly && <span className="status-pill gray">Contexto</span>}</div>
        <div className="task-meta">
          <span>Responsável: {node.assigneeName??"Não atribuído"}</span>
          <span className={node.overdue?"danger-text":node.dueSoon?"warning-text":""}>Prazo: {formatDate(node.dueDate)}{node.overdue?" · Atrasada":node.dueSoon?" · Vence em breve":""}</span>
          <span>{node.statusLabel}</span>
          {node.progressPercent!==null && <span>{node.progressPercent}% concluído ({node.completedDescendants}/{node.totalDescendants})</span>}
        </div>
      </div>
      {!node.contextOnly && <div className="equipment-row-actions">
        {canCreate && node.editable && <button onClick={()=>openCreateChild(node)}>+ Subtarefa</button>}
        {canEdit && node.editable && <button onClick={()=>openEdit(node)}>Editar</button>}
        {canEdit && node.editable && <button className="danger-action" onClick={()=>remove(node)}>Excluir</button>}
      </div>}
    </div>
    {!isCollapsed && node.children.map((child)=><TaskRow key={child.id} node={child} depth={depth+1} collapsed={collapsed} toggleCollapse={toggleCollapse} openEdit={openEdit} openCreateChild={openCreateChild} remove={remove} toggleDone={toggleDone} canCreate={canCreate} canEdit={canEdit}/>)}
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
    try {
      const payload={ title, description, assigneeId:assigneeId || null, urgency, dueDate, status, parentTaskId:parentTaskId || null };
      const result=item
        ? await api<{message:string}>(`/api/tasks/${item.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) })
        : await api<{message:string}>("/api/tasks",{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
      await saved(result.message);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível salvar a tarefa."); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">TAREFAS</p><h2>{item?"Editar tarefa":"Nova tarefa"}</h2><span>Defina responsável, urgência e prazo de entrega.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Título da tarefa *<input required value={title} onChange={(event)=>setTitle(event.target.value)}/></label>
        <label className="full">Descrição<textarea value={description} onChange={(event)=>setDescription(event.target.value)}/></label>
        <label>Tarefa pai<select disabled={lockParent} value={parentTaskId} onChange={(event)=>setParentTaskId(event.target.value)}><option value="">Nenhuma (tarefa principal)</option>{parentOptions.map((task)=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label>Responsável<select value={assigneeId} onChange={(event)=>setAssigneeId(event.target.value)}><option value="">Não atribuído</option>{assignableUsers.map((user)=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <label>Nível de urgência<select value={urgency} onChange={(event)=>setUrgency(event.target.value as Urgency)}><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Prazo de entrega *<input required type="date" value={dueDate} onChange={(event)=>setDueDate(event.target.value)}/></label>
        <label>Status<select value={status} onChange={(event)=>setStatus(event.target.value as TaskStatus)}><option value="TODO">A fazer</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option></select></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Salvando...":"Salvar tarefa"}</button></div>
      </form>
    </section>
  </div>;
}
