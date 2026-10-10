"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { consumirFiltros, type NavegacaoAssistente } from "../lib/assistente-nav";
import { DepartmentsModal, useDepartments, type Department } from "./DepartmentsManager";
import StockMovementsTable, { type StockMovementRow } from "./StockMovementsTable";
import { ThirdPartyPicker, ThirdPartyVehiclePicker, ThirdPartyWorkerPicker, useThirdPartyOptions, WorkerFormModal, type ThirdPartyOption, type VehicleOption, type WorkerOption } from "./ThirdPartiesView";
import {
  api, ApiError, brDay, CatalogPicker, EmployeePicker, EquipmentPicker, jsonBody, localToday, moneyFormat, parseQty, problemText, ProductPicker, qtyFormat, ShortageNotice,
  type CatalogOption, type EmployeeOption, type EquipmentOption, type ProductOption, type Shortage, type StockOptions,
} from "./stock-client";
import LoadWarning from "./LoadWarning";

type User = { name: string; permissions: string[] };
type ExitDoc = {
  id: number; number: string; exitDate: string; destination: string | null; front: string; notes: string | null;
  cancelledAt: string | null; cancelReason: string | null; createdBy: string | null; items: Array<{ tag: string; name: string; quantity: number; unitPrice: number | null }>;
  // Lançada pela Produção: estorno só pela Produção.
  productionProjectId?: number | null;
};
type ListResponse = { movements: StockMovementRow[]; exits: ExitDoc[]; canCreate: boolean; canCancel: boolean };
type Tab = "movimentar" | "historico";

const asOption = (department: Department | null): CatalogOption | null => (department ? { id: department.id, name: department.name } : null);

// Movimentação em duas abas: "Movimentar" já abre com o lançamento pronto (veículo, funcionário,
// departamento, data e produtos) e "Histórico" só carrega quando é aberta, com os filtros.
export default function StockExitsView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const canCreate = authUser.permissions.includes("stock.exits_create");
  // Aberto pelo "Ver no sistema" do Assistente JC: já no Histórico com o período da consulta.
  const [assistantFilters] = useState(() => (typeof window === "undefined" ? null : consumirFiltros("Movimentação")));
  const [tab, setTab] = useState<Tab>(canCreate && !assistantFilters ? "movimentar" : "historico");
  const [options, setOptions] = useState<StockOptions>({ fronts: [], defaultFrontId: null, equipment: [] });
  const departments = useDepartments();
  const [managing, setManaging] = useState(false);
  const [optionsError, setOptionsError] = useState("");
  useEffect(() => { api<StockOptions>("/api/stock/options").then(setOptions).catch(() => setOptionsError("Não foi possível carregar as frentes e os equipamentos. Recarregue a página ou verifique a conexão.")); }, []);

  return (
    <>
      <LoadWarning message={optionsError} />
      <div className="page-heading module-heading">
        <div><p className="eyebrow">ESTOQUE · SAÍDAS</p><h1>Movimentação</h1><span>Saída de produtos do estoque para um veículo, um funcionário e/ou um departamento — ou para um terceiro / prestador. Cada lançamento recebe um número (SAI-000123) e aparece no histórico do produto.</span></div>
        {departments.canManage && <div className="heading-actions"><button className="secondary" onClick={() => setManaging(true)}>Departamentos</button></div>}
      </div>
      <div className="main-tabs secondary-module-nav" role="tablist">
        {canCreate && <button type="button" role="tab" aria-selected={tab === "movimentar"} className={tab === "movimentar" ? "active" : ""} onClick={() => setTab("movimentar")}>Movimentar</button>}
        <button type="button" role="tab" aria-selected={tab === "historico"} className={tab === "historico" ? "active" : ""} onClick={() => setTab("historico")}>Histórico</button>
      </div>
      {tab === "movimentar" && canCreate
        ? <MovementForm options={options} departments={departments.departments} createDepartment={departments.canManage ? departments.create : undefined} flash={flash} />
        : <HistoryPanel options={options} departments={departments.departments} flash={flash} initial={assistantFilters} />}
      {managing && <DepartmentsModal close={() => setManaging(false)} changed={departments.reload} flash={flash} />}
    </>
  );
}

// RELATÓRIOS → Peças e produtos → Saídas de produtos: o mesmo Histórico da Movimentação (filtros e Excel).
export function StockExitsReport({ flash }: { flash: (message: string) => void }) {
  const [options, setOptions] = useState<StockOptions>({ fronts: [], defaultFrontId: null, equipment: [] });
  const departments = useDepartments();
  const [optionsError, setOptionsError] = useState("");
  useEffect(() => { api<StockOptions>("/api/stock/options").then(setOptions).catch(() => setOptionsError("Não foi possível carregar os equipamentos para o filtro.")); }, []);
  return <><LoadWarning message={optionsError} /><HistoryPanel options={options} departments={departments.departments} flash={flash} /></>;
}

type Line = { key: string; product: ProductOption | null; quantity: string };
const newLine = (): Line => ({ key: crypto.randomUUID(), product: null, quantity: "" });

function MovementForm({ options, departments, createDepartment, flash }: {
  options: StockOptions; departments: Department[]; createDepartment?: (name: string) => Promise<Department>; flash: (message: string) => void;
}) {
  const [frontId, setFrontId] = useState("");
  const [exitDate, setExitDate] = useState(localToday());
  const [equipmentItem, setEquipmentItem] = useState<EquipmentOption | null>(null);
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [department, setDepartment] = useState<CatalogOption | null>(null);
  // Destino: equipamento próprio / funcionário / departamento, ou Terceiro / Prestador (cadastro de terceiros).
  const [destination, setDestination] = useState<"PROPRIO" | "TERCEIRO">("PROPRIO");
  const thirdPartyOptions = useThirdPartyOptions();
  const [party, setParty] = useState<ThirdPartyOption | null>(null);
  const [partyVehicle, setPartyVehicle] = useState<VehicleOption | null>(null);
  const [receivedBy, setReceivedBy] = useState("");
  // Destino no terceiro: veículo da empresa ou funcionário dela (peças para motosserra, EPI...).
  const [partyTarget, setPartyTarget] = useState<"VEICULO" | "FUNCIONARIO">("VEICULO");
  const [partyWorker, setPartyWorker] = useState<WorkerOption | null>(null);
  const [creatingWorker, setCreatingWorker] = useState(false);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState("");
  const selectedFront = frontId || (options.defaultFrontId ? String(options.defaultFrontId) : "");
  const patch = (key: string, value: Partial<Line>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...value } : line)));
  const reset = () => { setEquipmentItem(null); setEmployee(null); setDepartment(null); setParty(null); setPartyVehicle(null); setPartyWorker(null); setReceivedBy(""); setNotes(""); setLines([newLine()]); setShortages([]); };
  const toThirdParty = destination === "TERCEIRO";

  async function submit(event: FormEvent | null, allowNegative = false) {
    event?.preventDefault();
    setError("");
    if (toThirdParty && !party) { setError("Escolha a empresa/pessoa (Terceiro / Prestador)."); return; }
    if (toThirdParty && partyTarget === "FUNCIONARIO" && !partyWorker) { setError("Escolha o funcionário do terceiro (ou mude o destino para Veículo)."); return; }
    if (toThirdParty && !receivedBy.trim()) { setError("Informe quem recebeu os produtos (Recebido por)."); return; }
    if (!toThirdParty && !equipmentItem && !employee && !department) { setError("Informe o destino: veículo, funcionário e/ou departamento."); return; }
    if (lines.some((line) => !line.product)) { setError("Escolha o produto de todos os itens (ou remova a linha vazia)."); return; }
    setBusy(true);
    try {
      const result = await api<{ message: string; number: string }>("/api/stock-exits", jsonBody("POST", {
        serviceFrontId: Number(selectedFront), exitDate, notes, allowNegative,
        ...(toThirdParty
          ? { destinationType: "THIRD_PARTY", thirdPartyId: party!.id, ...(partyTarget === "FUNCIONARIO" ? { thirdPartyVehicleId: null, thirdPartyEmployeeId: partyWorker?.id ?? null } : { thirdPartyVehicleId: partyVehicle?.id ?? null, thirdPartyEmployeeId: null }), receivedBy }
          : { equipmentId: equipmentItem?.id ?? null, employeeId: employee?.id ?? null, departmentId: department?.id ?? null }),
        items: lines.map((line) => ({ productId: line.product!.id, quantity: parseQty(line.quantity) })),
      }));
      flash(result.message); setLast(result.message); reset();
    } catch (problem) {
      if (problem instanceof ApiError && Array.isArray(problem.data.shortages)) setShortages(problem.data.shortages as Shortage[]);
      setError(problemText(problem, "Não foi possível lançar a saída."));
    } finally { setBusy(false); }
  }

  return (
    <article className="panel module-panel">
      <form className="stock-movement-form" onSubmit={(event) => submit(event)}>
        <div className="fleet-form-grid stock-movement-grid">
          {options.fronts.length > 1 && <label>Frente do estoque *<select required value={selectedFront} onChange={(event) => { setFrontId(event.target.value); setLines((current) => current.map((line) => ({ ...line, product: null }))); }}><option value="" disabled>Selecione</option>{options.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
          <fieldset className="fuel-exit-kind stock-destination-kind">
            <legend>Destino</legend>
            <button type="button" className={destination === "PROPRIO" ? "active" : ""} aria-pressed={destination === "PROPRIO"} onClick={() => setDestination("PROPRIO")}>Equipamento próprio / funcionário / departamento</button>
            <button type="button" className={destination === "TERCEIRO" ? "active" : ""} aria-pressed={destination === "TERCEIRO"} onClick={() => setDestination("TERCEIRO")}>Terceiro / Prestador</button>
          </fieldset>
          {toThirdParty ? <>
            <label>Empresa / pessoa *<ThirdPartyPicker options={thirdPartyOptions.options} loadError={thirdPartyOptions.error} value={party} onPick={(item) => { setParty(item); setPartyVehicle(null); setPartyWorker(null); }} /></label>
            {party && <div className="fuel-third-party-field"><span className="fuel-field-label">Destino *</span>
              <div className="fuel-destination-switch" role="group" aria-label="Destino no terceiro">
                {([["VEICULO", "Veículo"], ["FUNCIONARIO", "Funcionário"]] as const).map(([value, label]) => <button type="button" key={value} className={partyTarget === value ? "active" : ""} aria-pressed={partyTarget === value} onClick={() => setPartyTarget(value)}>{label}</button>)}
              </div></div>}
            {partyTarget === "FUNCIONARIO" && party
              ? <div className="fuel-third-party-field"><span className="fuel-field-label">Funcionário do terceiro *{thirdPartyOptions.canManage && <button type="button" className="link-button" onClick={() => setCreatingWorker(true)}>＋ Novo</button>}</span>
                <ThirdPartyWorkerPicker workers={party.employees} value={partyWorker} onPick={(item) => { setPartyWorker(item); if (item && !receivedBy.trim()) setReceivedBy(item.name); }} /></div>
              : <label>Veículo do terceiro<ThirdPartyVehiclePicker vehicles={party?.vehicles ?? []} value={partyVehicle} onPick={setPartyVehicle} disabled={!party} /></label>}
            <label>Recebido por *<input required value={receivedBy} list={party?.employees.length ? "stock-party-workers" : undefined} onChange={(event) => setReceivedBy(event.target.value)} placeholder="Escolha um funcionário da empresa ou digite o nome" />
              {party && party.employees.length > 0 && <datalist id="stock-party-workers">{party.employees.map((item) => <option key={item.id} value={item.name}>{item.jobTitle ?? ""}</option>)}</datalist>}</label>
          </> : <>
            <label>Veículo / equipamento<EquipmentPicker options={options.equipment} value={equipmentItem} onPick={setEquipmentItem} placeholder="Buscar pelo prefixo..." /></label>
            <label>Funcionário<EmployeePicker value={employee} frontId={null} onPick={setEmployee} placeholder="Buscar funcionário..." /></label>
            <label>Departamento<CatalogPicker options={departments.map(asOption).filter((row): row is CatalogOption => row !== null)} value={department} onPick={setDepartment}
              onCreate={createDepartment} placeholder="Buscar departamento..." createLabel="Cadastrar novo departamento" /></label>
          </>}
          <label>Data *<input type="date" required max={localToday()} value={exitDate} onChange={(event) => setExitDate(event.target.value)} /></label>
        </div>
        <small className="material-item-hint">{toThirdParty ? "Saída para terceiro: empresa e quem recebeu são obrigatórios; no destino Veículo a placa é opcional, no destino Funcionário escolha o funcionário da empresa. Terceiros ativos do cadastro (Combustível → Terceiros ou menu Produtos → Terceiros)." : "Informe pelo menos um destino: veículo, funcionário e/ou departamento."}</small>
        <section className="fleet-form-section">
          <div className="fleet-section-title"><h3>Produtos <small>({lines.length})</small></h3></div>
          {lines.map((line, index) => (
            <div className="stock-movement-line" key={line.key}>
              <b>{index + 1}</b>
              <label>Produto *<ProductPicker value={line.product} frontId={Number(selectedFront) || null} onPick={(product) => patch(line.key, { product })} /></label>
              <label>Quantidade *<input required inputMode="decimal" value={line.quantity} onChange={(event) => patch(line.key, { quantity: event.target.value })} /></label>
              {lines.length > 1 ? <button type="button" className="link-button" onClick={() => setLines(lines.filter((item) => item.key !== line.key))}>remover</button> : <span />}
            </div>
          ))}
          <button type="button" className="secondary po-add-item" onClick={() => setLines([...lines, newLine()])}>＋ Adicionar produto</button>
        </section>
        <label className="fleet-notes">Observações<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {shortages.length > 0 && <ShortageNotice shortages={shortages} busy={busy} confirm={() => submit(null, true)} />}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
        {last && !error && <p className="stock-summary">Último lançamento: {last}</p>}
        <div className="stock-movement-actions"><button type="button" className="secondary" onClick={reset} disabled={busy}>Limpar</button><button className="primary" disabled={busy}>{busy ? "LANÇANDO..." : "LANÇAR SAÍDA"}</button></div>
      </form>
      {creatingWorker && party && <WorkerFormModal thirdParty={party} item={null} close={() => setCreatingWorker(false)}
        saved={async (id, message) => { setCreatingWorker(false); flash(message); const list = await thirdPartyOptions.reload(); const updated = list.find((item) => item.id === party.id) ?? party; setParty(updated);
          const created = updated.employees.find((item) => item.id === id) ?? null; setPartyWorker(created); if (created && !receivedBy.trim()) setReceivedBy(created.name); }} />}
    </article>
  );
}

// Histórico: só carrega quando a aba é aberta (como no Combustível). Filtros combináveis.
function HistoryPanel({ options, departments, flash, initial }: { options: StockOptions; departments: Department[]; flash: (message: string) => void; initial?: NavegacaoAssistente | null }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"itens" | "saidas">("itens");
  const [equipmentFilter, setEquipmentFilter] = useState<EquipmentOption | null>(null);
  const [employeeFilter, setEmployeeFilter] = useState<EmployeeOption | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [productFilter, setProductFilter] = useState<ProductOption | null>(null);
  const thirdPartyOptions = useThirdPartyOptions();
  const [partyFilter, setPartyFilter] = useState<ThirdPartyOption | null>(null);
  const [partyVehicleFilter, setPartyVehicleFilter] = useState<VehicleOption | null>(null);
  const [partyWorkerFilter, setPartyWorkerFilter] = useState<WorkerOption | null>(null);
  const [from, setFrom] = useState(initial?.de ?? "");
  const [to, setTo] = useState(initial?.ate ?? "");
  const query = new URLSearchParams(Object.entries({
    equipamento: equipmentFilter ? String(equipmentFilter.id) : "", funcionario: employeeFilter ? String(employeeFilter.id) : "", departamento: departmentFilter,
    produto: productFilter ? String(productFilter.id) : "", de: from, ate: to,
    terceiro: partyFilter ? String(partyFilter.id) : "", veiculoTerceiro: partyVehicleFilter ? String(partyVehicleFilter.id) : "",
    funcionarioTerceiro: partyWorkerFilter ? String(partyWorkerFilter.id) : "",
  }).filter(([, value]) => value)).toString();
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<ListResponse>(`/api/stock-exits${query ? `?${query}` : ""}`)); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar a movimentação.")); }
  }, [query]);
  useEffect(() => { load(); }, [load]);
  async function cancelExit(exit: ExitDoc) {
    const reason = window.prompt(`Motivo do estorno da saída ${exit.number} (o estoque volta para a frente):`);
    if (!reason?.trim()) return;
    try { flash((await api<{ message: string }>(`/api/stock-exits/${exit.id}`, jsonBody("PUT", { reason }))).message); await load(); }
    catch (problem) { window.alert(problemText(problem, "Não foi possível estornar.")); }
  }
  const clear = () => { setEquipmentFilter(null); setEmployeeFilter(null); setDepartmentFilter(""); setProductFilter(null); setPartyFilter(null); setPartyVehicleFilter(null); setPartyWorkerFilter(null); setFrom(""); setTo(""); };
  const hasFilters = Boolean(query);
  const total = (data?.movements ?? []).reduce((sum, row) => sum + (row.total ?? 0), 0);

  return (
    <article className="panel module-panel equipment-management-panel">
      <div className="stock-filters stock-history-filters">
        <label className="stock-filter-wide">Veículo<EquipmentPicker options={options.equipment} value={equipmentFilter} onPick={setEquipmentFilter} /></label>
        <label className="stock-filter-wide">Funcionário<EmployeePicker value={employeeFilter} frontId={null} onPick={setEmployeeFilter} /></label>
        <label>Departamento<select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option value="">Todos</option>{departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="stock-filter-wide stock-filter-product">Peça / produto<ProductPicker value={productFilter} frontId={null} onPick={setProductFilter} /></label>
        <label className="stock-filter-wide">Terceiro / prestador<ThirdPartyPicker options={thirdPartyOptions.options} loadError={thirdPartyOptions.error} value={partyFilter} onPick={(item) => { setPartyFilter(item); setPartyVehicleFilter(null); setPartyWorkerFilter(null); }} /></label>
        {partyFilter && <label className="stock-filter-wide">Veículo do terceiro<ThirdPartyVehiclePicker vehicles={partyFilter.vehicles} value={partyVehicleFilter} onPick={setPartyVehicleFilter} /></label>}
        {partyFilter && partyFilter.employees.length > 0 && <label className="stock-filter-wide">Funcionário do terceiro<ThirdPartyWorkerPicker workers={partyFilter.employees} value={partyWorkerFilter} onPick={setPartyWorkerFilter} /></label>}
        <label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        {hasFilters && <button type="button" className="secondary" onClick={clear}>Limpar filtros</button>}
        <a className="secondary" href={`/api/stock-exits/export${query ? `?${query}` : ""}`}>Exportar Excel</a>
      </div>
      <div className="main-tabs secondary-module-nav" role="tablist">
        <button type="button" className={view === "itens" ? "active" : ""} onClick={() => setView("itens")}>Produtos movimentados</button>
        <button type="button" className={view === "saidas" ? "active" : ""} onClick={() => setView("saidas")}>Lançamentos (SAI)</button>
      </div>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
      {!data && !error ? <div className="page-loading"><span /><p>Carregando histórico...</p></div> : data && view === "itens" ? (
        <>
          <p className="stock-summary">{data.movements.length} lançamento(s) · valor total {moneyFormat.format(total)} · inclui as peças das O.S. já fechadas.</p>
          <StockMovementsTable rows={data.movements} showProduct empty="Nenhuma saída encontrada para os filtros." />
        </>
      ) : data && (
        <div className="table-scroll">
          <table className="stock-exits-table">
            <thead><tr><th>Saída</th><th title="Veículo · funcionário · departamento">Destino</th><th>Itens</th><th title="Frente do estoque · quem lançou">Frente</th>{data.canCancel && <th>Ações</th>}</tr></thead>
            <tbody>{data.exits.map((exit) => (
              <tr key={exit.id} className={exit.cancelledAt ? "stock-row-reversed" : ""}>
                <td><strong>{exit.number}</strong>{exit.productionProjectId ? <span className="production-badge running" title="Lançada pela Produção: altere ou estorne pela aba Produção"> Produção</span> : null}<small className="table-sub">{brDay(exit.exitDate)}{exit.cancelledAt ? ` · estornada: ${exit.cancelReason ?? ""}` : ""}</small></td>
                <td>{exit.destination ?? "—"}{exit.notes && <small className="table-sub">{exit.notes}</small>}</td>
                <td>{exit.items.map((item, index) => <small key={index} className="stock-exit-line">{item.tag} {item.name} — {qtyFormat.format(item.quantity)}{item.unitPrice !== null ? ` · ${moneyFormat.format(item.unitPrice * item.quantity)}` : ""}</small>)}</td>
                <td>{exit.front}<small className="table-sub">{exit.createdBy ?? "—"}</small></td>
                {data.canCancel && <td>{!exit.cancelledAt && !exit.productionProjectId && <div className="equipment-row-actions"><button onClick={() => cancelExit(exit)}>Estornar</button></div>}</td>}
              </tr>
            ))}</tbody>
          </table>
          {data.exits.length === 0 && <div className="empty-state">Nenhuma saída lançada para os filtros.</div>}
        </div>
      )}
    </article>
  );
}
