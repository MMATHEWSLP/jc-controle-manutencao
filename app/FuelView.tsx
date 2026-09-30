"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ThirdPartiesView, { METER_LABEL, ThirdPartyConsumptionReport, ThirdPartyFormModal, ThirdPartyPicker, ThirdPartyVehiclePicker, useThirdPartyOptions, VehicleFormModal, type ThirdPartyOption, type VehicleOption } from "./ThirdPartiesView";
import { ApiError, api as apiWithData } from "./stock-client";
import FuelTankView from "./FuelTankView";
import QueuedRequests from "./QueuedRequests";
import { enqueueRequest } from "../lib/offline-queue";
import { METER_PHRASES as METER_PHRASE } from "../lib/third-party-rules";
import { reportNetworkFailure } from "../lib/connectivity";

type MovementType = "ENTRADA" | "SAIDA" | "TRANSFERENCIA";
type Location = "FRENTE" | "PORTO";
type Front = { id: number; name: string };
type FuelType = { id: number; code: string; name: string; unit: string };
type Totals = { balance: number; entries: number; exits: number };
type LocationTotals = Totals & { byLocation: Record<Location, Totals> };
type Balance = LocationTotals & { fuelTypeId: number; code: string; name: string; unit: string; byFront: Array<LocationTotals & { serviceFrontId: number; name: string }> };
type Summary = {
  today: string; period: { from: string; to: string }; fuelTypes: FuelType[]; fronts: Front[]; destinationFronts: Front[];
  scopeFrontIds: number[]; allFronts: boolean; multiFront: boolean; defaultFrontId: number | null; balances: Balance[];
};
type Movement = {
  id: number; serviceFrontId: number; frontName: string; fuelTypeId: number; fuelName: string; unit: string; movementType: MovementType; movementLabel: string;
  movementDate: string; quantity: number; origin: string | null; stockLocation: Location; stockLocationLabel: string;
  thirdParty: boolean; thirdPartyKind: "GERAL" | "PRESTADOR" | null; thirdPartyDescription: string | null; providerCompany: string | null; providerEquipment: string | null;
  unitPrice: number | null; unitCost: number | null; cost: number | null; responsibleEmployeeId: number | null; equipmentId: number | null; equipmentPrefix: string | null; equipmentModel: string | null;
  meterReading: number | null; meterUnit: "HOURS" | "KM" | null; destinationFrontId: number | null; destinationFrontName: string | null;
  destinationLocation: Location | null; destinationLocationLabel: string | null;
  responsible: string | null; notes: string | null; createdByName: string | null; createdAt: string;
  // Carga retroativa de histórico: lote, origem ainda não conferida, veículo a identificar.
  importSource: string | null; originConfirmed: boolean; vehiclePending: boolean; importedVehicle: string | null;
  // Saída para terceiro do cadastro de Terceiros e o consumo calculado (km/L ou L/h).
  thirdPartyId: number | null; thirdPartyVehicleId: number | null; fullTank: boolean; consumptionOutlier: boolean; readingException: boolean;
  consumption: { value: number; unit: string; distance: number; liters: number } | null;
};
type Totals2 = { count: number; liters: number };
type HistorySummary = {
  show: { entries: boolean; exits: boolean; transfers: boolean }; entries: Totals2; exits: Totals2; transfers: Totals2; balance: number | null;
  byFuel: Array<{ fuelTypeId: number; fuelName: string; entries: Totals2; exits: Totals2; transfers: Totals2 }>;
};
type HistoryResponse = { movements: Movement[]; total: number; page: number; pageSize: number; summary: HistorySummary };
type EquipmentOption = {
  id: number; prefix: string; brand: string; model: string; type: string; controlType: "HOURS" | "KM" | "HOURS_KM";
  currentHours: number; currentKm: number; serviceFrontId: number | null; frontName: string | null; inActiveFront: boolean;
};
type User = { id: number; name: string; permissions: string[] };

const MOVEMENT_OPTIONS: Array<[MovementType, string, string]> = [["ENTRADA", "Entrada", "↓"], ["SAIDA", "Saída", "↑"], ["TRANSFERENCIA", "Transferência", "⇄"]];
const LOCATIONS: Array<[Location, string]> = [["FRENTE", "Frente"], ["PORTO", "Porto"]];
const locationLabel = (value: Location) => (value === "PORTO" ? "Porto" : "Frente");
// Formato brasileiro: 5.441 L e 1.234,50 L.
const liters = (value: number) => `${value.toLocaleString("pt-BR", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} L`;
const brDay = (value: string) => value.split("-").reverse().join("/");
// Início do período quando se filtra pendências da carga de histórico (planilha começa em 2025).
const HISTORY_START = "2020-01-01";
const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
function monthPeriod() {
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
  const [tab, setTab] = useState<"new" | "history" | "third-parties" | "consumption" | "tank">(canRegister ? "new" : "history");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Movement | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Cards: saldo atual + entradas/saídas do mês corrente, independentes do filtro do Histórico.
  const loadSummary = useCallback(async () => {
    setError("");
    try {
      setSummary(await api<Summary>("/api/fuel"));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível carregar os saldos.");
    }
  }, []);
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
          <span>Entradas, saídas e transferências de Diesel e Gasolina, com saldo separado em Frente e Porto.</span>
        </div>
      </div>
      <section className="fuel-balance-grid" aria-label="Saldos por tipo de combustível">
        {summary.balances.map((balance) => (
          <article key={balance.fuelTypeId} className={`fuel-balance-card fuel-${balance.code.toLowerCase().replace(/_/g, "-")} ${balance.balance < 0 ? "negative" : ""}`}>
            <header>
              <div><p>{balance.name.toUpperCase()}</p><small>{scopeLabel}</small></div>
              <div className="fuel-balance-total"><strong>{liters(balance.balance)}</strong><small>saldo atual</small></div>
            </header>
            <div className="fuel-balance-locations">
              {LOCATIONS.map(([key, label]) => (
                <span key={key} className={balance.byLocation[key].balance < 0 ? "negative" : ""}><small>{label}</small><b>{liters(balance.byLocation[key].balance)}</b></span>
              ))}
            </div>
            <div className="fuel-balance-period">
              <span className="in"><b>{liters(balance.entries)}</b>Entradas no mês</span>
              <span className="out"><b>{liters(balance.exits)}</b>Saídas no mês</span>
            </div>
            {balance.byFront.length > 1 && (
              <ul className="fuel-balance-fronts" aria-label="Saldo por frente (Frente / Porto)">
                {balance.byFront.map((front) => (
                  <li key={front.serviceFrontId}>
                    <span>{front.name}</span>
                    {LOCATIONS.map(([key, label]) => <b key={key} title={label} className={front.byLocation[key].balance < 0 ? "negative" : ""}><i>{label[0]}</i>{liters(front.byLocation[key].balance)}</b>)}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </section>
      <div className="main-tabs secondary-module-nav" aria-label="Sub-navegação do módulo Combustível">
        {canRegister && <button className={tab === "new" ? "active" : ""} onClick={() => { setTab("new"); setEditing(null); }}>{editing ? "Editar registro" : "Novo Registro"}</button>}
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Histórico</button>
        <button className={tab === "third-parties" ? "active" : ""} onClick={() => setTab("third-parties")}>Terceiros</button>
        <button className={tab === "consumption" ? "active" : ""} onClick={() => setTab("consumption")}>Consumo de Terceiros</button>
        <button className={tab === "tank" ? "active" : ""} onClick={() => setTab("tank")}>Tanque (régua)</button>
      </div>
      {canRegister && <QueuedRequests userId={authUser.id} kind="FUEL" title="Lançamentos guardados no celular" />}
      {tab === "tank" ? <FuelTankView fronts={summary.fronts} fuelTypes={summary.fuelTypes} defaultFrontId={summary.defaultFrontId} today={summary.today} canRegister={canRegister} canManage={canManage} flash={flash} />
        : tab === "third-parties" ? <ThirdPartiesView authUser={authUser} flash={flash} embedded />
        : tab === "consumption" ? <ThirdPartyConsumptionReport />
        : tab === "new" && (canRegister || editing)
        ? <FuelForm key={editing ? `edit-${editing.id}` : "new"} summary={summary} authUser={authUser} editing={editing} onSaved={async (message) => { const wasEditing = Boolean(editing); await afterSave(message); setTab(wasEditing ? "history" : "new"); }} onCancel={editing ? () => { setEditing(null); setTab("history"); } : undefined} />
        : <FuelHistory key={historyVersion} summary={summary} canManage={canManage} flash={flash}
          onEdit={(movement) => { setEditing(movement); setTab("new"); }} onDeleted={afterSave} />}
    </>
  );
}

type ExitKind = "FROTA" | "TERCEIROS" | "PRESTADOR";
type EmployeeOption = { id: number; name: string; jobTitle: string; company: string; serviceFrontId: number; frontName: string; inFront: boolean };
type Responsible = { employeeId: number | null; name: string; manual: boolean };

function FuelForm({ summary, authUser, editing, onSaved, onCancel }: { summary: Summary; authUser: User; editing: Movement | null; onSaved: (message: string) => Promise<void>; onCancel?: () => void }) {
  const [movementType, setMovementType] = useState<MovementType>(editing?.movementType ?? "SAIDA");
  const [exitKind, setExitKind] = useState<ExitKind>(!editing?.thirdParty ? "FROTA" : editing.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "TERCEIROS");
  const [frontId, setFrontId] = useState<number | null>(editing?.serviceFrontId ?? summary.defaultFrontId ?? (summary.fronts.length === 1 ? summary.fronts[0].id : null));
  const [stockLocation, setStockLocation] = useState<Location>(editing?.stockLocation ?? "FRENTE");
  const [fuelTypeId, setFuelTypeId] = useState<number>(editing?.fuelTypeId ?? summary.fuelTypes[0]?.id ?? 0);
  const [movementDate, setMovementDate] = useState(editing?.movementDate ?? summary.today);
  const [quantity, setQuantity] = useState(editing ? String(editing.quantity).replace(".", ",") : "");
  const [unitPrice, setUnitPrice] = useState(editing?.unitPrice != null ? String(editing.unitPrice).replace(".", ",") : "");
  const [meterReading, setMeterReading] = useState(editing?.meterReading != null ? String(editing.meterReading).replace(".", ",") : "");
  // Destino da transferência: "" = mesma frente (Frente ↔ Porto); ou outra filial.
  const [destinationFrontId, setDestinationFrontId] = useState<string>(editing?.destinationFrontId && editing.destinationFrontId !== editing.serviceFrontId ? String(editing.destinationFrontId) : "");
  const [destinationLocation, setDestinationLocation] = useState<Location>(editing?.destinationLocation ?? (editing?.stockLocation === "PORTO" ? "FRENTE" : "PORTO"));
  const [thirdPartyDescription, setThirdPartyDescription] = useState(editing?.thirdPartyDescription ?? "");
  // Terceiro do cadastro. Lançamento antigo (só texto livre) continua com os campos de texto ao editar.
  const legacyThirdParty = Boolean(editing?.thirdParty && !editing.thirdPartyId);
  const thirdPartyOptions = useThirdPartyOptions();
  const [party, setParty] = useState<ThirdPartyOption | null>(null);
  const [vehicle, setVehicle] = useState<VehicleOption | null>(null);
  const [partyReading, setPartyReading] = useState(editing?.thirdPartyId && editing.meterReading != null ? String(editing.meterReading).replace(".", ",") : "");
  const [fullTank, setFullTank] = useState(editing?.fullTank ?? true);
  const [readingException, setReadingException] = useState(editing?.readingException ?? false);
  const [exceptionAllowed, setExceptionAllowed] = useState(false);
  const [quickCreate, setQuickCreate] = useState<"party" | "vehicle" | null>(null);
  // Ao editar, recupera o terceiro/veículo do cadastro (ou um substituto, se foi inativado depois).
  useEffect(() => {
    if (!editing?.thirdPartyId || party) return;
    const found = thirdPartyOptions.options.find((item) => item.id === editing.thirdPartyId);
    const fallback: ThirdPartyOption = { id: editing.thirdPartyId, name: editing.providerCompany ?? editing.thirdPartyDescription ?? "Terceiro", kind: editing.thirdPartyKind === "PRESTADOR" ? "PRESTADOR" : "PESSOA_FISICA", document: null, vehicles: [] };
    const current = found ?? fallback;
    setParty(current);
    if (editing.thirdPartyVehicleId) setVehicle(current.vehicles.find((item) => item.id === editing.thirdPartyVehicleId)
      ?? { id: editing.thirdPartyVehicleId, thirdPartyId: current.id, plate: editing.providerEquipment ?? "Veículo", description: null, meterType: editing.meterUnit === "HOURS" ? "HORIMETRO" : "KM", lastReading: null, tankCapacityLiters: null });
  }, [editing, party, thirdPartyOptions.options]);
  const [providerCompany, setProviderCompany] = useState(editing?.providerCompany ?? "");
  const [providerEquipment, setProviderEquipment] = useState(editing?.providerEquipment ?? "");
  const [responsible, setResponsible] = useState<Responsible>(editing
    ? { employeeId: editing.responsibleEmployeeId, name: editing.responsible ?? "", manual: !editing.responsibleEmployeeId && Boolean(editing.responsible) }
    : { employeeId: null, name: "", manual: false });
  const [providerDriver, setProviderDriver] = useState(editing?.thirdPartyKind === "PRESTADOR" ? editing.responsible ?? "" : "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [equipment, setEquipment] = useState<EquipmentOption | null>(editing?.equipmentId ? {
    id: editing.equipmentId, prefix: editing.equipmentPrefix ?? "", brand: "", model: editing.equipmentModel ?? "", type: "", controlType: editing.meterUnit === "KM" ? "KM" : "HOURS",
    currentHours: 0, currentKm: 0, serviceFrontId: editing.serviceFrontId, frontName: editing.frontName, inActiveFront: true,
  } : null);
  // Lançamento importado do histórico: sem os campos obrigatórios dos lançamentos novos e com a
  // confirmação da origem (Frente/Porto) feita aqui.
  const historical = Boolean(editing?.importSource);
  const [originConfirmed, setOriginConfirmed] = useState(editing?.originConfirmed ?? true);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const isEntry = movementType === "ENTRADA";
  const isTransfer = movementType === "TRANSFERENCIA";
  const isExit = movementType === "SAIDA";
  const isProvider = isExit && exitKind === "PRESTADOR";
  const isThirdParty = isExit && exitKind !== "FROTA";
  // Saída para terceiro pelo cadastro (novo formato): empresa + veículo + leitura + tanque cheio.
  const registered = isThirdParty && !legacyThirdParty;
  const partyKinds: ThirdPartyOption["kind"][] | undefined = isProvider ? ["PRESTADOR", "TERCEIRIZADA"] : undefined;
  const needsVehicle = registered && party !== null && party.kind !== "PESSOA_FISICA";
  const readingValue = Number(partyReading.replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  const lowReading = registered && vehicle !== null && vehicle.lastReading !== null && partyReading.trim() !== "" && Number.isFinite(readingValue) && readingValue <= vehicle.lastReading;
  // Veículo/Máquina só na saída para a frota (entrada nunca é vinculada a equipamento).
  const showEquipment = isExit && exitKind === "FROTA";
  const frontName = summary.fronts.find((front) => front.id === frontId)?.name ?? null;
  // No histórico importado o equipamento pode ter mudado de frente depois do abastecimento: só avisa.
  const wrongFront = !historical && showEquipment && equipment !== null && frontId !== null && equipment.serviceFrontId !== frontId;
  const meterLabel = equipment?.controlType === "KM" ? "Hodômetro (km)" : equipment?.controlType === "HOURS_KM" ? "Horímetro / Hodômetro" : "Horímetro (h)";
  const fuelBalance = summary.balances.find((balance) => balance.fuelTypeId === fuelTypeId);
  const balanceHere = fuelBalance?.byFront.find((front) => front.serviceFrontId === frontId)?.byLocation[stockLocation].balance;
  const parseDecimal = (value: string) => Number(value.replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  const quantityValue = parseDecimal(quantity);
  const unitPriceValue = parseDecimal(unitPrice);
  const sameAsEditing = editing && editing.fuelTypeId === fuelTypeId && editing.serviceFrontId === frontId && editing.stockLocation === stockLocation && editing.movementType !== "ENTRADA";
  const lowBalance = !isEntry && balanceHere !== undefined && Number.isFinite(quantityValue) && quantityValue > balanceHere + (sameAsEditing ? editing.quantity : 0);
  const internalTransfer = isTransfer && !destinationFrontId;
  const sameStock = internalTransfer && destinationLocation === stockLocation;
  const responsibleName = isProvider ? providerDriver.trim() : responsible.name.trim();

  // Campos obrigatórios de cada tipo de movimentação / tipo de saída.
  const missing: Array<[string, string]> = [];
  if (summary.multiFront && !frontId) missing.push(["front", "Frente de Serviço"]);
  if (!movementDate) missing.push(["date", "Data"]);
  if (!(quantityValue > 0)) missing.push(["quantity", "Quantidade"]);
  if (isEntry && !historical && !(unitPriceValue > 0)) missing.push(["unitPrice", "Valor por litro"]);
  if (showEquipment && !historical && !equipment) missing.push(["equipment", "Veículo/Máquina"]);
  if (legacyThirdParty && isExit && exitKind === "TERCEIROS" && !thirdPartyDescription.trim()) missing.push(["description", "Destino/Descrição"]);
  if (legacyThirdParty && isProvider && !providerCompany.trim()) missing.push(["company", "Empresa"]);
  if (legacyThirdParty && isProvider && !providerEquipment.trim()) missing.push(["providerEquipment", "Descrição do Equipamento"]);
  if (registered && !party) missing.push(["party", isProvider ? "Empresa" : "Terceiro"]);
  if (needsVehicle && !vehicle) missing.push(["vehicle", "Veículo/Máquina do terceiro"]);
  if (registered && vehicle && !(partyReading.trim() && Number.isFinite(readingValue) && readingValue >= 0)) missing.push(["reading", `Leitura atual ${METER_PHRASE[vehicle.meterType]}`]);
  if (!responsibleName && !historical) missing.push(["responsible", isEntry ? "Responsável (quem recebeu)" : "Responsável"]);
  const missingKeys = new Set(missing.map(([key]) => key));
  const fieldError = (key: string, message = "Campo obrigatório.") => (touched[key] && missingKeys.has(key) ? <small className="fuel-field-error">{message}</small> : null);
  const touch = (key: string) => () => setTouched((current) => ({ ...current, [key]: true }));
  const invalid = (key: string) => (touched[key] && missingKeys.has(key) ? "fuel-invalid" : "");

  function changeOrigin(value: Location) {
    setStockLocation(value);
    if (historical && value !== editing?.stockLocation) setOriginConfirmed(true);
    // Transferência interna: o destino natural é o outro estoque da mesma frente.
    if (isTransfer && !destinationFrontId && destinationLocation === value) setDestinationLocation(value === "FRENTE" ? "PORTO" : "FRENTE");
  }

  // clientRequestId: o mesmo em todas as tentativas deste envio (confirmações e fila offline), para o
  // servidor nunca gravar duas vezes.
  async function submit(event: FormEvent | null, confirmations: { confirmTank?: boolean; confirmOutlier?: boolean } = {}, clientRequestId: string = crypto.randomUUID()) {
    event?.preventDefault();
    if (missing.length) { setTouched(Object.fromEntries(missing.map(([key]) => [key, true]))); return; }
    if (wrongFront) { setError(`O equipamento ${equipment!.prefix} está em ${equipment!.frontName ?? "outra frente"}. Não é possível lançar combustível para ele em ${frontName ?? "esta frente"}.`); return; }
    setBusy(true);
    setError("");
    try {
      const payload = {
        serviceFrontId: frontId, fuelTypeId, movementType, movementDate, quantity, stockLocation, notes,
        unitPrice: isEntry ? unitPrice : "",
        ...(historical ? { originConfirmed } : {}),
        thirdParty: isThirdParty, thirdPartyKind: isProvider ? "PRESTADOR" : isThirdParty ? "GERAL" : null,
        thirdPartyDescription: legacyThirdParty && isExit && exitKind === "TERCEIROS" ? thirdPartyDescription : "",
        providerCompany: legacyThirdParty && isProvider ? providerCompany : "", providerEquipment: legacyThirdParty && isProvider ? providerEquipment : "",
        ...(registered ? {
          // Campo próprio: "meterReading" logo abaixo é o do equipamento da frota (vazio aqui) e, com o
          // mesmo nome, sobrescrevia a leitura do terceiro no objeto enviado.
          thirdPartyId: party?.id ?? null, thirdPartyVehicleId: vehicle?.id ?? null, thirdPartyReading: vehicle ? partyReading : "", fullTank,
          readingException: readingException && (lowReading || exceptionAllowed), ...confirmations,
        } : {}),
        responsibleEmployeeId: isProvider || responsible.manual ? null : responsible.employeeId,
        responsible: responsibleName,
        equipmentId: showEquipment ? equipment?.id ?? null : null, meterReading: showEquipment ? meterReading : "",
        destinationFrontId: isTransfer && destinationFrontId ? Number(destinationFrontId) : null,
        destinationLocation: isTransfer ? destinationLocation : null,
        ...(editing ? {} : { clientRequestId }),
      };
      let result: { message: string };
      try {
        result = await apiWithData<{ message: string }>(editing ? `/api/fuel/movements/${editing.id}` : "/api/fuel/movements", {
          method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
      } catch (problem) {
        // Litros acima do tanque ou consumo fora da média: pede confirmação e reenvia.
        if (problem instanceof ApiError && (problem.data.confirm === "TANK" || problem.data.confirm === "OUTLIER")) {
          if (!window.confirm(`${problem.message}\n\nLançar mesmo assim?`)) { setBusy(false); return; }
          setBusy(false);
          return await submit(null, { ...confirmations, ...(problem.data.confirm === "TANK" ? { confirmTank: true } : { confirmOutlier: true }) }, clientRequestId);
        }
        if (problem instanceof ApiError && problem.data.exception === true) setExceptionAllowed(true);
        // Sem conexão: um lançamento novo fica guardado no celular e é enviado quando o sinal voltar.
        if (!(problem instanceof ApiError) && !editing) {
          reportNetworkFailure();
          const what = movementType === "ENTRADA" ? "Entrada" : movementType === "TRANSFERENCIA" ? "Transferência" : "Saída";
          await enqueueRequest({ userId: authUser.id, kind: "FUEL", url: "/api/fuel/movements", body: JSON.stringify(payload),
            summary: `${what} de ${quantity} L${equipment ? ` · ${equipment.prefix}` : ""} · ${movementDate.split("-").reverse().join("/")}` });
          result = { message: "Sem conexão: lançamento guardado no celular. Será enviado sozinho quando o sinal voltar." };
        } else throw problem;
      }
      if (!editing) {
        // Só depois de gravar (se falhar, nada é limpo). Ficam: tipo de movimentação, tipo de saída,
        // frente, origem, data e combustível, para lançar vários em sequência.
        setQuantity(""); setMeterReading(""); setNotes(""); setEquipment(null); setThirdPartyDescription("");
        setProviderCompany(""); setProviderEquipment(""); setProviderDriver(""); setUnitPrice(""); setTouched({});
        setParty(null); setVehicle(null); setPartyReading(""); setFullTank(true); setReadingException(false); setExceptionAllowed(false);
        setResponsible((current) => ({ employeeId: null, name: "", manual: current.manual }));
        thirdPartyOptions.reload().catch(() => undefined);
        // Próximo lançamento começa pela Empresa (ou pelo veículo da frota / quantidade).
        window.setTimeout(() => {
          const target = formRef.current?.querySelector<HTMLInputElement>(registered ? ".fuel-third-party-field input" : showEquipment ? ".fuel-equipment-picker input, .material-product-picker input" : ".fuel-quantity-input");
          target?.focus();
        }, 60);
      }
      await onSaved(result.message);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível salvar o lançamento.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel module-panel fuel-form-panel">
      <form ref={formRef} className="fuel-form" onSubmit={submit} noValidate>
        <div className="fuel-form-top full">
          <fieldset className="fuel-movement-type">
            <legend>Tipo de Movimentação</legend>
            {MOVEMENT_OPTIONS.map(([value, label, icon]) => (
              <button type="button" key={value} className={`${movementType === value ? "active" : ""} ${value.toLowerCase()}`} onClick={() => { setMovementType(value); setTouched({}); }} aria-pressed={movementType === value}>
                <span>{icon}</span>{label}
              </button>
            ))}
          </fieldset>
          {isExit && (
            <fieldset className="fuel-exit-kind">
              <legend>Tipo de saída</legend>
              {([["FROTA", "Frota (veículo/máquina)"], ["TERCEIROS", "Saída para terceiros"], ["PRESTADOR", "Prestadores de Serviço"]] as Array<[ExitKind, string]>).map(([value, label]) => (
                <button type="button" key={value} className={exitKind === value ? "active" : ""} aria-pressed={exitKind === value} onClick={() => { setExitKind(value); setTouched({}); if (value !== "FROTA") setEquipment(null); }}>{label}</button>
              ))}
            </fieldset>
          )}
        </div>
        {summary.multiFront && (
          <label className={invalid("front")}>
            Frente de Serviço *
            <select value={frontId ?? ""} onBlur={touch("front")} onChange={(event) => setFrontId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">Selecione a frente...</option>
              {summary.fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
            </select>
            {fieldError("front", "Escolha a frente do lançamento.")}
          </label>
        )}
        <label className={invalid("date")}>
          Data *
          <input type="date" value={movementDate} max={summary.today} onBlur={touch("date")} onChange={(event) => setMovementDate(event.target.value)} />
          {fieldError("date")}
        </label>
        <label>
          Tipo de Combustível *
          <select value={fuelTypeId} onChange={(event) => setFuelTypeId(Number(event.target.value))}>
            {summary.fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
        </label>
        <label>
          {isEntry ? "Estoque de entrada *" : "Origem *"}
          <select value={stockLocation} onChange={(event) => changeOrigin(event.target.value as Location)}>
            {LOCATIONS.map(([value, label]) => <option key={value} value={value}>{label}{frontName ? ` ${frontName}` : ""}</option>)}
          </select>
        </label>
        <label className={invalid("quantity")}>
          Quantidade (litros) *
          <input className="fuel-quantity-input" inputMode="decimal" placeholder="0,00" value={quantity} onBlur={touch("quantity")} onChange={(event) => setQuantity(event.target.value)} />
          {fieldError("quantity", "Informe a quantidade em litros.")}
          {!missingKeys.has("quantity") && balanceHere !== undefined && <small className={`fuel-hint ${lowBalance ? "warning" : ""}`}>{lowBalance ? "Atenção: o saldo ficará negativo. " : ""}Saldo {locationLabel(stockLocation)} {frontName}: {liters(balanceHere)}</small>}
        </label>
        {isEntry && (
          <label className={invalid("unitPrice")}>
            Valor por litro (R$) *
            <input inputMode="decimal" placeholder="0,00" value={unitPrice} onBlur={touch("unitPrice")} onChange={(event) => setUnitPrice(event.target.value)} />
            {fieldError("unitPrice", "Informe o valor pago por litro.")}
            {unitPriceValue > 0 && quantityValue > 0 && <small className="fuel-hint">Total da entrada: {money(unitPriceValue * quantityValue)}</small>}
          </label>
        )}
        {isTransfer && (
          <>
            <label>
              Destino *
              <select value={destinationLocation} onChange={(event) => setDestinationLocation(event.target.value as Location)}>
                {LOCATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              Filial Destino
              <select value={destinationFrontId} onChange={(event) => setDestinationFrontId(event.target.value)}>
                <option value="">Mesma frente{frontName ? ` (${frontName})` : ""}</option>
                {summary.destinationFronts.filter((front) => front.id !== frontId).map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
              </select>
              <small className="fuel-hint">{internalTransfer ? `${locationLabel(stockLocation)} → ${locationLabel(destinationLocation)} da mesma frente.` : "Transferência para outra filial."}</small>
            </label>
          </>
        )}
        {showEquipment && (
          <div className={invalid("equipment")} onBlur={touch("equipment")}>
            <EquipmentPicker frontId={frontId} frontName={frontName} value={equipment} onChange={setEquipment} required={!historical} historical={historical} />
            {fieldError("equipment", "Selecione o veículo/máquina abastecido.")}
          </div>
        )}
        {showEquipment && (
          <label>
            {meterLabel}
            <input inputMode="decimal" placeholder={equipment ? (equipment.controlType === "KM" ? `Atual: ${equipment.currentKm.toLocaleString("pt-BR")} km` : `Atual: ${equipment.currentHours.toLocaleString("pt-BR")} h`) : "Opcional"} value={meterReading} onChange={(event) => setMeterReading(event.target.value)} />
          </label>
        )}
        {registered && (
          <>
            <div className={`fuel-span-2 fuel-third-party-field ${invalid("party")}`} onBlur={touch("party")}>
              <span className="fuel-field-label">{isProvider ? "Empresa (prestador / terceirizada) *" : "Terceiro (empresa ou pessoa) *"}
                {thirdPartyOptions.canManage && <button type="button" className="link-button" onClick={() => setQuickCreate("party")}>＋ Novo</button>}</span>
              <ThirdPartyPicker options={thirdPartyOptions.options} loadError={thirdPartyOptions.error} kinds={partyKinds} value={party} onPick={(item) => { setParty(item); setVehicle(null); setPartyReading(""); setReadingException(false); setExceptionAllowed(false); }} />
              {fieldError("party", "Escolha no cadastro de terceiros.")}
            </div>
            <div className={`fuel-third-party-field ${invalid("vehicle")}`} onBlur={touch("vehicle")}>
              <span className="fuel-field-label">Veículo / máquina{needsVehicle ? " *" : " (opcional)"}
                {thirdPartyOptions.canManage && party && <button type="button" className="link-button" onClick={() => setQuickCreate("vehicle")}>＋ Novo</button>}</span>
              <ThirdPartyVehiclePicker vehicles={party?.vehicles ?? []} value={vehicle} disabled={!party} onPick={(item) => { setVehicle(item); setPartyReading(""); setReadingException(false); setExceptionAllowed(false); }} />
              {fieldError("vehicle", "Escolha o veículo do terceiro.")}
            </div>
            {vehicle && (
              <div className="fuel-span-2 fuel-reading-row">
                <label className={invalid("reading")}>
                  Leitura atual — {METER_LABEL[vehicle.meterType]} *
                  <input inputMode="decimal" value={partyReading} onBlur={touch("reading")} onChange={(event) => setPartyReading(event.target.value)} placeholder={vehicle.lastReading !== null ? `Última: ${vehicle.lastReading.toLocaleString("pt-BR")}` : "Leitura do painel"} />
                  <small className={`fuel-hint ${lowReading ? "warning" : ""}`}>{vehicle.lastReading !== null ? `Última leitura registrada: ${vehicle.lastReading.toLocaleString("pt-BR")} ${vehicle.meterType === "KM" ? "km" : "h"}` : "Primeiro abastecimento: esta leitura vira a base do consumo."}{lowReading ? " — a nova leitura precisa ser maior." : ""}</small>
                  {fieldError("reading", `Informe a leitura atual ${METER_PHRASE[vehicle.meterType]}.`)}
                </label>
                <div className="fuel-full-tank">
                  <label><input type="checkbox" checked={fullTank} onChange={(event) => setFullTank(event.target.checked)} /> Tanque cheio</label>
                  <small className="fuel-hint">{fullTank ? "O consumo é calculado desde o último tanque cheio." : "Parcial: os litros somam no próximo tanque cheio."}</small>
                </div>
              </div>
            )}
            {vehicle?.tankCapacityLiters && quantityValue > vehicle.tankCapacityLiters ? <p className="full fuel-hint warning">{liters(quantityValue)} passa da capacidade do tanque ({liters(vehicle.tankCapacityLiters)}): o lançamento vai pedir confirmação.</p> : null}
            {(lowReading || exceptionAllowed) && thirdPartyOptions.canManage && (
              <label className="full fuel-origin-check">
                <input type="checkbox" checked={readingException} onChange={(event) => setReadingException(event.target.checked)} /> Aceitar leitura menor/igual à última (exceção de ADMIN/GESTOR — justifique em Observações)
              </label>
            )}
            {party?.kind === "PESSOA_FISICA" && !vehicle && <p className="full fuel-hint">Pessoa física sem veículo: veículo e leitura são opcionais.</p>}
          </>
        )}
        {legacyThirdParty && isExit && exitKind === "TERCEIROS" && (
          <label className={`fuel-span-2 ${invalid("description")}`}>
            Destino/Descrição *
            <input value={thirdPartyDescription} onBlur={touch("description")} onChange={(event) => setThirdPartyDescription(event.target.value)} placeholder="Ex.: comunidade, pessoa atendida, placa do veículo de terceiro" />
            {fieldError("description", "Informe quem recebeu o combustível.")}
          </label>
        )}
        {isProvider && (
          <>
            {legacyThirdParty && <label className={invalid("company")}>
              Empresa *
              <input value={providerCompany} onBlur={touch("company")} onChange={(event) => setProviderCompany(event.target.value)} placeholder="Nome do prestador / empresa terceirizada" />
              {fieldError("company", "Informe a empresa do prestador.")}
            </label>}
            {legacyThirdParty && <label className={invalid("providerEquipment")}>
              Descrição do Equipamento *
              <input value={providerEquipment} onBlur={touch("providerEquipment")} onChange={(event) => setProviderEquipment(event.target.value)} placeholder="Modelo, placa ou identificação" />
              {fieldError("providerEquipment", "Descreva o equipamento do prestador.")}
            </label>}
            <label className={invalid("responsible")}>
              Responsável *
              <input value={providerDriver} onBlur={touch("responsible")} onChange={(event) => setProviderDriver(event.target.value)} placeholder="Motorista/operador do prestador que recebeu" />
              {fieldError("responsible", "Informe quem recebeu o combustível.")}
            </label>
          </>
        )}
        {!isProvider && (
          <div className={invalid("responsible")} onBlur={touch("responsible")}>
            <EmployeePicker label={isEntry ? "Responsável (quem recebeu) *" : "Responsável *"} frontId={frontId} value={responsible} onChange={setResponsible}
              placeholder={isEntry ? "Motorista ou funcionário que acompanhou o recebimento" : "Buscar funcionário..."} />
            {fieldError("responsible", isEntry ? "Informe quem recebeu fisicamente o combustível." : "Informe o responsável.")}
          </div>
        )}
        <label className="full">
          Observações
          <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={isEntry ? "Ex.: nota fiscal, fornecedor, placa do caminhão-tanque." : "Informações adicionais deste lançamento."} />
        </label>
        {historical && (
          <div className="full fuel-import-note">
            <p><b>Lançamento importado do histórico</b> ({editing!.importSource}). Na correção, responsável, valor por litro e veículo não são obrigatórios.</p>
            {editing!.vehiclePending && <p>Veículo a identificar — na planilha: <b>{editing!.importedVehicle ?? "sem veículo"}</b>. Escolha o veículo acima para tirar a pendência.</p>}
            <label className="fuel-origin-check"><input type="checkbox" checked={originConfirmed} onChange={(event) => setOriginConfirmed(event.target.checked)} /> Origem ({locationLabel(stockLocation)}) conferida</label>
          </div>
        )}
        {!summary.multiFront && frontName && <p className="full fuel-auto-front">Lançamento da frente <b>{frontName}</b> (frente do seu usuário). Lançado por {authUser.name}.</p>}
        {wrongFront && (
          <div className="equipment-form-error full"><span>!</span><strong>O equipamento {equipment!.prefix} está em {equipment!.frontName ?? "outra frente"}, não em {frontName}. Transfira o equipamento ou lance pela frente correta.</strong></div>
        )}
        {sameStock && <div className="equipment-form-error full"><span>!</span><strong>Escolha um destino diferente da origem (ex.: Frente → Porto).</strong></div>}
        {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
        <div className="modal-footer full">
          {missing.length > 0 && <span className="fuel-missing">Preencha: {missing.map(([, label]) => label).join(", ")}</span>}
          {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar edição</button>}
          <button className="primary" disabled={busy || wrongFront || sameStock || missing.length > 0}>{busy ? "Salvando..." : editing ? "Salvar alterações" : "Registrar lançamento"}</button>
        </div>
      </form>
      {quickCreate === "party" && (
        <ThirdPartyFormModal item={null} fronts={summary.fronts} defaultKind={isProvider ? "PRESTADOR" : "PESSOA_FISICA"} close={() => setQuickCreate(null)}
          saved={async (id) => { setQuickCreate(null); const list = await thirdPartyOptions.reload(); setParty(list.find((item) => item.id === id) ?? null); setVehicle(null); }} />
      )}
      {quickCreate === "vehicle" && party && (
        <VehicleFormModal thirdParty={party} item={null} fuelTypes={summary.fuelTypes} close={() => setQuickCreate(null)}
          saved={async (id) => { setQuickCreate(null); const list = await thirdPartyOptions.reload(); const updated = list.find((item) => item.id === party.id) ?? party; setParty(updated); setVehicle(updated.vehicles.find((item) => item.id === id) ?? null); }} />
      )}
    </article>
  );
}

// Responsável: escolhido da lista de Funcionários (autocomplete). Digitar o nome à mão fica como
// exceção (ex.: motorista do caminhão-tanque que não é funcionário).
function EmployeePicker({ label, frontId, value, onChange, placeholder }: { label: string; frontId: number | null; value: Responsible; onChange: (value: Responsible) => void; placeholder: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!open || value.manual) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ q: query });
      if (frontId) params.set("serviceFrontId", String(frontId));
      api<{ employees: EmployeeOption[] }>(`/api/employees/lookup?${params.toString()}`).then((result) => { setItems(result.employees); setUnavailable(false); })
        .catch(() => { setItems([]); setUnavailable(true); }).finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId, open, value.manual]);

  const toggleManual = <label className="fuel-manual-toggle"><input type="checkbox" checked={value.manual} onChange={(event) => onChange({ employeeId: null, name: event.target.checked ? query || value.name : "", manual: event.target.checked })} />Digitar nome manualmente</label>;
  if (value.manual) {
    return (
      <label className="fuel-employee-picker">
        {label}
        <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} placeholder="Nome de quem recebeu/abasteceu" />
        {toggleManual}
      </label>
    );
  }
  if (value.employeeId) {
    return (
      <div className="fuel-equipment-selected">
        <span>{label}</span>
        <div><strong>{value.name}</strong><button type="button" onClick={() => { onChange({ employeeId: null, name: "", manual: false }); setOpen(true); }}>Trocar</button></div>
      </div>
    );
  }
  return (
    <div className="fuel-equipment-picker fuel-employee-picker">
      <label>
        {label}
        <div className="page-search"><span>⌕</span><input value={query} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 180)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} placeholder={placeholder} /></div>
      </label>
      {toggleManual}
      {open && (
        <ul className="fuel-equipment-results" role="listbox">
          {loading && <li className="muted">Buscando...</li>}
          {!loading && unavailable && <li className="muted">Lista de funcionários indisponível — use &quot;Digitar nome manualmente&quot;.</li>}
          {!loading && !unavailable && items.length === 0 && <li className="muted">{query ? "Nenhum funcionário encontrado. Cadastre em Funcionários ou digite o nome manualmente." : "Digite para buscar."}</li>}
          {!loading && items.map((item) => (
            <li key={item.id} role="option" aria-selected={false} onMouseDown={(event) => { event.preventDefault(); onChange({ employeeId: item.id, name: item.name, manual: false }); setOpen(false); }}>
              <strong>{item.name}</strong><span>{item.jobTitle}</span><small>{item.inFront ? item.company : `${item.frontName} · ${item.company}`}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Busca de equipamento: prioriza a frente do lançamento, mas mostra também os de outras frentes,
// identificados com a frente onde realmente estão (o lançamento para eles é bloqueado).
function EquipmentPicker({ frontId, frontName, value, onChange, required, historical = false }: { frontId: number | null; frontName: string | null; value: EquipmentOption | null; onChange: (item: EquipmentOption | null) => void; required: boolean; historical?: boolean }) {
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
      if (historical) params.set("historico", "1");
      api<{ equipment: EquipmentOption[] }>(`/api/fuel/equipment?${params.toString()}`).then((result) => setItems(result.equipment)).catch(() => setItems([])).finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, frontId, open, historical]);

  if (value) {
    const other = frontId !== null && value.serviceFrontId !== frontId;
    return (
      <div className={`fuel-equipment-selected ${other ? "other-front" : ""}`}>
        <span>Veículo/Máquina{required ? " *" : ""}</span>
        <div><strong>{value.prefix}</strong><small>{`${value.brand} ${value.model}`.trim()}</small>{other && <em>está em {value.frontName ?? "outra frente"}</em>}<button type="button" onClick={() => { onChange(null); setOpen(true); }}>Trocar</button></div>
      </div>
    );
  }
  return (
    <div className="fuel-equipment-picker">
      <label>
        Veículo/Máquina{required ? " *" : ""}
        <div className="page-search"><span>⌕</span><input value={query} required={required} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 180)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} placeholder={frontName ? `Prefixo, modelo ou placa (${frontName})` : "Prefixo, modelo ou placa"} /></div>
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

function FuelHistory({ summary, canManage, flash, onEdit, onDeleted }: {
  summary: Summary; canManage: boolean; flash: (message: string) => void;
  onEdit: (movement: Movement) => void; onDeleted: (message: string) => Promise<void>;
}) {
  const [period, setPeriod] = useState(monthPeriod);
  const [frontFilter, setFrontFilter] = useState("");
  const [fuelTypeId, setFuelTypeId] = useState("");
  const [movementType, setMovementType] = useState("");
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState("");
  const [thirdPartyFilter, setThirdPartyFilter] = useState("");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const thirdPartyOptions = useThirdPartyOptions();
  const filterVehicles = thirdPartyOptions.options.find((item) => String(item.id) === thirdPartyFilter)?.vehicles ?? [];
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query), 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { setPage(1); }, [fuelTypeId, movementType, location, debounced, period.from, period.to, frontFilter, pending, thirdPartyFilter, vehicleFilter]);
  const params = useMemo(() => {
    const value = new URLSearchParams({ from: period.from, to: period.to });
    if (fuelTypeId) value.set("fuelTypeId", fuelTypeId);
    if (movementType) value.set("movementType", movementType);
    if (location) value.set("location", location);
    if (debounced) value.set("q", debounced);
    if (frontFilter) value.set("frontId", frontFilter);
    if (pending) value.set("pending", pending);
    if (thirdPartyFilter) value.set("thirdPartyId", thirdPartyFilter);
    if (thirdPartyFilter && vehicleFilter) value.set("vehicleId", vehicleFilter);
    return value;
  }, [period, fuelTypeId, movementType, location, debounced, frontFilter, pending, thirdPartyFilter, vehicleFilter]);
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

  const originText = (movement: Movement) => {
    if (movement.movementType !== "TRANSFERENCIA") return movement.stockLocationLabel;
    const otherFront = movement.destinationFrontId && movement.destinationFrontId !== movement.serviceFrontId;
    return `${movement.stockLocationLabel} → ${movement.destinationLocationLabel ?? "Frente"}${otherFront ? ` ${movement.destinationFrontName ?? ""}` : ""}`;
  };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportUrl = (format: "pdf" | "xlsx") => `/api/fuel/export?${params.toString()}&formato=${format}`;
  return (
    <article className="panel module-panel fuel-history-panel">
      <div className="products-filters fuel-history-filters">
        <label className="page-search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Equipamento, terceiro, responsável..." /></label>
        <label>De<input type="date" value={period.from} max={period.to} onChange={(event) => event.target.value && setPeriod({ ...period, from: event.target.value })} /></label>
        <label>Até<input type="date" value={period.to} min={period.from} onChange={(event) => event.target.value && setPeriod({ ...period, to: event.target.value })} /></label>
        {summary.multiFront && summary.scopeFrontIds.length > 1 && (
          <label>Frente<select value={frontFilter} onChange={(event) => setFrontFilter(event.target.value)}>
            <option value="">Todas em exibição</option>
            {summary.fronts.filter((front) => summary.scopeFrontIds.includes(front.id)).map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
          </select></label>
        )}
        <label>Combustível<select value={fuelTypeId} onChange={(event) => setFuelTypeId(event.target.value)}><option value="">Todos</option>{summary.fuelTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
        <label>Movimentação<select value={movementType} onChange={(event) => setMovementType(event.target.value)}><option value="">Todas</option>{MOVEMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="TERCEIROS">Saída para terceiros</option><option value="PRESTADORES">Saída — Prestador de Serviço</option></select></label>
        <label>Estoque<select value={location} onChange={(event) => setLocation(event.target.value)}><option value="">Frente e Porto</option>{LOCATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {/* Pendências da carga de histórico: ao escolher, o período abre desde o início do histórico. */}
        <label>Pendências<select value={pending} onChange={(event) => { setPending(event.target.value); if (event.target.value && period.from > HISTORY_START) setPeriod({ ...period, from: HISTORY_START }); }}><option value="">Nenhum filtro</option><option value="VEICULO">Veículo a identificar</option><option value="ORIGEM">Origem a confirmar</option><option value="IMPORTADOS">Importados do histórico</option></select></label>
        <label>Empresa / terceiro<select value={thirdPartyFilter} onChange={(event) => { setThirdPartyFilter(event.target.value); setVehicleFilter(""); }}><option value="">Todos</option>{thirdPartyOptions.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {thirdPartyFilter && filterVehicles.length > 0 && <label>Veículo<select value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)}><option value="">Todos</option>{filterVehicles.map((item) => <option key={item.id} value={item.id}>{item.plate}{item.description ? ` · ${item.description}` : ""}</option>)}</select></label>}
        <div className="fuel-export-actions">
          <a className="secondary" href={exportUrl("pdf")} target="_blank" rel="noopener noreferrer">Exportar PDF</a>
          <a className="secondary" href={exportUrl("xlsx")}>Exportar Excel</a>
        </div>
      </div>
      {error && <div className="operation-error"><span>!</span><div><strong>Falha ao carregar</strong><p>{error}</p></div><button onClick={load}>Tentar novamente</button></div>}
      {loading && !data ? <div className="page-loading"><span /><p>Carregando histórico...</p></div> : (
        <>
          {data?.summary && <HistorySummaryCards summary={data.summary} />}
          <div className="table-scroll">
            <table className="products-table fuel-history-table">
              <thead><tr><th>Data</th><th>Tipo</th><th>Combustível</th><th>Quantidade</th><th>Custo</th><th>Frente</th><th>Origem</th><th>Veículo/Máquina · Terceiro · Prestador</th><th>Hod./Horím.</th><th title="Consumo do abastecimento (veículos de terceiros): km/L ou L/h">Consumo</th><th>Responsável</th>{canManage && <th>Ações</th>}</tr></thead>
              <tbody>
                {data?.movements.map((movement) => (
                  <tr key={movement.id}>
                    <td>{brDay(movement.movementDate)}</td>
                    <td><span className={`fuel-type-pill ${movement.thirdParty ? (movement.thirdPartyKind === "PRESTADOR" ? "prestador" : "terceiros") : movement.movementType.toLowerCase()}`}>{movement.movementLabel}</span></td>
                    <td>{movement.fuelName}</td>
                    <td className="price-cell">{liters(movement.quantity)}</td>
                    <td className="price-cell" title={movement.unitCost !== null ? `${money(movement.unitCost)}/L ${movement.movementType === "ENTRADA" ? "(valor da entrada)" : "(custo médio do estoque)"}` : "Estoque sem valor por litro informado"}>
                      {movement.cost !== null ? money(movement.cost) : <small className="fuel-transfer">sem valor</small>}
                      {movement.unitCost !== null && <small className="fuel-unit-cost">{money(movement.unitCost)}/L</small>}
                    </td>
                    <td>{movement.frontName}</td>
                    <td>{originText(movement)}{movement.origin && <small className="fuel-transfer"> · {movement.origin}</small>}{!movement.originConfirmed && <span className="fuel-pending-badge origin" title="Origem assumida na importação do histórico">a confirmar</span>}</td>
                    <td>{movement.vehiclePending && !movement.equipmentPrefix ? <span className="fuel-pending-badge" title="Abastecimento importado sem veículo identificado">A identificar{movement.importedVehicle ? ` · ${movement.importedVehicle}` : ""}</span> : movement.thirdParty && movement.thirdPartyKind === "PRESTADOR" ? <span className="fuel-provider"><strong>{movement.providerCompany ?? "—"}</strong> <small>{movement.providerEquipment}</small></span> : movement.thirdParty ? <span className="fuel-third-party">{movement.thirdPartyDescription ?? "—"}</span> : movement.equipmentPrefix ? <><strong>{movement.equipmentPrefix}</strong> <small>{movement.equipmentModel}</small></> : "—"}</td>
                    <td>{movement.meterReading === null ? "—" : `${movement.meterReading.toLocaleString("pt-BR")} ${movement.meterUnit === "KM" ? "km" : "h"}`}</td>
                    <td className="price-cell">
                      {movement.consumption ? <strong>{movement.consumption.value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} {movement.consumption.unit}</strong> : movement.thirdPartyVehicleId ? <small className="fuel-transfer">{movement.readingException ? "nova base" : movement.fullTank ? "base" : "parcial"}</small> : "—"}
                      {movement.consumptionOutlier && <span className="fuel-pending-badge" title="Consumo mais de 25% diferente da média do veículo (confirmado no lançamento)">fora da média</span>}
                    </td>
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

// Cards do topo do Histórico: mesmos filtros da listagem, somando todas as páginas (servidor).
function HistorySummaryCards({ summary }: { summary: HistorySummary }) {
  const count = (value: number) => `${value.toLocaleString("pt-BR")} lançamento${value === 1 ? "" : "s"}`;
  const multiFuel = summary.byFuel.length > 1;
  const perFuel = (pick: (fuel: HistorySummary["byFuel"][number]) => Totals2) => multiFuel
    ? <small>{summary.byFuel.filter((fuel) => pick(fuel).count > 0).map((fuel) => `${fuel.fuelName}: ${liters(pick(fuel).liters)}`).join(" · ")}</small> : null;
  return (
    <div className="fuel-history-summary">
      {summary.show.entries && <div className="entrada"><span>Entradas</span><strong>{liters(summary.entries.liters)}</strong><em>{count(summary.entries.count)}</em>{perFuel((fuel) => fuel.entries)}</div>}
      {summary.show.exits && <div className="saida"><span>Saídas</span><strong>{liters(summary.exits.liters)}</strong><em>{count(summary.exits.count)}</em>{perFuel((fuel) => fuel.exits)}</div>}
      {summary.show.transfers && <div className="transferencia"><span>Transferências</span><strong>{liters(summary.transfers.liters)}</strong><em>{count(summary.transfers.count)}</em>{perFuel((fuel) => fuel.transfers)}</div>}
      {summary.balance !== null && <div className={summary.balance < 0 ? "saldo negativo" : "saldo"}><span>Saldo da movimentação</span><strong>{summary.balance > 0 ? "+" : ""}{liters(summary.balance)}</strong><em>entradas − saídas no período</em></div>}
    </div>
  );
}
