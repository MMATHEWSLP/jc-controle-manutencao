"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, jsonBody, problemText } from "./stock-client";

// Cadastro de Terceiros (prestadores, terceirizadas e pessoas físicas) com os veículos/máquinas deles.
// Aparece na aba Combustível (sub-aba "Terceiros") e no menu Produtos. ADMIN/GESTOR
// (third_parties.manage) cadastram, editam e inativam; os demais só consultam e selecionam.

type User = { name: string; permissions: string[] };
type Kind = "PRESTADOR" | "TERCEIRIZADA" | "PESSOA_FISICA";
type MeterType = "KM" | "HORIMETRO";
type VehicleType = "CAMINHAO" | "MAQUINA" | "VEICULO_LEVE" | "OUTRO";
type Option = { id: number; name: string };
export type ThirdPartyVehicle = {
  id: number; thirdPartyId: number; plate: string; description: string | null; vehicleType: VehicleType; meterType: MeterType; fuelTypeId: number | null; fuelName: string | null;
  tankCapacityLiters: number | null; expectedConsumption: number | null; lastReading: number | null; active: boolean; averageConsumption: number | null; consumptionUnit: string; fuelings: number; hasMovements: boolean;
};
export type ThirdParty = {
  id: number; name: string; kind: Kind; kindLabel: string; document: string | null; contactName: string | null; phone: string | null; serviceFrontId: number | null; front: string | null;
  notes: string | null; active: boolean; hasMovements: boolean; vehicles: ThirdPartyVehicle[];
};
type ListResponse = { thirdParties: ThirdParty[]; fuelTypes: Option[]; fronts: Option[]; canManage: boolean };
// Opções dos selects do Combustível/Movimentação (só ativos).
export type VehicleOption = { id: number; thirdPartyId: number; plate: string; description: string | null; meterType: MeterType; lastReading: number | null; tankCapacityLiters: number | null };
export type ThirdPartyOption = { id: number; name: string; kind: Kind; document: string | null; vehicles: VehicleOption[] };

export const KIND_LABELS: Record<Kind, string> = { PRESTADOR: "Prestador de serviço", TERCEIRIZADA: "Terceirizada", PESSOA_FISICA: "Pessoa física" };
const VEHICLE_LABELS: Record<VehicleType, string> = { CAMINHAO: "Caminhão", MAQUINA: "Máquina", VEICULO_LEVE: "Veículo leve", OUTRO: "Outro" };
export const METER_LABEL: Record<MeterType, string> = { KM: "Hodômetro (km)", HORIMETRO: "Horímetro (h)" };
const number = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? "—" : value.toLocaleString("pt-BR", { maximumFractionDigits: digits }));
const formatDocument = (value: string | null) => {
  if (!value) return "—";
  if (value.length === 14) return value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (value.length === 11) return value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return value;
};
const searchKey = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

// Lista de terceiros ativos para os selects, recarregável depois de um cadastro rápido.
export function useThirdPartyOptions() {
  const [options, setOptions] = useState<ThirdPartyOption[]>([]);
  const [canManage, setCanManage] = useState(false);
  const reload = useCallback(async () => {
    const result = await api<{ thirdParties: ThirdPartyOption[]; canManage: boolean }>("/api/third-parties?opcoes=1");
    setOptions(result.thirdParties); setCanManage(result.canManage);
    return result.thirdParties;
  }, []);
  useEffect(() => { reload().catch(() => undefined); }, [reload]);
  return { options, canManage, reload };
}

// Select com busca de empresa/pessoa (filtrado pelos tipos permitidos).
export function ThirdPartyPicker({ options, kinds, value, onPick, placeholder }: { options: ThirdPartyOption[]; kinds?: Kind[]; value: ThirdPartyOption | null; onPick: (item: ThirdPartyOption | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const key = searchKey(query.trim());
    return options.filter((item) => (!kinds || kinds.includes(item.kind)) && (!key || searchKey(`${item.name} ${item.document ?? ""} ${item.vehicles.map((vehicle) => vehicle.plate).join(" ")}`).includes(key))).slice(0, 40);
  }, [options, kinds, query]);
  if (value) return (
    <div className="material-product-chip"><strong>{value.name}</strong><small>{KIND_LABELS[value.kind]}</small><button type="button" onClick={(event) => { event.preventDefault(); onPick(null); }}>Trocar</button></div>
  );
  return (
    <div className="material-product-picker">
      <input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} placeholder={placeholder ?? "Buscar empresa, pessoa, CNPJ/CPF ou placa..."} />
      {open && <ul>
        {results.map((item) => (
          <li key={item.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); onPick(item); setQuery(""); setOpen(false); }}><b>{item.name}</b><small> · {KIND_LABELS[item.kind]}{item.vehicles.length ? ` · ${item.vehicles.length} veículo(s)` : ""}</small></button></li>
        ))}
        {results.length === 0 && <li className="muted"><small>Nenhum terceiro ativo encontrado.</small></li>}
      </ul>}
    </div>
  );
}

// Select com busca dos veículos da empresa escolhida.
export function ThirdPartyVehiclePicker({ vehicles, value, onPick, disabled }: { vehicles: VehicleOption[]; value: VehicleOption | null; onPick: (item: VehicleOption | null) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const key = searchKey(query.trim());
    return vehicles.filter((item) => !key || searchKey(`${item.plate} ${item.description ?? ""}`).includes(key)).slice(0, 40);
  }, [vehicles, query]);
  if (value) return (
    <div className="material-product-chip"><span className="material-item-kind linked">{value.plate}</span><strong>{value.description ?? "—"}</strong><small>{METER_LABEL[value.meterType]}</small><button type="button" onClick={(event) => { event.preventDefault(); onPick(null); }}>Trocar</button></div>
  );
  return (
    <div className="material-product-picker">
      <input value={query} disabled={disabled} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} placeholder={disabled ? "Escolha a empresa primeiro" : "Buscar placa ou modelo..."} />
      {open && !disabled && <ul>
        {results.map((item) => (
          <li key={item.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.preventDefault(); onPick(item); setQuery(""); setOpen(false); }}><b>{item.plate}</b> {item.description ?? ""}<small> · {METER_LABEL[item.meterType]}{item.lastReading !== null ? ` · última ${number(item.lastReading)}` : ""}</small></button></li>
        ))}
        {results.length === 0 && <li className="muted"><small>Nenhum veículo ativo desta empresa.</small></li>}
      </ul>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulários (também usados no cadastro rápido "+ Novo" do Combustível e da Movimentação)
// ---------------------------------------------------------------------------
export function ThirdPartyFormModal({ item, fronts, defaultKind, close, saved }: { item: ThirdParty | null; fronts: Option[]; defaultKind?: Kind; close: () => void; saved: (id: number, message: string) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation();
    setBusy(true); setError("");
    const form = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await api<{ id?: number; message: string }>(item ? `/api/third-parties/${item.id}` : "/api/third-parties", jsonBody(item ? "PUT" : "POST", form));
      await saved(result.id ?? item!.id, result.message);
    } catch (problem) { setError(problemText(problem, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal">
        <header><div><p className="eyebrow">TERCEIROS</p><h2>{item ? `Editar ${item.name}` : "Novo terceiro"}</h2><span>Empresa prestadora, terceirizada ou pessoa que não é da JC.</span></div><button type="button" onClick={close}>×</button></header>
        <form className="modal-form" onSubmit={submit}>
          <label className="full">Nome / razão social *<input name="name" required defaultValue={item?.name ?? ""} autoFocus /></label>
          <label>Tipo *<select name="kind" required defaultValue={item?.kind ?? defaultKind ?? "PRESTADOR"}>{(Object.keys(KIND_LABELS) as Kind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</select></label>
          <label>CNPJ / CPF<input name="document" inputMode="numeric" defaultValue={item?.document ?? ""} placeholder="Opcional" /></label>
          <label>Contato<input name="contactName" defaultValue={item?.contactName ?? ""} /></label>
          <label>Telefone<input name="phone" defaultValue={item?.phone ?? ""} /></label>
          <label>Frente principal<select name="serviceFrontId" defaultValue={item?.serviceFrontId ?? ""}><option value="">Todas / não informada</option>{fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>
          <label className="full">Observações<textarea name="notes" defaultValue={item?.notes ?? ""} /></label>
          {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
          <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button></div>
        </form>
      </section>
    </div>
  );
}

export function VehicleFormModal({ thirdParty, item, fuelTypes, close, saved }: { thirdParty: { id: number; name: string }; item: ThirdPartyVehicle | null; fuelTypes: Option[]; close: () => void; saved: (id: number, message: string) => void | Promise<void> }) {
  const [meterType, setMeterType] = useState<MeterType>(item?.meterType ?? "KM");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); event.stopPropagation();
    setBusy(true); setError("");
    const form = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await api<{ id?: number; message: string }>(item ? `/api/third-party-vehicles/${item.id}` : `/api/third-parties/${thirdParty.id}/vehicles`, jsonBody(item ? "PUT" : "POST", form));
      await saved(result.id ?? item!.id, result.message);
    } catch (problem) { setError(problemText(problem, "Não foi possível salvar o veículo.")); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal">
        <header><div><p className="eyebrow">VEÍCULO / MÁQUINA DE TERCEIRO</p><h2>{item ? `Editar ${item.plate}` : "Novo veículo"}</h2><span>{thirdParty.name}</span></div><button type="button" onClick={close}>×</button></header>
        <form className="modal-form" onSubmit={submit}>
          <label>Placa / identificação *<input name="plate" required defaultValue={item?.plate ?? ""} autoFocus /></label>
          <label>Modelo / descrição<input name="description" defaultValue={item?.description ?? ""} /></label>
          <label>Tipo *<select name="vehicleType" defaultValue={item?.vehicleType ?? "CAMINHAO"}>{(Object.keys(VEHICLE_LABELS) as VehicleType[]).map((type) => <option key={type} value={type}>{VEHICLE_LABELS[type]}</option>)}</select></label>
          <label>Medição *<select name="meterType" value={meterType} onChange={(event) => setMeterType(event.target.value as MeterType)}><option value="KM">KM (hodômetro)</option><option value="HORIMETRO">Horímetro (horas)</option></select></label>
          <label>Combustível<select name="fuelTypeId" defaultValue={item?.fuelTypeId ?? ""}><option value="">Não informado</option>{fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
          <label>Capacidade do tanque (L)<input name="tankCapacityLiters" inputMode="decimal" defaultValue={item?.tankCapacityLiters ?? ""} placeholder="Opcional" /></label>
          <label>Consumo esperado ({meterType === "KM" ? "km/L" : "L/h"})<input name="expectedConsumption" inputMode="decimal" defaultValue={item?.expectedConsumption ?? ""} placeholder="Opcional" /></label>
          <label>{item?.hasMovements ? "Última leitura (vem dos abastecimentos)" : "Leitura atual"}<input name="lastReading" inputMode="decimal" disabled={item?.hasMovements} defaultValue={item?.lastReading ?? ""} placeholder="Opcional" /></label>
          {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
          <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar veículo"}</button></div>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tela do cadastro
// ---------------------------------------------------------------------------
export default function ThirdPartiesView({ authUser, flash, embedded = false }: { authUser: User; flash: (message: string) => void; embedded?: boolean }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "INACTIVE" | "ALL">("ACTIVE");
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<ThirdParty | "new" | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<{ party: ThirdParty; item: ThirdPartyVehicle | null } | null>(null);
  const canManage = data?.canManage ?? authUser.permissions.includes("third_parties.manage");
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query.trim()), 300); return () => window.clearTimeout(timer); }, [query]);
  const load = useCallback(async () => {
    setError("");
    const params = new URLSearchParams({ situacao: status });
    if (debounced) params.set("q", debounced);
    if (kind) params.set("tipo", kind);
    try { setData(await api<ListResponse>(`/api/third-parties?${params.toString()}`)); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar os terceiros.")); }
  }, [debounced, kind, status]);
  useEffect(() => { load(); }, [load]);

  async function act(url: string, init: RequestInit, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    try { flash((await api<{ message: string }>(url, init)).message); await load(); }
    catch (problem) { window.alert(problemText(problem, "Não foi possível concluir.")); }
  }
  const opened = data?.thirdParties.find((party) => party.id === openId) ?? null;

  return (
    <>
      {!embedded && <div className="page-heading module-heading"><div><p className="eyebrow">CADASTRO · TERCEIROS</p><h1>Terceiros</h1><span>Empresas prestadoras, terceirizadas e pessoas que não são da JC, com os veículos e máquinas delas — usados na saída de combustível e na saída de produtos.</span></div></div>}
      <article className="panel module-panel equipment-management-panel">
        <div className="stock-filters third-party-filters">
          <label className="page-search stock-filter-wide"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, CNPJ/CPF, placa ou modelo..." /></label>
          <label>Tipo<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Todos</option>{(Object.keys(KIND_LABELS) as Kind[]).map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}</select></label>
          <label>Situação<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="ACTIVE">Ativos</option><option value="INACTIVE">Inativos</option><option value="ALL">Todos</option></select></label>
          {canManage && <button type="button" className="primary" onClick={() => setEditing("new")}>＋ Novo terceiro</button>}
        </div>
        {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
        {!data && !error ? <div className="page-loading"><span /><p>Carregando terceiros...</p></div> : data && (
          <div className="table-scroll">
            <table className="third-party-table">
              <thead><tr><th>Empresa / pessoa</th><th>Tipo</th><th>CNPJ / CPF</th><th>Contato</th><th>Frente</th><th>Veículos</th><th>Situação</th><th>Ações</th></tr></thead>
              <tbody>{data.thirdParties.map((party) => (
                <tr key={party.id} className={`${party.active ? "" : "stock-row-reversed"} ${openId === party.id ? "selected" : ""}`}>
                  <td><strong>{party.name}</strong>{party.notes && <small className="table-sub">{party.notes}</small>}</td>
                  <td>{party.kindLabel}</td>
                  <td>{formatDocument(party.document)}</td>
                  <td>{party.contactName ?? "—"}{party.phone && <small className="table-sub">{party.phone}</small>}</td>
                  <td>{party.front ?? "Todas"}</td>
                  <td>{party.vehicles.filter((vehicle) => vehicle.active).length}{party.vehicles.some((vehicle) => !vehicle.active) && <small className="table-sub">+{party.vehicles.filter((vehicle) => !vehicle.active).length} inativo(s)</small>}</td>
                  <td><span className={`status-pill ${party.active ? "green" : "gray"}`}>{party.active ? "Ativo" : "Inativo"}</span></td>
                  <td><div className="equipment-row-actions">
                    <button onClick={() => setOpenId(openId === party.id ? null : party.id)}>{openId === party.id ? "Fechar" : "Veículos"}</button>
                    {canManage && <button onClick={() => setEditing(party)}>Editar</button>}
                    {canManage && <button onClick={() => act(`/api/third-parties/${party.id}`, jsonBody("PUT", { active: !party.active }), party.active ? `Inativar ${party.name}? Ele deixa de aparecer nos lançamentos (o histórico fica).` : undefined)}>{party.active ? "Inativar" : "Reativar"}</button>}
                    {canManage && !party.hasMovements && !party.vehicles.some((vehicle) => vehicle.hasMovements) && <button onClick={() => act(`/api/third-parties/${party.id}`, { method: "DELETE" }, `Excluir ${party.name} e os veículos dele? (só é possível porque ainda não tem movimentação)`)}>Excluir</button>}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
            {data.thirdParties.length === 0 && <div className="empty-state">Nenhum terceiro encontrado para os filtros.</div>}
          </div>
        )}
      </article>
      {opened && data && (
        <article className="panel module-panel third-party-vehicles-panel">
          <div className="panel-head"><div><h2>Veículos e máquinas — {opened.name}</h2><p>Última leitura e média de consumo (dos abastecimentos das frentes que você enxerga).</p></div>
            {canManage && <button className="primary" onClick={() => setEditingVehicle({ party: opened, item: null })}>＋ Novo veículo</button>}</div>
          <div className="table-scroll">
            <table className="third-party-table">
              <thead><tr><th>Placa</th><th>Modelo</th><th>Tipo</th><th>Medição</th><th>Última leitura</th><th>Média de consumo</th><th>Tanque</th><th>Situação</th>{canManage && <th>Ações</th>}</tr></thead>
              <tbody>{opened.vehicles.map((vehicle) => (
                <tr key={vehicle.id} className={vehicle.active ? "" : "stock-row-reversed"}>
                  <td><strong>{vehicle.plate}</strong></td>
                  <td>{vehicle.description ?? "—"}{vehicle.fuelName && <small className="table-sub">{vehicle.fuelName}</small>}</td>
                  <td>{VEHICLE_LABELS[vehicle.vehicleType]}</td>
                  <td>{METER_LABEL[vehicle.meterType]}</td>
                  <td>{number(vehicle.lastReading)}</td>
                  <td>{vehicle.averageConsumption === null ? <small className="table-sub">{vehicle.fuelings ? "sem consumo calculado" : "sem abastecimentos"}</small> : <strong>{number(vehicle.averageConsumption)} {vehicle.consumptionUnit}</strong>}
                    {vehicle.expectedConsumption !== null && <small className="table-sub">esperado {number(vehicle.expectedConsumption)} {vehicle.consumptionUnit}</small>}</td>
                  <td>{vehicle.tankCapacityLiters === null ? "—" : `${number(vehicle.tankCapacityLiters)} L`}</td>
                  <td><span className={`status-pill ${vehicle.active ? "green" : "gray"}`}>{vehicle.active ? "Ativo" : "Inativo"}</span></td>
                  {canManage && <td><div className="equipment-row-actions">
                    <button onClick={() => setEditingVehicle({ party: opened, item: vehicle })}>Editar</button>
                    <button onClick={() => act(`/api/third-party-vehicles/${vehicle.id}`, jsonBody("PUT", { active: !vehicle.active }))}>{vehicle.active ? "Inativar" : "Reativar"}</button>
                    {!vehicle.hasMovements && <button onClick={() => act(`/api/third-party-vehicles/${vehicle.id}`, { method: "DELETE" }, `Excluir o veículo ${vehicle.plate}?`)}>Excluir</button>}
                  </div></td>}
                </tr>
              ))}</tbody>
            </table>
            {opened.vehicles.length === 0 && <div className="empty-state">Nenhum veículo cadastrado para este terceiro.</div>}
          </div>
        </article>
      )}
      {editing && data && <ThirdPartyFormModal item={editing === "new" ? null : editing} fronts={data.fronts} close={() => setEditing(null)}
        saved={async (id, message) => { setEditing(null); flash(message); await load(); setOpenId(id); }} />}
      {editingVehicle && data && <VehicleFormModal thirdParty={editingVehicle.party} item={editingVehicle.item} fuelTypes={data.fuelTypes} close={() => setEditingVehicle(null)}
        saved={async (_id, message) => { setEditingVehicle(null); flash(message); await load(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Relatório "Consumo de Terceiros" (aba Combustível)
// ---------------------------------------------------------------------------
type ReportVehicle = { id: number; plate: string; description: string | null; company: string; thirdPartyId: number; meterType: MeterType; unit: string; fuelings: number; liters: number; distance: number; average: number | null; lastReading: number | null; outliers: number };
type ReportCompany = { thirdPartyId: number; company: string; vehicles: number; fuelings: number; liters: number; outliers: number };
type ReportResponse = { vehicles: ReportVehicle[]; companies: ReportCompany[]; filters: { from: string; to: string }; fronts: Option[] };

export function ThirdPartyConsumptionReport() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [front, setFront] = useState("");
  const [party, setParty] = useState<ThirdPartyOption | null>(null);
  const [vehicle, setVehicle] = useState<VehicleOption | null>(null);
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState("");
  const options = useThirdPartyOptions();
  const params = useMemo(() => {
    const value = new URLSearchParams({ de: from, ate: to });
    if (front) value.set("frente", front);
    if (party) value.set("terceiro", String(party.id));
    if (vehicle) value.set("veiculo", String(vehicle.id));
    return value.toString();
  }, [from, to, front, party, vehicle]);
  useEffect(() => {
    setError("");
    api<ReportResponse>(`/api/third-parties/consumption?${params}`).then(setData).catch((problem) => setError(problemText(problem, "Não foi possível gerar o relatório.")));
  }, [params]);
  const totals = (data?.companies ?? []).reduce((sum, row) => ({ fuelings: sum.fuelings + row.fuelings, liters: sum.liters + row.liters, outliers: sum.outliers + row.outliers }), { fuelings: 0, liters: 0, outliers: 0 });
  return (
    <article className="panel module-panel fuel-history-panel">
      <div className="products-filters fuel-history-filters">
        <label>De<input type="date" value={from} max={to} onChange={(event) => event.target.value && setFrom(event.target.value)} /></label>
        <label>Até<input type="date" value={to} min={from} onChange={(event) => event.target.value && setTo(event.target.value)} /></label>
        {data && data.fronts.length > 1 && <label>Frente<select value={front} onChange={(event) => setFront(event.target.value)}><option value="">Todas em exibição</option>{data.fronts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <label className="stock-filter-wide">Empresa<ThirdPartyPicker options={options.options} value={party} onPick={(item) => { setParty(item); setVehicle(null); }} /></label>
        <label className="stock-filter-wide">Veículo<ThirdPartyVehiclePicker vehicles={party?.vehicles ?? []} value={vehicle} onPick={setVehicle} disabled={!party} /></label>
        <div className="fuel-export-actions"><a className="secondary" href={`/api/third-parties/consumption?${params}&formato=xlsx`}>Exportar Excel</a></div>
      </div>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div></div>}
      {!data && !error ? <div className="page-loading"><span /><p>Calculando consumo...</p></div> : data && (
        <>
          <p className="stock-summary">{data.vehicles.length} veículo(s) · {totals.fuelings} abastecimento(s) · {number(totals.liters)} L · {totals.outliers} fora da média. Média = total rodado ÷ litros (horímetro: litros ÷ horas), sem o primeiro abastecimento de cada veículo.</p>
          <div className="table-scroll">
            <table className="products-table fuel-history-table">
              <thead><tr><th>Empresa</th><th>Placa</th><th>Modelo</th><th>Abastecimentos</th><th>Litros</th><th>Rodado</th><th>Média</th><th>Última leitura</th><th>Fora da média</th></tr></thead>
              <tbody>{data.vehicles.map((row) => (
                <tr key={row.id}>
                  <td>{row.company}</td><td><strong>{row.plate}</strong></td><td>{row.description ?? "—"}</td><td>{row.fuelings}</td>
                  <td className="price-cell">{number(row.liters)} L</td><td className="price-cell">{number(row.distance)} {row.meterType === "KM" ? "km" : "h"}</td>
                  <td className="price-cell"><strong>{row.average === null ? "—" : `${number(row.average)} ${row.unit}`}</strong></td>
                  <td className="price-cell">{number(row.lastReading)}</td>
                  <td>{row.outliers > 0 ? <span className="fuel-pending-badge">{row.outliers}</span> : "0"}</td>
                </tr>
              ))}</tbody>
            </table>
            {data.vehicles.length === 0 && <div className="empty-state">Nenhum abastecimento de terceiro no período e filtros.</div>}
          </div>
          {data.companies.length > 0 && (
            <div className="table-scroll">
              <table className="products-table fuel-history-table">
                <thead><tr><th>Totais por empresa</th><th>Veículos</th><th>Abastecimentos</th><th>Litros</th><th>Fora da média</th></tr></thead>
                <tbody>{data.companies.map((row) => <tr key={row.thirdPartyId}><td><strong>{row.company}</strong></td><td>{row.vehicles}</td><td>{row.fuelings}</td><td className="price-cell">{number(row.liters)} L</td><td>{row.outliers}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </article>
  );
}
