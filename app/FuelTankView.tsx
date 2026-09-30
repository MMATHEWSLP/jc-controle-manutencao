"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import LoadWarning from "./LoadWarning";
import { formatBrDate } from "../lib/date-format";
import { reconcile } from "../lib/fuel-tank-rules";

type Location = "FRENTE" | "PORTO";
type Option = { id: number; name: string };
type Tank = {
  id: number; serviceFrontId: number; front: string; stockLocation: Location; fuelTypeId: number; fuelType: string; name: string; capacityLiters: number | null;
  calibrationText: string; calibrationPoints: number; maxCm: number | null; tolerancePercent: number; active: boolean;
};
type Measurement = {
  id: number; front: string; stockLocation: Location; fuelType: string; measuredAt: string; method: "LITROS" | "REGUA"; rulerCm: number | null;
  measuredLiters: number; calculatedLiters: number; difference: number; percent: number | null; status: "OK" | "PERDA" | "SOBRA"; tolerancePercent: number;
  adjusted: boolean; notes: string | null; createdBy: string | null;
};
type SummaryRow = { front: string; stockLocation: Location; fuelType: string; measurements: number; lossLiters: number; surplusLiters: number; outside: number; last: Measurement };
type Props = { fronts: Option[]; fuelTypes: Option[]; defaultFrontId: number | null; today: string; canRegister: boolean; canManage: boolean; flash: (message: string) => void };

const LOCATION_LABEL: Record<Location, string> = { FRENTE: "Frente", PORTO: "Porto" };
const liters = (value: number | null) => value === null ? "—" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const parseNumber = (value: string) => { const parsed = Number(value.trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return value.trim() && Number.isFinite(parsed) ? parsed : null; };
const nowLocal = () => { const date = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); return date.toISOString().slice(0, 16); };
const STATUS: Record<Measurement["status"], [string, string]> = { OK: ["green", "Dentro da tolerância"], PERDA: ["red", "Perda"], SOBRA: ["orange", "Sobra"] };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

// Conciliação do tanque (Combustível → Tanque): medição física × saldo do sistema.
export default function FuelTankView({ fronts, fuelTypes, defaultFrontId, today, canRegister, canManage, flash }: Props) {
  const [data, setData] = useState<{ measurements: Measurement[]; summary: SummaryRow[]; tanks: Tank[] } | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState(() => { const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 60); return date.toISOString().slice(0, 10); });
  const [to, setTo] = useState(today);
  const [managingTanks, setManagingTanks] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try { setData(await api(`/api/fuel/measurements?de=${from}&ate=${to}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar as medições."); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  async function remove(item: Measurement) {
    if (!window.confirm(`Excluir a medição de ${formatBrDate(item.measuredAt)} (${liters(item.measuredLiters)})?${item.adjusted ? " O ajuste de saldo feito por ela também será desfeito." : ""}`)) return;
    try { const result = await api<{ message: string }>(`/api/fuel/measurements/${item.id}`, { method: "DELETE" }); flash(result.message); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível excluir."); }
  }

  return <>
    <LoadWarning message={error} />
    <p className="table-sub fuel-tank-intro">Meça o tanque (régua ou visor) e lance aqui: o sistema compara com o saldo calculado (entradas − saídas até o dia da medição) e mostra a perda ou sobra. Diferença acima da tolerância do tanque fica destacada.</p>
    {canRegister && <MeasurementForm fronts={fronts} fuelTypes={fuelTypes} defaultFrontId={defaultFrontId} tanks={data?.tanks ?? []} canManage={canManage} onSaved={async (message) => { flash(message); await load(); }} />}
    {data && data.summary.length > 0 && <article className="panel module-panel fuel-tank-summary">
      <div className="panel-heading"><h2>Resumo do período</h2></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Estoque</th><th>Medições</th><th>Perdas</th><th>Sobras</th><th>Fora da tolerância</th><th>Última medição</th></tr></thead>
        <tbody>{data.summary.map((row) => <tr key={`${row.front}-${row.stockLocation}-${row.fuelType}`}>
          <td><b>{row.front} · {LOCATION_LABEL[row.stockLocation]}</b><small className="table-sub">{row.fuelType}</small></td>
          <td>{row.measurements}</td><td className={row.lossLiters > 0 ? "text-negative" : ""}>{liters(row.lossLiters)}</td><td>{liters(row.surplusLiters)}</td><td>{row.outside}</td>
          <td>{formatBrDate(row.last.measuredAt)}<small className="table-sub">{signed(row.last.difference)}{row.last.percent !== null ? ` (${row.last.percent.toLocaleString("pt-BR")}%)` : ""}</small></td>
        </tr>)}</tbody>
      </table></div>
    </article>}
    <article className="panel module-panel fuel-tank-history">
      <div className="panel-heading fuel-tank-history-head"><h2>Histórico de medições</h2>
        <div className="fuel-tank-filters"><label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          {canManage && <button type="button" className="secondary" onClick={() => setManagingTanks(true)}>Tanques e régua</button>}</div></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Data</th><th>Estoque</th><th>Medido</th><th>Sistema</th><th>Diferença</th><th>Situação</th><th>Lançado por</th>{canManage && <th>Ações</th>}</tr></thead>
        <tbody>{(data?.measurements ?? []).map((item) => {
          const [tone, label] = STATUS[item.status];
          return <tr key={item.id}>
            <td>{formatBrDate(item.measuredAt)}</td>
            <td>{item.front} · {LOCATION_LABEL[item.stockLocation]}<small className="table-sub">{item.fuelType}</small></td>
            <td>{liters(item.measuredLiters)}{item.method === "REGUA" && <small className="table-sub">régua {item.rulerCm?.toLocaleString("pt-BR")} cm</small>}</td>
            <td>{liters(item.calculatedLiters)}</td>
            <td className={item.difference < 0 ? "text-negative" : ""}>{signed(item.difference)}{item.percent !== null && <small className="table-sub">{item.percent.toLocaleString("pt-BR")}% (tolerância {item.tolerancePercent.toLocaleString("pt-BR")}%)</small>}</td>
            <td><span className={`status-pill ${tone}`}>{label}</span>{item.adjusted && <small className="table-sub">saldo ajustado</small>}</td>
            <td>{item.createdBy ?? "—"}{item.notes && <small className="table-sub">{item.notes}</small>}</td>
            {canManage && <td><button type="button" className="link-button" onClick={() => remove(item)}>Excluir</button></td>}
          </tr>;
        })}</tbody>
      </table></div>
      {data && data.measurements.length === 0 && <div className="empty-state">Nenhuma medição no período.</div>}
    </article>
    {managingTanks && data && <TanksModal tanks={data.tanks} fronts={fronts} fuelTypes={fuelTypes} close={() => setManagingTanks(false)} saved={async (message) => { flash(message); await load(); }} />}
  </>;
}

function MeasurementForm({ fronts, fuelTypes, defaultFrontId, tanks, canManage, onSaved }: { fronts: Option[]; fuelTypes: Option[]; defaultFrontId: number | null; tanks: Tank[]; canManage: boolean; onSaved: (message: string) => Promise<void> }) {
  const [frontId, setFrontId] = useState(defaultFrontId ?? fronts[0]?.id ?? 0);
  const [location, setLocation] = useState<Location>("FRENTE");
  const [fuelTypeId, setFuelTypeId] = useState(fuelTypes[0]?.id ?? 0);
  const [measuredAt, setMeasuredAt] = useState(nowLocal);
  const [method, setMethod] = useState<"LITROS" | "REGUA">("LITROS");
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [adjust, setAdjust] = useState(false);
  const [calculated, setCalculated] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tank = useMemo(() => tanks.find((item) => item.serviceFrontId === frontId && item.stockLocation === location && item.fuelTypeId === fuelTypeId) ?? null, [tanks, frontId, location, fuelTypeId]);
  const canRuler = Boolean(tank && tank.calibrationPoints >= 2);
  useEffect(() => { if (!canRuler && method === "REGUA") setMethod("LITROS"); }, [canRuler, method]);
  useEffect(() => {
    const day = measuredAt.slice(0, 10);
    if (!frontId || !fuelTypeId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    let active = true;
    api<{ calculated: number }>(`/api/fuel/measurements?previa=1&frente=${frontId}&local=${location}&combustivel=${fuelTypeId}&data=${day}`)
      .then((result) => { if (active) setCalculated(result.calculated); }).catch(() => { if (active) setCalculated(null); });
    return () => { active = false; };
  }, [frontId, location, fuelTypeId, measuredAt]);
  const typed = parseNumber(value);
  const preview = method === "LITROS" && typed !== null && calculated !== null ? reconcile(typed, calculated, tank?.tolerancePercent ?? 1) : null;

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ message: string }>("/api/fuel/measurements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        serviceFrontId: frontId, stockLocation: location, fuelTypeId, measuredAt, method, liters: method === "LITROS" ? typed : null, rulerCm: method === "REGUA" ? typed : null, notes, adjust,
      }) });
      setValue(""); setNotes(""); setAdjust(false); setMeasuredAt(nowLocal());
      await onSaved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível registrar."); }
    finally { setBusy(false); }
  }

  return <form className="panel module-panel fuel-tank-form" onSubmit={submit}>
    <div className="panel-heading"><h2>Nova medição</h2>{tank && <span className="table-sub">{tank.name}{tank.capacityLiters ? ` · ${liters(tank.capacityLiters)}` : ""} · tolerância {tank.tolerancePercent.toLocaleString("pt-BR")}%</span>}</div>
    <div className="fuel-tank-grid">
      <label>Frente<select value={frontId} onChange={(event) => setFrontId(Number(event.target.value))}>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
      <label>Local<select value={location} onChange={(event) => setLocation(event.target.value as Location)}><option value="FRENTE">Frente</option><option value="PORTO">Porto</option></select></label>
      <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(Number(event.target.value))}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      <label>Data e hora<input type="datetime-local" value={measuredAt} onChange={(event) => setMeasuredAt(event.target.value)} required /></label>
      <label>Como mediu<select value={method} onChange={(event) => setMethod(event.target.value as "LITROS" | "REGUA")}><option value="LITROS">Litros (visor / medidor)</option><option value="REGUA" disabled={!canRuler}>Régua em cm{canRuler ? "" : " (cadastre a tabela do tanque)"}</option></select></label>
      <label>{method === "REGUA" ? `Altura na régua (cm${tank?.maxCm ? `, até ${tank.maxCm}` : ""})` : "Litros medidos"}<input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder={method === "REGUA" ? "Ex.: 142,5" : "Ex.: 82.900"} required /></label>
      <label className="full">Observações<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Opcional (ex.: medido antes do abastecimento da manhã)" /></label>
    </div>
    <div className="fuel-tank-preview">
      <span>Saldo do sistema no dia: <b>{liters(calculated)}</b></span>
      {preview && <span className={`status-pill ${STATUS[preview.status][0]}`}>{STATUS[preview.status][1]}: {signed(preview.difference)}{preview.percent !== null ? ` (${preview.percent.toLocaleString("pt-BR")}%)` : ""}</span>}
      {method === "REGUA" && <span className="table-sub">Os litros saem da tabela do tanque ao salvar.</span>}
    </div>
    {canManage && <label className="fuel-tank-adjust"><input type="checkbox" checked={adjust} onChange={(event) => setAdjust(event.target.checked)} />Ajustar o saldo do sistema para o valor medido (gera um ajuste oculto, que não conta como entrada/saída)</label>}
    {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
    <div className="modal-footer"><button className="primary" disabled={busy || typed === null || !frontId}>{busy ? "Salvando..." : "Registrar medição"}</button></div>
  </form>;
}

function TanksModal({ tanks, fronts, fuelTypes, close, saved }: { tanks: Tank[]; fronts: Option[]; fuelTypes: Option[]; close: () => void; saved: (message: string) => Promise<void> }) {
  const [editing, setEditing] = useState<Tank | "new" | null>(null);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal fuel-tanks-modal">
      <header><div><p className="eyebrow">CONCILIAÇÃO DO TANQUE</p><h2>Tanques e tabela da régua</h2><span>Um tanque por frente, local e combustível. A tabela converte a altura da régua em litros; a tolerância define a diferença aceita.</span></div><button onClick={close} aria-label="Fechar">×</button></header>
      {!editing && <div className="modal-body">
        <div className="table-scroll"><table>
          <thead><tr><th>Tanque</th><th>Estoque</th><th>Capacidade</th><th>Régua</th><th>Tolerância</th><th /></tr></thead>
          <tbody>{tanks.map((tank) => <tr key={tank.id}><td><b>{tank.name}</b>{!tank.active && <small className="table-sub">inativo</small>}</td><td>{tank.front} · {LOCATION_LABEL[tank.stockLocation]}<small className="table-sub">{tank.fuelType}</small></td>
            <td>{liters(tank.capacityLiters)}</td><td>{tank.calibrationPoints >= 2 ? `${tank.calibrationPoints} pontos (até ${tank.maxCm} cm)` : "sem tabela"}</td><td>{tank.tolerancePercent.toLocaleString("pt-BR")}%</td>
            <td><button type="button" className="link-button" onClick={() => setEditing(tank)}>Editar</button></td></tr>)}</tbody>
        </table></div>
        {tanks.length === 0 && <div className="empty-state">Nenhum tanque cadastrado. Sem cadastro, a medição é lançada em litros com tolerância de 1%.</div>}
        <div className="modal-footer"><button className="primary" onClick={() => setEditing("new")}>+ Novo tanque</button></div>
      </div>}
      {editing && <TankForm tank={editing === "new" ? null : editing} fronts={fronts} fuelTypes={fuelTypes} cancel={() => setEditing(null)} saved={async (message) => { setEditing(null); await saved(message); }} />}
    </section>
  </div>;
}

function TankForm({ tank, fronts, fuelTypes, cancel, saved }: { tank: Tank | null; fronts: Option[]; fuelTypes: Option[]; cancel: () => void; saved: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ message: string }>(tank ? `/api/fuel/tanks/${tank.id}` : "/api/fuel/tanks", { method: tank ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        serviceFrontId: Number(form.get("serviceFrontId")), stockLocation: form.get("stockLocation"), fuelTypeId: Number(form.get("fuelTypeId")), name: form.get("name"),
        capacityLiters: form.get("capacityLiters"), tolerancePercent: form.get("tolerancePercent"), calibrationText: form.get("calibrationText"), active: form.get("active") === "on",
      }) });
      await saved(result.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  return <form className="modal-body fuel-tank-grid" onSubmit={submit}>
    <label>Frente<select name="serviceFrontId" defaultValue={tank?.serviceFrontId ?? fronts[0]?.id}>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
    <label>Local<select name="stockLocation" defaultValue={tank?.stockLocation ?? "FRENTE"}><option value="FRENTE">Frente</option><option value="PORTO">Porto</option></select></label>
    <label>Combustível<select name="fuelTypeId" defaultValue={tank?.fuelTypeId ?? fuelTypes[0]?.id}>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
    <label>Nome<input name="name" defaultValue={tank?.name ?? ""} placeholder="Ex.: Tanque aéreo 30 mil" required /></label>
    <label>Capacidade (L)<input name="capacityLiters" inputMode="decimal" defaultValue={tank?.capacityLiters ?? ""} placeholder="Opcional" /></label>
    <label>Tolerância (%)<input name="tolerancePercent" inputMode="decimal" defaultValue={tank?.tolerancePercent ?? 1} /></label>
    <label className="full">Tabela da régua (uma linha por ponto: centímetros;litros)<textarea name="calibrationText" rows={8} defaultValue={tank?.calibrationText ?? ""} placeholder={"0;0\n50;4.800\n100;10.150\n150;15.600\n200;20.900"} /></label>
    <label className="fuel-tank-adjust"><input type="checkbox" name="active" defaultChecked={tank?.active ?? true} />Tanque ativo</label>
    {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
    <div className="modal-footer full"><button type="button" className="secondary" onClick={cancel}>Voltar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar tanque"}</button></div>
  </form>;
}
