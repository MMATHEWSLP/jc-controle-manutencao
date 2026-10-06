"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Combustível → Histórico → "Resumo do dia": saldo anterior, entradas/transferências (se houver),
// consumo e saldo final de um estoque num dia, a mensagem pronta para o grupo do WhatsApp e o PDF
// das saídas do dia. Mensagem, tela e PDF vêm da mesma consulta (lib/fuel-daily.ts).
// ---------------------------------------------------------------------------
type Front = { id: number; name: string };
type FuelType = { id: number; code: string; name: string };
type Location = "FRENTE" | "PORTO" | "TODOS";
type Totals = { previous: number; entries: number; transfersIn: number; transfersOut: number; adjustments: number; consumption: number; final: number };
type Settings = { greeting: string; title: string; balanceLabel: string; configured: boolean };
type Exit = { id: number; equipment: string; plate: string | null; kind: "FROTA" | "TERCEIRO" | "PRESTADOR"; company: string | null; liters: number; reading: number | null; readingUnit: "KM" | "HOURS" | null; responsible: string | null; notes: string | null };
type Transfer = { id: number; direction: "ENVIADA" | "RECEBIDA"; liters: number; place: string; responsible: string | null; notes: string | null };
type Result = { date: string; totals: Totals; exits: Exit[]; transfers?: Transfer[]; convoyPending?: { liters: number; count: number }; exitsLiters: number; ledgerBalance: number; message: string; settings: Settings; canEditSettings: boolean; front: Front; fuel: { id: number; name: string } };

const LOCATIONS: Array<[Location, string]> = [["FRENTE", "Frente"], ["PORTO", "Porto"], ["TODOS", "Frente + Porto"]];
const KIND: Record<Exit["kind"], string> = { FROTA: "Frota", TERCEIRO: "Terceiro", PRESTADOR: "Prestador" };
const liters = (value: number) => `${(Math.round(value * 100) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}L`;
const API = "/api/fuel/daily-summary";

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "Não foi possível gerar o resumo."));
  return data as T;
}

export default function FuelDailySummaryModal({ today, fronts, fuelTypes, defaultFrontId, close, flash }: {
  today: string; fronts: Front[]; fuelTypes: FuelType[]; defaultFrontId: number | null; close: () => void; flash: (message: string) => void;
}) {
  const diesel = fuelTypes.find((type) => /DIESEL\s*S\s*10/i.test(type.name) || type.code === "DIESEL_S10") ?? fuelTypes[0];
  const [date, setDate] = useState(today);
  const [frontId, setFrontId] = useState(String(defaultFrontId ?? fronts[0]?.id ?? ""));
  const [fuelTypeId, setFuelTypeId] = useState(String(diesel?.id ?? ""));
  const [location, setLocation] = useState<Location>("FRENTE");
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const query = new URLSearchParams({ data: date, frontId, fuelTypeId, estoque: location }).toString();

  const load = useCallback(async () => {
    if (!frontId || !fuelTypeId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setLoading(true); setError("");
    try {
      const data = await api<Result>(`${API}?${new URLSearchParams({ data: date, frontId, fuelTypeId, estoque: location })}`);
      setResult(data); setMessage(data.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível gerar o resumo."); setResult(null); }
    finally { setLoading(false); }
  }, [date, frontId, fuelTypeId, location]);
  useEffect(() => { void load(); }, [load]);

  async function copy() {
    try { await navigator.clipboard.writeText(message); }
    catch {
      const area = document.createElement("textarea"); area.value = message; document.body.appendChild(area); area.select();
      document.execCommand("copy"); area.remove();
    }
    flash("Mensagem copiada. É só colar no grupo do WhatsApp.");
  }

  async function saveSettings() {
    if (!editing) return;
    setSaving(true);
    try {
      const data = await api<{ message: string }>(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frontId: Number(frontId), ...editing }) });
      setEditing(null); flash(data.message); await load();
    } catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setSaving(false); }
  }

  const t = result?.totals;
  const cards: Array<[string, number, string]> = t ? [
    ["Saldo anterior", t.previous, "gray"],
    ...(t.entries > 0 ? [["Entrada", t.entries, "green"] as [string, number, string]] : []),
    ...(t.transfersIn > 0 ? [["Transferência recebida", t.transfersIn, "blue"] as [string, number, string]] : []),
    ...(t.transfersOut > 0 ? [["Transferência enviada", t.transfersOut, "blue"] as [string, number, string]] : []),
    ...(t.adjustments !== 0 ? [["Ajuste de saldo", t.adjustments, "gray"] as [string, number, string]] : []),
    ["Consumo", t.consumption, "red"],
    ["Saldo final", t.final, t.final < 0 ? "red" : "green"],
  ] : [];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal fuel-daily-modal" role="dialog" aria-label="Resumo do dia">
        <header>
          <div><p className="eyebrow">COMBUSTÍVEL</p><h2>Resumo do dia</h2><span>Saídas do dia, saldo e mensagem pronta para o grupo do WhatsApp.</span></div>
          <button onClick={close} aria-label="Fechar">×</button>
        </header>
        <div className="fuel-daily-body">
          <div className="fuel-daily-filters">
            <label>Data<input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} /></label>
            <label>Frente<select value={frontId} onChange={(event) => setFrontId(event.target.value)}>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
            <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
            <label>Estoque<select value={location} onChange={(event) => setLocation(event.target.value as Location)}>{LOCATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          {error && <div className="operation-error"><span>!</span><div><strong>Falha ao gerar o resumo</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
          {loading && !result && <div className="page-loading"><span /><p>Calculando o resumo...</p></div>}
          {result && t && <>
            <div className={`fuel-daily-cards ${loading ? "loading" : ""}`}>
              {cards.map(([label, value, tone]) => <article key={label} className={tone}><span>{label}</span><strong>{liters(value)}</strong></article>)}
            </div>
            {(result.transfers ?? []).length > 0 && <ul className="fuel-daily-transfers">
              {(result.transfers ?? []).map((transfer) => <li key={transfer.id}>
                <b>Transferência {transfer.direction === "ENVIADA" ? "enviada" : "recebida"}:</b> {liters(transfer.liters)} {transfer.direction === "ENVIADA" ? "para" : "de"} <b>{transfer.place}</b>
                {transfer.responsible ? <small> · {transfer.responsible}</small> : null}{transfer.notes ? <small> · {transfer.notes}</small> : null}
              </li>)}
            </ul>}
            {result.convoyPending && result.convoyPending.liters > 0 && <div className="fuel-daily-convoy-pending">⏳ Comboio: {liters(result.convoyPending.liters)} pendentes de aprovação neste dia ({result.convoyPending.count} registro(s)). Só entram nas saídas e no saldo depois de aprovados.</div>}
            {result.ledgerBalance !== t.final && <div className="fuel-import-note"><p><b>Atenção:</b> o saldo final ({liters(t.final)}) difere do saldo do formulário para esta data ({liters(result.ledgerBalance)}). Avise o administrador.</p></div>}
            <div className="fuel-daily-grid">
              <div className="fuel-daily-message">
                <label>Mensagem para o WhatsApp<textarea value={message} rows={13} onChange={(event) => setMessage(event.target.value)} /></label>
                <div className="fuel-daily-actions">
                  <button type="button" className="primary" onClick={copy}>Copiar mensagem</button>
                  <a className="secondary fuel-daily-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">Abrir no WhatsApp</a>
                  <a className="secondary" href={`${API}?${query}&formato=pdf`} target="_blank" rel="noopener noreferrer">Baixar PDF</a>
                </div>
                {message !== result.message && <small className="fuel-hint">Você editou o texto. <button type="button" className="link-button" onClick={() => setMessage(result.message)}>Voltar ao texto calculado</button></small>}
                {result.canEditSettings && !editing && <button type="button" className="link-button" onClick={() => setEditing({ ...result.settings })}>⚙ Título e nome do saldo desta frente{result.settings.configured ? "" : " (usando o padrão)"}</button>}
                {editing && <div className="fuel-daily-settings">
                  <label>Saudação<input value={editing.greeting} maxLength={200} onChange={(event) => setEditing({ ...editing, greeting: event.target.value })} /></label>
                  <label>Título<input value={editing.title} maxLength={200} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
                  <label>Nome do saldo<input value={editing.balanceLabel} maxLength={200} onChange={(event) => setEditing({ ...editing, balanceLabel: event.target.value })} /></label>
                  <small>Pode usar {"{frente}"}, {"{combustivel}"} e {"{ano}"}. Vale para {result.front.name}.</small>
                  <div className="fuel-daily-actions"><button type="button" className="primary" disabled={saving} onClick={saveSettings}>{saving ? "Salvando..." : "Salvar"}</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancelar</button></div>
                </div>}
              </div>
              <div className="fuel-daily-exits">
                <strong>{result.exits.length} saída(s) · {liters(result.exitsLiters)}</strong>
                <div className="table-scroll"><table>
                  <thead><tr><th>Equipamento</th><th>Tipo</th><th>Empresa</th><th className="num">Litros</th><th>Responsável</th></tr></thead>
                  <tbody>{result.exits.map((row) => <tr key={row.id}><td><b>{row.equipment}</b>{row.plate && row.plate !== row.equipment ? <small> {row.plate}</small> : null}</td><td>{KIND[row.kind]}</td><td>{row.company ?? "—"}</td><td className="num">{liters(row.liters)}</td><td>{row.responsible ?? "—"}</td></tr>)}
                    {result.exits.length === 0 && <tr><td colSpan={5} className="empty-state">Nenhuma saída neste dia.</td></tr>}</tbody>
                </table></div>
              </div>
            </div>
          </>}
        </div>
      </section>
    </div>
  );
}
