"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationLink } from "../lib/notification-events";
import { enablePush, pushSupport, PUSH_CHANGED_EVENT, syncPush, type PushSupport } from "../lib/push-client";

// ---------------------------------------------------------------------------
// Sino da barra de cima (sistema e acesso de campo): contador de não lidas, lista, "marcar todas" e o
// botão para receber os avisos no celular. Tocar numa notificação (aqui ou no aviso do celular) abre a
// tela dela. lib/notifications.ts grava; o contador é consultado a cada minuto.
// ---------------------------------------------------------------------------
export type NotificationEntry = { id: number; event: string; title: string; body: string; link: NotificationLink | null; count: number; createdAt: string; updatedAt: string; readAt: string | null };
export const NOTIFICATIONS_CHANGED = "jc:notifications-changed";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Não foi possível carregar.");
  return data;
}
export const notificationApi = {
  list: () => call<{ items: NotificationEntry[]; unread: number }>("/api/notifications"),
  open: (id: number) => call<{ link: NotificationLink | null; unread: number }>("/api/notifications", { method: "PUT", body: JSON.stringify({ id, action: "OPEN" }) }),
  unread: (id: number) => call<{ unread: number }>("/api/notifications", { method: "PUT", body: JSON.stringify({ id, action: "UNREAD" }) }),
  readAll: () => call<{ unread: number }>("/api/notifications", { method: "PUT", body: JSON.stringify({ action: "READ_ALL" }) }),
};

export function timeAgo(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? "ontem" : days < 7 ? `há ${days} dias` : new Date(value).toLocaleDateString("pt-BR");
}

export const PUSH_HINT: Record<Exclude<PushSupport, "OK">, string> = {
  IOS_INSTALL: "No iPhone, os avisos chegam pelo app na Tela de Início: no Safari, toque em Compartilhar → \"Adicionar à Tela de Início\", abra o sistema por lá e ative.",
  ANDROID_APP: "Para receber os avisos no celular, atualize o app JC Sistema (versão nova em www.jcsistema.online/app/baixar). Por enquanto, veja aqui no sino.",
  ANDROID_SETUP: "Os avisos no celular pelo app Android ainda não foram ligados pelo administrador. Por enquanto, veja aqui no sino.",
  UNSUPPORTED: "Este navegador não recebe avisos fora do sistema. Veja aqui no sino.",
  DENIED: "Os avisos estão bloqueados para este site neste aparelho. Libere nos ajustes do navegador/celular.",
};

// Abre a notificação pedida pelo aviso do celular (?notificacao=ID na URL ou mensagem do service worker).
function notificationIdFrom(url: string) {
  try { const id = Number(new URL(url, window.location.origin).searchParams.get("notificacao")); return Number.isInteger(id) && id > 0 ? id : null; } catch { return null; }
}

export default function NotificationBell({ onNavigate, onSeeAll }: { onNavigate: (link: NotificationLink) => void; onSeeAll: () => void }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationEntry[] | null>(null);
  const [error, setError] = useState("");
  const [support, setSupport] = useState<PushSupport>("UNSUPPORTED");
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate);
  useEffect(() => { navigate.current = onNavigate; }, [onNavigate]);

  const refreshCount = useCallback(() => { call<{ unread: number }>("/api/notifications?count=1").then((result) => setUnread(result.unread)).catch(() => undefined); }, []);
  const loadList = useCallback(async () => {
    setError("");
    try { const result = await notificationApi.list(); setItems(result.items); setUnread(result.unread); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar."); }
  }, []);
  const openOne = useCallback(async (id: number) => {
    try { const result = await notificationApi.open(id); setUnread(result.unread); if (result.link) navigate.current(result.link); }
    catch { /* notificação de outro login ou apagada: só não navega */ }
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = window.setInterval(refreshCount, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") refreshCount(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshCount);
    // Tocou no aviso com o sistema fechado: abriu com ?notificacao=ID.
    const fromUrl = notificationIdFrom(window.location.href);
    if (fromUrl) {
      const url = new URL(window.location.href); url.searchParams.delete("notificacao");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      void openOne(fromUrl);
    }
    // Tocou no aviso com o sistema já aberto: o service worker manda a mensagem.
    const onMessage = (event: MessageEvent) => { if (event.data?.type === "OPEN_NOTIFICATION") { const id = notificationIdFrom(String(event.data.url ?? "")); if (id) void openOne(id); refreshCount(); } };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener(NOTIFICATIONS_CHANGED, refreshCount); navigator.serviceWorker?.removeEventListener("message", onMessage); };
  }, [refreshCount, openOne]);

  // Situação do aviso no celular neste aparelho; já permitido = confirma o aparelho neste login.
  useEffect(() => {
    const check = () => { const value = pushSupport(); setSupport(value); if (value === "OK") syncPush().then(setActive).catch(() => setActive(false)); };
    check();
    window.addEventListener(PUSH_CHANGED_EVENT, check);
    return () => window.removeEventListener(PUSH_CHANGED_EVENT, check);
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const close = (event: MouseEvent) => { if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open, loadList]);

  async function activate() {
    setBusy(true); setError("");
    try { await enablePush(); setActive(true); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível ativar."); setSupport(pushSupport()); }
    finally { setBusy(false); }
  }
  async function pick(item: NotificationEntry) { setOpen(false); await openOne(item.id); }
  async function readAll() { try { await notificationApi.readAll(); setUnread(0); await loadList(); } catch (problem) { setError(problem instanceof Error ? problem.message : "Falhou."); } }

  return <div className="notify-bell" ref={panel}>
    <button type="button" className={`notify-bell-button ${unread ? "has-unread" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={unread ? `Notificações: ${unread} não lida(s)` : "Notificações"} title="Notificações">
      <span aria-hidden="true">🔔</span>{unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
    </button>
    {open && <div className="notify-panel" role="dialog" aria-label="Notificações">
      <header><strong>Notificações</strong>{unread > 0 && <button type="button" className="link-button" onClick={() => void readAll()}>Marcar todas como lidas</button>}</header>
      {support === "OK" && !active && <div className="notify-push-offer"><span>Receba estes avisos no celular/computador, mesmo com o sistema fechado.</span><button type="button" className="primary" disabled={busy} onClick={() => void activate()}>{busy ? "Ativando..." : "Ativar notificações"}</button></div>}
      {support !== "OK" && <div className="notify-push-hint">{PUSH_HINT[support]}</div>}
      {error && <div className="fleet-form-error">! {error}</div>}
      <div className="notify-list">
        {items === null && !error && <div className="page-loading"><span /><p>Carregando...</p></div>}
        {items?.map((item) => <button type="button" key={item.id} className={`notify-item ${item.readAt ? "" : "unread"}`} onClick={() => void pick(item)}>
          <span className="notify-dot" aria-hidden="true" />
          <span className="notify-text"><strong>{item.title}</strong><span>{item.body}</span><small>{timeAgo(item.updatedAt)}{item.count > 1 && !item.title.includes(String(item.count)) ? ` · ${item.count} avisos` : ""}</small></span>
        </button>)}
        {items?.length === 0 && <div className="empty-state">Nenhuma notificação por enquanto.</div>}
      </div>
      <footer><button type="button" className="link-button" onClick={() => { setOpen(false); onSeeAll(); }}>Ver todas · preferências e aparelhos</button></footer>
    </div>}
  </div>;
}
