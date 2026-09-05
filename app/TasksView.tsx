"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type Urgency = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type TaskStatus = "TODO" | "IN_PROGRESS" | "AWAITING_COMPLETION_APPROVAL" | "AWAITING_NOT_DONE_AUTHORIZATION" | "DONE" | "NOT_DONE" | "CANCELLED";
type TaskNode = {
  id:number; parentTaskId:number|null; title:string; description:string|null;
  assigneeId:number|null; assigneeName:string|null;
  urgency:Urgency; urgencyLabel:string; dueDate:string; status:TaskStatus; statusLabel:string;
  createdBy:number|null; createdByName:string|null;
  viewedAt:string|null; viewedBy:number|null;
  requestedCompletionBy:number|null; requestedCompletionAt:string|null;
  completedAt:string|null; completedBy:number|null; completionNote:string|null;
  completionApprovedBy:number|null; completionApprovedAt:string|null; completionRejectionReason:string|null;
  requestedNonExecutionBy:number|null; requestedNonExecutionAt:string|null;
  notDoneAt:string|null; notDoneBy:number|null; notDoneReason:string|null;
  nonExecutionApprovedBy:number|null; nonExecutionApprovedAt:string|null; nonExecutionRejectionReason:string|null;
  cancelledAt:string|null; cancelledBy:number|null; cancelReason:string|null;
  deletedAt:string|null; deletedBy:number|null;
  overdue:boolean; dueSoon:boolean;
  progressPercent:number|null; totalDescendants:number; completedDescendants:number;
  canEdit:boolean; canReassign:boolean; canDelete:boolean;
  canRequestCompletion:boolean; canRequestNotDone:boolean; canDecide:boolean;
  canStart:boolean; canCancel:boolean; canRestore:boolean;
  viewerIsCreator:boolean; viewerIsAssignee:boolean;
  children:TaskNode[];
};
type AssignableUser = { id:number; name:string };
type AuthUser = { name:string; permissions:string[]; profile:string };
type HistoryEntry = { id:number; userId:number|null; userName:string|null; action:string; previousValue:string|null; newValue:string|null; occurredAt:string };
type TaskDetail = TaskNode & { createdAt:string; updatedAt:string; createdByRoleName:string|null; assigneeRoleName:string|null };
type ScopeFilter = "" | "received" | "sent";
type MainTab = "tasks" | "approvals" | "history";

async function api<T>(url:string, options?:RequestInit):Promise<T> { const response=await fetch(url,{cache:"no-store",...options}); const data=await response.json().catch(()=>({})) as Record<string,unknown>; if(!response.ok)throw new Error(String(data.error??"A operação não pôde ser concluída.")); return data as T; }
function formatDate(value:string) { if(!value)return "—"; const date=new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short"}).format(date); }
function formatDateTime(value:string|null) { if(!value)return "—"; const date=new Date(value); return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date); }
const urgencyTone:Record<Urgency,string> = { LOW:"green", MEDIUM:"yellow", HIGH:"orange", URGENT:"red" };
const statusTone:Record<TaskStatus,string> = {
  TODO:"gray", IN_PROGRESS:"blue", AWAITING_COMPLETION_APPROVAL:"orange", AWAITING_NOT_DONE_AUTHORIZATION:"orange",
  DONE:"green", NOT_DONE:"red", CANCELLED:"gray",
};
// Duas listas separadas (em vez de uma única com todos os status): a aba Tarefas só recebe
// tarefas ativas do servidor (Concluída/Não realizada saem da lista — seção 5 da especificação),
// e o Histórico só recebe tarefas finais (seção 6) — oferecer os status do "lado errado" em cada
// filtro criaria uma opção que nunca traz resultado nenhum.
const ACTIVE_STATUS_OPTIONS:Array<{value:TaskStatus|"";label:string}> = [
  { value:"", label:"Todos" }, { value:"TODO", label:"Pendente" }, { value:"IN_PROGRESS", label:"Em andamento" },
  { value:"AWAITING_COMPLETION_APPROVAL", label:"Aguard. aprovação da conclusão" }, { value:"AWAITING_NOT_DONE_AUTHORIZATION", label:"Aguard. autorização p/ não realizar" },
  { value:"CANCELLED", label:"Cancelada" },
];
const FINAL_STATUS_OPTIONS:Array<{value:TaskStatus|"";label:string}> = [
  { value:"", label:"Todos" }, { value:"DONE", label:"Concluída" }, { value:"NOT_DONE", label:"Não realizada" },
];
// Ações legadas (TASK_COMPLETED/TASK_NOT_DONE) continuam mapeadas para não quebrar a leitura do
// histórico de tarefas gravado antes do fluxo de aprovação em duas etapas.
const HISTORY_ACTION_LABELS:Record<string,string> = {
  TASK_CREATED:"Tarefa criada", TASK_VIEWED:"Visualizada pelo responsável", TASK_STARTED:"Marcada como em andamento",
  TASK_UPDATED:"Dados atualizados", TASK_REASSIGNED:"Responsável alterado",
  TASK_COMPLETION_REQUESTED:"Conclusão solicitada", TASK_COMPLETION_APPROVED:"Conclusão aprovada", TASK_COMPLETION_REJECTED:"Conclusão rejeitada",
  TASK_NOT_DONE_REQUESTED:"Não realização solicitada", TASK_NOT_DONE_AUTHORIZED:"Não realização autorizada", TASK_NOT_DONE_DENIED:"Não realização recusada",
  TASK_COMPLETED:"Concluída", TASK_NOT_DONE:"Marcada como não realizada",
  TASK_CANCELLED:"Cancelada", TASK_DELETED:"Excluída", TASK_RESTORED:"Restaurada pelo administrador",
};

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

// Acessibilidade compartilhada por todo modal/drawer do módulo (seção 11 da especificação): Esc
// fecha, Tab fica preso dentro do diálogo enquanto ele está aberto, e o foco volta ao elemento que
// abriu o modal quando ele fecha. Um único hook em vez de repetir a mesma lógica em cada modal.
function useModalA11y(dialogRef:React.RefObject<HTMLElement|null>, close:()=>void) {
  useEffect(()=>{
    const previousFocus=document.activeElement as HTMLElement|null;
    function focusableElements() {
      const root=dialogRef.current; if(!root) return [] as HTMLElement[];
      return Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el)=>!el.hasAttribute("disabled"));
    }
    focusableElements()[0]?.focus();
    function onKeyDown(event:KeyboardEvent) {
      if(event.key==="Escape") { event.preventDefault(); close(); return; }
      if(event.key==="Tab") {
        const items=focusableElements(); if(items.length===0) return;
        const first=items[0]; const last=items[items.length-1];
        if(event.shiftKey && document.activeElement===first) { event.preventDefault(); last.focus(); }
        else if(!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown",onKeyDown);
    return ()=>{ document.removeEventListener("keydown",onKeyDown); previousFocus?.focus?.(); };
  },[dialogRef,close]);
}

export default function TasksView({ authUser, flash }:{ authUser:AuthUser; flash:(message:string)=>void }) {
  const [mainTab,setMainTab]=useState<MainTab>("tasks");
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
  const [requestingCompletion,setRequestingCompletion]=useState<TaskNode|null>(null);
  const [requestingNotDone,setRequestingNotDone]=useState<TaskNode|null>(null);
  const [deciding,setDeciding]=useState<{ node:TaskNode; kind:"COMPLETION"|"NOT_DONE" }|null>(null);
  const [cancelling,setCancelling]=useState<TaskNode|null>(null);
  const [viewingId,setViewingId]=useState<number|null>(null);

  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{ tasks:TaskNode[]; assignableUsers:AssignableUser[]; canCreate:boolean; viewerHasTaskRole:boolean }>("/api/tasks"); setTree(result.tasks); setAssignableUsers(result.assignableUsers); setCanCreate(result.canCreate); setViewerHasTaskRole(result.viewerHasTaskRole); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar as tarefas."); }finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);

  const flatTasks=useMemo(()=>flattenTree(tree),[tree]);
  const predicate=useCallback((node:TaskNode)=>matchesFilters(node,query,urgencyFilter,statusFilter,overdueOnly,scopeFilter),[query,urgencyFilter,statusFilter,overdueOnly,scopeFilter]);
  const visibleRoots=useMemo(()=>tree.filter((root)=>nodeMatches(root,predicate)),[tree,predicate]);
  const overdueCount=useMemo(()=>flatTasks.filter((node)=>node.overdue).length,[flatTasks]);
  const hasActiveFilters=Boolean(query||urgencyFilter||statusFilter||overdueOnly||scopeFilter);
  const clearFilters=useCallback(()=>{ setQuery(""); setUrgencyFilter(""); setStatusFilter(""); setOverdueOnly(false); setScopeFilter(""); },[]);
  // "Aguardando minha aprovação" (seção 15): só tarefas que o próprio usuário criou e que aguardam
  // a decisão DELE — nunca soma pedidos de terceiros que ele apenas visualiza por conexão.
  const pendingApprovals=useMemo(()=>flatTasks.filter((node)=>node.viewerIsCreator && node.canDecide && (node.status==="AWAITING_COMPLETION_APPROVAL"||node.status==="AWAITING_NOT_DONE_AUTHORIZATION")),[flatTasks]);

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
    <div className="page-heading module-heading"><div><p className="eyebrow">GESTÃO DE EQUIPE</p><h1>Tarefas</h1><span>Visibilidade por Cargo de Tarefas.{overdueCount>0?` ${overdueCount} tarefa(s) atrasada(s) visível(is) para você.`:""} <details className="inline-help"><summary>Como funciona</summary>Cada pessoa só vê tarefas em que é responsável, criador, já foi responsável, ou tem conexão de visualização/gerenciamento configurada no Gestor de Cargos de Tarefas.</details></span></div><div className="heading-actions"><NotificationBell openTask={(taskId)=>setViewingId(taskId)}/>{canCreate && mainTab==="tasks" && <button className="primary" onClick={()=>setModal({ item:null, presetParentId:null })}>＋ Nova tarefa</button>}</div></div>
    {!viewerHasTaskRole && <div className="operation-error"><span>!</span><div><strong>Seu Cargo de Tarefas não está configurado</strong><p>Você não poderá criar nem receber novas tarefas até que o administrador regularize seu cadastro em Usuários.</p></div></div>}
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação de Tarefas">
      <button className={mainTab==="tasks"?"active":""} onClick={()=>setMainTab("tasks")}>Tarefas</button>
      {pendingApprovals.length>0 && <button className={mainTab==="approvals"?"active":""} onClick={()=>setMainTab("approvals")}>Aguardando minha aprovação<span className="nav-badge">{pendingApprovals.length}</span></button>}
      <button className={mainTab==="history"?"active":""} onClick={()=>setMainTab("history")}>Histórico</button>
    </div>
    {mainTab==="history" ? <TaskHistoryPanel/> : mainTab==="approvals" ? <>
      <article className="panel module-panel">
        <div className="task-card-grid">
          {pendingApprovals.map((node)=><TaskCard key={node.id} node={node} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse}
            openEdit={(n)=>setModal({ item:n, presetParentId:null })} openCreateChild={(n)=>setModal({ item:null, presetParentId:n.id })}
            openRequestCompletion={setRequestingCompletion} openRequestNotDone={setRequestingNotDone}
            openDecide={(n,kind)=>setDeciding({ node:n, kind })}
            openCancel={setCancelling} start={startTask} openDetails={(n)=>setViewingId(n.id)} remove={removeTask} canCreate={canCreate} emphasizeDecision/>)}
        </div>
        {pendingApprovals.length===0 && <div className="empty-state">Nenhuma aprovação pendente.</div>}
      </article>
    </> : <>
    <TaskSummaryPanel authUser={authUser} users={assignableUsers}/>
    <article className="panel module-panel">
      <div className="module-filters-grid">
        <label className="page-search span-wide"><span>⌕</span><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Pesquisar por título ou responsável..."/></label>
        <label>Escopo<select value={scopeFilter} onChange={(event)=>setScopeFilter(event.target.value as ScopeFilter)}><option value="">Todas visíveis</option><option value="received">Recebidas por mim</option><option value="sent">Enviadas por mim</option></select></label>
        <label>Urgência<select value={urgencyFilter} onChange={(event)=>setUrgencyFilter(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
        <label>Status<select value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}>{ACTIVE_STATUS_OPTIONS.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="compact-switch"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/><span>Somente atrasadas</span></label>
        {hasActiveFilters && <button type="button" className="secondary clear-filters" onClick={clearFilters}>Limpar filtros</button>}
      </div>
      <div className="task-card-grid">
        {visibleRoots.map((root)=><TaskCard key={root.id} node={root} depth={0} collapsed={collapsed} toggleCollapse={toggleCollapse}
          openEdit={(node)=>setModal({ item:node, presetParentId:null })} openCreateChild={(node)=>setModal({ item:null, presetParentId:node.id })}
          openRequestCompletion={setRequestingCompletion} openRequestNotDone={setRequestingNotDone}
          openDecide={(node,kind)=>setDeciding({ node, kind })}
          openCancel={setCancelling} start={startTask} openDetails={(node)=>setViewingId(node.id)} remove={removeTask} canCreate={canCreate}/>)}
      </div>
      {visibleRoots.length===0 && <div className="empty-state">Nenhuma tarefa encontrada.{hasActiveFilters && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div>}
    </article>
    {modal && <TaskModal item={modal.item} presetParentId={modal.presetParentId} assignableUsers={assignableUsers} flatTasks={flatTasks} close={()=>setModal(null)} saved={async(message)=>{ setModal(null); await load(); flash(message); }}/>}
    </>}
    {requestingCompletion && <RequestCompletionModal node={requestingCompletion} close={()=>setRequestingCompletion(null)} saved={async(message)=>{ setRequestingCompletion(null); await load(); flash(message); }}/>}
    {cancelling && <CancelTaskModal node={cancelling} close={()=>setCancelling(null)} saved={async(message)=>{ setCancelling(null); await load(); flash(message); }}/>}
    {requestingNotDone && <RequestNotDoneModal node={requestingNotDone} close={()=>setRequestingNotDone(null)} saved={async(message)=>{ setRequestingNotDone(null); await load(); flash(message); }}/>}
    {deciding && <DecisionModal node={deciding.node} kind={deciding.kind} close={()=>setDeciding(null)} saved={async(message)=>{ setDeciding(null); await load(); flash(message); }}/>}
    {viewingId!==null && <TaskDetailModal id={viewingId} subtasks={flatTasks.find((task)=>task.id===viewingId)?.children} close={()=>setViewingId(null)} onChanged={load} openRequestCompletion={setRequestingCompletion} openRequestNotDone={setRequestingNotDone} openDecide={(node,kind)=>setDeciding({ node, kind })} openEdit={(node)=>{ setViewingId(null); setModal({ item:node, presetParentId:null }); }}/>}
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
const HISTORY_STATUS_TONE:Record<string,string> = { ...statusTone, REASSIGNED:"orange" };

type TaskNotification = { id:number; taskId:number; type:string; message:string; createdAt:string; readAt:string|null };

// Sino de notificações (seção 18) — recebimento, reatribuição, pedidos/decisões de conclusão e
// não realização, cancelamento. Prazo próximo/vencido não gera notificação persistida (calculado
// ao vivo no Painel resumido abaixo); aqui só os eventos que o backend efetivamente grava.
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

type SummaryData = { receivedPending:number; receivedInProgress:number; receivedOverdue:number; sentAwaitingResponse:number; sentAwaitingMyApproval:number; completedInPeriod:number; notDoneInPeriod:number };

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
      <div className={summary.sentAwaitingMyApproval>0?"warning-text":""}><strong>{summary.sentAwaitingMyApproval}</strong><span>Aguardando minha aprovação</span></div>
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
  const hasActiveFilters=Boolean(q||status||urgency||roleId||from||to||overdueOnly);
  const clearFilters=useCallback(()=>{ setQ(""); setStatus(""); setUrgency(""); setRoleId(""); setFrom(""); setTo(""); setOverdueOnly(false); },[]);

  return <article className="panel module-panel">
    <div className="main-tabs secondary-module-nav" aria-label="Recebidas ou Enviadas"><button className={scope==="received"?"active":""} onClick={()=>setScope("received")}>Histórico de Recebidas</button><button className={scope==="sent"?"active":""} onClick={()=>setScope("sent")}>Histórico de Enviadas</button></div>
    <div className="module-filters-grid">
      <label className="page-search span-wide"><span>⌕</span><input value={q} onChange={(event)=>setQ(event.target.value)} placeholder="Pesquisar por título..."/></label>
      <label>Status<select value={status} onChange={(event)=>setStatus(event.target.value)}>{FINAL_STATUS_OPTIONS.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>Urgência<select value={urgency} onChange={(event)=>setUrgency(event.target.value)}><option value="">Todas</option><option value="LOW">Baixa</option><option value="MEDIUM">Média</option><option value="HIGH">Alta</option><option value="URGENT">Urgente</option></select></label>
      <label>Cargo de Tarefas<select value={roleId} onChange={(event)=>setRoleId(event.target.value)}><option value="">Todos</option>{taskRoles.map((role)=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      <div className="date-range"><label>De<input type="date" value={from} onChange={(event)=>setFrom(event.target.value)}/></label><label>Até<input type="date" value={to} onChange={(event)=>setTo(event.target.value)}/></label></div>
      <label className="compact-switch"><input type="checkbox" checked={overdueOnly} onChange={(event)=>setOverdueOnly(event.target.checked)}/><span>Somente atrasadas</span></label>
      {hasActiveFilters && <button type="button" className="secondary clear-filters" onClick={clearFilters}>Limpar filtros</button>}
    </div>
    {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
    {loading ? <div className="page-loading"><span/><p>Carregando histórico...</p></div> : <div className="task-card-grid">
      {entries.map((entry)=><article key={entry.id} className={`task-card history-card ${entry.deletedAt?"deleted":""}`}>
        <header className="task-card-head">
          <h3>{entry.title}</h3>
          <div className="task-card-badges"><span className={`status-pill ${urgencyTone[entry.urgency]}`}>{entry.urgencyLabel}</span><span className={`status-pill ${HISTORY_STATUS_TONE[entry.status]??"gray"}`}>{entry.statusLabel}</span></div>
        </header>
        <div className="task-card-body">
          <dl>
            <div><dt>{scope==="received"?"Criador":"Responsável"}</dt><dd>{scope==="received"?(entry.createdByName??"—"):(entry.assigneeName??"—")}</dd></div>
            <div><dt>Cargo</dt><dd>{(scope==="received"?entry.creatorRoleName:entry.assigneeRoleName)??"—"}</dd></div>
            <div><dt>Prazo</dt><dd>{formatDate(entry.dueDate)}</dd></div>
            <div><dt>Criada em</dt><dd>{formatDateTime(entry.createdAt)}{entry.reassignedAt && <> · reatribuída em {formatDateTime(entry.reassignedAt)}</>}</dd></div>
          </dl>
          {entry.deletedAt && <p className="danger-text">Excluída em {formatDateTime(entry.deletedAt)}</p>}
        </div>
        <footer className="task-card-footer"><button type="button" className="view-details-action" onClick={()=>setViewingId(entry.id)}>👁 Abrir tarefa</button></footer>
      </article>)}
    </div>}
    {!loading && entries.length===0 && <div className="empty-state">Nenhum registro encontrado para os filtros atuais.{hasActiveFilters && <button type="button" className="secondary" onClick={clearFilters}>Limpar filtros</button>}</div>}
    {viewingId!==null && <TaskDetailModal id={viewingId} close={()=>setViewingId(null)} onChanged={load}/>}
  </article>;
}

function TaskCard({ node, depth, collapsed, toggleCollapse, openEdit, openCreateChild, openRequestCompletion, openRequestNotDone, openDecide, openCancel, start, openDetails, remove, canCreate, emphasizeDecision }:{
  node:TaskNode; depth:number; collapsed:Set<number>; toggleCollapse:(id:number)=>void;
  openEdit:(node:TaskNode)=>void; openCreateChild:(node:TaskNode)=>void;
  openRequestCompletion:(node:TaskNode)=>void; openRequestNotDone:(node:TaskNode)=>void;
  openDecide:(node:TaskNode,kind:"COMPLETION"|"NOT_DONE")=>void;
  openCancel:(node:TaskNode)=>void; start:(node:TaskNode)=>void;
  openDetails:(node:TaskNode)=>void; remove:(node:TaskNode)=>void; canCreate:boolean; emphasizeDecision?:boolean;
}) {
  const isCollapsed=collapsed.has(node.id);
  const accent=node.overdue?"overdue":node.status==="AWAITING_COMPLETION_APPROVAL"||node.status==="AWAITING_NOT_DONE_AUTHORIZATION"?"awaiting":node.status==="IN_PROGRESS"?"in-progress":node.status==="DONE"?"done":"neutral";
  const decideKind = node.status==="AWAITING_COMPLETION_APPROVAL" ? "COMPLETION" : node.status==="AWAITING_NOT_DONE_AUTHORIZATION" ? "NOT_DONE" : null;
  return <article className={`task-card accent-${accent} ${depth>0?"task-card-nested":""}`}>
    <header className="task-card-head">
      <span className="task-card-id">#{node.id}</span>
      <h3><button type="button" className="task-title-link" onClick={()=>openDetails(node)}>{node.title}</button></h3>
      <div className="task-card-badges">
        <span className={`status-pill ${urgencyTone[node.urgency]}`}>{node.urgencyLabel}</span>
        <span className={`status-pill ${statusTone[node.status]}`}>{node.statusLabel}</span>
        {node.overdue && <span className="status-pill red">Atrasada</span>}
      </div>
    </header>
    <div className="task-card-body">
      {node.description && <div className="task-card-description-wrap">
        <p className="task-card-description">{node.description}</p>
        {node.description.length>160 && <button type="button" className="task-card-description-more" onClick={()=>openDetails(node)}>Ver mais</button>}
      </div>}
      <dl>
        <div><dt>Responsável</dt><dd>{node.assigneeName??"—"}</dd></div>
        <div><dt>Criado por</dt><dd>{node.createdByName??"—"}</dd></div>
        <div><dt>Prazo</dt><dd className={node.overdue?"danger-text":node.dueSoon?"warning-text":""}>{formatDate(node.dueDate)}</dd></div>
        {node.progressPercent!==null && <div><dt>Progresso</dt><dd>{node.progressPercent}% ({node.completedDescendants}/{node.totalDescendants} subtarefas)</dd></div>}
      </dl>
      {node.status==="AWAITING_COMPLETION_APPROVAL" && <p className="task-card-pending-note">Pedido de conclusão de {node.requestedCompletionAt?formatDateTime(node.requestedCompletionAt):"—"}{node.completionNote?`: "${node.completionNote}"`:""}</p>}
      {node.status==="AWAITING_NOT_DONE_AUTHORIZATION" && <p className="task-card-pending-note">Pedido de não realização de {node.requestedNonExecutionAt?formatDateTime(node.requestedNonExecutionAt):"—"}{node.notDoneReason?`: "${node.notDoneReason}"`:""}</p>}
    </div>
    <footer className="task-card-footer">
      <button type="button" className="view-details-action" onClick={()=>openDetails(node)}>👁 Abrir tarefa</button>
      {node.canStart && <button onClick={()=>start(node)}>▸ Iniciar</button>}
      {node.canRequestCompletion && <button className="primary" onClick={()=>openRequestCompletion(node)}>Concluir</button>}
      {node.canRequestNotDone && <button onClick={()=>openRequestNotDone(node)}>Não realizar</button>}
      {node.canDecide && decideKind && <button className={emphasizeDecision?"primary":""} onClick={()=>openDecide(node,decideKind)}>Decidir</button>}
      {canCreate && node.canEdit && <button onClick={()=>openCreateChild(node)}>+ Subtarefa</button>}
      {node.canEdit && <button onClick={()=>openEdit(node)}>Editar</button>}
      {node.canCancel && <button onClick={()=>openCancel(node)}>Cancelar</button>}
      {node.canDelete && <button className="danger-action" onClick={()=>remove(node)}>Excluir</button>}
    </footer>
    {node.children.length>0 && <div className="task-card-subtasks">
      <button type="button" className="task-card-subtasks-toggle" onClick={()=>toggleCollapse(node.id)}>{isCollapsed?"▸":"▾"} {node.children.length} subtarefa{node.children.length>1?"s":""}</button>
      {!isCollapsed && <div className="task-card-grid nested">
        {node.children.map((child)=><TaskCard key={child.id} node={child} depth={depth+1} collapsed={collapsed} toggleCollapse={toggleCollapse} openEdit={openEdit} openCreateChild={openCreateChild} openRequestCompletion={openRequestCompletion} openRequestNotDone={openRequestNotDone} openDecide={openDecide} openCancel={openCancel} start={start} openDetails={openDetails} remove={remove} canCreate={canCreate}/>)}
      </div>}
    </div>}
  </article>;
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
  const dialogRef=useRef<HTMLElement|null>(null);
  useModalA11y(dialogRef, close);

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

  return <div className="modal-backdrop">
    <section className="modal" ref={dialogRef} role="dialog" aria-modal="true">
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

// Solicitar conclusão (seção 13): o responsável envia observação + evidência de que terminou, mas
// a tarefa só vira DONE quando o criador aprovar — nunca aqui.
function RequestCompletionModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [note,setNote]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const dialogRef=useRef<HTMLElement|null>(null);
  useModalA11y(dialogRef, close);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!note.trim()) { setError("A observação da conclusão é obrigatória."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"REQUEST_COMPLETION", completionNote:note }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível solicitar a conclusão."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop">
    <section className="modal" ref={dialogRef} role="dialog" aria-modal="true">
      <header><div><p className="eyebrow">SOLICITAR CONCLUSÃO</p><h2>{node.title}</h2><span>Descreva o que foi feito. A tarefa só será concluída após a aprovação de quem a criou.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Observação da conclusão *<textarea required value={note} onChange={(event)=>setNote(event.target.value)} placeholder="Descreva como a tarefa foi concluída."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Enviando...":"Enviar para aprovação"}</button></div>
      </form>
    </section>
  </div>;
}

// Solicitar não realização (seção 14): mesma lógica — vira pedido, não decisão final.
function RequestNotDoneModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const dialogRef=useRef<HTMLElement|null>(null);
  useModalA11y(dialogRef, close);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!reason.trim()) { setError("A justificativa é obrigatória."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"REQUEST_NOT_DONE", notDoneReason:reason }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível registrar o pedido de não realização."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop">
    <section className="modal" ref={dialogRef} role="dialog" aria-modal="true">
      <header><div><p className="eyebrow">SOLICITAR NÃO REALIZAÇÃO</p><h2>{node.title}</h2><span>Justifique por que a tarefa não será realizada. A decisão final é de quem a criou.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Justificativa *<textarea required value={reason} onChange={(event)=>setReason(event.target.value)} placeholder="Explique o motivo."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy?"Enviando...":"Enviar para autorização"}</button></div>
      </form>
    </section>
  </div>;
}

// Decisão do criador (seções 13/14/16): aprovar/rejeitar conclusão, ou autorizar/recusar não
// realização — nunca as duas coisas ao mesmo tempo (o `kind` vem do status atual da tarefa).
function DecisionModal({ node, kind, close, saved }:{ node:TaskNode; kind:"COMPLETION"|"NOT_DONE"; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [decision,setDecision]=useState<"APPROVE"|"REJECT"|null>(null);
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const isCompletion=kind==="COMPLETION";
  const approveAction=isCompletion?"APPROVE_COMPLETION":"AUTHORIZE_NOT_DONE";
  const rejectAction=isCompletion?"REJECT_COMPLETION":"DENY_NOT_DONE";
  const rejectField=isCompletion?"completionRejectionReason":"nonExecutionRejectionReason";
  const dialogRef=useRef<HTMLElement|null>(null);
  useModalA11y(dialogRef, close);

  async function submit(event:FormEvent) {
    event.preventDefault();
    if(decision==="REJECT" && !reason.trim()) { setError(isCompletion?"Informe o motivo da rejeição.":"Informe o motivo da recusa."); return; }
    setBusy(true); setError("");
    try {
      const body:Record<string,unknown> = decision==="APPROVE" ? { action:approveAction } : { action:rejectAction, [rejectField]:reason };
      const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
      await saved(result.message);
    } catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível registrar a decisão."); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop">
    <section className="modal" ref={dialogRef} role="dialog" aria-modal="true">
      <header><div><p className="eyebrow">{isCompletion?"DECIDIR CONCLUSÃO":"DECIDIR NÃO REALIZAÇÃO"}</p><h2>{node.title}</h2><span>Responsável: {node.assigneeName??"—"}</span></div><button onClick={close}>×</button></header>
      <div className="modal-form">
        <div className="full"><span>{isCompletion?"Observação enviada":"Justificativa enviada"}</span><p>{(isCompletion?node.completionNote:node.notDoneReason) || "—"}</p></div>
      </div>
      <form className="modal-form" onSubmit={submit}>
        <div className="full decision-choice">
          <button type="button" className={decision==="APPROVE"?"primary":"secondary"} onClick={()=>setDecision("APPROVE")}>{isCompletion?"✓ Aprovar conclusão":"✓ Autorizar não realização"}</button>
          <button type="button" className={decision==="REJECT"?"danger-action":"secondary"} onClick={()=>setDecision("REJECT")}>{isCompletion?"✕ Rejeitar":"✕ Não autorizar"}</button>
        </div>
        {decision==="REJECT" && <label className="full">{isCompletion?"Motivo da rejeição *":"Motivo da recusa *"}<textarea required value={reason} onChange={(event)=>setReason(event.target.value)}/></label>}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy || !decision}>{busy?"Confirmando...":"Confirmar decisão"}</button></div>
      </form>
    </section>
  </div>;
}

function CancelTaskModal({ node, close, saved }:{ node:TaskNode; close:()=>void; saved:(message:string)=>Promise<void> }) {
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const dialogRef=useRef<HTMLElement|null>(null);
  useModalA11y(dialogRef, close);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!reason.trim()) { setError("O motivo do cancelamento é obrigatório."); return; }
    setBusy(true); setError("");
    try { const result=await api<{message:string}>(`/api/tasks/${node.id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"CANCEL", cancelReason:reason }) }); await saved(result.message); }
    catch(problem) { setError(problem instanceof Error?problem.message:"Não foi possível cancelar a tarefa."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop">
    <section className="modal" ref={dialogRef} role="dialog" aria-modal="true">
      <header><div><p className="eyebrow">CANCELAR TAREFA</p><h2>{node.title}</h2><span>Cancelar preserva a tarefa no histórico — diferente de excluir. Informe o motivo.</span></div><button onClick={close}>×</button></header>
      <form className="modal-form" onSubmit={submit}>
        <label className="full">Motivo do cancelamento *<textarea required value={reason} onChange={(event)=>setReason(event.target.value)} placeholder="Explique por que esta tarefa está sendo cancelada."/></label>
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Voltar</button><button className="primary danger-action" disabled={busy}>{busy?"Cancelando...":"Confirmar cancelamento"}</button></div>
      </form>
    </section>
  </div>;
}

function TaskDetailModal({ id, subtasks, close, onChanged, openRequestCompletion, openRequestNotDone, openDecide, openEdit }:{
  id:number; subtasks?:TaskNode[]; close:()=>void; onChanged?:()=>void;
  openRequestCompletion?:(node:TaskNode)=>void; openRequestNotDone?:(node:TaskNode)=>void; openDecide?:(node:TaskNode,kind:"COMPLETION"|"NOT_DONE")=>void;
  openEdit?:(node:TaskNode)=>void;
}) {
  const [detail,setDetail]=useState<TaskDetail|null>(null);
  const [history,setHistory]=useState<HistoryEntry[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [restoring,setRestoring]=useState(false);
  const [copied,setCopied]=useState(false);
  const dialogRef=useRef<HTMLElement|null>(null);
  const load=useCallback(async()=>{ setLoading(true); setError(""); try{ const result=await api<{task:TaskDetail;history:HistoryEntry[]}>(`/api/tasks/${id}`); setDetail(result.task); setHistory(result.history); }catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível carregar a tarefa."); }finally{ setLoading(false); } },[id]);
  useEffect(()=>{ load(); },[load]);
  useModalA11y(dialogRef, close);

  async function restore() {
    setRestoring(true);
    try{ await api<{message:string}>(`/api/tasks/${id}`,{ method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ action:"RESTORE" }) }); await load(); onChanged?.(); }
    catch(problem){ setError(problem instanceof Error?problem.message:"Não foi possível restaurar a tarefa."); }
    finally{ setRestoring(false); }
  }
  async function copyDescription() {
    if(!detail?.description) return;
    try{ await navigator.clipboard.writeText(detail.description); setCopied(true); window.setTimeout(()=>setCopied(false),2000); }
    catch{ /* área de transferência indisponível neste navegador/contexto */ }
  }
  const decideKind = detail && (detail.status==="AWAITING_COMPLETION_APPROVAL" ? "COMPLETION" : detail.status==="AWAITING_NOT_DONE_AUTHORIZATION" ? "NOT_DONE" : null);
  return <div className="modal-backdrop" onMouseDown={(event)=>{ if(event.target===event.currentTarget) close(); }}>
    <section className="modal task-detail-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="task-detail-modal-title">
      <header>
        <div>
          <p className="eyebrow">DETALHES DA TAREFA</p>
          <h2 id="task-detail-modal-title">{detail?`#${detail.id} — ${detail.title}`:"Carregando..."}</h2>
          {detail && <div className="task-card-badges task-detail-badges">
            <span className={`status-pill ${urgencyTone[detail.urgency]}`}>{detail.urgencyLabel}</span>
            <span className={`status-pill ${statusTone[detail.status]}`}>{detail.statusLabel}</span>
            {detail.overdue && <span className="status-pill red">Atrasada</span>}
          </div>}
        </div>
        <button onClick={close} aria-label="Fechar">×</button>
      </header>
      <div className="modal-form">
        {loading && <p className="full">Carregando...</p>}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        {detail && <>
          {detail.deletedAt && <div className="equipment-form-error full"><span>!</span><div><strong>Tarefa excluída em {formatDateTime(detail.deletedAt)}</strong>{detail.canRestore && <div><button type="button" className="secondary" disabled={restoring} onClick={restore}>{restoring?"Restaurando...":"Restaurar tarefa"}</button></div>}</div></div>}
          <div className="full task-detail-description">
            <div className="task-detail-description-head"><span>Descrição</span><button type="button" className="secondary small" onClick={copyDescription} disabled={!detail.description}>{copied?"Copiado!":"Copiar descrição"}</button></div>
            <div className="task-detail-description-body">{detail.description || "Sem descrição."}</div>
          </div>
          <div><span>Responsável</span><strong>{detail.assigneeName??"—"}{detail.assigneeRoleName?` (${detail.assigneeRoleName})`:""}</strong></div>
          <div><span>Criado por</span><strong>{detail.createdByName??"—"}{detail.createdByRoleName?` (${detail.createdByRoleName})`:""}</strong></div>
          <div><span>Criado em</span><strong>{formatDateTime(detail.createdAt)}</strong></div>
          <div><span>Prazo</span><strong>{formatDate(detail.dueDate)}</strong></div>
          {subtasks && subtasks.length>0 && <div><span>Progresso</span><strong>{subtasks.filter((child)=>child.status==="DONE").length}/{subtasks.length} subtarefas concluídas</strong></div>}
          {detail.viewedAt && <div><span>Visualizada pelo responsável em</span><strong>{formatDateTime(detail.viewedAt)}</strong></div>}
          {detail.completionNote && <div className="full"><span>Observação da conclusão ({formatDateTime(detail.requestedCompletionAt ?? detail.completedAt)})</span><p>{detail.completionNote}</p></div>}
          {detail.completionApprovedAt && <div className="full"><span>Conclusão aprovada em {formatDateTime(detail.completionApprovedAt)}</span></div>}
          {detail.completionRejectionReason && <div className="full"><span>Motivo da rejeição da conclusão</span><p>{detail.completionRejectionReason}</p></div>}
          {detail.notDoneReason && <div className="full"><span>Justificativa de não realização ({formatDateTime(detail.requestedNonExecutionAt ?? detail.notDoneAt)})</span><p>{detail.notDoneReason}</p></div>}
          {detail.nonExecutionApprovedAt && <div className="full"><span>Não realização autorizada em {formatDateTime(detail.nonExecutionApprovedAt)}</span></div>}
          {detail.nonExecutionRejectionReason && <div className="full"><span>Motivo da recusa da não realização</span><p>{detail.nonExecutionRejectionReason}</p></div>}
          {detail.cancelReason && <div className="full"><span>Motivo do cancelamento ({formatDateTime(detail.cancelledAt)})</span><p>{detail.cancelReason}</p></div>}
          {subtasks && subtasks.length>0 && <div className="full task-detail-subtasks">
            <p className="eyebrow">SUBTAREFAS</p>
            <ul>{subtasks.map((child)=><li key={child.id}><span>#{child.id} · {child.title}</span><span className={`status-pill ${statusTone[child.status]}`}>{child.statusLabel}</span></li>)}</ul>
          </div>}
          {(detail.canEdit || detail.canRequestCompletion || detail.canRequestNotDone || (detail.canDecide && decideKind)) && <div className="full modal-footer" style={{ padding:0 }}>
            {detail.canEdit && openEdit && <button type="button" className="secondary" onClick={()=>{ close(); openEdit(detail); }}>Editar</button>}
            {detail.canRequestCompletion && openRequestCompletion && <button className="primary" onClick={()=>{ close(); openRequestCompletion(detail); }}>Solicitar conclusão</button>}
            {detail.canRequestNotDone && openRequestNotDone && <button onClick={()=>{ close(); openRequestNotDone(detail); }}>Solicitar não realização</button>}
            {detail.canDecide && decideKind && openDecide && <button className="primary" onClick={()=>{ close(); openDecide(detail,decideKind); }}>Decidir</button>}
          </div>}
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
