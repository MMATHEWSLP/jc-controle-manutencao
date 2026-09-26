"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- ícone estático pequeno do próprio app */
import { useEffect, useState } from "react";
import { QUEUE_EVENT, listQueued, syncQueue } from "../lib/offline-queue";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

// Presente em todas as telas: registra o app (service worker), mostra quando o celular está
// sem internet, envia a fila do Controle Diário quando a conexão volta e oferece "Instalar app".
export default function AppRuntime() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    const refreshPending = () => { listQueued().then((items) => setPending(items.filter((item) => item.status === "PENDING").length)).catch(() => undefined); };
    const goOnline = () => { setOnline(true); syncQueue().catch(() => undefined); };
    const goOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    refreshPending();
    syncQueue().catch(() => undefined);
    const timer = window.setInterval(() => { if (navigator.onLine) syncQueue().catch(() => undefined); }, 60_000);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener(QUEUE_EVENT, refreshPending);

    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let hidden = false;
    try { hidden = window.localStorage.getItem("jc-install-dismissed") === "1"; } catch { /* navegador sem storage */ }
    setDismissed(standalone || hidden);
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    // iPhone não tem o botão automático: mostramos a instrução "Compartilhar > Adicionar à Tela de Início".
    if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) setIosHint(true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener(QUEUE_EVENT, refreshPending);
      window.removeEventListener("beforeinstallprompt", onPrompt);
    };
  }, []);

  function dismiss() { setDismissed(true); try { window.localStorage.setItem("jc-install-dismissed", "1"); } catch { /* ignora */ } }
  async function install() { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice.catch(() => undefined); setInstallPrompt(null); dismiss(); }

  return <>
    {!online && <div className="app-offline-banner" role="status"><strong>Sem internet</strong><span>Mostrando os últimos dados salvos no celular. O Controle Diário pode ser preenchido e será enviado quando o sinal voltar.{pending > 0 ? ` ${pending} registro(s) aguardando envio.` : ""}</span></div>}
    {online && pending > 0 && <div className="app-offline-banner syncing" role="status"><strong>Enviando</strong><span>{pending} registro(s) do Controle Diário aguardando envio...</span></div>}
    {!dismissed && (installPrompt || iosHint) && <div className="app-install-hint" role="dialog" aria-label="Instalar app">
      <img src="/icon-192.png" alt="" width={40} height={40}/>
      <div><strong>Instale o app JC Sistema</strong><span>{installPrompt ? "Abre direto da tela inicial, em tela cheia, e funciona sem internet." : "No Safari, toque em Compartilhar e depois em \"Adicionar à Tela de Início\"."}</span></div>
      {installPrompt && <button type="button" className="primary" onClick={install}>Instalar</button>}
      <button type="button" className="app-install-close" onClick={dismiss} aria-label="Fechar">×</button>
    </div>}
  </>;
}
