"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./stock-client";
import { STAGE_STATUS_LABELS, type FunctionGroup, type StageStatus } from "../lib/production-rules";

// Peças de tela compartilhadas pelas abas da PRODUÇÃO: tipos, estado na URL, filtro de frentes, selo de
// etapa e a busca de funcionário (com função, empresa e "mostrar todos").

export type ProductionAccess = { view: boolean; costs: boolean; launch: boolean; manage: boolean; admin: boolean };
export type ProductionFront = { id: number; name: string };
export type ProductionReason = { id: number; code: string; description: string; active: boolean };
export type ProductionContext = { access: ProductionAccess; fronts: ProductionFront[]; defaultFrontId: number | null; reasons: ProductionReason[] };
export type ProductionEmployee = { id: number; name: string; jobTitle: string; company: string; frontName: string };

export const number = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: digits }));
export const money = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
export const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const frontsQuery = (selected: number[]) => (selected.length ? `frentes=${selected.join(",")}` : "");

// ---------------------------------------------------------------------------
// Estado na URL (?tela=producao&aba=...&sub=...&frentes=1,2): o link pode ser compartilhado. Ao sair do
// módulo, os parâmetros são retirados para o próximo recarregamento não voltar para cá.
// ---------------------------------------------------------------------------
const URL_KEYS = ["tela", "aba", "sub", "frentes"] as const;
export function readProductionUrl() {
  if (typeof window === "undefined") return { aba: null, sub: null, frentes: null as string | null };
  const params = new URLSearchParams(window.location.search);
  return params.get("tela") === "producao" ? { aba: params.get("aba"), sub: params.get("sub"), frentes: params.get("frentes") } : { aba: null, sub: null, frentes: null };
}
export function writeProductionUrl(values: { aba: string; sub?: string | null; frentes: number[] }) {
  const params = new URLSearchParams(window.location.search);
  params.set("tela", "producao"); params.set("aba", values.aba);
  if (values.sub) params.set("sub", values.sub); else params.delete("sub");
  if (values.frentes.length) params.set("frentes", values.frentes.join(",")); else params.delete("frentes");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
}
export function clearProductionUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("tela") !== "producao") return;
  for (const key of URL_KEYS) params.delete(key);
  const rest = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
}

// Frentes escolhidas: guardadas por pessoa no navegador; na primeira vez, a frente do seletor global do topo.
const storageKey = (userId: number) => `jc-producao-frentes:${userId}`;
export function initialFronts(userId: number, fromUrl: string | null, visible: ProductionFront[]): number[] {
  const valid = (ids: number[]) => ids.filter((id) => visible.some((front) => front.id === id));
  const parse = (raw: string | null | undefined) => valid(String(raw ?? "").split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (fromUrl) return parse(fromUrl);
  try { const saved = window.localStorage.getItem(storageKey(userId)); if (saved !== null) return parse(saved); } catch { /* sem armazenamento */ }
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("jc_active_front="));
  const match = cookie ? /^(\d+):(\d+)$/.exec(decodeURIComponent(cookie.split("=")[1] ?? "")) : null;
  return match && Number(match[1]) === userId ? parse(match[2]) : [];
}
export function saveFronts(userId: number, selected: number[]) {
  try { window.localStorage.setItem(storageKey(userId), selected.join(",")); } catch { /* sem armazenamento */ }
}

// Card com uma caixa por frente + "Todas as frentes" (seleção vazia = todas).
export function FrontFilter({ fronts, selected, onChange }: { fronts: ProductionFront[]; selected: number[]; onChange: (ids: number[]) => void }) {
  if (fronts.length <= 1) return null;
  const all = selected.length === 0;
  const toggle = (id: number) => {
    const base = all ? [] : selected;
    const next = base.includes(id) ? base.filter((item) => item !== id) : [...base, id];
    onChange(next.length === fronts.length ? [] : next);
  };
  return <div className="panel production-fronts" role="group" aria-label="Frentes em exibição na Produção">
    <strong>Frentes</strong>
    <label className={all ? "checked" : ""}><input type="checkbox" checked={all} onChange={() => onChange([])} /> Todas as frentes</label>
    {fronts.map((front) => <label key={front.id} className={!all && selected.includes(front.id) ? "checked" : ""}>
      <input type="checkbox" checked={!all && selected.includes(front.id)} onChange={() => toggle(front.id)} /> {front.name}
    </label>)}
  </div>;
}
export function frontsTitle(fronts: ProductionFront[], selected: number[]) {
  if (selected.length === 0 || selected.length === fronts.length) return "Todas as frentes";
  return fronts.filter((front) => selected.includes(front.id)).map((front) => front.name).join(", ");
}

// Período das consultas (?de&ate&projeto): por padrão do dia 1º do mês até hoje.
export type Period = { de: string; ate: string; projeto: string };
export const monthPeriod = (): Period => { const today = localToday(); return { de: `${today.slice(0, 7)}-01`, ate: today, projeto: "" }; };
export const periodQuery = (period: Period, selectedFronts: number[], extra: Record<string, string | null | undefined> = {}) => {
  const params = new URLSearchParams({ de: period.de, ate: period.ate });
  if (period.projeto) params.set("projeto", period.projeto);
  if (selectedFronts.length) params.set("frentes", selectedFronts.join(","));
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return params.toString();
};
export function PeriodFilter({ value, onChange, projects, children }: { value: Period; onChange: (period: Period) => void; projects?: Array<{ id: number; name: string; frontName: string }>; children?: ReactNode }) {
  return <div className="production-period">
    <label>De<input type="date" value={value.de} onChange={(event) => event.target.value && onChange({ ...value, de: event.target.value })} /></label>
    <label>Até<input type="date" value={value.ate} onChange={(event) => event.target.value && onChange({ ...value, ate: event.target.value })} /></label>
    {projects && <label>Projeto<select value={value.projeto} onChange={(event) => onChange({ ...value, projeto: event.target.value })}>
      <option value="">Todos os projetos</option>
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.frontName}</option>)}
    </select></label>}
    {children}
  </div>;
}

export function Modal({ title, subtitle, close, busy, children, wide }: { title: string; subtitle?: string; close: () => void; busy?: boolean; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section className={`modal production-modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
      <header><div><p className="eyebrow">PRODUÇÃO</p><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      {children}
    </section>
  </div>;
}

export function StageBadge({ status }: { status: StageStatus }) {
  const tone = status === "FINALIZADO" ? "done" : status === "EM_ANDAMENTO" ? "running" : "none";
  return <span className={`production-badge ${tone}`}>{STAGE_STATUS_LABELS[status]}</span>;
}

// Busca de funcionário: por padrão só a função do campo (ex.: operador de skidder); "mostrar todos" serve
// para quando a função no cadastro está desatualizada. Desligados não aparecem.
// compact: dentro da grade do lançamento (só nome e empresa); endpoint: o apontador de campo usa /api/producao/campo/funcionarios.
export function ProductionEmployeePicker({ value, onPick, frontId, group, placeholder, disabled, compact, endpoint = "/api/producao/funcionarios", invalid }: {
  value: ProductionEmployee | null; onPick: (employee: ProductionEmployee | null) => void; frontId: number | null; group: FunctionGroup | null; placeholder?: string; disabled?: boolean;
  compact?: boolean; endpoint?: string; invalid?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(group === null);
  const [options, setOptions] = useState<ProductionEmployee[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (frontId) params.set("frente", String(frontId));
    if (group) params.set("funcao", group);
    if (all) params.set("todos", "1");
    if (!query.trim() && !frontId) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<{ employees: ProductionEmployee[] }>(`${endpoint}?${params.toString()}`).then((result) => setOptions(result.employees)).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId, group, all, open, endpoint]);
  if (value && compact) return <div className="production-person-chip"><span><b>{value.name}</b><small>{value.company}</small></span>
    {!disabled && <button type="button" aria-label={`Tirar ${value.name}`} onClick={(event) => { event.preventDefault(); onPick(null); }}>✕</button>}</div>;
  if (value) return <div className="material-product-chip"><strong>{value.name}</strong><small>{value.jobTitle} · {value.company} · {value.frontName}</small>
    {!disabled && <button type="button" onClick={(event) => { event.preventDefault(); onPick(null); }}>Trocar</button>}</div>;
  return <div className={`material-product-picker production-employee-picker${compact ? " compact" : ""}${invalid ? " invalid" : ""}`}>
    <input value={query} disabled={disabled} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} placeholder={placeholder ?? "Buscar funcionário pelo nome..."} />
    {group && <label className="production-show-all"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} /> mostrar todos os funcionários</label>}
    {open && options.length > 0 && <ul>{options.map((option) => (
      <li key={option.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); onPick(option); setQuery(""); setOpen(false); }}>
        <b>{option.name}</b><small> · {option.jobTitle} · {option.company} · {option.frontName}</small>
      </button></li>
    ))}</ul>}
    {open && (query.trim().length >= 2) && options.length === 0 && <p className="material-product-empty">Nenhum funcionário encontrado{group && !all ? " com esta função. Marque “mostrar todos”" : ""}.</p>}
  </div>;
}
