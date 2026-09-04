"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

type RoleMapRole = { id: number; name: string; visualOrder: number; isRoot: boolean; active: boolean; userCount: number };
type RoleMapConnection = { id?: number; sourceRoleId: number; targetRoleId: number; canSend: boolean; canViewReceived: boolean; canViewSent: boolean; canManage: boolean };
type Point = { x: number; y: number };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

function connectionKey(c: { sourceRoleId: number; targetRoleId: number }) { return `${c.sourceRoleId}:${c.targetRoleId}`; }
function sortedConnections(list: RoleMapConnection[]) { return [...list].sort((a, b) => connectionKey(a).localeCompare(connectionKey(b))); }
function connectionsEqual(a: RoleMapConnection[], b: RoleMapConnection[]) {
  const sa = sortedConnections(a); const sb = sortedConnections(b);
  if (sa.length !== sb.length) return false;
  return sa.every((c, index) => connectionKey(c) === connectionKey(sb[index]) && c.canSend === sb[index].canSend && c.canViewReceived === sb[index].canViewReceived && c.canViewSent === sb[index].canViewSent && c.canManage === sb[index].canManage);
}

const COL_WIDTH = 210; const ROW_HEIGHT = 148; const CARD_W = 168; const CARD_H = 74;

// Layout automático e determinístico: cargo raiz centralizado no topo, demais cargos abaixo em
// linhas, ordenados pela ordem visual. Sem posições manuais persistidas — "Reorganizar
// automaticamente" e a abertura do painel sempre produzem o mesmo resultado (seção 6).
function layoutRoles(roles: RoleMapRole[]): { positions: Map<number, Point>; width: number; height: number } {
  const root = roles.find((role) => role.isRoot);
  const rest = roles.filter((role) => !role.isRoot).sort((a, b) => a.visualOrder - b.visualOrder);
  const cols = Math.max(1, Math.min(4, rest.length));
  const positions = new Map<number, Point>();
  const rootOffset = root ? ROW_HEIGHT : 0;
  if (root) positions.set(root.id, { x: ((cols - 1) * COL_WIDTH) / 2, y: 0 });
  rest.forEach((role, index) => {
    const col = index % cols; const row = Math.floor(index / cols);
    positions.set(role.id, { x: col * COL_WIDTH, y: rootOffset + row * ROW_HEIGHT });
  });
  const rows = root ? Math.ceil(rest.length / cols) + 1 : Math.ceil(rest.length / cols);
  return { positions, width: cols * COL_WIDTH, height: Math.max(1, rows) * ROW_HEIGHT };
}

export default function TaskRoleManagerModal({ close, onSaved }: { close: () => void; onSaved: () => Promise<void> }) {
  const [roles, setRoles] = useState<RoleMapRole[]>([]);
  const [savedConnections, setSavedConnections] = useState<RoleMapConnection[]>([]);
  const [connections, setConnections] = useState<RoleMapConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [scale, setScale] = useState(1);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [editingPair, setEditingPair] = useState<{ source: number; target: number } | null>(null);
  const [newRoleName, setNewRoleName] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api<{ roles: RoleMapRole[]; connections: RoleMapConnection[] }>("/api/task-roles/map");
      setRoles(result.roles);
      setSavedConnections(result.connections);
      setConnections(result.connections);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar o mapa de cargos."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const { positions, width, height } = useMemo(() => layoutRoles(roles), [roles]);
  const dirty = !connectionsEqual(connections, savedConnections);
  const matchesSearch = useCallback((role: RoleMapRole) => !search.trim() || role.name.toLocaleLowerCase("pt-BR").includes(search.trim().toLocaleLowerCase("pt-BR")), [search]);

  function requestClose() {
    if (dirty && !window.confirm("Há alterações não salvas no mapa de cargos. Fechar sem salvar?")) return;
    close();
  }

  function centralize() {
    const viewport = viewportRef.current; if (!viewport) return;
    viewport.scrollTo({ left: Math.max(0, (width * scale - viewport.clientWidth) / 2), top: 0, behavior: "smooth" });
  }
  function reorganize() { setScale(1); requestAnimationFrame(centralize); }

  async function createRole(event: FormEvent) {
    event.preventDefault();
    const name = newRoleName.trim(); if (!name) return;
    try { await api("/api/task-roles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); setNewRoleName(""); await load(); await onSaved(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível criar o cargo."); }
  }
  async function renameRole(role: RoleMapRole, name: string) {
    if (!name.trim() || name.trim() === role.name) return;
    try { await api(`/api/task-roles/${role.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) }); await load(); await onSaved(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível renomear o cargo."); }
  }
  async function toggleRoleActive(role: RoleMapRole) {
    if (role.isRoot) return;
    if (role.active && !window.confirm(`Desativar o cargo "${role.name}"? Usuários vinculados a ele deixam de poder enviar ou receber tarefas até serem regularizados para outro cargo. O histórico dessas tarefas é preservado.`)) return;
    try { await api(`/api/task-roles/${role.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !role.active }) }); await load(); await onSaved(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível alterar o cargo."); }
  }

  function cardClick(roleId: number) {
    if (selectedSource === null) { setSelectedSource(roleId); return; }
    setEditingPair({ source: selectedSource, target: roleId });
    setSelectedSource(null);
  }

  function applyConnection(next: RoleMapConnection | null, source: number, target: number) {
    setConnections((current) => {
      const withoutPair = current.filter((c) => !(c.sourceRoleId === source && c.targetRoleId === target));
      return next ? [...withoutPair, next] : withoutPair;
    });
    setEditingPair(null);
  }
  function removeConnection(source: number, target: number) {
    const sourceRole = roles.find((role) => role.id === source); const targetRole = roles.find((role) => role.id === target);
    if (!window.confirm(`Remover a conexão de "${sourceRole?.name}" para "${targetRole?.name}"? Isso pode retirar acessos quando o mapa for salvo.`)) return;
    applyConnection(null, source, target);
  }

  async function save() {
    setSaving(true); setError("");
    try {
      const result = await api<{ connections: RoleMapConnection[] }>("/api/task-roles/connections", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connections: connections.map(({ sourceRoleId, targetRoleId, canSend, canViewReceived, canViewSent, canManage }) => ({ sourceRoleId, targetRoleId, canSend, canViewReceived, canViewSent, canManage })) }) });
      setSavedConnections(result.connections); setConnections(result.connections);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar o mapa de cargos. Nenhuma alteração foi aplicada."); }
    finally { setSaving(false); }
  }
  function restore() { setConnections(savedConnections); }

  const activeRoles = roles.filter((role) => role.active);
  const editingConnection = editingPair ? connections.find((c) => c.sourceRoleId === editingPair.source && c.targetRoleId === editingPair.target) ?? null : null;

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <section className="modal task-role-manager-modal">
      <header>
        <div><p className="eyebrow">TAREFAS · ADMINISTRAÇÃO</p><h2>Gestor de Cargos de Tarefas</h2><span>Defina quem pode enviar, visualizar e gerenciar tarefas de quem. Nada é concedido automaticamente por posição no mapa — só pelas conexões abaixo.</span></div>
        <button onClick={requestClose}>×</button>
      </header>
      {loading ? <div className="page-loading"><span/><p>Carregando mapa de cargos...</p></div> : <>
        {error && <div className="equipment-form-error" style={{ margin: "0 20px 12px" }}><span>!</span><strong>{error}</strong></div>}
        <div className="task-role-toolbar">
          <label className="page-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar cargo..."/></label>
          <div className="task-role-zoom">
            <button type="button" onClick={() => setScale((s) => Math.max(0.5, Math.round((s - 0.1) * 10) / 10))}>−</button>
            <span>{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => setScale((s) => Math.min(1.6, Math.round((s + 0.1) * 10) / 10))}>+</button>
          </div>
          <button type="button" className="secondary" onClick={centralize}>Centralizar</button>
          <button type="button" className="secondary" onClick={reorganize}>Reorganizar automaticamente</button>
          {selectedSource !== null && <span className="task-role-hint">Selecione o cargo de destino para configurar a conexão (ou clique no mesmo cargo para permitir envio entre usuários dele).</span>}
        </div>
        <div className="task-role-canvas-viewport" ref={viewportRef}>
          <div className="task-role-canvas-scaler" style={{ width: width * scale + CARD_W * scale, height: height * scale + CARD_H * scale }}>
            <div className="task-role-canvas" style={{ width: width + CARD_W, height: height + CARD_H, transform: `scale(${scale})` }}>
              <svg className="task-role-lines" width={width + CARD_W} height={height + CARD_H}>
                <defs>
                  {(["send", "view-received", "view-sent", "manage"] as const).map((kind) => (
                    <marker key={kind} id={`trm-arrow-${kind}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" className={`task-role-arrow-${kind}`}/></marker>
                  ))}
                </defs>
                {connections.map((connection) => {
                  const from = positions.get(connection.sourceRoleId); const to = positions.get(connection.targetRoleId);
                  if (!from || !to) return null;
                  const kind = connection.canManage ? "manage" : connection.canSend ? "send" : connection.canViewReceived ? "view-received" : "view-sent";
                  if (connection.sourceRoleId === connection.targetRoleId) {
                    const cx = from.x + CARD_W / 2; const cy = from.y;
                    return <path key={connectionKey(connection)} d={`M ${cx - 18} ${cy} C ${cx - 50} ${cy - 46}, ${cx + 50} ${cy - 46}, ${cx + 18} ${cy}`} className={`task-role-line task-role-line-${kind} task-role-self`} markerEnd={`url(#trm-arrow-${kind})`} onClick={() => setEditingPair({ source: connection.sourceRoleId, target: connection.targetRoleId })}/>;
                  }
                  const x1 = from.x + CARD_W / 2; const y1 = from.y + CARD_H / 2; const x2 = to.x + CARD_W / 2; const y2 = to.y + CARD_H / 2;
                  const dx = x2 - x1; const dy = y2 - y1; const len = Math.hypot(dx, dy) || 1;
                  const pad = 42; const ex = x2 - (dx / len) * pad; const ey = y2 - (dy / len) * pad;
                  return <line key={connectionKey(connection)} x1={x1} y1={y1} x2={ex} y2={ey} className={`task-role-line task-role-line-${kind}`} markerEnd={`url(#trm-arrow-${kind})`} onClick={() => setEditingPair({ source: connection.sourceRoleId, target: connection.targetRoleId })}/>;
                })}
              </svg>
              {activeRoles.map((role) => { const point = positions.get(role.id); if (!point) return null; const dimmed = !matchesSearch(role); return (
                <div key={role.id} className={`task-role-card ${role.isRoot ? "root" : ""} ${selectedSource === role.id ? "selected" : ""} ${dimmed ? "dimmed" : ""}`} style={{ left: point.x, top: point.y, width: CARD_W, height: CARD_H }} onClick={() => cardClick(role.id)}>
                  <strong>{role.name}</strong>
                  <span>{role.isRoot ? "Cargo raiz · acesso global" : `${role.userCount} usuário(s)`}</span>
                </div>
              ); })}
            </div>
          </div>
        </div>
        <div className="task-role-legend">
          <span><i className="task-role-swatch send"/> Enviar tarefas</span>
          <span><i className="task-role-swatch view-received"/> Visualizar recebidas</span>
          <span><i className="task-role-swatch view-sent"/> Visualizar enviadas</span>
          <span><i className="task-role-swatch manage"/> Gerenciar</span>
          <span className="task-role-legend-note">Clique em um cargo e depois em outro (ou no mesmo) para configurar a conexão. Clique numa linha para editá-la.</span>
        </div>
        <div className="task-role-manager-body">
          <div className="task-role-list">
            <h3>Cargos</h3>
            {roles.map((role) => <div className={`task-role-list-item ${role.active ? "" : "inactive"}`} key={role.id}>
              <input defaultValue={role.name} onBlur={(event) => renameRole(role, event.target.value)} disabled={role.isRoot}/>
              <span>{role.userCount} usuário(s)</span>
              {role.isRoot ? <span className="role-pill">raiz</span> : <button type="button" className={role.active ? "danger-action" : "activate-action"} onClick={() => toggleRoleActive(role)}>{role.active ? "Desativar" : "Ativar"}</button>}
            </div>)}
            <form className="task-role-new" onSubmit={createRole}>
              <input placeholder="Novo cargo..." value={newRoleName} onChange={(event) => setNewRoleName(event.target.value)}/>
              <button type="submit" className="secondary">+ Cargo</button>
            </form>
          </div>
        </div>
        {dirty && <div className="task-role-unsaved"><span>!</span><p>Há alterações no mapa de conexões ainda não salvas.</p><button type="button" className="secondary" onClick={restore}>Restaurar</button></div>}
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={requestClose}>{dirty ? "Cancelar" : "Fechar"}</button>
          <button type="button" className="primary" disabled={saving || !dirty} onClick={save}>{saving ? "Salvando..." : "Salvar mapa"}</button>
        </div>
      </>}
    </section>
    {editingPair && <ConnectionEditModal
      sourceRole={roles.find((role) => role.id === editingPair.source)!}
      targetRole={roles.find((role) => role.id === editingPair.target)!}
      connection={editingConnection}
      close={() => setEditingPair(null)}
      apply={(next) => applyConnection(next, editingPair.source, editingPair.target)}
      remove={editingConnection ? () => removeConnection(editingPair.source, editingPair.target) : null}
    />}
  </div>;
}

function ConnectionEditModal({ sourceRole, targetRole, connection, close, apply, remove }: {
  sourceRole: RoleMapRole; targetRole: RoleMapRole; connection: RoleMapConnection | null;
  close: () => void; apply: (next: RoleMapConnection) => void; remove: (() => void) | null;
}) {
  const [canSend, setCanSend] = useState(connection?.canSend ?? false);
  const [canViewReceived, setCanViewReceived] = useState(connection?.canViewReceived ?? false);
  const [canViewSent, setCanViewSent] = useState(connection?.canViewSent ?? false);
  const [canManage, setCanManage] = useState(connection?.canManage ?? false);
  const sameRole = sourceRole.id === targetRole.id;
  const empty = !canSend && !canViewReceived && !canViewSent && !canManage;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (empty) { if (remove) remove(); close(); return; }
    apply({ sourceRoleId: sourceRole.id, targetRoleId: targetRole.id, canSend, canViewReceived, canViewSent, canManage });
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal connection-edit-modal">
      <header><div><p className="eyebrow">CONEXÃO ENTRE CARGOS</p><h2>{sourceRole.name} → {targetRole.name}</h2><span>{sameRole ? "Envio de tarefas entre usuários deste mesmo cargo." : "O que usuários de “" + sourceRole.name + "” podem fazer com tarefas de “" + targetRole.name + "”."}</span></div><button onClick={close}>×</button></header>
      <form className="modal-form connection-edit-form" onSubmit={submit}>
        <label className={`connection-toggle ${canSend ? "checked" : ""}`}><input type="checkbox" checked={canSend} onChange={(event) => setCanSend(event.target.checked)}/><span><b>{sameRole ? "Permitir envio de tarefas entre usuários deste mesmo cargo" : "Enviar tarefas para"}</b><small>{sourceRole.name} pode criar tarefas com responsáveis do cargo {targetRole.name}.</small></span></label>
        {!sameRole && <>
          <label className={`connection-toggle ${canViewReceived ? "checked" : ""}`}><input type="checkbox" checked={canViewReceived} onChange={(event) => setCanViewReceived(event.target.checked)}/><span><b>Visualizar tarefas recebidas por</b><small>Vê as tarefas em que alguém do cargo {targetRole.name} é o responsável (somente leitura).</small></span></label>
          <label className={`connection-toggle ${canViewSent ? "checked" : ""}`}><input type="checkbox" checked={canViewSent} onChange={(event) => setCanViewSent(event.target.checked)}/><span><b>Visualizar tarefas enviadas por</b><small>Vê as tarefas criadas por alguém do cargo {targetRole.name} (somente leitura).</small></span></label>
          <label className={`connection-toggle ${canManage ? "checked" : ""}`}><input type="checkbox" checked={canManage} onChange={(event) => setCanManage(event.target.checked)}/><span><b>Gerenciar tarefas de</b><small>Edita, reatribui, exclui e vê o histórico completo das tarefas recebidas pelo cargo {targetRole.name}. Inclui visualizar.</small></span></label>
        </>}
        <div className="modal-footer full">
          {remove && <button type="button" className="danger-action" onClick={() => { remove(); close(); }}>Remover conexão</button>}
          <button type="button" className="secondary" onClick={close}>Cancelar</button>
          <button type="submit" className="primary">{empty ? "Remover" : "Aplicar"}</button>
        </div>
      </form>
    </section>
  </div>;
}
