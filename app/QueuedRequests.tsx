"use client";
import { useEffect, useState } from "react";
import { listQueuedRequests, QUEUE_EVENT, removeQueuedRequest, syncQueue, type QueuedRequest, type QueuedRequestKind } from "../lib/offline-queue";

// Lista do que ficou guardado no celular (checklist, abastecimento, leituras) com envio manual
// e descarte dos recusados. Some quando não há nada na fila.
export default function QueuedRequests({ userId, kind, title = "Guardados no celular" }: { userId: number; kind: QueuedRequestKind; title?: string }) {
  const [items, setItems] = useState<QueuedRequest[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [retryMessage, setRetryMessage] = useState("");
  useEffect(() => {
    const refresh = () => { listQueuedRequests(userId, kind).then(setItems).catch(() => setItems([])); };
    refresh(); window.addEventListener(QUEUE_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_EVENT, refresh);
  }, [userId, kind]);
  if (!items.length) return null;
  async function retry() {
    setSyncing(true); setRetryMessage("");
    try { await syncQueue(); const left = await listQueuedRequests(userId, kind); if (left.some((item) => item.status === "PENDING")) setRetryMessage("Ainda sem conexão com o servidor. O envio acontece sozinho quando o sinal voltar."); }
    finally { setSyncing(false); }
  }
  return <section className="panel daily-queue">
    {items.some((item) => item.status === "PENDING")
      ? <header><div><strong>{title}</strong><span>Serão enviados automaticamente quando houver internet.</span></div><button type="button" className="secondary" disabled={syncing} onClick={retry}>{syncing ? "Enviando..." : "Enviar agora"}</button></header>
      : <header><div><strong>Não enviados</strong><span>O servidor recusou estes envios. Confira o motivo e descarte.</span></div></header>}
    {retryMessage && <p className="daily-queue-note">{retryMessage}</p>}
    <ul>{items.map((item) => <li key={item.id} className={item.status === "ERROR" ? "error" : ""}>
      <strong>{item.summary}</strong><span>{new Date(item.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
      {item.status === "ERROR" ? <><small>Não enviado: {item.error}</small><button type="button" className="danger-action" onClick={() => { if (window.confirm("Descartar este envio guardado no celular?")) removeQueuedRequest(item.id); }}>Descartar</button></> : <small>Aguardando envio</small>}
    </li>)}</ul>
  </section>;
}
