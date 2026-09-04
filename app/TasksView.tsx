"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "NOT_DONE" | "CANCELLED";
type TaskNode = {
  id:number; parentTaskId:number|null; title:string; description:string|null;
  assigneeId:number|null; assigneeName:string|null;
  urgency:Urgency; urgencyLabel:string; dueDate:string; status:TaskStatus; statusLabel:string;
  createdBy:number|null; createdByName:string|null;
  viewedAt:string|null; viewedBy:number|null;
  completedAt:string|null; completedBy:number|null; completionNote:string|null;
  notDoneAt:string|null; notDoneBy:number|null; notDoneReason:string|null;
  cancelledAt:string|null; cancelledBy:number|null; cancelReason:string|null;
  deletedAt:string|null; deletedBy:number|null;
  overdue:boolean; dueSoon:boolean;
  progressPercent:number|null; totalDescendants:number; completedDescendants:number;
  canEdit:boolean; canReassign:boolean; canDelete:boolean; canComplete:boolean; canMarkNotDone:boolean;
  canStart:boolean; canCancel:boolean; canRestore:boolean;
  viewerIsCreator:boolean; viewerIsAssignee:boolean;
  children:TaskNode[];
};
type AssignableUser = { id:number; name:string };
type AuthUser = { name:string; permissions:string[]; profile:string };
type HistoryEntry = { id:number; userId:number|null; userName:string|null; action:string; previousValue:string|null; newValue:string|null; occurredAt:string };
type TaskDetail = TaskNode & { createdAt:string; updatedAt:string };
type ScopeFilter = "" | "received" | "sent";

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string) { if(!value)return "—"; const date=new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(date); }
function formatDateTime(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const urgencyTone:Record<Urgency,string> = { LOW:"green", MEDIUM:"yellow", HIGH:"orange", URGENT:"red" };
const statusTone:Record<TaskStatus,string> = { TODO:"gray", IN_PROGRESS:"yellow", DONE:"green", NOT_DONE:"red", CANCELLED:"gray" };
const HISTORY_ACTION_LABELS:Record<string,string> = { TASK_CREATED:"Tarefa criada", TASK_VIEWED:"Visualizada pelo responsável", TASK_STARTED:"Marcada como em andamento", TASK_UPDATED:"Dados atualizados", TASK_REASSIGNED:"Responsável alterado", TASK_COMPLETED:"Concluída", TASK_NOT_DONE:"Marcada como não realizada", TASK_CANCELLED:"Cancelada", TASK_DELETED:"Excluída", TASK_RESTORED:"Restaurada pelo administrador" };

function flattenTree(nodes:TaskNode[]):TaskNode[] { return nodes.flatMap((node)=>[node,...flattenTree(node.children)]); }
function matchesFilters(node:TaskNode,query:string,urgency:string,status:string,overdueOnly:boolean,scope:ScopeFilter) {
  if(scope==="received" && !node.viewerIsAssignee) return false;
  if(scope==="sent" && !node.viewerIsCreator) return false;
  if(overdueOnly && !node.overdue) return false;
  if(urgency && node.urgency!==urgency) return false;
  if(status && node.status!==status) return false;
  if(query) { const key=query.toLocaleLowerCase("pt-BR"); const haystack=`${node.title} ${node.assigneeName??""}`.toLocaleLowerCase("pt-BR"); if(!haystack.includes(key)) return false; }
  return true;
}
function nodeMatches(node:TaskNode,predicate:(node:TaskNode)=>boolean):boolean { return predicate(node) || node.children.some((child)=>nodeMatches(child,predicate)); }

export default function TasksView({ authUser, flash }:{ authUser:AuthUser; flash:(message:string)=>void }) {
  const [mainTab,setMainTab]=useState<"tasks"|"history">("tasks");
  const [tree,setTree]=useState<TaskNode[]>([]);
  const [assignableUsers,setAssignableUsers]=useState<AssignableUser[]>([]);
  const [canCreate,setCanCreate]=useState(false);
  const [viewerHasTaskRole,setViewerHasTaskRole]=useState(true);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [urgencyFilter,setUrgencyFilter]=useState("");
  const [statusFilter,setStatusFilter]=useState("");
  const [overdueOnly,setOverdueOnly]=useState(false);
  const [scopeFilter,setScopeFilter]=useState<ScopeFilter>("");
  const [collapsed,setCollapsed]=useState<Set<number>>(new Set());
  const [modal,setModal]=useState<{ item:TaskNode|null; presetParentId:number|null }|null>(null);
  const [completing,setCompleting]=useState<TaskNode|null>(null);
  const [notDoing,setNotDoing]=useState<TaskNode|null>(null);
  const [cancelling,setCancelling]=useState<TaskNode|null>(null);
  const [viewingId,setViewingId]=useState<number|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{ tasks:TaskNode[]; assignableUsers:AssignableUser[]; canCreate:boolean; viewerHasTaskRole:boolean }>("/api/tasks"); setTree(result.tasks); setAssignableUsers(result.assignableUsers); setCanCreate(result.canCreate); setViewerHasTaskRole(result.viewerHasTaskRole); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as tarefas."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);

  const flatTasks=useMemo(()=>flattenTree(tree),[tree]);
  const predicate=useCallback((node:TaskNode)=>matchesFilters(node,query,urgencyFilter,statusFilter,overdueOnly,scopeFilter),[query,urgencyFilter,statusFilter,overdueOnly,scopeFilter]);
  const visibleRoots=useMemo(()=>tree.filter((root)=>nodeMatches(root,predicate)),[tree,predicate]);
  const overdueCount=useMemo(()=>flatTasks.filter((node)=>node.overdue).length,[flatTasks]);

  function toggleCollapse(id:number) { setCollapsed((current)=>{ const next=new Set(current); if(next.has(id))next.delete(id); else next.add(id); return next; }); }
  async function removeTask(node:TaskNode) {
    if(!window.confirm(`Excluir a tarefa "${node.title}"? Esta ação registra quem excluiu e não pode ser desfeita pela interface.`)) return;
    try{ const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"DELETE" }); await load(); flash(result.message); }catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível excluir a tarefa."); }
  }
  async function startTask(node:TaskNode) {
    try{ const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"START" }) }); await load(); flash(result.message); }catch(problem){ flash(problem instanceof Error?problem.message:"Não foi possível iniciar a tarefa."); }
  }

  if(loading && tree.length===0) return <div className="page-loading"><span/><p>Carregando tarefas...</p></div>;
  return <>
    <div className="page-heading module-heading"><div><p className="eyebrow">GESTÃO DE EQUIPE</p><h1>Tarefas</h1><span>Visibilidade por Cargo de Tarefas: cada um só vê tarefas em que é responsável, criador, já foi responsável, ou tem conexão de visualização/gerenciamento configurada no Gestor de Cargos de Tarefas.{overdueCount>0?` ${overdueCount} tarefa(s) atrasada(s) visível(is) para você.`:""}</span></div><div className="heading-actions"><NotificationBell openTask={(taskId)=>setViewingId(taskId)}/>{canCreate && mainTab==="tasks" && <button className="primary" onClick={()=>setModal({ item:null, presetParentId:null })}>＋ Nova tarefa</button>}</div></div>
    {!viewerHasTaskRole && <div className="operation-error"><span>!</span><div><strong>Seu Cargo de Tarefas não está configurado</strong><p>Você não poderá criar nem receber novas tarefas até que o administrador regularize seu cadastro em Usuários.</p></div></div>}
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação de Tarefas"><button className={mainTab==="tasks"?"active":""} onClick={()=>setMainTab("tasks")}>Tarefas</button><button className={mainTab==="history"?"active":""} onClick={()=>setMainTab("history")}>Histórico</button></div>
    {mainTab==="history" ? <TaskHistoryPanel/> : <>
    <TaskSummaryPanel authUser={authUser} users={assignableUsers}/>
    <article className="panel module-panel">
      <div className="equipment-management-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar tarefa ou responsável..."/></label>
        <label>Escopo<select value={scopeFilter} onChange={(event)=>setScopeFilter(event.target.value as ScopeFilter)}><option value="">Todas visíveis</option><option value="received">Recebidas por mim</option><option value="sent">Enviadas por mim</option></select></label>
        <label>Urgência<select value={urgencyFilter} onChange={(event)=>setUrgencyFilter(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="">Todos</option><option value="TODO">Pendente</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option><option value="NOT_DONE">Não realizada</option><option value="CANCELLED">Cancelada</option></select></label>
        <label className="fleet-check"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/> Somente atrasadas</label>
      </div>
      <div className="task-tree">
        {visibleRoots.map((root)=><TaskRow key={root.id} node={root} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse}
          openEdit={(node)=>setModal({ item:node, presetParentId:null })} openCreateChild={(node)=>setModal({ item:null, presetParentId:node.id })}
          openComplete={setCompleting} openNotDone={setNotDoing} openCancel={setCancelling} start={startTask} openDetails={(node)=>setViewingId(node.id)} remove={removeTask} canCreate={canCreate}/>)}
        {visibleRoots.length===0 && <div className="empty-state">Nenhuma tarefa encontrada.</div>}
      </div>
    </article>
    {modal && <TaskModal item={modal.item} presetParentId={modal.presetParentId} assignableUsers={assignableUsers} flatTasks={flatTasks} close={()=>setModal(null)} saved={async(message)=>{ setModal(null); await load(); flash(message); }}/>}
    </>}
    {completing && <CompleteModal node={completing} close={()=>setCompleting(null)} saved={async(message)=>{ setCompleting(null); await load(); flash(message); }}/>}
    {cancelling && <CancelTaskModal node={cancelling} close={()=>setCancelling(null)} saved={async(message)=>{ setCancelling(null); await load(); flash(message); }}/>}
    {notDoing && <NotDoneModal node={notDoing} close={()=>setNotDoing(null)} saved={async(message)=>{ setNotDoing(null); await load(); flash(message); }}/>}
    {viewingId!==null && <TaskDetailModal id={viewingId} close={()=>setViewingId(null)} onChanged={load}/>}
  </>;
}

type TaskRoleOption = { id:number; name:string };
type HistoryEntryRow = {
  id:number; title:string; description:string|null;
  assigneeId:number|null; assigneeName:string|null; assigneeRoleName:string|null;
  createdBy:number|null; createdByName:string|null; creatorRoleName:string|null;
  urgency:Urgency; urgencyLabel:string; dueDate:string; status:string; statusLabel:string;
  reassignedAt:string|null; deletedAt:string|null;
  completionNote:string|null; notDoneReason:string|null; cancelReason:string|null;
  createdAt:string; updatedAt:string;
};
const HISTORY_STATUS_TONE:Record<string,string> = { TODO:"gray", IN_PROGRESS:"yellow", DONE:"green", NOT_DONE:"red", CANCELLED:"gray", REASSIGNED:"orange" };

type TaskNotification = { id:number; taskId:number; type:string; message:string; createdAt:string; readAt:string|null };

// Sino de notificações (seção 18) — recebimento, reatribuição, conclusão, não realização e
// cancelamento. Prazo próximo/vencido não gera notificação persistida (calculado ao vivo no
// Painel resumido abaixo); aqui só os eventos que o backend efetivamente grava.
function NotificationBell({ openTask }:{ openTask:(taskId:number)=>void }) {
  const [notifications,setNotifications]=useState<TaskNotification[]>([]);
  const [unreadCount,setUnreadCount]=useState(0);
  const [open,setOpen]=useState(false);
  const load=useCallback(async()=>{ try{ const result=await api<{ notifications:TaskNotification[]; unreadCount:number }>("/api/tasks/notifications"); setNotifications(result.notifications); setUnreadCount(result.unreadCount); }catch{ /* o sino nunca deve travar a tela de tarefas */ } },[]);
  useEffect(()=>{ load(); const interval=window.setInterval(load,60000); return ()=>window.clearInterval(interval); },[load]);
  async function selectNotification(notification:TaskNotification) {
    if(!notification.readAt) { try{ await api("/api/tasks/notifications",{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ id:notification.id }) }); await load(); }catch{ /* ignora falha ao marcar lida */ } }
    setOpen(false); openTask(notification.taskId);
  }
  async function markAllRead() { try{ await api("/api/tasks/notifications",{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"MARK_ALL_READ" }) }); await load(); }catch{ /* ignora falha ao marcar todas */ } }
  return <div className="task-notification-bell">
    <button type="button" className="task-notification-toggle" onClick={()=>setOpen((current)=>!current)} aria-label="Notificações de tarefas" aria-expanded={open}>🔔{unreadCount>0 && <b>{unreadCount>9?"9+":unreadCount}</b>}</button>
    {open && <div className="task-notification-dropdown">
      <header><strong>Notificações</strong>{unreadCount>0 && <button type="button" onClick={markAllRead}>Marcar tudo como lido</button>}</header>
      <div className="task-notification-list">
        {notifications.map((notification)=><button type="button" key={notification.id} className={`task-notification-item ${notification.readAt?"":"unread"}`} onClick={()=>selectNotification(notification)}>
          <span>{notification.message}</span><small>{formatDateTime(notification.createdAt)}</small>
        </button>)}
        {notifications.length===0 && <div className="empty-state">Nenhuma notificação.</div>}
      </div>
    </div>}
  </div>;
}

type SummaryData = { receivedPending:number; receivedInProgress:number; receivedOverdue:number; sentAwaitingResponse:number; completedInPeriod:number; notDoneInPeriod:number };

// Painel resumido (seção 19) — sempre restrito ao que o próprio usuário pode ver; o filtro por
// usuário/cargo só existe (e só tem efeito) para o cargo raiz, e reaproveita a mesma lista de
// usuários já carregada para "Nova tarefa" (para o cargo raiz ela já é "todos os ativos").
function TaskSummaryPanel({ authUser, users }:{ authUser:AuthUser; users:AssignableUser[] }) {
  const isAdmin=authUser.profile==="ADMIN";
  const [summary,setSummary]=useState<SummaryData|null>(null);
  const [userId,setUserId]=useState("");
  const [roleId,setRoleId]=useState("");
  const [taskRoles,setTaskRoles]=useState<TaskRoleOption[]>([]);
  const load=useCallback(async()=>{
    const params=new URLSearchParams();
    if(isAdmin && roleId) params.set("roleId",roleId);
    else if(isAdmin && userId) params.set("userId",userId);
    try{ const result=await api<{ summary:SummaryData }>(`/api/tasks/summary?${params.toString()}`); setSummary(result.summary); }catch{ /* silencioso: painel é só um resumo */ }
  },[isAdmin,userId,roleId]);
  useEffect(()=>{ load(); },[load]);
  useEffect(()=>{ if(isAdmin) api<{ roles:TaskRoleOption[] }>("/api/task-roles").then((result)=>setTaskRoles(result.roles)).catch(()=>undefined); },[isAdmin]);
  if(!summary) return null;
  return <article className="panel module-panel task-summary-panel">
    <div className="task-summary-head">
      <h2>Painel resumido</h2>
      {isAdmin && <div className="task-summary-filters">
        <select value={userId} onChange={(event)=>{ setUserId(event.target.value); setRoleId(""); }}><option value="">Meu resumo</option>{users.map((user)=><option key={user.id} value={user.id}>{user.name}</option>)}</select>
        <select value={roleId} onChange={(event)=>{ setRoleId(event.target.value); setUserId(""); }}><option value="">Todos os cargos</option>{taskRoles.map((role)=><option key={role.id} value={role.id}>{role.name}</option>)}</select>
      </div>}
    </div>
    <div className="task-summary-grid">
      <div><strong>{summary.receivedPending}</strong><span>Recebidas pendentes</span></div>
      <div><strong>{summary.receivedInProgress}</strong><span>Em andamento</span></div>
      <div className={summary.receivedOverdue>0?"danger-text":""}><strong>{summary.receivedOverdue}</strong><span>Recebidas vencidas</span></div>
      <div><strong>{summary.sentAwaitingResponse}</strong><span>Enviadas aguardando resposta</span></div>
      <div><strong>{summary.completedInPeriod}</strong><span>Concluídas no mês</span></div>
      <div><strong>{summary.notDoneInPeriod}</strong><span>Não realizadas no mês</span></div>
    </div>
  </article>;
}

// Histórico individual — seção 13: duas abas (Recebidas/Enviadas), sempre centradas no usuário
// autenticado. Diferente da lista principal, mostra tarefas excluídas/reatribuídas quando o
// usuário tinha participação legítima, com filtros e linha do tempo completa por tarefa.
function TaskHistoryPanel() {
  const [scope,setScope]=useState<"received"|"sent">("received");
  const [entries,setEntries]=useState<HistoryEntryRow[]>([]);
  const [taskRoles,setTaskRoles]=useState<TaskRoleOption[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [q,setQ]=useState("");
  const [status,setStatus]=useState("");
  const [urgency,setUrgency]=useState("");
  const [roleId,setRoleId]=useState("");
  const [from,setFrom]=useState("");
  const [to,setTo]=useState("");
  const [overdueOnly,setOverdueOnly]=useState(false);
  const [viewingId,setViewingId]=useState<number|null>(null);

  const load=useCallback(async()=>{
    setLoading(true); setError("");
    const params=new URLSearchParams({ scope });
    if(q)params.set("q",q); if(status)params.set("status",status); if(urgency)params.set("urgency",urgency);
    if(roleId)params.set("roleId",roleId); if(from)params.set("from",from); if(to)params.set("to",to);
    if(overdueOnly)params.set("overdueOnly","1");
    try{ const result=await api<{ entries:HistoryEntryRow[]; taskRoles:TaskRoleOption[] }>(`/api/tasks/history?${params.toString()}`); setEntries(result.entries); setTaskRoles(result.taskRoles); }
    catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar o histórico."); }
    finally{ setLoading(false); }
  },[scope,q,status,urgency,roleId,from,to,overdueOnly]);
  useEffect(()=>{ load(); },[load]);

  return <article className="panel module-panel">
    <div className="main-tabs secondary-module-nav" aria-label="Recebidas ou Enviadas"><button className={scope==="received"?"active":""} onClick={()=>setScope("received")}>Histórico de Recebidas</button><button className={scope==="sent"?"active":""} onClick={()=>setScope("sent")}>Histórico de Enviadas</button></div>
    <div className="equipment-management-filters">
      <label className="page-search"><span>⌕</span><input value={q} onChange={(event)=>setQ(event.target.value)} placeholder="Pesquisar por título..."/></label>
      <label>Status<select value={status} onChange={(event)=>setStatus(event.target.value)}><option value="">Todos</option><option value="TODO">Pendente</option><option value="IN_PROGRESS">Em andamento</option><option value="DONE">Concluída</option><option value="NOT_DONE">Não realizada</option><option value="CANCELLED">Cancelada</option></select></label>
      <label>Urgência<select value={urgency} onChange={(event)=>setUrgency(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
      <label>Cargo de Tarefas<select value={roleId} onChange={(event)=>setRoleId(event.target.value)}><option value="">Todos</option>{taskRoles.map((role)=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <label>De<input type="date" value={from} onChange={(event)=>setFrom(event.target.value)}/></label>
      <label>Até<input type="date" value={to} onChange={(event)=>setTo(event.target.value)}/></label>
      <label className="fleet-check"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/> Somente atrasadas</label>
    </div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    {loading ? <div className="page-loading"><span/><p>Carregando histórico...</p></div> : <div className="table-scroll"><table><thead><tr><th>Tarefa</th><th>{scope==="received"?"Criador":"Responsável"}</th><th>Cargo</th><th>Prazo</th><th>Urgência</th><th>Status</th><th>Criada em</th><th></th></tr></thead><tbody>
      {entries.map((entry)=><tr key={entry.id} className={entry.deletedAt?"task-history-deleted":""}>
        <td><strong className="table-strong">{entry.title}</strong>{entry.deletedAt && <small className="danger-text"> · excluída</small>}</td>
        <td>{scope==="received"?(entry.createdByName??"—"):(entry.assigneeName??"—")}</td>
        <td>{(scope==="received"?entry.creatorRoleName:entry.assigneeRoleName)??"—"}</td>
        <td>{formatDate(entry.dueDate)}</td>
        <td><span className={`status-pill ${urgencyTone[entry.urgency]}`}>{entry.urgencyLabel}</span></td>
        <td><span className={`status-pill ${HISTORY_STATUS_TONE[entry.status]??"gray"}`}>{entry.statusLabel}</span>{entry.reassignedAt && <small> em {formatDateTime(entry.reassignedAt)}</small>}</td>
        <td>{formatDateTime(entry.createdAt)}</td>
        <td><button onClick={()=>setViewingId(entry.id)}>Ver linha do tempo</button></td>
      </tr>)}
    </tbody></table>{entries.length===0 && <div className="empty-state">Nenhum registro encontrado para os filtros atuais.</div>}</div>}
    {viewingId!==null && <TaskDetailModal id={viewingId} close={()=>setViewingId(null)} onChanged={load}/>}
  </article>;
}

function TaskRow({ node, depth, collapsed, toggleCollapse, openEdit, openCreateChild, openComplete, openNotDone, openCancel, start, openDetails, remove, canCreate }:{
  node:TaskNode; depth:number; collapsed:Set<number>; toggleCollapse:(id:number)=>void;
  openEdit:(node:TaskNode)=>void; openCreateChild:(node:TaskNode)=>void; openComplete:(node:TaskNode)=>void; openNotDone:(node:TaskNode)=>void;
  openCancel:(node:TaskNode)=>void; start:(node:TaskNode)=>void;
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
        {node.canStart && <button onClick={()=>start(node)}>▸ Iniciar</button>}
        {node.canComplete && <button className="primary" onClick={()=>openComplete(node)}>Concluir</button>}
        {node.canMarkNotDone && <button onClick={()=>openNotDone(node)}>Não realizar</button>}
        {canCreate && node.canEdit && <button onClick={()=>openCreateChild(node)}>+ Subtarefa</button>}
        {node.canEdit && <button onClick={()=>openEdit(node)}>Editar</button>}
        {node.canCancel && <button onClick={()=>openCancel(node)}>Cancelar</button>}
        {node.canDelete && <button className="danger-action" onClick={()=>remove(node)}>Excluir</button>}
      </div>
    </div>
    {!isCollapsed && node.children.map((child)=><TaskRow key={child.id} node={child} depth={depth+1} collapsed={collapsed} toggleCollapse={toggleCollapse} openEdit={openEdit} openCreateChild={openCreateChild} openComplete={openComplete} openNotDone={openNotDone} openCancel={openCancel} start={start} openDetails={openDetails} remove={remove} canCreate={canCreate}/>)}
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
  const [parentTaskId,setParentTaskId]=useState(item?.parentTaskId ? String(item.parentTaskId) : presetParentId ? String(presetParentId) : "");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const lockParent=presetParentId!==null && !item;
  const parentOptions=flatTasks.filter((task)=>task.id!==item?.id);

  async function submit(event:FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    if(!assigneeId) { setError("Selecione um responsável para a tarefa."); setBusy(false); return; }
    try {
      const payload={ title, description, assigneeId, urgency, dueDate, parentTaskId:parentTaskId || null };
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
        {item && <label>Status atual<input value={item.statusLabel} readOnly/><small>O status muda pelas ações da própria tarefa (Iniciar, Concluir, Não realizar, Cancelar) — nunca por aqui.</small></label>}
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

function CancelTaskModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!reason.trim()) { setError("O motivo do cancelamento é obrigatório."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"CANCEL", cancelReason:reason }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível cancelar a tarefa."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal">
      <header><div><p className="eyebrow">CANCELAR TAREFA</p><h2>{node.title}</h2><span>Cancelar preserva a tarefa no histórico — diferente de excluir. Informe o motivo.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Motivo do cancelamento *<textarea required value={reason} onChange={(event)=>setReason(event.target.value)} placeholder="Explique por que esta tarefa está sendo cancelada."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Voltar</button><button className="primary danger-action" disabled={busy}>{busy?"Cancelando...":"Confirmar cancelamento"}</button></div>
      </form>
    </section>
  </div>;
}

function TaskDetailModal({ id, close, onChanged }:{ id:number; close:()=>void; onChanged?:()=>void }) {
  const [detail,setDetail]=useState<TaskDetail|null>(null);
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [restoring,setRestoring]=useState(false);
  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{task:TaskDetail;history:HistoryEntry[]}>(`/api/tasks/${id}`); setDetail(result.task); setHistory(result.history); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar a tarefa."); }finally{ setLoading(false); } },[id]);
  useEffect(()=>{ load(); },[load]);
  async function restore() {
    setRestoring(true);
    try{ await api<{message:string}>(`/api/tasks/${id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"RESTORE" }) }); await load(); onChanged?.(); }
    catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível restaurar a tarefa."); }
    finally{ setRestoring(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal task-detail-modal">
      <header><div><p className="eyebrow">DETALHES DA TAREFA</p><h2>{detail?.title ?? "Carregando..."}</h2><span>Histórico completo de alterações desta tarefa.</span></div><button onClick={close}>×</button></header>
      <div className="modal-form">
        {loading && <p className="full">Carregando...</p>}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        {detail && <>
          {detail.deletedAt && <div className="equipment-form-error full"><span>!</span><div><strong>Tarefa excluída em {formatDateTime(detail.deletedAt)}</strong>{detail.canRestore && <div><button type="button" className="secondary" disabled={restoring} onClick={restore}>{restoring?"Restaurando...":"Restaurar tarefa"}</button></div>}</div></div>}
          <div className="full"><p>{detail.description || "Sem descrição."}</p></div>
          <div><span>Responsável</span><strong>{detail.assigneeName??"—"}</strong></div>
          <div><span>Criado por</span><strong>{detail.createdByName??"—"}</strong></div>
          <div><span>Prazo</span><strong>{formatDate(detail.dueDate)}</strong></div>
          <div><span>Status</span><strong>{detail.statusLabel}</strong></div>
          {detail.viewedAt && <div><span>Visualizada pelo responsável em</span><strong>{formatDateTime(detail.viewedAt)}</strong></div>}
          {detail.completionNote && <div className="full"><span>Observação da conclusão ({formatDateTime(detail.completedAt)})</span><p>{detail.completionNote}</p></div>}
          {detail.notDoneReason && <div className="full"><span>Justificativa de não realização ({formatDateTime(detail.notDoneAt)})</span><p>{detail.notDoneReason}</p></div>}
          {detail.cancelReason && <div className="full"><span>Motivo do cancelamento ({formatDateTime(detail.cancelledAt)})</span><p>{detail.cancelReason}</p></div>}
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
