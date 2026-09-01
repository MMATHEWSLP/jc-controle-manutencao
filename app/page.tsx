"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import Image from "next/image";
import { readSpreadsheetFile, type SpreadsheetReadingRow } from "../lib/excel-client";
import QrCodesView from "./QrCodesView";
import WhatsappView from "./WhatsappView";
import FleetStatusView from "./FleetStatusView";
import EquipmentManagementView from "./EquipmentManagementView";
type Permission = "dashboard.view" | "equipment.view" | "equipment.create" | "equipment.edit" | "equipment.transfer" | "equipment.applicable_types" | "equipment.edit_plan" | "meter.view" | "meter.create" | "meter.edit" | "maintenance.view" | "maintenance.create" | "maintenance.edit" | "maintenance.history" | "alerts.view" | "alerts.share" | "alerts.settings" | "whatsapp.view" | "whatsapp.send" | "whatsapp.manage" | "fleet.view" | "fleet.update" | "fleet.report" | "users.view" | "users.create" | "users.edit" | "users.permissions" | "users.status";
type Profile = "ADMIN" | "GESTOR" | "OFICINA" | "OPERADOR" | "ALMOXARIFADO";
type AuthUser = {
    id: number;
    name: string;
    username: string;
    email: string;
    profile: Profile;
    status: "ACTIVE" | "INACTIVE";
    theme: "LIGHT" | "DARK";
    isPrimaryAdmin: boolean;
    lastAccessAt: string | null;
    createdAt: string;
    permissions: Permission[];
    serviceFrontId: number | null;
    serviceFrontName: string | null;
};
type MaintenanceType = {
    id: number;
    name: string;
    category: string;
};
type PlanState = {
    configured: boolean;
    unit: "HOURS" | "KM";
    unitLabel: "h" | "km";
    currentValue: number;
    lastValue: number | null;
    interval: number | null;
    nextValue: number | null;
    remaining: number | null;
    overdue: number;
    used: number | null;
    health: number | null;
    level: "OK" | "WARNING" | "NEAR" | "OVERDUE";
    label: string;
    tone: string;
};
type Plan = {
    id: number;
    equipmentId: number;
    maintenanceTypeId: number;
    name: string;
    category: string;
    triggerMode: "HOURS" | "KM";
    intervalHours: number | null;
    intervalKm: number | null;
    intervalDays: number | null;
    lastHours: number | null;
    lastKm: number | null;
    lastDate: string | null;
    nextHours: number | null;
    nextKm: number | null;
    nextDate: string | null;
    oilType: string | null;
    filterReference: string | null;
    notes: string | null;
    state: PlanState;
    estimatedDays: number | null;
};
type Equipment = {
    id: number;
    code: string;
    prefix: string;
    type: string;
    brand: string;
    model: string;
    year: number | null;
    serial: string;
    chassis: string | null;
    identificationType: "SERIAL_NUMBER" | "CHASSIS";
    identificationValue: string | null;
    plate: string | null;
    front: string;
    hours: number;
    km: number;
    control: "HOURS" | "KM" | "HOURS_KM";
    status: string;
    reading: string;
    health: number | null;
    situation: string;
    tone: string;
    qrToken: string | null;
    applicableMaintenanceTypes: MaintenanceType[];
    plans: Plan[];
    createdAt: string;
    updatedAt: string;
    serviceFrontId: number | null;
    oilChangeEnabled: boolean;
    notes: string | null;
};
type AlertPlan = Plan & {
    prefix: string;
    equipment: string;
    equipmentCategory: string;
    front: string;
};
type HistoryItem = {
    id: string;
    sourceId: number;
    maintenanceId: number | null;
    maintenanceTypeId: number | null;
    kind: "MAINTENANCE" | "READING" | "IMPORTED";
    date: string;
    recordedAt: string;
    equipmentId: number | null;
    prefix: string;
    equipmentCategory: string;
    front: string | null;
    action: string;
    category: string;
    service: string;
    previousReading: number | null;
    newReading: number | null;
    hours: number | null;
    km: number | null;
    interval: number | null;
    nextReading: number | null;
    unit: "HOURS" | "KM";
    currentStatus: "OK" | "WARNING" | "NEAR" | "OVERDUE" | null;
    method: string;
    responsible: string;
    workOrder: string;
    notes: string | null;
    cost: number;
};
type Dashboard = {
    equipmentTotal: number;
    active: number;
    stopped: number;
    fronts: number;
    normal: number;
    attention: number;
    urgent: number;
    overdue: number;
    unconfigured: number;
    due7: number;
    due30: number;
    recentMaintenances: number;
};
type SystemData = {
    generatedAt: string;
    equipment: Equipment[];
    maintenanceTypes: MaintenanceType[];
    alerts: AlertPlan[];
    history: HistoryItem[];
    readings: HistoryItem[];
    dashboard: Dashboard;
};
type UserRecord = AuthUser & {
    profileLabel: string;
};
type ServiceFront = { id:number;name:string;location:string|null;active:boolean };
type Section = "Dashboard" | "Equipamentos da troca" | "Equipamentos" | "QR Codes" | "Horímetros / KM" | "Registrar troca de óleo" | "Central de alertas" | "WhatsApp" | "Histórico" | "Status da Frota" | "Usuários";
const emptyData: SystemData = { generatedAt: "", equipment: [], maintenanceTypes: [], alerts: [], history: [], readings: [], dashboard: { equipmentTotal: 0, active: 0, stopped: 0, fronts: 0, normal: 0, attention: 0, urgent: 0, overdue: 0, unconfigured: 0, due7: 0, due30: 0, recentMaintenances: 0 } };
const internalNav: Array<[
    string,
    Section,
    Permission
]> = [["▦", "Dashboard", "dashboard.view"], ["▣", "Equipamentos da troca", "equipment.view"], ["▤", "QR Codes", "equipment.view"], ["◴", "Horímetros / KM", "meter.view"], ["＋", "Registrar troca de óleo", "maintenance.create"], ["△", "Central de alertas", "alerts.view"], ["◉", "WhatsApp", "whatsapp.view"], ["↻", "Histórico", "maintenance.history"]];
const profileLabels: Record<Profile, string> = { ADMIN: "Administrador", GESTOR: "Gestor", OFICINA: "Manutenção / Oficina", OPERADOR: "Operador", ALMOXARIFADO: "Almoxarifado" };
const permissionGroups: Array<{
    label: string;
    items: Array<[
        Permission,
        string
    ]>;
}> = [
    { label: "Dashboard", items: [["dashboard.view", "Visualizar Dashboard"]] },
    { label: "Equipamentos", items: [["equipment.view", "Visualizar equipamentos"], ["equipment.create", "Cadastrar equipamento"], ["equipment.edit", "Editar equipamento"], ["equipment.transfer", "Pode transferir equipamentos entre frentes"], ["equipment.applicable_types", "Alterar itens aplicáveis"], ["equipment.edit_plan", "Alterar planos"]] },
    { label: "Horímetros / KM", items: [["meter.view", "Visualizar leituras"], ["meter.create", "Registrar leitura"], ["meter.edit", "Editar ou excluir leitura"]] },
    { label: "Trocas", items: [["maintenance.view", "Visualizar trocas"], ["maintenance.create", "Registrar troca"], ["maintenance.edit", "Editar ou excluir manutenção"], ["maintenance.history", "Visualizar histórico"]] },
    { label: "Alertas", items: [["alerts.view", "Visualizar alertas"], ["alerts.share", "Compartilhar alertas"], ["alerts.settings", "Configurar alertas"]] },
    { label: "WhatsApp", items: [["whatsapp.view", "Visualizar configurações e histórico"], ["whatsapp.send", "Enviar alertas"], ["whatsapp.manage", "Gerenciar destinatários e automação"]] },
    { label: "Status da Frota", items: [["fleet.view", "Visualizar Status da Frota"], ["fleet.update", "Atualizar ocorrências e pedidos"], ["fleet.report", "Exportar relatório diário"]] },
    { label: "Usuários", items: [["users.view", "Visualizar usuários"], ["users.create", "Criar usuários"], ["users.edit", "Editar usuários"], ["users.permissions", "Alterar permissões"], ["users.status", "Ativar/desativar"]] },
];
const allPermissions = permissionGroups.flatMap((group) => group.items.map(([key]) => key));
const profileDefaults: Record<"ADMIN" | "GESTOR" | "OFICINA" | "OPERADOR", Permission[]> = { ADMIN: allPermissions, GESTOR: ["dashboard.view", "equipment.view", "meter.view", "maintenance.view", "maintenance.history", "alerts.view", "alerts.share", "whatsapp.view", "whatsapp.send", "fleet.view", "fleet.update", "fleet.report"], OFICINA: ["equipment.view", "equipment.edit_plan", "meter.view", "meter.create", "maintenance.view", "maintenance.create", "maintenance.edit", "maintenance.history", "alerts.view", "fleet.view", "fleet.update", "fleet.report"], OPERADOR: [] };
async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> { const response = await fetch(url, { cache: "no-store", ...options }); let data: Record<string, unknown> = {}; try {
    data = await response.json() as Record<string, unknown>;
}
catch { /* tratada abaixo */ } if (!response.ok)
    throw Object.assign(new Error(String(data.error ?? "A operação não pôde ser concluída.")), { status: response.status, data }); return data as T; }
function formatNumber(value: number | null | undefined) { return value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: 1 }); }
function planBalanceText(state: PlanState) { if (!state.configured || state.remaining === null)
    return "—"; if (state.level === "NEAR")
    return `Urgente — vencido há ${formatNumber(state.overdue)} ${state.unitLabel}`; if (state.level === "OVERDUE")
    return `Vencido há ${formatNumber(state.overdue)} ${state.unitLabel}`; return `Restam ${formatNumber(state.remaining)} ${state.unitLabel}`; }
function formatDate(value: string, withTime = true) { if (!value) return "Sem data"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" }).format(date); }
function localDateTime() { const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); return date.toISOString().slice(0, 16); }
function inputDateTime(value: string) { const date = new Date(value); if (Number.isNaN(date.getTime()))
    return ""; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function maintenanceServiceKey(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim().replace(/^TROCA DE OLEO (DO|DA|DOS|DAS) /, "").replace(/^TROCA (DO|DA|DOS|DAS) /, "").replace(/\s+/g, " "); }
function equipmentLookupKey(value: string) { return value.split("·")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export function maintenanceEquipmentSearchKey(value: string | null | undefined) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export function maintenanceEquipmentLabel(item: Equipment) { return `${item.prefix} · ${item.brand} ${item.model} · ${item.reading}`; }
export function maintenanceEquipmentRank(item: Equipment, query: string) {
    const prefix = maintenanceEquipmentSearchKey(item.prefix);
    if (prefix === query)
        return 0;
    if (prefix.startsWith(query))
        return 1;
    if (prefix.includes(query))
        return 2;
    if (maintenanceEquipmentSearchKey(item.model).includes(query))
        return 3;
    if (maintenanceEquipmentSearchKey(item.brand).includes(query))
        return 4;
    const otherFields = [item.code, item.plate, item.type, `${item.brand} ${item.model}`, maintenanceEquipmentLabel(item)];
    return otherFields.some((value) => maintenanceEquipmentSearchKey(value).includes(query)) ? 5 : Number.POSITIVE_INFINITY;
}
export function searchMaintenanceEquipment(items: Equipment[], value: string, limit = 15) {
    const query = maintenanceEquipmentSearchKey(value);
    if (!query)
        return [];
    return items.map((item) => ({ item, rank: maintenanceEquipmentRank(item, query) })).filter((result) => Number.isFinite(result.rank)).sort((a, b) => a.rank - b.rank || a.item.prefix.localeCompare(b.item.prefix, "pt-BR", { numeric: true, sensitivity: "base" })).slice(0, limit).map((result) => result.item);
}
function historyReading(item: HistoryItem) { if (item.hours !== null && item.km !== null)
    return `${formatNumber(item.hours)} h · ${formatNumber(item.km)} km`; return `${formatNumber(item.newReading)} ${item.unit === "KM" ? "km" : "h"}`; }
function exportMaintenancePdf(item: HistoryItem) { if (item.kind === "READING")
    return; window.open(`/api/maintenance-pdf?kind=${item.kind}&id=${item.sourceId}`, "_blank", "noopener,noreferrer"); }
function equipmentCategories(data: SystemData) { return [...new Set(data.equipment.map((item) => item.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })); }
function appendReportValues(params: URLSearchParams, key: string, values: string[]) { values.forEach((value) => params.append(key, value)); }
function openReportPdf(path: string, params: URLSearchParams) { const query = params.toString(); window.open(`${path}${query ? `?${query}` : ""}`, "_blank", "noopener,noreferrer"); }
function CategoryReportFilter({ categories, selected, onChange }: { categories: string[]; selected: string[]; onChange: (values: string[]) => void; }) {
    const label = selected.length === 0 ? "Todas as categorias" : selected.length === 1 ? selected[0] : `${selected.length} categorias`;
    function toggle(category: string) { onChange(selected.includes(category) ? selected.filter((item) => item !== category) : [...selected, category]); }
    return <details className="category-report-filter"><summary><span>Categoria do equipamento</span><strong>{label}</strong><b>⌄</b></summary><div><button type="button" className={selected.length === 0 ? "selected" : ""} onClick={() => onChange([])}><i>{selected.length === 0 ? "✓" : ""}</i>Todas as categorias</button>{categories.map((category) => <button type="button" className={selected.includes(category) ? "selected" : ""} key={category} onClick={() => toggle(category)}><i>{selected.includes(category) ? "✓" : ""}</i>{category}</button>)}</div></details>;
}
function BrandMark() { return <div className="brand-mark"><Image src="/jc-florestais-logo.png" alt="JC Florestais" width={113} height={51} priority unoptimized onError={(event)=>{event.currentTarget.style.display="none";}}/></div>; }
function can(user: AuthUser | undefined | null, permission: Permission) { return Boolean(user?.permissions.includes(permission)); }
function LoginScreen({ onAuthenticated }: {
    onAuthenticated: (user: AuthUser) => void;
}) {
    const [show, setShow] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); try {
        const result = await fetchJson<{
            user: AuthUser;
        }>("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: form.get("credential"), password: form.get("password") }) });
        onAuthenticated(result.user);
    }
    catch (problem) {
        setError(problem instanceof Error ? problem.message : "Não foi possível entrar.");
    }
    finally {
        setBusy(false);
    } }
    return <main className="auth-shell"><section className="login-brand-panel"><div><BrandMark /><strong>MANUTENÇÃO</strong></div><p>Gestão preventiva com dados persistentes e rastreabilidade completa.</p><ul><li><span>✓</span> Leitura, plano, alerta e troca interligados</li><li><span>✓</span> Controle independente por horas e quilômetros</li><li><span>✓</span> Operações validadas e registradas no servidor</li></ul><small>Sistema de Manutenção Preventiva</small></section><section className="login-form-panel"><form className="login-card" onSubmit={submit}><div className="login-mobile-brand"><BrandMark /><strong>MANUTENÇÃO</strong></div><p className="eyebrow">LOGIN</p><h1>Acesso ao sistema</h1><span>Entre com seu usuário e senha para carregar os dados da operação.</span><label className="login-field">Usuário<input name="credential" required autoComplete="username" placeholder="Digite seu usuário"/></label><label className="login-field">Senha<div className="password-field"><input name="password" type={show ? "text" : "password"} required autoComplete="current-password"/><button type="button" onClick={() => setShow(!show)}>{show ? "Ocultar" : "Mostrar"}</button></div></label>{error && <div className="login-error">! {error}</div>}<button className="primary login-submit" disabled={busy}>{busy ? "Validando..." : "ENTRAR"}</button><small className="security-caption">Sessão protegida e validação realizada no servidor.</small></form></section></main>;
}
export default function Home() {
    const [authUser, setAuthUser] = useState<AuthUser | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [theme, setTheme] = useState<"LIGHT" | "DARK">("LIGHT");
    const [data, setData] = useState<SystemData>(emptyData);
    const [dataLoading, setDataLoading] = useState(false);
    const [dataError, setDataError] = useState("");
    const [active, setActive] = useState<Section>("Dashboard");
    const [oilOpen, setOilOpen] = useState(true);
    const [profileOpen, setProfileOpen] = useState(false);
    const [notice, setNotice] = useState("");
    const [equipmentModal, setEquipmentModal] = useState<Equipment | null | "new">(null);
    const [sheetId, setSheetId] = useState<number | null>(null);
    const [users, setUsers] = useState<UserRecord[]>([]);
    const [userModal, setUserModal] = useState<UserRecord | null | "new">(null);
    const [serviceFronts, setServiceFronts] = useState<ServiceFront[]>([]);
    const flash = useCallback((message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 3200); }, []);
    const refresh = useCallback(async () => { setDataLoading(true); setDataError(""); try {
        setData(await fetchJson<SystemData>("/api/system"));
    }
    catch (problem) {
        setDataError(problem instanceof Error ? problem.message : "Não foi possível carregar os dados.");
    }
    finally {
        setDataLoading(false);
    } }, []);
    const loadUsers = useCallback(async () => { if (!can(authUser, "users.view"))
        return; try {
        const result = await fetchJson<{
            users: UserRecord[];
        }>("/api/users");
        setUsers(result.users);
    }
    catch (problem) {
        flash(problem instanceof Error ? problem.message : "Não foi possível carregar os usuários.");
    } }, [authUser, flash]);
    useEffect(() => { fetchJson<{
        user: AuthUser | null;
    }>("/api/auth/session").then((result) => { if (result.user) {
        setAuthUser(result.user);
        setTheme(result.user.theme);
    } }).catch(() => undefined).finally(() => setAuthLoading(false)); }, []);
    useEffect(() => { document.documentElement.dataset.theme = theme.toLowerCase(); window.localStorage.setItem("maintenance-theme", theme); }, [theme]);
    useEffect(() => { if (authUser)
        refresh(); }, [authUser, refresh]);
    useEffect(() => { if (authUser && can(authUser, "users.view"))
        loadUsers(); }, [authUser, loadUsers]);
    useEffect(() => { if (authUser)
        fetchJson<{ fronts: ServiceFront[] }>("/api/service-fronts").then((result) => setServiceFronts(result.fronts)).catch(() => setServiceFronts([])); }, [authUser]);
    if (authLoading)
        return <main className="auth-shell"><div className="auth-loading"><BrandMark /><span>Preparando ambiente seguro...</span></div></main>;
    if (!authUser)
        return <LoginScreen onAuthenticated={(user) => { setAuthUser(user); setTheme(user.theme); const next = new URLSearchParams(window.location.search).get("next"); if (next?.startsWith("/equipamento/qr/"))
            window.location.assign(next); }}/>;
    const allowed = internalNav.filter(([, , permission]) => can(authUser, permission));
    const standaloneAllowed = active === "Status da Frota" && can(authUser, "fleet.view") || active === "Equipamentos" && can(authUser, "equipment.view") || active === "Usuários" && can(authUser, "users.view");
    const effective = standaloneAllowed ? active : !allowed.some(([, label]) => label === active) ? allowed[0]?.[1] ?? (can(authUser, "equipment.view") ? "Equipamentos" : can(authUser, "fleet.view") ? "Status da Frota" : can(authUser, "users.view") ? "Usuários" : "Dashboard") : active;
    const oilActive = allowed.some(([, label]) => label === effective);
    const initials = authUser.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    async function toggleTheme() { const next = theme === "LIGHT" ? "DARK" : "LIGHT"; setTheme(next); setAuthUser((current) => current ? { ...current, theme: next } : current); fetchJson("/api/auth/theme", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: next }) }).catch(() => undefined); }
    async function logout() { await fetchJson("/api/auth/logout", { method: "POST" }).catch(() => undefined); setAuthUser(null); setData(emptyData); }
    const contentProps = { data, authUser, refresh, flash };
    return <main className="app-shell"><section className="workspace"><header className="app-header"><div className="topbar"><div className="header-brand"><BrandMark /><div><strong>MANUTENÇÃO</strong><span>Gestão preventiva</span></div></div><div className="header-spacer"/><div className="top-actions"><span className="system-online"><i /> Banco conectado</span><button className="theme-toggle" onClick={toggleTheme}><span>{theme === "LIGHT" ? "☀" : "☾"}</span>{theme === "LIGHT" ? "Claro" : "Escuro"}</button><div className="profile-control"><button className="profile-button" onClick={() => setProfileOpen(!profileOpen)} aria-expanded={profileOpen}><span className="top-avatar">{initials}</span><span><strong>{authUser.name}</strong><small>{authUser.serviceFrontName ?? profileLabels[authUser.profile]}</small></span><b>⌄</b></button>{profileOpen && <div className="profile-menu"><div><span className="top-avatar">{initials}</span><p><strong>{authUser.name}</strong><small>@{authUser.username} · {authUser.serviceFrontName ?? "Todas as frentes"}</small></p></div><button className="logout-button" onClick={logout}>Sair</button></div>}</div></div></div><nav className="navigation-stack" aria-label="Navegação do sistema"><div className="main-tabs primary-module-nav" aria-label="Módulos principais"><button className={`oil-menu-toggle ${oilActive ? "active expanded" : ""}`} onClick={() => { setOilOpen(true); if (!oilActive && allowed[0])
        setActive(allowed[0][1]); }} aria-expanded={oilOpen && oilActive}><span className="nav-icon">◉</span><span>TROCA DE ÓLEO</span><b>{oilOpen && oilActive ? "⌃" : "⌄"}</b>{data.dashboard.overdue + data.dashboard.urgent > 0 && <i>{data.dashboard.overdue + data.dashboard.urgent}</i>}</button>{can(authUser, "equipment.view") && <button className={`equipment-primary-nav ${effective === "Equipamentos" ? "active" : ""}`} onClick={() => { setActive("Equipamentos"); setOilOpen(false); }}><span className="nav-icon">▣</span><span>EQUIPAMENTOS</span></button>}{can(authUser, "fleet.view") && <button className={`fleet-primary-nav ${effective === "Status da Frota" ? "active" : ""}`} onClick={() => { setActive("Status da Frota"); setOilOpen(false); }}><span className="nav-icon">▥</span><span>STATUS DA FROTA</span></button>}{can(authUser, "users.view") && <button className={`users-nav ${effective === "Usuários" ? "active" : ""}`} onClick={() => { setActive("Usuários"); setOilOpen(false); }}><span className="nav-icon">♙</span><span>USUÁRIOS</span></button>}</div>{oilOpen && oilActive && <div className="main-tabs secondary-module-nav" aria-label="Navegação do módulo Troca de óleo">{allowed.map(([icon, label]) => <button key={label} className={effective === label ? "active" : ""} onClick={() => setActive(label)}><span className="nav-icon">{icon}</span><span>{label}</span>{label === "Central de alertas" && data.dashboard.overdue + data.dashboard.urgent > 0 && <b className="nav-badge">{data.dashboard.overdue + data.dashboard.urgent}</b>}</button>)}</div>}</nav></header><div className="content">{dataError && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar o sistema</strong><p>{dataError}</p></div><button onClick={refresh}>Tentar novamente</button></div>}{dataLoading && !data.generatedAt ? <div className="page-loading"><span /><p>Carregando equipamentos, planos e alertas...</p></div> : <SectionView section={effective} {...contentProps} users={users} loadUsers={loadUsers} openEquipment={(id) => setSheetId(id)} openEquipmentModal={(item) => setEquipmentModal(item)} openUserModal={(item) => setUserModal(item)}/>}</div></section>{notice && <div className="toast"><span>✓</span>{notice}</div>}{sheetId !== null && data.equipment.some((item) => item.id === sheetId) && <EquipmentSheet equipment={data.equipment.find((item) => item.id === sheetId)!} authUser={authUser} close={() => setSheetId(null)} refresh={refresh} flash={flash}/>}{equipmentModal && <EquipmentModal item={equipmentModal === "new" ? null : equipmentModal} maintenanceTypes={data.maintenanceTypes} authUser={authUser} close={() => setEquipmentModal(null)} saved={async (message) => { setEquipmentModal(null); await refresh(); flash(message); }}/>}{userModal && <UserModal item={userModal === "new" ? null : userModal} actor={authUser} fronts={serviceFronts} close={() => setUserModal(null)} saved={async (message) => { setUserModal(null); await loadUsers(); flash(message); }}/>}</main>;
}
function SectionView(props: {
    section: Section;
    data: SystemData;
    authUser: AuthUser;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
    users: UserRecord[];
    loadUsers: () => Promise<void>;
    openEquipment: (id: number) => void;
    openEquipmentModal: (item: Equipment | "new") => void;
    openUserModal: (item: UserRecord | "new") => void;
}) { if (props.section === "Dashboard")
    return <DashboardView {...props}/>; if (props.section === "Equipamentos")
    return <EquipmentManagementView authUser={props.authUser} flash={props.flash} refreshSystem={props.refresh}/>; if (props.section === "Equipamentos da troca")
    return <EquipmentView {...props}/>; if (props.section === "QR Codes")
    return <QrCodesView {...props}/>; if (props.section === "Horímetros / KM")
    return <MeterView {...props}/>; if (props.section === "Registrar troca de óleo")
    return <MaintenanceView {...props}/>; if (props.section === "Central de alertas")
    return <AlertsView {...props}/>; if (props.section === "WhatsApp")
    return <WhatsappView authUser={props.authUser} flash={props.flash}/>; if (props.section === "Histórico")
    return <HistoryView {...props}/>; if (props.section === "Status da Frota")
    return <FleetStatusView authUser={props.authUser} flash={props.flash}/>; return <UsersView {...props}/>; }
function ModuleHeader({ eyebrow, title, subtitle, action, onAction }: {
    eyebrow: string;
    title: string;
    subtitle: string;
    action?: string;
    onAction?: () => void;
}) { return <div className="page-heading module-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><span>{subtitle}</span></div>{action && <div className="heading-actions"><button className="primary" onClick={onAction}>{action}</button></div>}</div>; }
function StatusPill({ state }: {
    state: PlanState;
}) { return <span className={`status-pill ${state.tone}`}>{state.label}</span>; }
function DashboardView({ data, authUser, openEquipment }: {
    data: SystemData;
    authUser: AuthUser;
    openEquipment: (id: number) => void;
}) { const d = data.dashboard; const priorities = data.alerts.slice(0, 8); const healthTotal = d.normal + d.attention + d.urgent + d.overdue; const healthy = healthTotal ? Math.round(d.normal / healthTotal * 100) : 0; return <><ModuleHeader eyebrow="VISÃO GERAL DA OPERAÇÃO" title={`Olá, ${authUser.name.split(" ")[0]}.`} subtitle={`Dados atualizados em ${data.generatedAt ? formatDate(data.generatedAt) : "agora"}.`}/><div className="metric-grid"><Metric icon="▣" value={d.equipmentTotal} label="Equipamentos" detail={`${d.active} ativos`} tone="navy"/><Metric icon="✓" value={d.normal} label="Manutenções normais" detail={`${d.unconfigured} sem plano`} tone="green"/><Metric icon="◷" value={d.attention + d.urgent} label="Próximas / urgentes" detail={`${d.due7} previstas em 7 dias`} tone="amber"/><Metric icon="!" value={d.overdue} label="Manutenções vencidas" detail={`${d.due30} previstas em 30 dias`} tone="red"/></div><div className="control-dashboard"><article className="control-card hours"><div className="control-card-head"><span>▣</span><div><p>FROTA CADASTRADA</p><strong>{d.equipmentTotal} equipamentos</strong></div></div><div className="control-stats"><span><b>{d.active}</b>Ativos</span><span><b>{d.stopped}</b>Parados / manutenção</span><span><b>{d.fronts}</b>Frentes</span></div></article><article className="control-card km"><div className="control-card-head"><span>↻</span><div><p>MOVIMENTAÇÃO RECENTE</p><strong>Últimos 30 dias</strong></div></div><div className="control-stats"><span><b>{d.recentMaintenances}</b>Trocas</span><span><b>{d.due7}</b>Previsão 7 dias</span><span><b>{d.due30}</b>Previsão 30 dias</span></div></article><article className="overdue-total-card"><span>!</span><div><p>SAÚDE GERAL DOS PLANOS</p><strong>{healthy}%</strong><small>Calculada com dados reais dos planos</small></div></article></div><div className="dashboard-grid dashboard-live"><article className="panel table-panel"><div className="panel-head"><div><h2>Prioridades de manutenção</h2><p>Ordenadas pelo plano mais crítico</p></div><span className="live-data-badge">DADOS DO BANCO</span></div><PlanTable plans={priorities} openEquipment={openEquipment}/></article><article className="panel attention-panel"><div className="panel-head"><div><h2>Resumo preventivo</h2><p>Todos os planos configurados</p></div></div><div className="status-overview"><StatusLine tone="green" label="Normal" value={d.normal}/><StatusLine tone="yellow" label="Atenção" value={d.attention}/><StatusLine tone="orange" label="Urgente" value={d.urgent}/><StatusLine tone="red" label="Vencido" value={d.overdue}/><StatusLine tone="gray" label="Sem configuração" value={d.unconfigured}/></div></article></div></>; }
function Metric({ icon, value, label, detail, tone }: {
    icon: string;
    value: number;
    label: string;
    detail: string;
    tone: string;
}) { return <article className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span><small>{detail}</small></div></article>; }
function StatusLine({ tone, label, value }: {
    tone: string;
    label: string;
    value: number;
}) { return <div className={`status-line ${tone}`}><i /><span>{label}</span><strong>{value}</strong></div>; }
function PlanTable({ plans, openEquipment }: {
    plans: AlertPlan[];
    openEquipment: (id: number) => void;
}) { return <div className="table-scroll"><table><thead><tr><th>Equipamento</th><th>Serviço</th><th>Atual</th><th>Próxima</th><th>Saldo</th><th>Status</th><th /></tr></thead><tbody>{plans.map((plan) => <tr key={`${plan.equipmentId}-${plan.id}`}><td><div className="machine-cell"><span>{plan.prefix.slice(0, 2)}</span><div><strong>{plan.prefix}</strong><small>{plan.equipment}</small></div></div></td><td>{plan.name}</td><td>{formatNumber(plan.state.currentValue)} {plan.state.unitLabel}</td><td>{formatNumber(plan.state.nextValue)} {plan.state.unitLabel}</td><td className={plan.state.level === "OVERDUE" || plan.state.level === "NEAR" ? "danger-text" : ""}>{planBalanceText(plan.state)}</td><td><StatusPill state={plan.state}/></td><td><button className="row-action" onClick={() => openEquipment(plan.equipmentId)}>›</button></td></tr>)}</tbody></table>{plans.length === 0 && <div className="empty-state">Nenhum plano configurado. Abra um equipamento e salve seu Plano de Manutenção.</div>}</div>; }
function EquipmentView({ data, openEquipment }: {
    data: SystemData;
    openEquipment: (id: number) => void;
}) { const [query, setQuery] = useState(""); const normalized = query.toLowerCase(); const items = data.equipment.filter((item) => !normalized || [item.prefix, item.type, item.brand, item.model, item.plate, item.front].some((value) => String(value ?? "").toLowerCase().includes(normalized))); return <><ModuleHeader eyebrow="TROCA DE ÓLEO" title="Equipamentos da troca" subtitle="Somente equipamentos da sua frente com troca de óleo habilitada."/><div className="summary-strip"><div><strong>{data.dashboard.equipmentTotal}</strong><span>Total cadastrado</span></div><div><strong>{data.dashboard.active}</strong><span>Ativos</span></div><div><strong>{data.dashboard.stopped}</strong><span>Parados / manutenção</span></div><div><strong>{data.dashboard.fronts}</strong><span>Frentes de serviço</span></div></div><article className="panel module-panel"><div className="toolbar page-search-toolbar"><label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar prefixo, tipo, marca, modelo, placa ou frente..."/></label><span className="live-data-badge">{items.length} ENCONTRADOS</span></div><div className="equipment-grid">{items.map((item) => <button className="equipment-card" key={item.id} onClick={() => openEquipment(item.id)}><div className="equipment-card-top"><span className="equipment-avatar">{item.prefix.slice(0, 2)}</span><span className={`status-pill ${item.status === "Ativo" ? "green" : "gray"}`}>{item.status}</span></div><p>{item.type}</p><h3>{item.prefix} · {item.brand} {item.model}</h3><div className="equipment-meta"><span>Frente<strong>{item.front}</strong></span><span>Leitura<strong>{item.reading}</strong></span><span>Planos<strong>{item.plans.length} configurados</strong></span></div><div className={`health-line ${item.tone}`}><div><span>Saúde preventiva</span><b>{item.health === null ? "Sem plano" : `${item.health}%`}</b></div><i><em style={{ width: `${item.health ?? 0}%` }}/></i></div><span className="details-link">Abrir ficha do equipamento →</span></button>)}</div>{items.length === 0 && <div className="empty-state">Nenhum equipamento encontrado.</div>}</article></>; }
type ReadingImportPreviewRow = { rowNumber:number;equipmentInput:string;equipmentId:number|null;prefix:string;equipment:string;reading:number|null;readingRaw:string;unit:"HOURS"|"KM"|"HOURS_KM"|null;currentReading:number|null;responsible:string;readingDate:string|null;notes:string;front:string;status:"READY"|"WARNING"|"ERROR";code:string;message:string;ready:boolean };
type ReadingImportAnalysis = { fileName:string;rows:ReadingImportPreviewRow[];summary:{total:number;ready:number;warnings:number;errors:number;blocked:number} };
type ReadingImportResult = { fileName:string;updated:number;skipped:number;errors:number;total:number;errorRows:ReadingImportPreviewRow[] };
function downloadImportErrors(rows:ReadingImportPreviewRow[],fileName:string){const escaped=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`;const csv=["LINHA;EQUIPAMENTO;LEITURA;ERRO",...rows.map((row)=>[row.rowNumber,row.equipmentInput,row.readingRaw,row.message].map(escaped).join(";"))].join("\r\n");const link=document.createElement("a");const url=URL.createObjectURL(new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"}));link.href=url;link.download=`erros-${fileName.replace(/\.[^.]+$/,"")}.csv`;link.click();URL.revokeObjectURL(url);}
function ReadingImportModal({ close, completed }: { close:()=>void;completed:(message:string)=>Promise<void> }) {
    const [file,setFile]=useState<File|null>(null);const [parsedRows,setParsedRows]=useState<SpreadsheetReadingRow[]>([]);const [analysis,setAnalysis]=useState<ReadingImportAnalysis|null>(null);const [result,setResult]=useState<ReadingImportResult|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");
    async function analyze(){if(!file)return;setBusy(true);setError("");setResult(null);try{const rows=await readSpreadsheetFile(file);setParsedRows(rows);setAnalysis(await fetchJson<ReadingImportAnalysis>("/api/reading-imports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"ANALYZE",fileName:file.name,rows})}));}catch(problem){setAnalysis(null);setError(problem instanceof Error?problem.message:"Não foi possível analisar o arquivo.");}finally{setBusy(false);}}
    async function confirm(){if(!file||!parsedRows.length||!analysis?.summary.ready)return;setBusy(true);setError("");try{const imported=await fetchJson<ReadingImportResult>("/api/reading-imports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"CONFIRM",fileName:file.name,rows:parsedRows})});setResult(imported);await completed(`Importação concluída: ${imported.updated} equipamento(s) atualizado(s).`);}catch(problem){setError(problem instanceof Error?problem.message:"Não foi possível confirmar a importação.");}finally{setBusy(false);}}
    const statusLabel=(row:ReadingImportPreviewRow)=>row.status==="READY"?"✓ Pronto":row.ready?"⚠ Pronto com alerta":row.status==="WARNING"?"⚠ Verificar":"✕ Erro";
    return <div className="modal-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!busy)close();}}><section className="modal reading-import-modal"><header><div><p className="eyebrow">IMPORTAÇÃO EM LOTE</p><h2>Importar leituras por Excel</h2><span>O arquivo é analisado primeiro. Nenhum equipamento é atualizado antes da confirmação.</span></div><button disabled={busy} onClick={close}>×</button></header>{result?<div className="reading-import-complete"><span>✓</span><h3>Importação concluída</h3><div><p><strong>{result.updated}</strong>Atualizados</p><p><strong>{result.skipped}</strong>Ignorados</p><p><strong>{result.errors}</strong>Erros</p></div>{result.errorRows.length>0&&<button className="secondary" onClick={()=>downloadImportErrors(result.errorRows,result.fileName)}>⇩ Baixar relatório de erros</button>}<button className="primary" onClick={close}>Concluir</button></div>:<><div className="import-steps"><span className="done"><b>1</b>Baixar modelo</span><span className={file?"done":""}><b>2</b>Selecionar arquivo</span><span className={analysis?"done":""}><b>3</b>Analisar</span><span className={analysis?"done":""}><b>4</b>Conferir</span><span><b>5</b>Confirmar</span></div><div className="reading-import-body"><div className="import-file-actions"><a className="secondary import-template-link" href="/modelos/modelo-importacao-leituras.xlsx" download>⇩ Baixar modelo Excel</a><label className="import-file-picker"><input type="file" accept=".xlsx,.xls,.csv" onChange={(event)=>{const selected=event.target.files?.[0]??null;setFile(selected);setAnalysis(null);setParsedRows([]);setError("");}}/><span>{file?file.name:"Selecionar arquivo .xlsx, .xls ou .csv"}</span><b>Procurar</b></label><button className="primary" disabled={!file||busy} onClick={analyze}>{busy&&!analysis?"Analisando...":"Analisar arquivo"}</button></div>{error&&<div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}{analysis&&<><div className="import-summary"><p><span>Arquivo</span><strong>{analysis.fileName}</strong></p><p><span>Linhas</span><strong>{analysis.summary.total}</strong></p><p className="ready"><span>Prontas</span><strong>{analysis.summary.ready}</strong></p><p className="warning"><span>Com alerta</span><strong>{analysis.summary.warnings}</strong></p><p className="error"><span>Com erro</span><strong>{analysis.summary.errors}</strong></p></div><div className="import-preview-table"><table><thead><tr><th>Linha</th><th>Equipamento</th><th>Nova leitura</th><th>Unidade</th><th>Leitura atual</th><th>Responsável</th><th>Situação</th></tr></thead><tbody>{analysis.rows.map((row)=><tr key={`${row.rowNumber}-${row.equipmentInput}`} className={row.status.toLowerCase()}><td>{row.rowNumber}</td><td><strong>{row.prefix}</strong><small>{row.equipment}</small></td><td>{formatNumber(row.reading)}</td><td>{row.unit==="KM"?"KM":row.unit==="HOURS"?"HORAS":row.unit==="HOURS_KM"?"HORAS + KM":"—"}</td><td>{formatNumber(row.currentReading)}</td><td>{row.responsible||"—"}</td><td><span className={`import-row-status ${row.status.toLowerCase()} ${row.ready?"importable":""}`}>{statusLabel(row)}</span><small>{row.message}</small></td></tr>)}</tbody></table></div><div className="import-confirmation"><p><strong>{analysis.summary.ready} linha(s)</strong> serão atualizadas usando a mesma validação e o mesmo recálculo da leitura manual.</p><button className="primary" disabled={!analysis.summary.ready||busy} onClick={confirm}>{busy?"Importando e recalculando...":`Confirmar importação (${analysis.summary.ready})`}</button></div></>}</div></>}</section></div>;
}
function MeterView({ data, authUser, refresh, flash, openEquipment }: {
    data: SystemData;
    authUser: AuthUser;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
    openEquipment: (id: number) => void;
}) { const [equipmentId, setEquipmentId] = useState(data.equipment[0]?.id ?? 0); const [equipmentSearch,setEquipmentSearch]=useState(""); const [importOpen,setImportOpen]=useState(false); const equipment = data.equipment.find((item) => item.id === equipmentId) ?? data.equipment[0]; const [busy, setBusy] = useState(false); const [error, setError] = useState(""); function chooseEquipment(value:string){setEquipmentSearch(value);const key=equipmentLookupKey(value);const matches=data.equipment.filter((item)=>equipmentLookupKey(item.prefix)===key);if(matches.length===1)setEquipmentId(matches[0].id);} useEffect(() => { if (!equipmentId && data.equipment[0])
    setEquipmentId(data.equipment[0].id); }, [data.equipment, equipmentId]); async function submit(event: FormEvent<HTMLFormElement>, authorized = false) { event.preventDefault(); if (!equipment)
    return; setBusy(true); setError(""); const form = new FormData(event.currentTarget); const payload = { equipmentId: equipment.id, readingDate: form.get("readingDate"), hours: form.get("hours"), km: form.get("km"), operator: form.get("operator"), notes: form.get("notes"), authorizeRegression: authorized }; try {
    const result = await fetchJson<{
        hoursUsed: number;
        kmUsed: number;
    }>("/api/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await refresh();
    flash(`Leitura salva. Uso registrado: ${formatNumber(result.hoursUsed)} h / ${formatNumber(result.kmUsed)} km.`);
    event.currentTarget.reset();
}
catch (problem) {
    const typed = problem as Error & {
        data?: {
            requiresConfirmation?: boolean;
        };
    };
    if (typed.data?.requiresConfirmation && window.confirm(`${typed.message}\n\nConfirmar como administrador?`)) {
        setBusy(false);
        return submit(event, true);
    }
    setError(typed.message);
}
finally {
    setBusy(false);
} } return <><ModuleHeader eyebrow="LEITURAS OPERACIONAIS" title="Horímetros e quilometragem" subtitle="Registre uma leitura manual ou importe vários equipamentos por Excel com conferência antes de salvar."/><div className="meter-entry-actions"><button className="active">＋ Nova leitura manual</button><button onClick={()=>setImportOpen(true)}>⇧ Importar Excel</button><a href="/modelos/modelo-importacao-leituras.xlsx" download>⇩ Baixar modelo</a></div><div className="split-grid"><article className="panel quick-form"><div className="section-title"><span className="section-icon blue">◷</span><div><h2>Nova leitura manual</h2><p>Pesquise em toda a base pelo prefixo, marca ou modelo.</p></div><button className="import-inline-action" onClick={()=>setImportOpen(true)}>⇧ Importar Excel</button></div>{equipment ? <form className="form-grid" onSubmit={submit}><label className="full">Pesquisar equipamento<input value={equipmentSearch} list="meter-equipment-search" placeholder={`${equipment.prefix} · ${equipment.brand} ${equipment.model}`} onChange={(event)=>chooseEquipment(event.target.value)}/><datalist id="meter-equipment-search">{data.equipment.map((item)=><option key={item.id} value={`${item.prefix} · ${item.brand} ${item.model}`}>{item.type} · {item.front}</option>)}</datalist><small className="meter-selected-equipment">Selecionado: <strong>{equipment.prefix} · {equipment.brand} {equipment.model}</strong></small></label><div className="reading-comparison full"><span>Leitura atual</span><strong>{equipment.reading}</strong><small>Controle: {equipment.control === "HOURS" ? "Horímetro" : equipment.control === "KM" ? "Quilometragem" : "Horímetro e quilometragem"}</small></div><label>Data<input name="readingDate" type="datetime-local" defaultValue={localDateTime()} required/></label>{equipment.control !== "KM" && <label>Novo horímetro<div className="reading-field"><input name="hours" type="number" min="0" step="0.1" defaultValue={equipment.hours} required/><span>h</span></div></label>}{equipment.control !== "HOURS" && <label>Nova quilometragem<div className="reading-field"><input name="km" type="number" min="0" step="0.1" defaultValue={equipment.km} required/><span>km</span></div></label>}<label>Operador<input name="operator" defaultValue={authUser.name}/></label><label className="full">Observação<textarea name="notes" placeholder="Ocorrência ou motivo da atualização"/></label>{error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}<button className="primary form-submit" disabled={busy}>{busy ? "Salvando..." : "Salvar leitura e recalcular"}</button></form> : <div className="empty-state">Cadastre um equipamento antes de registrar leituras.</div>}</article><article className="panel recent-panel"><div className="panel-head"><div><h2>Leituras recentes</h2><p>Histórico persistente no banco</p></div></div>{data.readings.slice(0, 10).map((item) => <button className="reading-row reading-button" key={item.id} onClick={() => item.equipmentId && openEquipment(item.equipmentId)}><span className="equipment-avatar">{item.prefix.slice(0, 2)}</span><div><strong>{item.prefix}</strong><small>{item.action} · {item.method}</small></div><div className="reading-value"><strong>{formatNumber(item.newReading)} {item.unit === "KM" ? "km" : "h"}</strong><small>{formatDate(item.date)}</small></div><b>›</b></button>)}{data.readings.length === 0 && <div className="empty-state">Nenhuma leitura registrada ainda.</div>}</article></div>{importOpen&&<ReadingImportModal close={()=>setImportOpen(false)} completed={async(message)=>{await refresh();flash(message);}}/>}</>; }
function MaintenanceView({ data, refresh, flash }: {
    data: SystemData;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
}) {
    const configuredEquipment = useMemo(() => data.equipment.filter((item) => item.status === "Ativo" && item.plans.some((plan) => plan.state.configured)), [data.equipment]);
    const [equipmentId, setEquipmentId] = useState(configuredEquipment[0]?.id ?? 0);
    const equipment = configuredEquipment.find((item) => item.id === equipmentId) ?? configuredEquipment[0];
    const [equipmentQuery, setEquipmentQuery] = useState(configuredEquipment[0] ? maintenanceEquipmentLabel(configuredEquipment[0]) : "");
    const [searchOpen, setSearchOpen] = useState(false);
    const [activeResult, setActiveResult] = useState(0);
    const [selected, setSelected] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [lastPdf, setLastPdf] = useState<number | null>(null);
    const normalizedQuery = maintenanceEquipmentSearchKey(equipmentQuery);
    const equipmentResults = useMemo(() => searchMaintenanceEquipment(configuredEquipment, equipmentQuery), [configuredEquipment, equipmentQuery]);
    useEffect(() => {
        if (equipment && configuredEquipment.some((item) => item.id === equipmentId))
            return;
        const first = configuredEquipment[0];
        setEquipmentId(first?.id ?? 0);
        setEquipmentQuery(first ? maintenanceEquipmentLabel(first) : "");
        setSelected([]);
    }, [configuredEquipment, equipment, equipmentId]);
    function choose(id: number) { setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
    function selectEquipment(item: Equipment) {
        setEquipmentId(item.id);
        setEquipmentQuery(maintenanceEquipmentLabel(item));
        setSelected([]);
        setError("");
        setSearchOpen(false);
        setActiveResult(0);
    }
    function handleEquipmentSearchKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Escape") {
            setSearchOpen(false);
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setSearchOpen(true);
            setActiveResult((current) => Math.min(current + 1, Math.max(0, equipmentResults.length - 1)));
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveResult((current) => Math.max(0, current - 1));
            return;
        }
        if (event.key === "Enter" && searchOpen && equipmentResults[activeResult]) {
            event.preventDefault();
            selectEquipment(equipmentResults[activeResult]);
        }
    }
    async function submit(event: FormEvent<HTMLFormElement>, authorized = false) { event.preventDefault(); if (!equipment)
    return; if (!selected.length) {
    setError("Selecione pelo menos um item realizado.");
    return;
} setBusy(true); setError(""); const form = new FormData(event.currentTarget); const payload = { equipmentId: equipment.id, planIds: selected, performedAt: form.get("performedAt"), hours: form.get("hours"), km: form.get("km"), workOrder: form.get("workOrder"), cost: form.get("cost"), notes: form.get("notes"), authorizeRegression: authorized }; try {
    const result = await fetchJson<{
        maintenanceCount: number;
        workOrder: string;
        duplicate?: boolean;
        message?: string;
        maintenanceIds: number[];
    }>("/api/maintenance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await refresh();
    setSelected([]);
    setLastPdf(result.maintenanceIds[0] ?? null);
    flash(result.duplicate ? result.message ?? "Esta troca já estava no Histórico; nenhum dado foi duplicado." : `${result.maintenanceCount} item(ns) registrado(s). Novo ciclo iniciado na ${result.workOrder}.`);
}
catch (problem) {
    const typed = problem as Error & {
        data?: {
            requiresConfirmation?: boolean;
        };
    };
    if (typed.data?.requiresConfirmation && window.confirm(`${typed.message}\n\nConfirmar como administrador?`)) {
        setBusy(false);
        return submit(event, true);
    }
    setError(typed.message);
}
finally {
    setBusy(false);
} } return <><ModuleHeader eyebrow="REGISTRO DE SERVIÇO" title="Registrar troca de óleo" subtitle="Selecione o equipamento e os planos executados. Cada item reinicia apenas o próprio ciclo."/><article className="panel maintenance-live-form">{equipment ? <form className="modal-form maintenance-page-form" onSubmit={submit}><div className="full maintenance-equipment-search"><label htmlFor="maintenance-equipment-search">Equipamento</label><div className="maintenance-equipment-search-control"><span aria-hidden="true">⌕</span><input id="maintenance-equipment-search" value={equipmentQuery} role="combobox" aria-autocomplete="list" aria-controls="maintenance-equipment-results" aria-expanded={searchOpen} aria-activedescendant={searchOpen && equipmentResults[activeResult] ? `maintenance-equipment-${equipmentResults[activeResult].id}` : undefined} autoComplete="off" placeholder="Pesquisar equipamento por prefixo, modelo ou placa..." onFocus={(event) => { setSearchOpen(true); event.currentTarget.select(); }} onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)} onChange={(event) => { setEquipmentQuery(event.target.value); setSearchOpen(true); setActiveResult(0); }} onKeyDown={handleEquipmentSearchKey}/>{equipmentQuery && <button type="button" aria-label="Limpar pesquisa" onMouseDown={(event) => event.preventDefault()} onClick={() => { setEquipmentQuery(""); setSearchOpen(true); setActiveResult(0); }}>×</button>}</div>{searchOpen && <div className="maintenance-equipment-results" id="maintenance-equipment-results" role="listbox">{!normalizedQuery ? <div className="maintenance-equipment-search-hint"><span>⌕</span><strong>Digite para pesquisar...</strong><small>Prefixo, código, marca, modelo ou placa</small></div> : equipmentResults.length ? <>{equipmentResults.map((item, index) => <button type="button" role="option" aria-selected={index === activeResult} id={`maintenance-equipment-${item.id}`} className={index === activeResult ? "active" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveResult(index)} onClick={() => selectEquipment(item)}><span className="equipment-avatar">{item.prefix.slice(0, 2)}</span><span><strong>{item.prefix} · {item.brand} {item.model}</strong><small>{[item.code && `Código ${item.code}`, item.plate && `Placa ${item.plate}`, item.type, item.front].filter(Boolean).join(" · ")}</small></span><b>{item.reading}</b></button>)}<div className="maintenance-equipment-result-count">{equipmentResults.length} resultado(s) mais relevante(s)</div></> : <div className="maintenance-equipment-search-hint empty"><span>!</span><strong>Nenhum equipamento encontrado</strong><small>Tente outro prefixo, código, modelo, marca ou placa.</small></div>}</div>}<small className="maintenance-selected-equipment">Selecionado: <strong>{equipment.prefix} · {equipment.brand} {equipment.model}</strong></small></div><div className="maintenance-context full"><div><span>Leitura atual</span><strong>{equipment.reading}</strong></div><div><span>Frente</span><strong>{equipment.front}</strong></div><div><span>Planos configurados</span><strong>{equipment.plans.filter((plan) => plan.state.configured).length}</strong></div><div><span>Situação geral</span><strong>{equipment.situation}</strong></div></div><fieldset className="maintenance-selector full"><legend>ITENS REALIZADOS <span>selecione um ou mais</span></legend><div className="maintenance-plan-selector">{equipment.plans.filter((plan) => plan.state.configured).map((plan) => <label className={selected.includes(plan.id) ? "checked" : ""} key={plan.id}><input type="checkbox" checked={selected.includes(plan.id)} onChange={() => choose(plan.id)}/><span><strong>{plan.name}</strong><small>Última: {formatNumber(plan.state.lastValue)} {plan.state.unitLabel} · Próxima: {formatNumber(plan.state.nextValue)} {plan.state.unitLabel} · {planBalanceText(plan.state)}</small></span><StatusPill state={plan.state}/><i>✓</i></label>)}</div></fieldset><label>Data e hora<input name="performedAt" type="datetime-local" defaultValue={localDateTime()} required/></label>{equipment.control !== "KM" && <label>Horímetro da troca<div className="reading-field"><input name="hours" type="number" min="0" step="0.1" defaultValue={equipment.hours} required/><span>h</span></div></label>}{equipment.control !== "HOURS" && <label>KM da troca<div className="reading-field"><input name="km" type="number" min="0" step="0.1" defaultValue={equipment.km} required/><span>km</span></div></label>}<label>Número da OS <small>(opcional)</small><input name="workOrder" placeholder="Gerado automaticamente se vazio"/></label><label>Custo total <small>(opcional)</small><input name="cost" type="number" min="0" step="0.01" defaultValue="0"/></label><label className="full">Observação<textarea name="notes" placeholder="Serviço executado, ocorrências ou peças utilizadas"/></label>{error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}<div className="transaction-note full"><span>✓</span><p>A manutenção, o histórico, o novo ciclo e os alertas serão gravados juntos. Se uma etapa falhar, toda a operação será desfeita.</p></div><button className="primary form-submit" disabled={busy}>{busy ? "Registrando..." : "Confirmar troca e iniciar novo ciclo"}</button></form> : <div className="empty-state"><h2>Nenhum plano configurado</h2><p>Abra a ficha de um equipamento ativo, entre em Plano de Manutenção e salve os intervalos antes de registrar uma troca.</p></div>}</article>{lastPdf && <div className="maintenance-pdf-ready"><div><strong>Comprovante disponível</strong><span>A manutenção foi salva. A exportação não altera nenhum dado.</span></div><button className="primary" onClick={() => window.open(`/api/maintenance-pdf?kind=MAINTENANCE&id=${lastPdf}`, "_blank", "noopener,noreferrer")}>⇩ EXPORTAR PDF</button></div>}</>; }

type ManualWhatsappShare = {
    mode: "MANUAL";
    alerts: Array<{ planId: number; prefix: string; maintenanceName: string; level: "WARNING" | "NEAR" | "OVERDUE"; status: string; message: string; }>;
    recipients: Array<{ id: number; name: string; phone: string; matchingPlanIds: number[]; }>;
};
function ManualWhatsappModal({ share, close }: { share: ManualWhatsappShare; close: () => void; }) {
    const [selectedRecipients, setSelectedRecipients] = useState<number[]>([]);
    const [opened, setOpened] = useState(0);
    const queue = useMemo(() => share.alerts.flatMap((alert) => share.recipients.filter((recipient) => selectedRecipients.includes(recipient.id) && recipient.matchingPlanIds.includes(alert.planId)).map((recipient) => ({ alert, recipient }))), [share, selectedRecipients]);
    const current = queue[opened];
    function toggle(id: number) { setOpened(0); setSelectedRecipients((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]); }
    function openWhatsapp() { if (!current)
        return; window.open(`https://wa.me/${current.recipient.phone}?text=${encodeURIComponent(current.alert.message)}`, "_blank", "noopener,noreferrer"); setOpened((value) => value + 1); }
    return <div className="modal-backdrop"><section className="modal manual-whatsapp-modal"><header><div><p>MODO MANUAL</p><h2>Enviar alerta para</h2><span>Escolha os destinatários. O sistema abrirá uma conversa por vez com a mensagem pronta.</span></div><button onClick={close}>×</button></header><div className="manual-whatsapp-layout"><section className="manual-recipient-picker"><h3>Destinatários cadastrados</h3>{share.recipients.map((recipient) => <label className={selectedRecipients.includes(recipient.id) ? "selected" : ""} key={recipient.id}><input type="checkbox" checked={selectedRecipients.includes(recipient.id)} onChange={() => toggle(recipient.id)}/><span className="wa-avatar">{recipient.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("")}</span><span><strong>{recipient.name}</strong><small>{recipient.phone} · {recipient.matchingPlanIds.length} alerta(s) compatível(is)</small></span><i>✓</i></label>)}<button className="manual-select-all" onClick={() => { setOpened(0); setSelectedRecipients(selectedRecipients.length === share.recipients.length ? [] : share.recipients.map((item) => item.id)); }}>{selectedRecipients.length === share.recipients.length ? "Limpar seleção" : "Selecionar todos"}</button></section><section className="manual-message-preview"><div><h3>Mensagem preparada</h3><span>{queue.length ? `${Math.min(opened + 1, queue.length)} de ${queue.length}` : `${share.alerts.length} alerta(s)`}</span></div>{current ? <><p><strong>{current.alert.prefix} · {current.alert.maintenanceName}</strong><small>Para {current.recipient.name}</small></p><pre>{current.alert.message}</pre></> : opened > 0 && queue.length > 0 ? <div className="manual-send-complete"><span>✓</span><strong>Fila concluída</strong><small>As conversas selecionadas foram abertas para confirmação manual.</small></div> : <div className="manual-send-empty"><span>◉</span><strong>Selecione pelo menos um destinatário</strong><small>Nenhuma mensagem será enviada automaticamente.</small></div>}</section></div><footer><p>{opened > 0 ? `${opened} conversa(s) aberta(s)` : "O envio só acontece após sua confirmação no WhatsApp."}</p><div><button className="secondary" onClick={close}>{opened >= queue.length && opened > 0 ? "Concluir" : "Cancelar"}</button>{current && <button className="primary" onClick={openWhatsapp}>◉ {opened === 0 ? `Abrir WhatsApp (1 de ${queue.length})` : `Próximo destinatário (${opened + 1} de ${queue.length})`}</button>}</div></footer></section></div>;
}
type AlertSettingsRecord = { alertaHorasVerde: number; alertaHorasAmareloInicio: number; alertaHorasAmareloFim: number; alertaHorasLaranjaInicio: number; alertaHorasLaranjaFim: number; alertaKmVerde: number; alertaKmAmareloInicio: number; alertaKmAmareloFim: number; alertaKmLaranjaInicio: number; alertaKmLaranjaFim: number; urgencyPercent: number; };
function UrgencySettingsModal({ close, saved }: { close: () => void; saved: (message: string) => Promise<void>; }) {
    const [settings, setSettings] = useState<AlertSettingsRecord | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => { fetchJson<AlertSettingsRecord>("/api/alert-settings").then(setSettings).catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar a configuração.")); }, []);
    async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!settings)
        return; setBusy(true); setError(""); const form = new FormData(event.currentTarget); try {
        await fetchJson("/api/alert-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, urgencyPercent: Number(form.get("urgencyPercent")) }) });
        await saved("Limite de urgência atualizado e alertas recalculados.");
    }
    catch (problem) {
        setError(problem instanceof Error ? problem.message : "Não foi possível salvar a configuração.");
    }
    finally {
        setBusy(false);
    } }
    return <div className="modal-backdrop"><section className="modal urgency-settings-modal"><header><div><p>REGRA CENTRALIZADA</p><h2>Limite para status Urgente</h2><span>Urgente só é aplicado depois do vencimento crítico.</span></div><button onClick={close}>×</button></header>{settings ? <form onSubmit={submit}><label>Percentual do intervalo após o vencimento<div className="urgency-percent-field"><input name="urgencyPercent" type="number" min="1" max="100" step="1" defaultValue={settings.urgencyPercent} required/><span>%</span></div></label><div className="urgency-example"><strong>Exemplo com intervalo de 250 h</strong><span>Com 20%, fica Vencido até 50 h de atraso e passa para Urgente somente acima de 50 h.</span></div>{error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}<footer><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Recalculando..." : "Salvar e recalcular"}</button></footer></form> : <div className="page-loading"><span/><p>{error || "Carregando configuração..."}</p></div>}</section></div>;
}
function AlertsView({ data, authUser, flash, openEquipment, refresh }: {
    data: SystemData;
    authUser: AuthUser;
    flash: (message: string) => void;
    openEquipment: (id: number) => void;
    refresh: () => Promise<void>;
}) {
    const [filter, setFilter] = useState("TODOS");
    const [frontFilter, setFrontFilter] = useState("TODAS");
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
    const [equipmentFilter, setEquipmentFilter] = useState("TODOS");
    const [equipmentQuery, setEquipmentQuery] = useState("");
    const [equipmentSearchOpen, setEquipmentSearchOpen] = useState(false);
    const [activeEquipmentResult, setActiveEquipmentResult] = useState(0);
    const [selected, setSelected] = useState<number[]>([]);
    const [sending, setSending] = useState(false);
    const [manualShare, setManualShare] = useState<ManualWhatsappShare | null>(null);
    const [urgencyOpen, setUrgencyOpen] = useState(false);
    const allowed = can(authUser, "whatsapp.send");
    const categories = useMemo(() => equipmentCategories(data), [data]);
    const fronts = useMemo(() => [...new Set(data.equipment.map((item) => item.front))].sort((a, b) => a.localeCompare(b, "pt-BR")), [data.equipment]);
    const availableEquipment = useMemo(() => data.equipment.filter((item) => (frontFilter === "TODAS" || item.front === frontFilter) && (selectedCategories.length === 0 || selectedCategories.includes(item.type))), [data.equipment, frontFilter, selectedCategories]);
    const normalizedEquipmentQuery = maintenanceEquipmentSearchKey(equipmentQuery);
    const equipmentResults = useMemo(() => {
        const candidates = normalizedEquipmentQuery ? availableEquipment.filter((item) => maintenanceEquipmentSearchKey([item.prefix, item.code, item.brand, item.model, item.type, item.plate, item.front].filter(Boolean).join(" ")).includes(normalizedEquipmentQuery)) : availableEquipment;
        return candidates.sort((a, b) => a.prefix.localeCompare(b.prefix, "pt-BR", { numeric: true, sensitivity: "base" })).slice(0, 30);
    }, [availableEquipment, normalizedEquipmentQuery]);
    const selectedEquipment = equipmentFilter === "TODOS" ? null : data.equipment.find((item) => item.id === Number(equipmentFilter)) ?? null;
    const categoryFilteredPlans = data.alerts.filter((plan) => (frontFilter === "TODAS" || plan.front === frontFilter) && (selectedCategories.length === 0 || selectedCategories.includes(plan.equipmentCategory)) && (equipmentFilter === "TODOS" || plan.equipmentId === Number(equipmentFilter)));
    const unitFilteredPlans = categoryFilteredPlans.filter((plan) => filter !== "HOURS" && filter !== "KM" || filter === plan.state.unit);
    const plans = unitFilteredPlans.filter((plan) => !["OK", "WARNING", "NEAR", "OVERDUE"].includes(filter) || filter === plan.state.level);
    const overdueCount = unitFilteredPlans.filter((plan) => plan.state.level === "OVERDUE" || plan.state.level === "NEAR").length;
    const nearCount = unitFilteredPlans.filter((plan) => plan.state.level === "WARNING").length;
    const filteredStatusCounts = {
        normal: plans.filter((plan) => plan.state.level === "OK").length,
        attention: plans.filter((plan) => plan.state.level === "WARNING").length,
        urgent: plans.filter((plan) => plan.state.level === "NEAR").length,
        overdue: plans.filter((plan) => plan.state.level === "OVERDUE").length,
    };
    useEffect(() => {
        if (selectedEquipment && !availableEquipment.some((item) => item.id === selectedEquipment.id)) {
            setEquipmentFilter("TODOS");
            setEquipmentQuery("");
        }
    }, [availableEquipment, selectedEquipment]);
    useEffect(() => { setSelected([]); }, [filter, frontFilter, selectedCategories, equipmentFilter]);
    const eligible = (plan: AlertPlan) => plan.state.level === "WARNING" || plan.state.level === "NEAR" || plan.state.level === "OVERDUE";
    function toggle(id: number) { setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
    function selectAlertEquipment(item: Equipment | null) {
        setEquipmentFilter(item ? String(item.id) : "TODOS");
        setEquipmentQuery(item ? `${item.prefix} · ${item.brand} ${item.model}` : "");
        setEquipmentSearchOpen(false);
        setActiveEquipmentResult(0);
    }
    function handleAlertEquipmentSearchKey(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Escape") { setEquipmentSearchOpen(false); return; }
        if (!equipmentSearchOpen) setEquipmentSearchOpen(true);
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveEquipmentResult((current) => Math.min(current + 1, Math.max(0, equipmentResults.length - 1))); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveEquipmentResult((current) => Math.max(0, current - 1)); }
        if (event.key === "Enter" && equipmentResults[activeEquipmentResult]) { event.preventDefault(); selectAlertEquipment(equipmentResults[activeEquipmentResult]); }
    }
    function exportReport(forcedStatuses?: Array<"OK" | "WARNING" | "NEAR" | "OVERDUE">) {
        const params = new URLSearchParams(); appendReportValues(params, "category", selectedCategories);
        if (frontFilter !== "TODAS") params.append("front", frontFilter);
        if (equipmentFilter !== "TODOS") params.append("equipment", equipmentFilter);
        if (filter === "HOURS" || filter === "KM") params.append("unit", filter);
        if (forcedStatuses) appendReportValues(params, "status", forcedStatuses); else if (["OK", "WARNING", "NEAR", "OVERDUE"].includes(filter)) params.append("status", filter);
        openReportPdf("/api/alerts-report-pdf", params);
    }
    async function send(planIds: number[]) {
        const targets = data.alerts.filter((plan) => planIds.includes(plan.id) && eligible(plan));
        if (!targets.length)
            return;
        setSending(true);
        try {
            const result = await fetchJson<ManualWhatsappShare | { mode: "API"; message: string }>("/api/whatsapp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "START_SEND", planIds }) });
            setSelected([]);
            if (result.mode === "MANUAL")
                setManualShare(result);
            else
                flash(result.message);
        }
        catch (problem) {
            flash(problem instanceof Error ? problem.message : "Não foi possível enviar os alertas.");
        }
        finally {
            setSending(false);
        }
    }
    return <><ModuleHeader eyebrow="PRIORIDADES DA OPERAÇÃO" title="Central de alertas" subtitle="Situações calculadas no backend a partir da leitura atual, última troca e intervalo."/><div className="alert-summary unit-summary"><Metric icon="✓" value={filteredStatusCounts.normal} label="Normais" detail="Fora da faixa de atenção" tone="green"/><Metric icon="!" value={filteredStatusCounts.attention} label="Atenção" detail="Aproximando do limite" tone="amber"/><Metric icon="◷" value={filteredStatusCounts.urgent} label="Urgentes" detail="Atraso crítico" tone="amber"/><Metric icon="!" value={filteredStatusCounts.overdue} label="Vencidas" detail="Limite ultrapassado" tone="red"/></div><article className="panel module-panel"><div className="report-filter-bar"><label>Frente<select value={frontFilter} onChange={(event) => setFrontFilter(event.target.value)}><option value="TODAS">Todas as frentes</option>{fronts.map((front) => <option key={front}>{front}</option>)}</select></label><CategoryReportFilter categories={categories} selected={selectedCategories} onChange={setSelectedCategories}/><div className="alert-equipment-combobox"><label htmlFor="alert-equipment-search">Equipamento</label><div className="alert-equipment-search-control"><span aria-hidden="true">⌕</span><input id="alert-equipment-search" value={equipmentQuery} role="combobox" aria-autocomplete="list" aria-controls="alert-equipment-results" aria-expanded={equipmentSearchOpen} aria-activedescendant={equipmentSearchOpen && equipmentResults[activeEquipmentResult] ? `alert-equipment-${equipmentResults[activeEquipmentResult].id}` : undefined} autoComplete="off" placeholder="Todos os equipamentos" onFocus={(event) => { setEquipmentSearchOpen(true); event.currentTarget.select(); }} onBlur={() => window.setTimeout(() => setEquipmentSearchOpen(false), 120)} onChange={(event) => { setEquipmentQuery(event.target.value); setEquipmentFilter("TODOS"); setEquipmentSearchOpen(true); setActiveEquipmentResult(0); }} onKeyDown={handleAlertEquipmentSearchKey}/>{equipmentQuery && <button type="button" aria-label="Limpar equipamento" onMouseDown={(event) => event.preventDefault()} onClick={() => selectAlertEquipment(null)}>×</button>}</div>{equipmentSearchOpen && <div className="alert-equipment-results" id="alert-equipment-results" role="listbox"><button type="button" className={!selectedEquipment && !equipmentQuery ? "selected" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => selectAlertEquipment(null)}><span className="equipment-avatar">∞</span><span><strong>Todos os equipamentos</strong><small>Remover o filtro de equipamento</small></span></button>{equipmentResults.map((item, index) => <button type="button" role="option" aria-selected={item.id === selectedEquipment?.id} id={`alert-equipment-${item.id}`} className={index === activeEquipmentResult ? "active" : ""} key={item.id} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveEquipmentResult(index)} onClick={() => selectAlertEquipment(item)}><span className="equipment-avatar">{item.prefix.slice(0, 2)}</span><span><strong>{item.prefix} · {item.brand} {item.model}</strong><small>{[item.code && `Código ${item.code}`, item.type, item.plate && `Placa ${item.plate}`, item.front && `Frente ${item.front}`].filter(Boolean).join(" · ")}</small></span></button>)}{equipmentResults.length === 0 && <div className="alert-equipment-empty"><strong>Nenhum equipamento encontrado</strong><small>Tente outro prefixo, nome, marca, modelo ou descrição.</small></div>}</div>}<small className="alert-equipment-selection">{selectedEquipment ? `Filtrando por ${selectedEquipment.prefix} · ${selectedEquipment.brand} ${selectedEquipment.model}` : `${availableEquipment.length} equipamento(s) disponível(is)`}</small></div>{can(authUser, "alerts.settings") && <button type="button" className="alert-settings-action" onClick={() => setUrgencyOpen(true)}>⚙ LIMITE URGENTE</button>}</div><div className="filter-strip wa-alert-filter"><div className="filter-chips">{[["TODOS", "Todos"], ["HOURS", "Horas"], ["KM", "KM"], ["WARNING", "Próxima troca"], ["NEAR", "Urgente"], ["OVERDUE", "Vencido"]].map(([key, label]) => <button key={key} className={filter === key ? "selected" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="wa-selection-actions"><span>{plans.length} planos</span><button className="report-pdf-action" disabled={plans.length === 0} onClick={() => exportReport()}>⇩ EXPORTAR PDF</button><button className="near-pdf-action" disabled={nearCount === 0} onClick={() => exportReport(["WARNING"])}>⇩ PERTO DE VENCER ({nearCount})</button><button className="overdue-pdf-action" disabled={overdueCount === 0} onClick={() => exportReport(["OVERDUE", "NEAR"])}>⇩ VENCIDOS ({overdueCount})</button>{allowed && selected.length > 0 && <button className="primary small" disabled={sending} onClick={() => send(selected)}>◉ {sending ? "Enviando..." : `Enviar selecionados (${selected.length})`}</button>}</div></div><div className="alerts-list grouped-alerts">{plans.map((plan) => <article className={`alert-row grouped ${plan.state.tone}`} key={`${plan.equipmentId}-${plan.id}`}>{allowed && eligible(plan) && <label className="wa-alert-select" title="Selecionar para enviar"><input type="checkbox" checked={selected.includes(plan.id)} onChange={() => toggle(plan.id)}/><span>✓</span></label>}<div className="level-icon">{plan.state.level === "OK" ? "✓" : "!"}</div><div className="alert-copy"><div className="alert-title-line"><StatusPill state={plan.state}/><b className={`unit-badge ${plan.state.unit.toLowerCase()}`}>{plan.state.unit === "KM" ? "QUILOMETRAGEM" : "HORÍMETRO"}</b></div><strong>{plan.prefix} · {plan.equipment}</strong><small className="alert-front-inline">{plan.equipmentCategory} · {plan.name} · Frente {plan.front}</small><p>Atual: <b>{formatNumber(plan.state.currentValue)} {plan.state.unitLabel}</b> · Próxima: <b>{formatNumber(plan.state.nextValue)} {plan.state.unitLabel}</b> · <strong>{planBalanceText(plan.state)}</strong></p></div><div className="alert-actions">{allowed && eligible(plan) && <button className="wa-send-action" disabled={sending} onClick={() => send([plan.id])}>◉ Enviar WhatsApp</button>}<button className="secondary small" onClick={() => openEquipment(plan.equipmentId)}>Abrir ficha</button></div></article>)}</div>{plans.length === 0 && <div className="empty-state">Nenhum plano corresponde aos filtros.</div>}</article>{manualShare && <ManualWhatsappModal share={manualShare} close={() => setManualShare(null)}/>} {urgencyOpen && <UrgencySettingsModal close={() => setUrgencyOpen(false)} saved={async (message) => { setUrgencyOpen(false); await refresh(); flash(message); }}/>}</>;
}
function HistoryView({ data, authUser, refresh, flash, openEquipment }: {
    data: SystemData;
    authUser: AuthUser;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
    openEquipment: (id: number) => void;
}) {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState("TODOS");
    const [frontFilter, setFrontFilter] = useState("TODAS");
    const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
    const [equipmentFilter, setEquipmentFilter] = useState("TODOS");
    const [statusFilter, setStatusFilter] = useState("TODOS");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [editing, setEditing] = useState<HistoryItem | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const normalized = query.toLowerCase();
    const categories = useMemo(() => equipmentCategories(data), [data]);
    const fronts = useMemo(() => [...new Set(data.history.map((item) => item.front).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, "pt-BR")), [data.history]);
    const canEditItem = (item: HistoryItem) => item.kind === "READING" ? can(authUser, "meter.edit") : can(authUser, "maintenance.edit");
    const rows = data.history.filter((item) => (kind === "TODOS" || item.kind === kind) && (frontFilter === "TODAS" || item.front === frontFilter) && (selectedCategories.length === 0 || selectedCategories.includes(item.equipmentCategory)) && (equipmentFilter === "TODOS" || item.equipmentId === Number(equipmentFilter)) && (statusFilter === "TODOS" || item.currentStatus === statusFilter) && (!dateFrom || item.date.slice(0, 10) >= dateFrom) && (!dateTo || item.date.slice(0, 10) <= dateTo) && (!normalized || [item.prefix, item.equipmentCategory, item.action, item.category, item.service, item.responsible, item.workOrder].some((value) => value.toLowerCase().includes(normalized))));
    function exportReport() {
        const params = new URLSearchParams(); appendReportValues(params, "category", selectedCategories);
        if (frontFilter !== "TODAS") params.append("front", frontFilter);
        if (equipmentFilter !== "TODOS") params.append("equipment", equipmentFilter); if (statusFilter !== "TODOS") params.append("status", statusFilter); if (kind !== "TODOS") params.append("kind", kind);
        if (dateFrom) params.append("from", dateFrom); if (dateTo) params.append("to", dateTo); if (query.trim()) params.append("q", query.trim());
        openReportPdf("/api/history-report-pdf", params);
    }
    async function remove(item: HistoryItem) {
        const reading = item.kind === "READING";
        const description = reading ? `a atualização ${historyReading(item)}` : `a troca de ${item.service}`;
        if (!window.confirm(`Excluir ${description} do equipamento ${item.prefix}?\n\nA leitura atual, os planos e os alertas serão conferidos e recalculados após a exclusão.`))
            return;
        setDeleting(item.id);
        try {
            const result = await fetchJson<{
                message: string;
            }>(reading ? "/api/readings" : "/api/history", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.sourceId, kind: item.kind }) });
            await refresh();
            flash(result.message);
        }
        catch (problem) {
            flash(problem instanceof Error ? problem.message : "Não foi possível excluir o registro.");
        }
        finally {
            setDeleting(null);
        }
    }
    return <><ModuleHeader eyebrow="RASTREABILIDADE" title="Histórico completo" subtitle="Consulte, filtre e exporte os registros organizados pela categoria real de cada equipamento."/><article className="panel module-panel"><div className="toolbar page-search-toolbar"><label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar equipamento, ação, serviço, responsável ou OS..."/></label><select className="history-kind-filter" value={kind} onChange={(event) => setKind(event.target.value)}><option value="TODOS">Todas as ações</option><option value="READING">Leituras</option><option value="MAINTENANCE">Manutenções</option><option value="IMPORTED">Importados</option></select><button className="report-pdf-action history-report-export" disabled={rows.length === 0} onClick={exportReport}>⇩ EXPORTAR RELATÓRIO PDF ({rows.length})</button></div><div className="report-filter-bar history-report-filters"><label>Frente<select value={frontFilter} onChange={(event) => setFrontFilter(event.target.value)}><option value="TODAS">Todas as frentes</option>{fronts.map((front) => <option key={front}>{front}</option>)}</select></label><CategoryReportFilter categories={categories} selected={selectedCategories} onChange={setSelectedCategories}/><label>Equipamento<select value={equipmentFilter} onChange={(event) => setEquipmentFilter(event.target.value)}><option value="TODOS">Todos os equipamentos</option>{data.equipment.filter((item) => selectedCategories.length === 0 || selectedCategories.includes(item.type)).map((item) => <option key={item.id} value={item.id}>{item.prefix} · {item.type}</option>)}</select></label><label>Status atual<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="TODOS">Todos / sem status</option><option value="OK">Normal</option><option value="WARNING">Perto de vencer</option><option value="NEAR">Urgente</option><option value="OVERDUE">Vencido</option></select></label><label>Data inicial<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)}/></label><label>Data final<input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)}/></label></div><div className="table-scroll"><table className="history-table"><thead><tr><th>Data e hora</th><th>Equipamento</th><th>Ação</th><th>Item / Serviço</th><th>Nova leitura</th><th>Responsável</th><th>OS</th><th>Ações</th></tr></thead><tbody>{rows.slice(0, 1000).map((item) => <tr key={item.id}><td><span className="history-detail"><strong>{formatDate(item.date)}</strong><small>Registrado: {formatDate(item.recordedAt)}</small></span></td><td><span className="history-detail"><strong className="table-strong">{item.prefix}</strong><small>{item.equipmentCategory} · {item.front??"Frente não registrada"}</small></span></td><td><span className={`history-action ${item.kind.toLowerCase()}`}>{item.action}</span></td><td><span className="history-detail"><strong>{item.service}</strong>{item.kind !== "READING" && <small>{item.category} · Intervalo: {formatNumber(item.interval)} {item.unit === "KM" ? "km" : "h"} · Próxima: {formatNumber(item.nextReading)} {item.unit === "KM" ? "km" : "h"}</small>}</span></td><td><strong className="history-reading">{historyReading(item)}</strong></td><td>{item.responsible}</td><td><span className="os-pill">{item.workOrder}</span></td><td><div className="history-row-actions">{item.kind !== "READING" && <button className="history-pdf-action" onClick={() => exportMaintenancePdf(item)}>⇩ PDF individual</button>}{canEditItem(item) && <><button className="history-edit-action" onClick={() => setEditing(item)}>✎ Editar</button><button className="history-delete-action" disabled={deleting === item.id} onClick={() => remove(item)}>{deleting === item.id ? "Excluindo..." : "Excluir"}</button></>}{item.equipmentId && <button className="row-action" title="Abrir equipamento" onClick={() => openEquipment(item.equipmentId!)}>›</button>}</div></td></tr>)}</tbody></table></div>{rows.length === 0 && <div className="empty-state">Nenhum registro corresponde aos filtros.</div>}</article>{editing && <HistoryEditModal item={editing} data={data} close={() => setEditing(null)} saved={async (message) => { setEditing(null); await refresh(); flash(message); }}/>}</>;
}
function HistoryEditModal({ item, data, close, saved }: {
    item: HistoryItem;
    data: SystemData;
    close: () => void;
    saved: (message: string) => Promise<void>;
}) {
    const inferredType = item.maintenanceTypeId ?? data.maintenanceTypes.find((type) => maintenanceServiceKey(type.name) === maintenanceServiceKey(item.service))?.id ?? 0;
    const [equipmentId, setEquipmentId] = useState(item.equipmentId ?? data.equipment.find((equipment) => equipment.prefix === item.prefix)?.id ?? 0);
    const [prefix, setPrefix] = useState(item.prefix);
    const [maintenanceTypeId, setMaintenanceTypeId] = useState(inferredType);
    const [unit, setUnit] = useState<"HOURS" | "KM">(item.unit);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const selectedEquipment = data.equipment.find((equipment) => equipment.id === equipmentId);
    async function submit(event: FormEvent<HTMLFormElement>, authorized = false) {
        event.preventDefault();
        setBusy(true);
        setError("");
        const form = new FormData(event.currentTarget);
        try {
            const reading = item.kind === "READING";
            const payload = reading ? { id: item.sourceId, readingDate: form.get("readingDate"), hours: form.get("hours"), km: form.get("km"), operator: form.get("operator"), notes: form.get("notes"), authorizeRegression: authorized } : { id: item.sourceId, kind: item.kind, equipmentId, prefix, maintenanceTypeId, performedAt: form.get("performedAt"), reading: form.get("reading"), unit, mechanic: form.get("mechanic"), workOrder: form.get("workOrder"), cost: form.get("cost"), notes: form.get("notes") };
            const result = await fetchJson<{
                message: string;
            }>(reading ? "/api/readings" : "/api/history", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            await saved(result.message);
        }
        catch (problem) {
            const typed = problem as Error & {
                data?: {
                    requiresConfirmation?: boolean;
                };
            };
            if (typed.data?.requiresConfirmation && window.confirm(`${typed.message}\n\nConfirmar como administrador?`)) {
                setBusy(false);
                return submit(event, true);
            }
            setError(typed.message || "Não foi possível editar o registro.");
        }
        finally {
            setBusy(false);
        }
    }
    const reading = item.kind === "READING";
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
        close(); }}><section className="modal history-edit-modal"><header><div><p className="eyebrow">CORREÇÃO DO HISTÓRICO</p><h2>{reading ? "Editar atualização de KM/horímetro" : "Editar troca de óleo"}</h2><span>{reading ? "A leitura atual será alterada somente se este registro ainda corresponder ao valor atual do equipamento." : "Ao salvar, a próxima troca, o restante, o status e os alertas serão recalculados."}</span></div><button onClick={close}>×</button></header><form className="modal-form" onSubmit={submit}>{reading ? <><div className="history-edit-context full"><span>Equipamento<strong>{selectedEquipment?.prefix ?? item.prefix}</strong></span><span>Controle<strong>{selectedEquipment?.control === "HOURS_KM" ? "HORAS E KM" : selectedEquipment?.control === "KM" ? "KM" : "HORAS"}</strong></span></div><label>Data e hora<input name="readingDate" type="datetime-local" required defaultValue={inputDateTime(item.date)}/></label>{selectedEquipment?.control !== "KM" && <label>Horímetro<div className="reading-field"><input name="hours" type="number" min="0" step="0.1" required defaultValue={item.hours ?? selectedEquipment?.hours ?? 0}/><span>h</span></div></label>}{selectedEquipment?.control !== "HOURS" && <label>Quilometragem<div className="reading-field"><input name="km" type="number" min="0" step="0.1" required defaultValue={item.km ?? selectedEquipment?.km ?? 0}/><span>km</span></div></label>}<label>Responsável<input name="operator" defaultValue={item.responsible}/></label><label className="full">Observações<textarea name="notes" defaultValue={item.notes ?? ""}/></label></> : <>{item.kind === "MAINTENANCE" ? <label className="full">Equipamento<select value={equipmentId} required onChange={(event) => setEquipmentId(Number(event.target.value))}><option value="">Selecione</option>{data.equipment.map((equipment) => <option key={equipment.id} value={equipment.id}>{equipment.prefix} · {equipment.brand} {equipment.model}</option>)}</select></label> : <label className="full">Prefixo do equipamento<input value={prefix} required list="history-equipment-prefixes" onChange={(event) => { const value = event.target.value.toUpperCase(); setPrefix(value); const equipment = data.equipment.find((candidate) => candidate.prefix === value); if (equipment && equipment.control !== "HOURS_KM")
        setUnit(equipment.control); }}/><datalist id="history-equipment-prefixes">{data.equipment.map((equipment) => <option key={equipment.id} value={equipment.prefix}/>)}</datalist></label>}<label className="full">Tipo de manutenção<select value={maintenanceTypeId} required onChange={(event) => setMaintenanceTypeId(Number(event.target.value))}><option value="">Selecione o serviço</option>{data.maintenanceTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>{item.kind === "IMPORTED" ? "Data e hora (opcional)" : "Data e hora"}<input name="performedAt" type="datetime-local" required={item.kind === "MAINTENANCE"} defaultValue={inputDateTime(item.date)}/></label><label>Leitura da troca<div className="reading-field"><input name="reading" type="number" min="0" step="0.1" required defaultValue={item.newReading ?? 0}/><span>{unit === "KM" ? "km" : "h"}</span></div></label>{item.kind === "IMPORTED" && <label className="full">Unidade<select value={unit} onChange={(event) => setUnit(event.target.value as "HOURS" | "KM")}><option value="HOURS">Horímetro (h)</option><option value="KM">Quilometragem (km)</option></select></label>}{item.kind === "MAINTENANCE" && <><div className="history-edit-context full"><span>Equipamento selecionado<strong>{selectedEquipment?.prefix ?? "—"}</strong></span><span>Unidade do registro<strong>{item.unit === "KM" ? "KM" : "HORAS"}</strong></span></div><label>Responsável<input name="mechanic" defaultValue={item.responsible}/></label><label>Número da OS<input name="workOrder" required defaultValue={item.workOrder}/></label><label>Custo total<input name="cost" type="number" min="0" step="0.01" defaultValue={item.cost}/></label><label className="full">Observações<textarea name="notes" defaultValue={item.notes ?? ""}/></label></>}</>} {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}<div className="history-recalculation-note full"><span>↻</span><p>{reading ? "Se esta for a leitura que controla o valor atual, a correção será aplicada ao equipamento e todos os alertas serão recalculados." : "A leitura atual do equipamento não será alterada. Somente o registro da troca e os cálculos derivados dele serão atualizados."}</p></div><div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando e recalculando..." : "Salvar alteração"}</button></div></form></section></div>;
}
function UsersView({ users, authUser, loadUsers, flash, openUserModal }: {
    users: UserRecord[];
    authUser: AuthUser;
    loadUsers: () => Promise<void>;
    flash: (message: string) => void;
    openUserModal: (item: UserRecord | "new") => void;
}) { async function toggle(user: UserRecord) { try {
    await fetchJson("/api/users", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...user, action: "UPDATE", status: user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }) });
    await loadUsers();
    flash(`Usuário ${user.status === "ACTIVE" ? "desativado" : "ativado"}.`);
}
catch (problem) {
    flash(problem instanceof Error ? problem.message : "Não foi possível alterar o usuário.");
} } return <><ModuleHeader eyebrow="ACESSO E SEGURANÇA" title="Usuários e permissões" subtitle="Este módulo permanece separado de Troca de Óleo." action={can(authUser, "users.create") ? "＋ Novo usuário" : undefined} onAction={() => openUserModal("new")}/><div className="user-summary"><article><strong>{users.length}</strong><span>Cadastrados</span></article><article><strong>{users.filter((user) => user.status === "ACTIVE").length}</strong><span>Ativos</span></article><article><strong>{users.filter((user) => user.profile === "ADMIN").length}</strong><span>Administradores</span></article><article><strong>{users.filter((user) => user.status === "INACTIVE").length}</strong><span>Inativos</span></article></div><article className="panel module-panel"><div className="table-scroll"><table className="users-table"><thead><tr><th>Nome</th><th>Usuário</th><th>E-mail</th><th>Frente</th><th>Perfil</th><th>Status</th><th>Último acesso</th><th>Ações</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><div className="user-name-cell"><span className="avatar light">{user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("")}</span><div><strong>{user.name}</strong>{user.isPrimaryAdmin && <small>Administrador principal</small>}</div></div></td><td>@{user.username}</td><td>{user.email}</td><td>{user.serviceFrontName ?? "Todas as frentes"}</td><td><span className="role-pill">{user.profileLabel}</span></td><td><span className={`status-pill ${user.status === "ACTIVE" ? "green" : "gray"}`}>{user.status === "ACTIVE" ? "Ativo" : "Inativo"}</span></td><td>{user.lastAccessAt ? formatDate(user.lastAccessAt) : "Nunca"}</td><td><div className="user-actions">{can(authUser, "users.edit") && (!user.isPrimaryAdmin || user.id === authUser.id) && <button onClick={() => openUserModal(user)}>Editar</button>}{can(authUser, "users.status") && !user.isPrimaryAdmin && user.id !== authUser.id && <button className={user.status === "ACTIVE" ? "danger-action" : "activate-action"} onClick={() => toggle(user)}>{user.status === "ACTIVE" ? "Desativar" : "Ativar"}</button>}</div></td></tr>)}</tbody></table></div></article></>; }
function EquipmentSheet({ equipment, authUser, close, refresh, flash }: {
    equipment: Equipment;
    authUser: AuthUser;
    close: () => void;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
}) { const [tab, setTab] = useState<"summary" | "plan" | "history" | "alerts">("summary"); return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
    close(); }}><section className="equipment-sheet"><header className="sheet-header"><div className="sheet-identity"><span className="equipment-avatar sheet-avatar">{equipment.prefix.slice(0, 2)}</span><div><p>{equipment.type.toUpperCase()}</p><h2>{equipment.prefix} · {equipment.brand} {equipment.model}</h2><span>ID {equipment.id} · {equipment.front} · Dados persistentes</span></div></div><button className="sheet-close" onClick={close}>×</button></header><div className="sheet-actions"><div><span className={`status-pill ${equipment.status === "Ativo" ? "green" : "gray"}`}>{equipment.status}</span><strong>{equipment.reading}</strong><small>Leitura atual</small></div></div><nav className="sheet-tabs"><button className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>Dados gerais</button><button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>Plano de Manutenção <b>{equipment.plans.length}</b></button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Histórico</button><button className={tab === "alerts" ? "active" : ""} onClick={() => setTab("alerts")}>Alertas</button></nav><div className="sheet-content">{tab === "summary" && <><div className="sheet-summary-grid"><article className="sheet-card equipment-data"><div className="sheet-card-head"><h3>Dados do equipamento</h3><span>▣</span></div><dl><div><dt>ID interno</dt><dd>{equipment.id}</dd></div><div><dt>Prefixo</dt><dd>{equipment.prefix}</dd></div><div><dt>Tipo</dt><dd>{equipment.type}</dd></div><div><dt>Marca / Modelo</dt><dd>{equipment.brand} {equipment.model}</dd></div><div><dt>Placa</dt><dd>{equipment.plate ?? "—"}</dd></div><div><dt>Frente</dt><dd>{equipment.front}</dd></div><div className="wide"><dt>{equipment.identificationType === "CHASSIS" ? "Chassi" : "Número de série"}</dt><dd>{equipment.identificationValue ?? "—"}</dd></div></dl></article><article className="sheet-card health-overview"><div className="sheet-card-head"><h3>Saúde preventiva</h3><span>◉</span></div><div className="health-score"><strong>{equipment.health === null ? "—" : `${equipment.health}%`}</strong><span>{equipment.situation}</span></div><div className={`health-line large ${equipment.tone}`}><i><em style={{ width: `${equipment.health ?? 0}%` }}/></i></div><div className="health-counts"><span><b>{equipment.plans.filter((plan) => plan.state.level === "OK").length}</b>Normais</span><span><b>{equipment.plans.filter((plan) => plan.state.level !== "OK").length}</b>Requerem atenção</span><span><b>{equipment.plans.length}</b>Planos</span></div></article></div><article className="sheet-card applicable-summary"><div className="sheet-card-head"><div><h3>Itens aplicáveis</h3><p>Somente estes itens podem compor os planos deste equipamento.</p></div></div><div>{equipment.applicableMaintenanceTypes.map((type) => <span key={type.id}>✓ {type.name}</span>)}</div></article></>}{tab === "plan" && <PlanEditor equipment={equipment} editable={can(authUser, "equipment.edit_plan")} refresh={refresh} flash={flash}/>} {tab === "history" && <EquipmentHistory equipmentId={equipment.id}/>} {tab === "alerts" && <article className="sheet-card"><div className="sheet-card-head"><h3>Alertas do equipamento</h3></div>{equipment.plans.filter((plan) => plan.state.configured).map((plan) => <div className={`sheet-alert ${plan.state.tone}`} key={plan.id}><span>{plan.state.level === "OK" ? "✓" : "!"}</span><div><strong>{plan.name}</strong><small>{planBalanceText(plan.state)} · Próxima: {formatNumber(plan.state.nextValue)} {plan.state.unitLabel}</small></div><StatusPill state={plan.state}/></div>)}{equipment.plans.length === 0 && <div className="empty-state">Salve o Plano de Manutenção para gerar alertas.</div>}</article>}</div></section></div>; }
function EquipmentHistory({ equipmentId }: {
    equipmentId: number;
}) { const [data, setData] = useState<SystemData | null>(null); useEffect(() => { fetchJson<SystemData>("/api/system").then(setData).catch(() => undefined); }, []); const rows = data?.history.filter((item) => item.equipmentId === equipmentId) ?? []; return <article className="sheet-card"><div className="sheet-card-head"><h3>Histórico permanente</h3></div><div className="table-scroll"><table><thead><tr><th>Data</th><th>Ação</th><th>Serviço</th><th>Leitura</th><th>Usuário</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td>{formatDate(item.date)}</td><td>{item.action}</td><td>{item.service}</td><td>{formatNumber(item.newReading)} {item.unit === "KM" ? "km" : "h"}</td><td>{item.responsible}</td></tr>)}</tbody></table></div>{rows.length === 0 && <div className="empty-state">Nenhum registro para este equipamento.</div>}</article>; }
function PlanEditor({ equipment, editable, refresh, flash }: {
    equipment: Equipment;
    editable: boolean;
    refresh: () => Promise<void>;
    flash: (message: string) => void;
}) { const initial = useMemo(() => equipment.applicableMaintenanceTypes.map((type) => { const plan = equipment.plans.find((item) => item.maintenanceTypeId === type.id); const mode = plan?.triggerMode ?? (equipment.control === "KM" ? "KM" : "HOURS"); return { maintenanceTypeId: type.id, name: type.name, triggerMode: mode, interval: plan?.state.interval === null || plan?.state.interval === undefined ? "" : String(plan.state.interval), plan }; }), [equipment]); const [rows, setRows] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); async function save() { setBusy(true); setError(""); try {
    await fetchJson("/api/plans", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ equipmentId: equipment.id, plans: rows.map((row) => ({ maintenanceTypeId: row.maintenanceTypeId, triggerMode: row.triggerMode, interval: Number(row.interval) })) }) });
    await refresh();
    flash(`Plano de ${equipment.prefix} salvo e alertas recalculados.`);
}
catch (problem) {
    setError(problem instanceof Error ? problem.message : "Não foi possível salvar o plano.");
}
finally {
    setBusy(false);
} } return <article className="sheet-card equipment-plan-card"><div className="equipment-plan-title"><div><p>PLANO DE MANUTENÇÃO</p><h3>Plano — {equipment.prefix}</h3><span>Cada item possui intervalo e ciclo independentes.</span></div>{editable && <button className="primary" disabled={busy} onClick={save}>{busy ? "Salvando..." : "Salvar plano"}</button>}</div><div className="equipment-plan-context"><div><span>Equipamento</span><strong>{equipment.prefix}</strong></div><div><span>Controle</span><strong>{equipment.control === "KM" ? "KM" : equipment.control === "HOURS" ? "Horas" : "Horas e KM"}</strong></div><div><span>Leitura atual</span><strong>{equipment.reading}</strong></div><div><span>Itens aplicáveis</span><strong>{rows.length}</strong></div></div><div className="table-scroll"><table className="plan-table editable-plan"><thead><tr><th>Item</th><th>Controlar por</th><th>Intervalo</th><th>Última troca</th><th>Próxima</th><th>Saldo</th><th>Status</th></tr></thead><tbody>{rows.map((row, index) => { const state = row.plan?.state; return <tr key={row.maintenanceTypeId}><td><strong className="table-strong">{row.name}</strong></td><td><select disabled={!editable || equipment.control !== "HOURS_KM"} value={row.triggerMode} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, triggerMode: event.target.value as "HOURS" | "KM", interval: event.target.value === "KM" ? "10000" : "500" } : item))}><option value="HOURS" disabled={equipment.control === "KM"}>Horas</option><option value="KM" disabled={equipment.control === "HOURS"}>Quilômetros</option></select></td><td><div className="inline-unit"><input disabled={!editable} type="number" min="0.1" step="0.1" value={row.interval} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, interval: event.target.value } : item))}/><span>{row.triggerMode === "KM" ? "km" : "h"}</span></div></td><td>{formatNumber(state?.lastValue)} {state?.unitLabel ?? (row.triggerMode === "KM" ? "km" : "h")}</td><td>{formatNumber(state?.nextValue)} {state?.unitLabel ?? (row.triggerMode === "KM" ? "km" : "h")}</td><td className={state?.level === "OVERDUE" || state?.level === "NEAR" ? "danger-text" : ""}>{state ? planBalanceText(state) : "—"}</td><td>{state ? <StatusPill state={state}/> : <span className="status-pill gray">Não salvo</span>}</td></tr>; })}</tbody></table></div>{error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}</article>; }
function EquipmentModal({ item, maintenanceTypes, authUser, close, saved }: {
    item: Equipment | null;
    maintenanceTypes: MaintenanceType[];
    authUser: AuthUser;
    close: () => void;
    saved: (message: string) => void;
}) { const [control, setControl] = useState<"HOURS" | "KM" | "HOURS_KM">(item?.control ?? "HOURS"); const [identification, setIdentification] = useState<"SERIAL_NUMBER" | "CHASSIS">(item?.identificationType ?? "SERIAL_NUMBER"); const [applicable, setApplicable] = useState<number[]>(item?.applicableMaintenanceTypes.map((type) => type.id) ?? []); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); const applicableNames = maintenanceTypes.filter((type) => applicable.includes(type.id)).map((type) => type.name); const payload = { ...Object.fromEntries(form.entries()), originalPrefix: item?.prefix, preservedSerialNumber: item?.serial, preservedChassis: item?.chassis, applicableMaintenanceTypes: applicableNames }; try {
    await fetchJson("/api/equipment", { method: item ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    saved(`${String(form.get("prefix")).toUpperCase()} ${item ? "atualizado" : "cadastrado"} com sucesso.`);
}
catch (problem) {
    setError(problem instanceof Error ? problem.message : "Não foi possível salvar o equipamento.");
}
finally {
    setBusy(false);
} } const status = item?.status === "Parado" ? "STOPPED" : item?.status === "Em manutenção" ? "MAINTENANCE" : item?.status === "Inativo" ? "INACTIVE" : "ACTIVE"; return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
    close(); }}><section className="modal equipment-modal"><header><div><p className="eyebrow">EQUIPAMENTO</p><h2>{item ? "Editar equipamento" : "Cadastrar equipamento"}</h2><span>Os vínculos internos utilizam o ID do banco, não apenas o prefixo.</span></div><button onClick={close}>×</button></header><form className="modal-form" onSubmit={submit}><label>Prefixo<input name="prefix" required defaultValue={item?.prefix}/></label><label>Tipo<input name="type" required defaultValue={item?.type}/></label><label>Marca<input name="brand" required defaultValue={item?.brand}/></label><label>Modelo<input name="model" required defaultValue={item?.model}/></label><label>Ano<input name="year" type="number" min="1950" max="2100" defaultValue={item?.year ?? ""}/></label><label>Placa<input name="plate" defaultValue={item?.plate ?? ""}/></label><label>Frente atual<input value={item?.front ?? "Sem frente definida"} readOnly/><small>Use a aba Equipamentos para transferir entre frentes.</small></label><label>Status<select name="status" defaultValue={status}><option value="ACTIVE">Ativo</option><option value="STOPPED">Parado</option><option value="MAINTENANCE">Em manutenção</option><option value="INACTIVE">Inativo</option></select></label><label>Identificação<select name="identificationType" value={identification} onChange={(event) => setIdentification(event.target.value as typeof identification)}><option value="SERIAL_NUMBER">Número de série</option><option value="CHASSIS">Chassi</option></select></label><label>{identification === "CHASSIS" ? "Chassi" : "Número de série"}<input name="identificationValue" required defaultValue={identification === "CHASSIS" ? item?.chassis ?? "" : item?.serial ?? ""}/></label><label className="full">Tipo de medição<select name="controlType" value={control} onChange={(event) => setControl(event.target.value as typeof control)}><option value="HOURS">Horímetro</option><option value="KM">Quilometragem</option><option value="HOURS_KM">Horímetro e quilometragem</option></select></label>{control !== "KM" && <label>Horímetro atual<input name="currentHours" type="number" min="0" step="0.1" required defaultValue={item?.hours ?? 0}/></label>}{control !== "HOURS" && <label>Quilometragem atual<input name="currentKm" type="number" min="0" step="0.1" required defaultValue={item?.km ?? 0}/></label>}<fieldset className="maintenance-selector full"><legend>ITENS APLICÁVEIS <span>{applicable.length} selecionados</span></legend><p>Itens desmarcados não geram plano nem alerta; o histórico anterior é preservado.</p><div>{maintenanceTypes.map((type) => <label className={applicable.includes(type.id) ? "checked" : ""} key={type.id}><input type="checkbox" disabled={Boolean(item) && !can(authUser, "equipment.applicable_types")} checked={applicable.includes(type.id)} onChange={(event) => setApplicable((current) => event.target.checked ? [...current, type.id] : current.filter((id) => id !== type.id))}/><span>{type.name}</span><i>✓</i></label>)}</div></fieldset><label className="full">Observações<textarea name="notes" defaultValue={item?.notes??""}/></label>{error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}<div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar equipamento"}</button></div></form></section></div>; }
function UserModal({ item, actor, fronts, close, saved }: {
    item: UserRecord | null;
    actor: AuthUser;
    fronts: ServiceFront[];
    close: () => void;
    saved: (message: string) => void;
}) { const baseProfile = (item?.profile === "ALMOXARIFADO" ? "OPERADOR" : item?.profile ?? "OPERADOR") as "ADMIN" | "GESTOR" | "OFICINA" | "OPERADOR"; const [profile, setProfile] = useState(baseProfile); const [permissions, setPermissions] = useState<Permission[]>(item?.permissions ?? profileDefaults[baseProfile]); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); const payload = { id: item?.id, action: "UPDATE", name: form.get("name"), username: form.get("username"), email: form.get("email"), password: item ? undefined : form.get("password"), profile, status: item?.status ?? "ACTIVE", serviceFrontId: form.get("serviceFrontId") || null, permissions }; try {
    await fetchJson("/api/users", { method: item ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    saved(item ? "Usuário atualizado com sucesso." : "Usuário criado com sucesso.");
}
catch (problem) {
    setError(problem instanceof Error ? problem.message : "Não foi possível salvar o usuário.");
}
finally {
    setBusy(false);
} } const assign = can(actor, "users.permissions") && !item?.isPrimaryAdmin && item?.id !== actor.id; return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget)
    close(); }}><section className="modal user-modal"><header><div><p className="eyebrow">ACESSO E SEGURANÇA</p><h2>{item ? "Editar usuário" : "Novo usuário"}</h2><span>Defina perfil e permissões validadas no servidor.</span></div><button onClick={close}>×</button></header><form className="modal-form user-form" onSubmit={submit}><label>Nome<input name="name" required defaultValue={item?.name}/></label><label>Usuário<input name="username" required defaultValue={item?.username}/></label><label className="full">E-mail<input name="email" type="email" required defaultValue={item?.email}/></label>{!item && <label className="full">Senha inicial<input name="password" type="password" minLength={10} required/></label>}<label>Perfil<select value={profile} disabled={!assign && Boolean(item)} onChange={(event) => { const next = event.target.value as typeof profile; setProfile(next); setPermissions(profileDefaults[next]); }}><option value="ADMIN">Administrador</option><option value="GESTOR">Gestor</option><option value="OFICINA">Manutenção / Oficina</option><option value="OPERADOR">Operador</option></select></label><label>Frente de serviço<select name="serviceFrontId" required={profile!=="ADMIN"} disabled={!assign&&Boolean(item)} defaultValue={item?.serviceFrontId??""}><option value="">{profile==="ADMIN"?"Todas as frentes":"Selecione a frente"}</option>{fronts.map((front)=><option key={front.id} value={front.id}>{front.name}</option>)}</select></label><div className="permission-groups full">{permissionGroups.map((group) => <fieldset key={group.label}><legend>{group.label}</legend>{group.items.map(([permission, label]) => <label className={permissions.includes(permission) ? "checked" : ""} key={permission}><input type="checkbox" disabled={!assign && Boolean(item)} checked={permissions.includes(permission)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, permission] : current.filter((key) => key !== permission))}/><span><b>{label}</b><small>{permissions.includes(permission) ? "Permitido" : "Bloqueado"}</small></span><i>{permissions.includes(permission) ? "✓" : ""}</i></label>)}</fieldset>)}</div>{error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}<div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar usuário"}</button></div></form></section></div>; }
