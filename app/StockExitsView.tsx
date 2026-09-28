"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import StockMovementsTable, { type StockMovementRow } from "./StockMovementsTable";
import {
  api, ApiError, brDay, EmployeePicker, EquipmentPicker, jsonBody, localToday, moneyFormat, parseQty, problemText, ProductPicker, qtyFormat, ShortageNotice,
  type EmployeeOption, type EquipmentOption, type ProductOption, type Shortage, type StockOptions,
} from "./stock-client";

type User = { name: string; permissions: string[] };
type ExitDoc = {
  id: number; number: string; exitDate: string; destinationType: "EMPLOYEE" | "EQUIPMENT"; destination: string | null; front: string; notes: string | null;
  cancelledAt: string | null; cancelReason: string | null; createdBy: string | null; items: Array<{ tag: string; name: string; quantity: number; unitPrice: number | null }>;
};
type ListResponse = { movements: StockMovementRow[]; exits: ExitDoc[]; canCreate: boolean; canCancel: boolean };
type Quick = "TODAS" | "VEICULO" | "FUNCIONARIO";

// Movimentação: saída de produtos do estoque para funcionário ou equipamento (SAI-000123) e o
// histórico das saídas (inclui as peças das O.S. fechadas) com filtros rápidos.
export default function StockExitsView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [options, setOptions] = useState<StockOptions>({ fronts: [], defaultFrontId: null, equipment: [] });
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"itens" | "saidas">("itens");
  const [quick, setQuick] = useState<Quick>("TODAS");
  const [equipmentFilter, setEquipmentFilter] = useState<EquipmentOption | null>(null);
  const [employeeFilter, setEmployeeFilter] = useState<EmployeeOption | null>(null);
  const [productFilter, setProductFilter] = useState<ProductOption | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [creating, setCreating] = useState(false);
  const canCreate = authUser.permissions.includes("stock.exits_create");

  useEffect(() => { api<StockOptions>("/api/stock/options").then(setOptions).catch(() => undefined); }, []);
  const query = new URLSearchParams(Object.entries({
    equipamento: equipmentFilter ? String(equipmentFilter.id) : "", funcionario: employeeFilter ? String(employeeFilter.id) : "",
    produto: productFilter ? String(productFilter.id) : "", de: from, ate: to,
  }).filter(([, value]) => value)).toString();
  const load = useCallback(async () => {
    setError("");
    try { setData(await api<ListResponse>(`/api/stock-exits${query ? `?${query}` : ""}`)); }
    catch (problem) { setError(problemText(problem, "Não foi possível carregar a movimentação.")); }
  }, [query]);
  useEffect(() => { load(); }, [load]);

  function chooseQuick(value: Quick) {
    setQuick(value);
    if (value !== "VEICULO") setEquipmentFilter(null);
    if (value !== "FUNCIONARIO") setEmployeeFilter(null);
  }
  async function cancelExit(exit: ExitDoc) {
    const reason = window.prompt(`Motivo do estorno da saída ${exit.number} (o estoque volta para a frente):`);
    if (!reason?.trim()) return;
    try { flash((await api<{ message: string }>(`/api/stock-exits/${exit.id}`, jsonBody("PUT", { reason }))).message); await load(); }
    catch (problem) { window.alert(problemText(problem, "Não foi possível estornar.")); }
  }
  const total = (data?.movements ?? []).reduce((sum, row) => sum + (row.total ?? 0), 0);

  return (
    <>
      <div className="page-heading module-heading">
        <div><p className="eyebrow">ESTOQUE · SAÍDAS</p><h1>Movimentação</h1><span>Saída de produtos do estoque para um funcionário ou um equipamento. Cada saída recebe um número (SAI-000123) e aparece no histórico do produto.</span></div>
        {canCreate && <div className="heading-actions"><button className="primary" onClick={() => setCreating(true)}>＋ Nova saída</button></div>}
      </div>
      <article className="panel module-panel equipment-management-panel">
        <div className="main-tabs secondary-module-nav stock-quick-filters" role="tablist" aria-label="Filtro rápido">
          <button type="button" className={quick === "TODAS" ? "active" : ""} onClick={() => chooseQuick("TODAS")}>Todas as saídas</button>
          <button type="button" className={quick === "VEICULO" ? "active" : ""} onClick={() => chooseQuick("VEICULO")}>Por veículo / equipamento</button>
          <button type="button" className={quick === "FUNCIONARIO" ? "active" : ""} onClick={() => chooseQuick("FUNCIONARIO")}>Por funcionário</button>
        </div>
        <div className="equipment-management-filters stock-filters">
          {quick === "VEICULO" && <label className="stock-filter-wide">Equipamento<EquipmentPicker options={options.equipment} value={equipmentFilter} onPick={setEquipmentFilter} /></label>}
          {quick === "FUNCIONARIO" && <label className="stock-filter-wide">Funcionário<EmployeePicker value={employeeFilter} frontId={null} onPick={setEmployeeFilter} /></label>}
          <label className="stock-filter-wide">Produto<ProductPicker value={productFilter} frontId={null} onPick={setProductFilter} /></label>
          <label>De<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>Até<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button type="button" className="secondary" onClick={() => { chooseQuick("TODAS"); setProductFilter(null); setFrom(""); setTo(""); }}>Limpar filtros</button>
        </div>
        <div className="main-tabs secondary-module-nav" role="tablist">
          <button type="button" className={tab === "itens" ? "active" : ""} onClick={() => setTab("itens")}>Histórico de movimentação</button>
          <button type="button" className={tab === "saidas" ? "active" : ""} onClick={() => setTab("saidas")}>Saídas lançadas (SAI)</button>
        </div>
        {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
        {!data && !error ? <div className="page-loading"><span /><p>Carregando movimentação...</p></div> : data && tab === "itens" ? (
          <>
            <p className="stock-summary">{data.movements.length} lançamento(s) · valor total {moneyFormat.format(total)} · inclui as peças das O.S. já fechadas.</p>
            <StockMovementsTable rows={data.movements} showProduct empty="Nenhuma saída encontrada para os filtros." />
          </>
        ) : data && (
          <div className="table-scroll">
            <table className="stock-exits-table">
              <thead><tr><th>Saída</th><th>Destino</th><th>Itens</th><th title="Frente do estoque · quem lançou">Frente</th>{data.canCancel && <th>Ações</th>}</tr></thead>
              <tbody>{data.exits.map((exit) => (
                <tr key={exit.id} className={exit.cancelledAt ? "stock-row-reversed" : ""}>
                  <td><strong>{exit.number}</strong><small className="table-sub">{brDay(exit.exitDate)}{exit.cancelledAt ? ` · estornada: ${exit.cancelReason ?? ""}` : ""}</small></td>
                  <td>{exit.destination ?? "—"}<small className="table-sub">{exit.destinationType === "EQUIPMENT" ? "Equipamento" : "Funcionário"}{exit.notes ? ` · ${exit.notes}` : ""}</small></td>
                  <td>{exit.items.map((item, index) => <small key={index} className="stock-exit-line">{item.tag} {item.name} — {qtyFormat.format(item.quantity)}{item.unitPrice !== null ? ` · ${moneyFormat.format(item.unitPrice * item.quantity)}` : ""}</small>)}</td>
                  <td>{exit.front}<small className="table-sub">{exit.createdBy ?? "—"}</small></td>
                  {data.canCancel && <td>{!exit.cancelledAt && <div className="equipment-row-actions"><button onClick={() => cancelExit(exit)}>Estornar</button></div>}</td>}
                </tr>
              ))}</tbody>
            </table>
            {data.exits.length === 0 && <div className="empty-state">Nenhuma saída lançada para os filtros.</div>}
          </div>
        )}
      </article>
      {creating && <StockExitModal options={options} close={() => setCreating(false)} saved={async (message) => { setCreating(false); await load(); flash(message); }} />}
    </>
  );
}

type Line = { key: string; product: ProductOption | null; quantity: string };
const newLine = (): Line => ({ key: crypto.randomUUID(), product: null, quantity: "" });

function StockExitModal({ options, close, saved }: { options: StockOptions; close: () => void; saved: (message: string) => Promise<void> }) {
  const [frontId, setFrontId] = useState(options.defaultFrontId ? String(options.defaultFrontId) : "");
  const [exitDate, setExitDate] = useState(localToday());
  const [destinationType, setDestinationType] = useState<"EMPLOYEE" | "EQUIPMENT">("EQUIPMENT");
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [equipmentItem, setEquipmentItem] = useState<EquipmentOption | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (key: string, value: Partial<Line>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...value } : line)));

  async function submit(event: FormEvent | null, allowNegative = false) {
    event?.preventDefault();
    setError("");
    if (lines.some((line) => !line.product)) { setError("Escolha o produto de todos os itens."); return; }
    setBusy(true);
    try {
      const result = await api<{ message: string }>("/api/stock-exits", jsonBody("POST", {
        serviceFrontId: Number(frontId), exitDate, destinationType, employeeId: employee?.id, equipmentId: equipmentItem?.id, notes, allowNegative,
        items: lines.map((line) => ({ productId: line.product!.id, quantity: parseQty(line.quantity) })),
      }));
      await saved(result.message);
    } catch (problem) {
      if (problem instanceof ApiError && Array.isArray(problem.data.shortages)) setShortages(problem.data.shortages as Shortage[]);
      setError(problemText(problem, "Não foi possível lançar a saída."));
    } finally { setBusy(false); }
  }

  return (
    <div className="fleet-modal-backdrop" role="presentation"><form className="fleet-modal" onSubmit={(event) => submit(event)}>
      <header><div><p>MOVIMENTAÇÃO</p><h2>Nova saída de estoque</h2><span>Os produtos saem do estoque da frente escolhida para o destino informado.</span></div><button type="button" onClick={close} aria-label="Fechar">×</button></header>
      <div className="fleet-modal-body">
        <div className="fleet-form-grid">
          {options.fronts.length === 1
            ? <label>Frente do estoque<input value={options.fronts[0].name} readOnly /></label>
            : <label>Frente do estoque *<select required value={frontId} onChange={(event) => { setFrontId(event.target.value); setLines((current) => current.map((line) => ({ ...line, product: null }))); }}><option value="" disabled>Selecione</option>{options.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}</select></label>}
          <label>Data da saída *<input type="date" required max={localToday()} value={exitDate} onChange={(event) => setExitDate(event.target.value)} /></label>
          <div className="span-2 stock-destination">
            <span className="stock-label">Destino *</span>
            <div className="material-item-mode" role="group" aria-label="Destino"><button type="button" className={destinationType === "EQUIPMENT" ? "active" : ""} onClick={() => setDestinationType("EQUIPMENT")}>Veículo / equipamento</button><button type="button" className={destinationType === "EMPLOYEE" ? "active" : ""} onClick={() => setDestinationType("EMPLOYEE")}>Funcionário</button></div>
            {destinationType === "EQUIPMENT"
              ? <EquipmentPicker options={options.equipment} value={equipmentItem} onPick={setEquipmentItem} />
              : <EmployeePicker value={employee} frontId={Number(frontId) || null} onPick={setEmployee} />}
          </div>
        </div>
        <section className="fleet-form-section">
          <div className="fleet-section-title"><h3>Produtos</h3><button type="button" onClick={() => setLines([...lines, newLine()])}>＋ ADICIONAR PRODUTO</button></div>
          {lines.map((line, index) => (
            <div className="fleet-order-editor" key={line.key}>
              <header><b>Item {index + 1}</b>{lines.length > 1 && <button type="button" onClick={() => setLines(lines.filter((item) => item.key !== line.key))}>Remover</button>}</header>
              <div className="fleet-form-grid">
                <label className="span-2">Produto *<ProductPicker value={line.product} frontId={Number(frontId) || null} onPick={(product) => patch(line.key, { product })} /></label>
                <label>Quantidade *<input required inputMode="decimal" value={line.quantity} onChange={(event) => patch(line.key, { quantity: event.target.value })} /></label>
              </div>
            </div>
          ))}
        </section>
        <label className="fleet-notes">Observações<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {shortages.length > 0 && <ShortageNotice shortages={shortages} busy={busy} confirm={() => submit(null, true)} />}
        {error && <div className="equipment-form-error"><span>!</span><strong>{error}</strong></div>}
      </div>
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "LANÇANDO..." : "LANÇAR SAÍDA"}</button></footer>
    </form></div>
  );
}
