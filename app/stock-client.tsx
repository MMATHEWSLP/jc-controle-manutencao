"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from "react";

// Peças de tela compartilhadas pelos módulos que lançam estoque (Movimentação, Ordem de Serviço e
// Solicitação de Pedidos): chamada à API, busca de produto com saldo, funcionário e equipamento.

export class ApiError extends Error { constructor(message: string, public status: number, public data: Record<string, unknown>) { super(message); } }

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(String(data.error ?? "A operação não pôde ser concluída."), response.status, data);
  return data as T;
}
export const jsonBody = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const problemText = (problem: unknown, fallback: string) => (problem instanceof Error ? problem.message : fallback);

export const qtyFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });
export const moneyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const brDay = (value: string | null | undefined) => (value ? value.slice(0, 10).split("-").reverse().join("/") : "—");
export const brDateTime = (value: string | null | undefined) => (value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—");
export function localToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export const parseQty = (value: string) => { const parsed = Number(value.replace(",", ".")); return Number.isFinite(parsed) ? parsed : NaN; };

export type Front = { id: number; name: string };
export type EquipmentOption = { id: number; prefix: string; description: string; serviceFrontId: number | null; front: string | null; meterUnit: "HOURS" | "KM"; currentReading: number };
export type StockOptions = { fronts: Front[]; defaultFrontId: number | null; equipment: EquipmentOption[] };
export type ProductOption = { id: number; tag: string; name: string; reference: string | null; references: string[]; price?: number; brand?: string | null; supplierId?: number | null; balance?: number | null };
export type EmployeeOption = { id: number; name: string; jobTitle: string; company: string; frontName: string };
export type Shortage = { productId: number; label: string; requested: number; available: number };

// Busca de produto ÚNICA do sistema (Ordem de Serviço, Solicitação de Materiais, Solicitação de
// Pedidos, Movimentação...): mesma dupla de lupas do módulo Produtos — busca ampla (TAG, nome ou
// referência) e "# TAG exata" (só o produto cuja TAG é idêntica). Mostra o saldo na frente informada
// quando o endpoint devolve. `endpoint` muda só a rota (cada módulo confere as próprias permissões).
export function ProductPicker({ value, frontId, onPick, placeholder, endpoint = "/api/stock/products" }: { value: ProductOption | null; frontId: number | null; onPick: (product: ProductOption | null) => void; placeholder?: string; endpoint?: string }) {
  const [query, setQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [options, setOptions] = useState<ProductOption[]>([]);
  const [open, setOpen] = useState(false);
  const exact = tagQuery.trim();
  const broad = query.trim();
  useEffect(() => {
    if (!exact && broad.length < 2) { setOptions([]); return; }
    const params = new URLSearchParams(exact ? { tag: exact } : { q: broad });
    if (frontId) params.set("frente", String(frontId));
    const timer = window.setTimeout(() => {
      api<{ products: ProductOption[] }>(`${endpoint}?${params.toString()}`)
        .then((result) => { setOptions(result.products); setOpen(true); }).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [exact, broad, frontId, endpoint]);
  const pick = (option: ProductOption) => { onPick(option); setQuery(""); setTagQuery(""); setOpen(false); };
  if (value) return (
    <div className="material-product-chip">
      <span className="material-item-kind linked">{value.tag}</span><strong>{value.name}</strong>
      {typeof value.balance === "number" && <small>Saldo: {qtyFormat.format(value.balance)}</small>}
      <button type="button" onClick={() => onPick(null)}>Trocar</button>
    </div>
  );
  return (
    <div className="material-product-picker product-picker-two-search">
      <div className="product-picker-inputs">
        <label className="page-search" title="Busca ampla: TAG, nome ou referência (aproximada)"><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value) setTagQuery(""); }} onFocus={() => setOpen(true)} placeholder={placeholder ?? "Buscar por TAG, nome ou referência..."} /></label>
        <label className="page-search products-tag-search" title="Somente o produto com esta TAG exata (sem correspondências parciais)"><span>#</span><input value={tagQuery} onChange={(event) => { setTagQuery(event.target.value); if (event.target.value) setQuery(""); }} onFocus={() => setOpen(true)} placeholder="TAG exata" inputMode="numeric" aria-label="Buscar por TAG exata" /></label>
      </div>
      {open && options.length > 0 && <ul>{options.map((option) => (
        <li key={option.id}><button type="button" onClick={() => pick(option)}>
          <b>{option.tag}</b> {option.name}{option.references.length > 0 && <small> · Ref. {option.references.join(", ")}</small>}{typeof option.balance === "number" && <small> · Saldo {qtyFormat.format(option.balance)}</small>}
        </button></li>
      ))}</ul>}
      {open && (exact || broad.length >= 2) && options.length === 0 && <p className="material-product-empty">{exact ? `Nenhum produto com a TAG exata "${exact}".` : "Nenhum produto encontrado."}</p>}
    </div>
  );
}

export function EmployeePicker({ value, frontId, onPick, placeholder }: { value: EmployeeOption | null; frontId: number | null; onPick: (employee: EmployeeOption | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EmployeeOption[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) { setOptions([]); return; }
    const timer = window.setTimeout(() => {
      api<{ employees: EmployeeOption[] }>(`/api/employees/lookup?q=${encodeURIComponent(query.trim())}${frontId ? `&serviceFrontId=${frontId}` : ""}`)
        .then((result) => { setOptions(result.employees); setOpen(true); }).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId]);
  if (value) return (
    <div className="material-product-chip"><strong>{value.name}</strong><small>{value.jobTitle} · {value.frontName}</small><button type="button" onClick={() => onPick(null)}>Trocar</button></div>
  );
  return (
    <div className="material-product-picker">
      <input value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setOpen(true)} placeholder={placeholder ?? "Buscar funcionário pelo nome..."} />
      {open && options.length > 0 && <ul>{options.map((option) => (
        <li key={option.id}><button type="button" onClick={() => { onPick(option); setQuery(""); setOpen(false); }}><b>{option.name}</b><small> · {option.jobTitle} · {option.frontName}</small></button></li>
      ))}</ul>}
      {open && query.trim().length >= 2 && options.length === 0 && <p className="material-product-empty">Nenhum funcionário encontrado.</p>}
    </div>
  );
}

// Equipamento por prefixo/descrição (lista já carregada das frentes que a pessoa enxerga).
export function EquipmentPicker({ options, value, onPick, placeholder }: { options: EquipmentOption[]; value: EquipmentOption | null; onPick: (item: EquipmentOption | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const key = query.trim().toUpperCase();
    return (key ? options.filter((item) => `${item.prefix} ${item.description} ${item.front ?? ""}`.toUpperCase().includes(key)) : options).slice(0, 40);
  }, [options, query]);
  if (value) return (
    <div className="material-product-chip"><span className="material-item-kind linked">{value.prefix}</span><strong>{value.description}</strong><small>{value.front ?? "Sem frente"}</small><button type="button" onClick={() => onPick(null)}>Trocar</button></div>
  );
  return (
    <div className="material-product-picker">
      <input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} placeholder={placeholder ?? "Buscar equipamento pelo prefixo..."} />
      {open && results.length > 0 && <ul>{results.map((item) => (
        <li key={item.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onPick(item); setQuery(""); setOpen(false); }}><b>{item.prefix}</b> {item.description}<small> · {item.front ?? "Sem frente"}</small></button></li>
      ))}</ul>}
    </div>
  );
}

// Aviso de saldo insuficiente devolvido pela API (409) com a opção de lançar mesmo assim.
export function ShortageNotice({ shortages, confirm, busy }: { shortages: Shortage[]; confirm: () => void; busy: boolean }) {
  return (
    <div className="stock-shortage full">
      <strong>Saldo insuficiente na frente para:</strong>
      <ul>{shortages.map((item) => <li key={item.productId}>{item.label}: pedido {qtyFormat.format(item.requested)}, saldo {qtyFormat.format(item.available)}</li>)}</ul>
      <button type="button" className="secondary" disabled={busy} onClick={confirm}>Lançar mesmo assim (saldo fica negativo)</button>
    </div>
  );
}
