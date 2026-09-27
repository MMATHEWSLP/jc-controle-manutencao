"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type MovementType = "ENTRADA" | "SAIDA" | "TRANSFERENCIA";
type Front = { id: number; name: string };
type FuelType = { id: number; code: string; name: string; unit: string };
type Totals = { balance: number; entries: number; exits: number };
type Balance = Totals & { fuelTypeId: number; code: string; name: string; unit: string; byFront: Array<Totals & { serviceFrontId: number; name: string }> };
type Summary = {
  today: string; period: { from: string; to: string }; fuelTypes: FuelType[]; fronts: Front[]; destinationFronts: Front[];
  scopeFrontIds: number[]; allFronts: boolean; multiFront: boolean; defaultFrontId: number | null; balances: Balance[];
};
type Movement = {
  id: number; serviceFrontId: number; frontName: string; fuelTypeId: number; fuelName: string; unit: string; movementType: MovementType; movementLabel: string;
  movementDate: string; quantity: number; origin: string | null; equipmentId: number | null; equipmentPrefix: string | null; equipmentModel: string | null;
  meterReading: number | null; meterUnit: "HOURS" | "KM" | null; destinationFrontId: number | null; destinationFrontName: string | null;
  responsible: string | null; notes: string | null; createdByName: string | null; createdAt: string;
};
type HistoryResponse = { movements: Movement[]; total: number; page: number; pageSize: number };
type EquipmentOption = {
  id: number; prefix: string; brand: string; model: string; type: string; controlType: "HOURS" | "KM" | "HOURS_KM";
  currentHours: number; currentKm: number; serviceFrontId: number | null; frontName: string | null; inActiveFront: boolean;
};
type User = { name: string; permissions: string[] };

const MOVEMENT_OPTIONS: Array<[MovementType, string, string]> = [["ENTRADA", "Entrada", "↓"], ["SAIDA", "Saída", "↑"], ["TRANSFERENCIA", "Transferência", "⇄"]];
const liters = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
const brDay = (value: string) => value.split("-").reverse().join("/");
function defaultPeriod() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

export default function FuelView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const canRegister = authUser.permissions.includes("fuel.register");
  const canManage = authUser.permissions.includes("fuel.manage");
  const [tab, setTab] = useState<"new" | "history">(canRegister ? "new" : "history");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  // Período padrão = mês corrente (mesmo padrão do servidor, lib/fuel.ts).
  const [period, setPeriod] = useState(defaultPeriod);
  const [frontFilter, setFrontFilter] = useState("");
  const [editing, setEditing] = useState<Movement | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  const loadSummary = useCallback(async () => {
    setError("");
    const params = new URLSearchParams({ from: period.from, to: period.to });
    if (frontFilter) params.set("frontId", frontFilter);
    try {
      const result = await api<Summary>(`/api/fuel?${params.toString()}`);
      setSummary(result);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível carregar os saldos.");
    }
  }, [period, frontFilter]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  if (error && !summary) return <div className="operation-error"><span>!</span><div><strong>Falha ao carregar o módulo de combustível</strong><p>{error}</p></div><button onClick={loadSummary}>Tentar novamente</button></div>;
  if (!summary) return <div className="page-loading"><span /><p>Carregando saldos de combustível...</p></div>;

  const scopeLabel = summary.allFronts ? "Todas as frentes" : summary.fronts.filter((front) => summary.scopeFrontIds.includes(front.id)).map((front) => front.name).join(", ") || "Sem frente vinculada";
  const afterSave = async (message: string) => {
    setEditing(null);
    await loadSummary();
    setHistoryVersion((value) => value + 1);
    flash(message);
  };

  return (
    <>
      <div className="page-heading module-heading">
        <div>
          <p className="eyebrow">COMBUSTÍVEL · {scopeLabel.toUpperCase()}</p>
          <h1>Registro de Movimentação de Combustível</h1>
          <span>Entradas, saídas e transferências de Diesel e Gasolina, com saldo por frente de serviço.</span>
        </div>
      </div>
      <section className="fuel-balance-grid" aria-label="Saldos por tipo de combustível">
        {summary.balances.map((balance) => (
          <article key={balance.fuelTypeId} className={`fuel-balance-card fuel-${balance.code.toLowerCase().replace(/_/g, "-")} ${balance.balance < 0 ? "negative" : ""}`}>
            <header><span>⛽</span><div><p>{balance.name.toUpperCase()}</p><small>{scopeLabel}</small></div></header>
            <strong>{liters(balance.balance)}</strong>
            <small className="fuel-balance-caption">Saldo atual</small>
            <div className="fuel-balance-period">
              <span className="in"><b>{liters(balance.entries)}</b>Entradas no período</span>
              <span className="out"><b>{liters(balance.exits)}</b>Saídas no período</span>
            </div>
            {balance.byFront.length > 1 && (
              <ul className="fuel-balance-fronts" aria-label="Saldo por frente">
                {balance.byFront.map((front) => <li key={front.serviceFrontId}><span>{front.name}</span><b className={front.balance < 0 ? "negative" : ""}>{liters(front.balance)}</b></li>)}
              </ul>
            )}
          </article>
        ))}
      </section>
      <div className="fuel-period-bar">
        <span>Período dos cards e do histórico:</span>
        <label>De<input type="date" value={period.from} max={period.to} onChange={(event) => event.target.value && setPeriod({ ...period, from: event.target.value })} /></label>
        <label>Até<input type="date" value={period.to} min={period.from} onChange={(event) => event.target.value && setPeriod({ ...period, to: event.target.value })} /></label>
        {summary.multiFront && summary.scopeFrontIds.length + (frontFilter ? 1 : 0) > 1 && (
          <label>Frente<select value={frontFilter} onChange={(event) => setFrontFilter(event.target.value)}>
            <option value="">Todas em exibição</option>
            {summary.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
          </select></label>
        )}
      </div>
      <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação do módulo Combustível">
        {canRegister && <button className={tab === "new" ? "active" : ""} onClick={() => { setTab("new"); setEditing(null); }}>{editing ? "Editar registro" : "Novo Registro"}</button>}
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Histórico</button>
      </div>
      {tab === "new" && (canRegister || editing)
        ? <FuelForm key={editing ? `edit-${editing.id}` : "new"} summary={summary} authUser={authUser} editing={editing} onSaved={async (message) => { await afterSave(message); setTab(editing ? "history" : "new"); }} onCancel={editing ? () => { setEditing(null); setTab("history"); } : undefined} />
        : <FuelHistory key={historyVersion} summary={summary} period={period} frontFilter={frontFilter} canManage={canManage} flash={flash}
          onEdit={(movement) => { setEditing(movement); setTab("new"); }} onDeleted={async (message) => { await afterSave(message); }} />}
    </>
  );
}

function FuelForm({ summary, authUser, editing, onSaved, onCancel }: { summary: Summary; authUser: User; editing: Movement | null; onSaved: (message: string) => Promise<void>; onCancel?: () => void }) {
  const [movementType, setMovementType] = useState<MovementType>(editing?.movementType ?? "SAIDA");
  const [frontId, setFrontId] = useState<number | null>(editing?.serviceFrontId ?? summary.defaultFrontId ?? (summary.fronts.length === 1 ? summary.fronts[0].id : null));
  const [fuelTypeId, setFuelTypeId] = useState<number>(editing?.fuelTypeId ?? summary.fuelTypes[0]?.id ?? 0);
  const [movementDate, setMovementDate] = useState(editing?.movementDate ?? summary.today);
  const [quantity, setQuantity] = useState(editing ? String(editing.quantity).replace(".", ",") : "");
  const [origin, setOrigin] = useState(editing?.origin ?? "");
  const [meterReading, setMeterReading] = useState(editing?.meterReading != null ? String(editing.meterReading).replace(".", ",") : "");
  const [destinationFrontId, setDestinationFrontId] = useState<number | null>(editing?.destinationFrontId ?? null);
  const [responsible, setResponsible] = useState(editing?.responsible ?? authUser.name);
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [equipment, setEquipment] = useState<EquipmentOption | null>(editing?.equipmentId ? {
    id: editing.equipmentId, prefix: editing.equipmentPrefix ?? "", brand: "", model: editing.equipmentModel ?? "", type: "", controlType: editing.meterUnit === "KM" ? "KM" : "HOURS",
    currentHours: 0, currentKm: 0, serviceFrontId: editing.serviceFrontId, frontName: editing.frontName, inActiveFront: true,
  } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const frontName = summary.fronts.find((front) => front.id === frontId)?.name ?? null;
  const wrongFront = equipment !== null && frontId !== null && equipment.serviceFrontId !== frontId;
  const needsEquipment = movementType === "SAIDA";
  const showEquipment = movementType !== "TRANSFERENCIA";
  const meterLabel = equipment?.controlType === "KM" ? "Hodômetro (km)" : equipment?.controlType === "HOURS_KM" ? "Horímetro / Hodômetro" : "Horímetro (h)";
  const balanceHere = summary.balances.find((balance) => balance.fuelTypeId === fuelTypeId)?.byFront.find((front) => front.serviceFrontId === frontId)?.balance;
  const quantityValue = Number(quantity.replace(/\./g, "").replace(",", "."));
  const lowBalance = movementType !== "ENTRADA" && balanceHere !== undefined && Number.isFinite(quantityValue) && quantityValue > balanceHere + (editing && editing.fuelTypeId === fuelTypeId && editing.serviceFrontId === frontId && editing.movementType !== "ENTRADA" ? editing.quantity : 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (wrongFront) { setError(`O equipamento ${equipment!.prefix} está em ${equipment!.frontName ?? "outra frente"}. Não é possível lançar combustível para ele em ${frontName ?? "esta frente"}.`); return; }
    setBusy(true);
    setError("");
    try {
      const payload = {
        serviceFrontId: frontId, fuelTypeId, movementType, movementDate, quantity, origin, meterReading: showEquipment ? meterReading : "",
        equipmentId: showEquipment ? equipment?.id ?? null : null, destinationFrontId, responsible, notes,
      };
      const result = await api<{ message: string }>(editing ? `/api/fuel/movements/${editing.id}` : "/api/fuel/movements", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!editing) { setQuantity(""); setMeterReading(""); setNotes(""); setEquipment(null); setOrigin(""); }
      await onSaved(result.message);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível salvar o lançamento.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel module-panel fuel-form-panel">
      <form className="modal-form fuel-form" onSubmit={submit}>
        <fieldset className="full fuel-movement-type">
          <legend>Tipo de Movimentação</legend>
          {MOVEMENT_OPTIONS.map(([value, label, icon]) => (
            <button type="button" key={value} className={`${movementType === value ? "active" : ""} ${value.toLowerCase()}`} onClick={() => setMovementType(value)} aria-pressed={movementType === value}>
              <span>{icon}</span>{label}
            </button>
          ))}
        </fieldset>
        {summary.multiFront ? (
          <label>
            Frente de Serviço
            <select required value={frontId ?? ""} onChange={(event) => setFrontId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Selecione a frente...</option>
              {summary.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          Data
          <input type="date" required value={movementDate} max={summary.today} onChange={(event) => setMovementDate(event.target.value)} />
        </label>
        <label>
          Tipo de Combustível
          <select required value={fuelTypeId} onChange={(event) => setFuelTypeId(Number(event.target.value))}>
            {summary.fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
        </label>
        <label>
          Quantidade (litros)
          <input required inputMode="decimal" placeholder="0,00" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          {balanceHere !== undefined && <small className={`fuel-hint ${lowBalance ? "warning" : ""}`}>{lowBalance ? "Atenção: o saldo desta frente ficará negativo. " : ""}Saldo em {frontName}: {liters(balanceHere)}</small>}
        </label>
        <label>
          Origem
          <input placeholder={movementType === "ENTRADA" ? "Ex.: Posto / NF / fornecedor" : "Ex.: Tanque da frente, comboio"} value={origin} onChange={(event) => setOrigin(event.target.value)} />
        </label>
        {movementType === "TRANSFERENCIA" && (
          <label>
            Filial Destino
            <select required value={destinationFrontId ?? ""} onChange={(event) => setDestinationFrontId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Selecione a filial destino...</option>
              {summary.destinationFronts.filter((front) => front.id !== frontId).map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
            </select>
          </label>
        )}
        {showEquipment && (
          <EquipmentPicker frontId={frontId} frontName={frontName} value={equipment} onChange={setEquipment} required={needsEquipment} />
        )}
        {showEquipment && (
          <label>
            {meterLabel}
            <input inputMode="decimal" placeholder={equipment ? (equipment.controlType === "KM" ? `Atual: ${equipment.currentKm.toLocaleString("pt-BR")} km` : `Atual: ${equipment.currentHours.toLocaleString("pt-BR")} h`) : "Opcional"} value={meterReading} onChange={(event) => setMeterReading(event.target.value)} />
          </label>
        )}
        <label>
          Responsável
          <input value={responsible} onChange={(event) => setResponsible(event.target.value)} />
        </label>
        <label className="full">
          Observações
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Informações adicionais deste lançamento." />
        </label>
        {!summary.multiFront && frontName && <p className="full fuel-auto-front">Lançamento da frente <b>{frontName}</b> (frente do seu usuário).</p>}
        {wrongFront && (
          <div className="equipment-form-error full"><span>!</span><strong>O equipamento {equipment!.prefix} está em {equipment!.frontName ?? "outra frente"}, não em {frontName}. Transfira o equipamento ou lance pela frente correta.</strong></div>
        )}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full">
          {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar edição</button>}
          <button className="primary" disabled={busy || wrongFront || !frontId}>{busy ? "Salvando..." : editing ? "Salvar alterações" : "Registrar lançamento"}</button>
        </div>
      </form>
    </article>
  );
}

// Busca de equipamento: prioriza a frente do lançamento, mas mostra também os de outras frentes,
// identificados com a frente onde realmente estão (o lançamento para eles é bloqueado).
function EquipmentPicker({ frontId, frontName, value, onChange, required }: { frontId: number | null; frontName: string | null; value: EquipmentOption | null; onChange: (item: EquipmentOption | null) => void; required: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EquipmentOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ q: query });
      if (frontId) params.set("serviceFrontId", String(frontId));
      api<{ equipment: EquipmentOption[] }>(`/api/fuel/equipment?${params.toString()}`).then((result) => setItems(result.equipment)).catch(() => setItems([])).finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId, open]);

  if (value) {
    const other = frontId !== null && value.serviceFrontId !== frontId;
    return (
      <div className={`fuel-equipment-selected ${other ? "other-front" : ""}`}>
        <span>Veículo/Máquina{required ? " *" : ""}</span>
        <div><strong>{value.prefix}</strong><small>{`${value.brand} ${value.model}`.trim()}</small>{other && <em>está em {value.frontName ?? "outra frente"}</em>}</div>
        <button type="button" onClick={() => { onChange(null); setOpen(true); }}>Trocar</button>
      </div>
    );
  }
  return (
    <div className="fuel-equipment-picker">
      <label>
        Veículo/Máquina{required ? " *" : ""}
        <div className="page-search"><span>⌕</span><input value={query} required={required} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 180)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} placeholder={frontName ? `Prefixo, modelo ou placa (frente ${frontName})` : "Prefixo, modelo ou placa"} /></div>
      </label>
      {open && (
        <ul className="fuel-equipment-results" role="listbox">
          {loading && <li className="muted">Buscando...</li>}
          {!loading && items.length === 0 && <li className="muted">{query ? "Nenhum equipamento encontrado." : "Digite para buscar em todas as frentes."}</li>}
          {!loading && items.map((item) => {
            const other = frontId !== null && item.serviceFrontId !== frontId;
            return (
              <li key={item.id} role="option" aria-selected={false} className={other ? "other-front" : ""} onMouseDown={(event) => { event.preventDefault(); onChange(item); setOpen(false); }}>
                <strong>{item.prefix}</strong><span>{`${item.brand} ${item.model}`.trim()}</span>
                {other ? <em>— está em {item.frontName ?? "sem frente"}</em> : <small>{item.frontName}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FuelHistory({ summary, period, frontFilter, canManage, flash, onEdit, onDeleted }: {
  summary: Summary; period: { from: string; to: string }; frontFilter: string; canManage: boolean; flash: (message: string) => void;
  onEdit: (movement: Movement) => void; onDeleted: (message: string) => Promise<void>;
}) {
  const [fuelTypeId, setFuelTypeId] = useState("");
  const [movementType, setMovementType] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { setPage(1); }, [fuelTypeId, movementType, debounced, period.from, period.to, frontFilter]);
  const params = useMemo(() => {
    const value = new URLSearchParams({ from: period.from, to: period.to });
    if (fuelTypeId) value.set("fuelTypeId", fuelTypeId);
    if (movementType) value.set("movementType", movementType);
    if (debounced) value.set("q", debounced);
    if (frontFilter) value.set("frontId", frontFilter);
    return value;
  }, [period, fuelTypeId, movementType, debounced, frontFilter]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setData(await api<HistoryResponse>(`/api/fuel/movements?${params.toString()}&page=${page}`)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Não foi possível carregar o histórico."); }
    finally { setLoading(false); }
  }, [params, page]);
  useEffect(() => { load(); }, [load]);

  async function remove(movement: Movement) {
    if (!window.confirm(`Excluir o lançamento de ${liters(movement.quantity)} de ${movement.fuelName} (${brDay(movement.movementDate)})? O saldo será recalculado.`)) return;
    try {
      const result = await api<{ message: string }>(`/api/fuel/movements/${movement.id}`, { method: "DELETE" });
      await onDeleted(result.message);
    } catch (problem) { flash(problem instanceof Error ? problem.message : "Não foi possível excluir."); }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportUrl = (format: "pdf" | "xlsx") => `/api/fuel/export?${params.toString()}&formato=${format}`;
  return (
    <article className="panel module-panel fuel-history-panel">
      <div className="products-filters fuel-history-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Equipamento, origem, responsável..." /></label>
        <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}><option value="">Todos</option>{summary.fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
        <label>Movimentação<select value={movementType} onChange={(event) => setMovementType(event.target.value)}><option value="">Todas</option>{MOVEMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="fuel-export-actions">
          <a className="secondary" href={exportUrl("pdf")} target="_blank" rel="noopener noreferrer">Exportar PDF</a>
          <a className="secondary" href={exportUrl("xlsx")}>Exportar Excel</a>
        </div>
      </div>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
      {loading && !data ? <div className="page-loading"><span /><p>Carregando histórico...</p></div> : (
        <>
          <div className="table-scroll">
            <table className="products-table fuel-history-table">
              <thead><tr><th>Data</th><th>Tipo</th><th>Combustível</th><th>Quantidade</th><th>Frente</th><th>Veículo/Máquina</th><th>Hod./Horím.</th><th>Origem</th><th>Responsável</th>{canManage && <th>Ações</th>}</tr></thead>
              <tbody>
                {data?.movements.map((movement) => (
                  <tr key={movement.id}>
                    <td>{brDay(movement.movementDate)}</td>
                    <td><span className={`fuel-type-pill ${movement.movementType.toLowerCase()}`}>{movement.movementLabel}</span></td>
                    <td>{movement.fuelName}</td>
                    <td className="price-cell">{liters(movement.quantity)}</td>
                    <td>{movement.frontName}{movement.movementType === "TRANSFERENCIA" && <small className="fuel-transfer"> → {movement.destinationFrontName ?? "—"}</small>}</td>
                    <td>{movement.equipmentPrefix ? <><strong>{movement.equipmentPrefix}</strong> <small>{movement.equipmentModel}</small></> : "—"}</td>
                    <td>{movement.meterReading === null ? "—" : `${movement.meterReading.toLocaleString("pt-BR")} ${movement.meterUnit === "KM" ? "km" : "h"}`}</td>
                    <td>{movement.origin ?? "—"}</td>
                    <td title={movement.notes ?? undefined}>{movement.responsible ?? "—"}{movement.createdByName && movement.createdByName !== movement.responsible && <small className="fuel-created-by"> · lançado por {movement.createdByName}</small>}</td>
                    {canManage && <td><div className="equipment-row-actions"><button onClick={() => onEdit(movement)}>Editar</button><button onClick={() => remove(movement)}>Excluir</button></div></td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.movements.length === 0 && <div className="empty-state">Nenhum lançamento encontrado para o período e filtros selecionados.</div>}
          </div>
          <div className="pagination-bar">
            <span>Página {data?.page ?? 1} de {totalPages} · {(data?.total ?? 0).toLocaleString("pt-BR")} lançamentos</span>
            <div className="pagination-controls">
              <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>‹ Anterior</button>
              <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Próxima ›</button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
