"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useRef, useState, type FormEvent } from "react";

// Acesso de campo: 1) procura o nome  2) digita o código  3) confirma "Sou eu".
// Botões grandes (mín. 48 px): usado no celular, muitas vezes com luva e sol forte.
type Operator = { id: number; name: string };
type Confirmed = { id: number; name: string; jobTitle: string | null; front: string | null };

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível continuar."));
  return data as T;
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export default function FieldLogin({ onBack, onAuthenticated }: { onBack: () => void; onAuthenticated: (user: unknown) => void }) {
  const [step, setStep] = useState<"name" | "code" | "confirm">("name");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Operator[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Operator | null>(null);
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== "name") return;
    const term = query.trim();
    if (term.length < 2) { setResults([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      fetch(`/api/auth/field/search?q=${encodeURIComponent(term)}`, { cache: "no-store", signal: controller.signal })
        .then((response) => response.json()).then((data: { operators?: Operator[] }) => setResults(data.operators ?? []))
        .catch(() => undefined).finally(() => setSearching(false));
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, step]);

  useEffect(() => { if (step === "code") codeInput.current?.focus(); }, [step]);

  function pick(operator: Operator) { setSelected(operator); setCode(""); setError(""); setStep("code"); }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const result = await post<{ operator: Confirmed }>("/api/auth/field/verify", { operatorId: selected.id, code });
      setConfirmed(result.operator); setStep("confirm");
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível conferir."); setCode(""); }
    finally { setBusy(false); }
  }

  async function enter() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await post("/api/auth/field/login", { operatorId: selected.id, code });
      const session = await fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.json()) as { user?: unknown };
      if (!session.user) throw new Error("Não foi possível abrir a sessão. Tente de novo.");
      onAuthenticated(session.user);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível entrar."); }
    finally { setBusy(false); }
  }

  function notMe() { setConfirmed(null); setSelected(null); setCode(""); setQuery(""); setResults([]); setStep("name"); }

  return <div className="login-card field-login">
    <p className="eyebrow">ACESSO DE CAMPO</p>
    {step === "name" && <>
      <h1>Qual é o seu nome?</h1>
      <span>Digite parte do seu nome e toque nele na lista.</span>
      <label className="field-search"><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome ou matrícula" autoComplete="off" autoCapitalize="words" aria-label="Seu nome ou matrícula"/></label>
      <div className="field-results">
        {results.map((operator) => <button type="button" key={operator.id} onClick={() => pick(operator)}><b>{initials(operator.name)}</b><span>{operator.name}</span></button>)}
        {query.trim().length >= 2 && !searching && results.length === 0 && <p>Nenhum funcionário encontrado. Confira o nome ou procure o encarregado.</p>}
      </div>
    </>}
    {step === "code" && selected && <form onSubmit={verify}>
      <h1>Digite o seu PIN</h1>
      <span>{selected.name}</span>
      <input ref={codeInput} className="field-code" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={8} value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="••••" aria-label="PIN de acesso"/>
      {error && <div className="login-error">! {error}</div>}
      <button className="primary field-big" disabled={busy || code.length < 4}>{busy ? "Conferindo..." : "CONTINUAR"}</button>
      <button type="button" className="field-link" onClick={notMe}>Não é você? Voltar</button>
    </form>}
    {step === "confirm" && confirmed && <div className="field-confirm">
      <b className="field-avatar">{initials(confirmed.name)}</b>
      <strong>{confirmed.name}</strong>
      {confirmed.jobTitle && <span>{confirmed.jobTitle}</span>}
      {confirmed.front && <small>Frente: {confirmed.front}</small>}
      {error && <div className="login-error">! {error}</div>}
      <button type="button" className="primary field-big" disabled={busy} onClick={enter}>{busy ? "Entrando..." : "SOU EU, CONTINUAR"}</button>
      <button type="button" className="field-big secondary" disabled={busy} onClick={notMe}>Não sou eu, voltar</button>
    </div>}
    {step === "name" && <button type="button" className="field-link" onClick={onBack}>← Entrar com usuário e senha</button>}
  </div>;
}
