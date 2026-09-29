// Regras puras do Lançamento de Combustível (sem banco), testadas em tests/fuel-rules.test.mjs.

export const FUEL_MOVEMENT_TYPES = ["ENTRADA", "SAIDA", "TRANSFERENCIA"] as const;
export type FuelMovementType = typeof FUEL_MOVEMENT_TYPES[number];
export const FUEL_MOVEMENT_LABELS: Record<FuelMovementType, string> = { ENTRADA: "Entrada", SAIDA: "Saída", TRANSFERENCIA: "Transferência" };
export const THIRD_PARTY_LABEL = "Saída para terceiros";
export const PROVIDER_LABEL = "Saída — Prestador de Serviço";
export type ThirdPartyKind = "GERAL" | "PRESTADOR";

// Cada frente tem dois estoques independentes: o da Frente e o do Porto.
export const FUEL_LOCATIONS = ["FRENTE", "PORTO"] as const;
export type FuelLocation = typeof FUEL_LOCATIONS[number];
export const FUEL_LOCATION_LABELS: Record<FuelLocation, string> = { FRENTE: "Frente", PORTO: "Porto" };

export function isFuelMovementType(value: unknown): value is FuelMovementType {
  return typeof value === "string" && (FUEL_MOVEMENT_TYPES as readonly string[]).includes(value);
}
export function isFuelLocation(value: unknown): value is FuelLocation {
  return typeof value === "string" && (FUEL_LOCATIONS as readonly string[]).includes(value);
}

export function fuelMovementLabel(movement: { movementType: FuelMovementType; thirdParty?: boolean; thirdPartyKind?: ThirdPartyKind | null }) {
  if (movement.movementType !== "SAIDA" || !movement.thirdParty) return FUEL_MOVEMENT_LABELS[movement.movementType];
  return movement.thirdPartyKind === "PRESTADOR" ? PROVIDER_LABEL : THIRD_PARTY_LABEL;
}

export type LedgerMovement = {
  serviceFrontId: number;
  stockLocation?: FuelLocation;
  destinationFrontId: number | null;
  destinationLocation?: FuelLocation | null;
  fuelTypeId: number;
  movementType: FuelMovementType;
  movementDate: string;
  quantity: number;
  // Ajuste de saldo: muda o saldo, mas não conta como entrada/saída.
  balanceAdjustment?: boolean;
};

export type FuelTotals = { balance: number; entries: number; exits: number };
export type FuelLocationTotals = FuelTotals & { byLocation: Record<FuelLocation, FuelTotals> };
export type FuelBalance = FuelLocationTotals & { byFront: Map<number, FuelLocationTotals> };

const round = (value: number) => Math.round(value * 1000) / 1000;
const emptyTotals = (): FuelTotals => ({ balance: 0, entries: 0, exits: 0 });
const emptyLocationTotals = (): FuelLocationTotals => ({ ...emptyTotals(), byLocation: { FRENTE: emptyTotals(), PORTO: emptyTotals() } });

type Leg = { frontId: number; location: FuelLocation; delta: number };

// Aplica os "pés" de um lançamento a um agrupamento (consolidado, uma frente, um estoque...).
// Se os dois pés de uma transferência caem no MESMO agrupamento, ela é interna a ele: o saldo não
// muda (os pés se anulam) e ela não conta como entrada/saída desse agrupamento.
function apply(totals: FuelTotals, legs: Leg[], allLegs: number, inPeriod: boolean, balanceOnly = false) {
  if (legs.length === 0) return;
  for (const leg of legs) totals.balance += leg.delta;
  if (balanceOnly || !inPeriod || (allLegs === 2 && legs.length === 2)) return;
  for (const leg of legs) {
    if (leg.delta > 0) totals.entries += leg.delta; else totals.exits -= leg.delta;
  }
}

function roundTotals(totals: FuelTotals) {
  totals.balance = round(totals.balance); totals.entries = round(totals.entries); totals.exits = round(totals.exits);
}

// Saldo = tudo o que entrou − tudo o que saiu, desde sempre (nunca gravado; sempre recalculado).
// Entradas/saídas do período = só os lançamentos entre `from` e `to` (datas AAAA-MM-DD, inclusive).
// Transferência: sai do estoque de origem (frente + Frente/Porto) e entra no estoque destino.
export function computeFuelBalances(movements: LedgerMovement[], scope: { fronts: number[]; from: string; to: string }) {
  const inScope = new Set(scope.fronts);
  const result = new Map<number, FuelBalance>();
  for (const movement of movements) {
    const inPeriod = movement.movementDate >= scope.from && movement.movementDate <= scope.to;
    const adjustment = movement.balanceAdjustment === true;
    const quantity = movement.quantity;
    const origin: FuelLocation = movement.stockLocation ?? "FRENTE";
    const legs: Leg[] =
      movement.movementType === "ENTRADA" ? [{ frontId: movement.serviceFrontId, location: origin, delta: quantity }]
        : movement.movementType === "SAIDA" ? [{ frontId: movement.serviceFrontId, location: origin, delta: -quantity }]
          : [
            { frontId: movement.serviceFrontId, location: origin, delta: -quantity },
            { frontId: movement.destinationFrontId ?? movement.serviceFrontId, location: movement.destinationLocation ?? "FRENTE", delta: quantity },
          ];
    const scoped = legs.filter((leg) => inScope.has(leg.frontId));
    if (scoped.length === 0) continue;
    let balance = result.get(movement.fuelTypeId);
    if (!balance) { balance = { ...emptyLocationTotals(), byFront: new Map() }; result.set(movement.fuelTypeId, balance); }
    apply(balance, scoped, legs.length, inPeriod, adjustment);
    for (const location of FUEL_LOCATIONS) apply(balance.byLocation[location], scoped.filter((leg) => leg.location === location), legs.length, inPeriod, adjustment);
    for (const frontId of new Set(scoped.map((leg) => leg.frontId))) {
      let front = balance.byFront.get(frontId);
      if (!front) { front = emptyLocationTotals(); balance.byFront.set(frontId, front); }
      const frontLegs = scoped.filter((leg) => leg.frontId === frontId);
      apply(front, frontLegs, legs.length, inPeriod, adjustment);
      for (const location of FUEL_LOCATIONS) apply(front.byLocation[location], frontLegs.filter((leg) => leg.location === location), legs.length, inPeriod, adjustment);
    }
  }
  for (const balance of result.values()) {
    for (const totals of [balance, ...Object.values(balance.byLocation)]) roundTotals(totals);
    for (const front of balance.byFront.values()) for (const totals of [front, ...Object.values(front.byLocation)]) roundTotals(totals);
  }
  return result;
}

export type FuelMovementInput = {
  serviceFrontId: number;
  stockLocation: FuelLocation;
  fuelTypeId: number;
  movementType: FuelMovementType;
  movementDate: string;
  quantity: number;
  equipmentId: number | null;
  meterReading: number | null;
  destinationFrontId: number | null;
  destinationLocation: FuelLocation | null;
  thirdParty: boolean;
  thirdPartyKind: ThirdPartyKind | null;
  thirdPartyDescription: string | null;
  providerCompany: string | null;
  providerEquipment: string | null;
  unitPrice: number | null;
  responsible: string | null;
};

export type FuelEquipmentContext = { id: number; prefix: string; serviceFrontId: number | null; frontName: string | null } | null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Devolve a mensagem de erro (ou null se o lançamento é válido). A regra mais importante: nunca
// lançar combustível para um equipamento que está em outra frente que não a do lançamento.
// historical = lançamento vindo da carga retroativa de histórico (fuel_movements.import_source): na
// correção dele continuam valendo as regras de estrutura (tipo, data, quantidade, destino da
// transferência), mas não os campos obrigatórios dos lançamentos novos (responsável, valor por litro,
// veículo na saída) nem a frente ATUAL do equipamento (ele pode ter sido transferido ou vendido depois).
export function validateFuelMovement(input: FuelMovementInput, equipment: FuelEquipmentContext, today: string, options: { historical?: boolean } = {}): string | null {
  const historical = options.historical === true;
  if (!isFuelMovementType(input.movementType)) return "Escolha o tipo de movimentação (Entrada, Saída ou Transferência).";
  if (!Number.isInteger(input.serviceFrontId) || input.serviceFrontId <= 0) return "Escolha a frente de serviço do lançamento.";
  if (!isFuelLocation(input.stockLocation)) return "Escolha a origem do lançamento (Frente ou Porto).";
  if (!Number.isInteger(input.fuelTypeId) || input.fuelTypeId <= 0) return "Escolha o tipo de combustível.";
  if (!DATE.test(input.movementDate) || Number.isNaN(new Date(`${input.movementDate}T12:00:00Z`).getTime())) return "Informe uma data válida.";
  if (input.movementDate > today) return "A data do lançamento não pode ser futura.";
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return "Informe a quantidade em litros (maior que zero).";
  if (input.meterReading !== null && (!Number.isFinite(input.meterReading) || input.meterReading < 0)) return "Informe um hodômetro/horímetro válido (zero ou mais).";
  // Responsável é obrigatório em todos os tipos (na Entrada é quem recebeu o combustível).
  if (!historical && !input.responsible?.trim()) return input.movementType === "ENTRADA" ? "Informe o responsável que recebeu o combustível." : "Informe o responsável.";
  if (input.movementType === "ENTRADA") {
    if (historical ? input.unitPrice !== null && (!Number.isFinite(input.unitPrice) || input.unitPrice <= 0) : input.unitPrice === null || !Number.isFinite(input.unitPrice) || input.unitPrice <= 0) return "Informe o valor por litro (R$) desta entrada.";
    if (input.equipmentId) return "A entrada não é vinculada a veículo/máquina.";
  }
  if (input.thirdParty) {
    if (input.movementType !== "SAIDA") return "Saída para terceiros só vale para o tipo Saída.";
    if (input.equipmentId) return "Saída para terceiros não usa equipamento da frota.";
    if (input.thirdPartyKind === "PRESTADOR") {
      if (!input.providerCompany?.trim()) return "Informe a empresa do prestador de serviço.";
      if (!input.providerEquipment?.trim()) return "Informe a descrição do equipamento do prestador.";
    } else if (!input.thirdPartyDescription?.trim()) return "Na saída para terceiros, informe o Destino/Descrição (quem recebeu o combustível).";
  } else if (!historical && input.movementType === "SAIDA" && !input.equipmentId) return "Na saída, informe o veículo/máquina abastecido (ou use Saída para terceiros).";
  if (input.movementType === "TRANSFERENCIA") {
    if (!isFuelLocation(input.destinationLocation)) return "Na transferência, informe o estoque de destino (Frente ou Porto).";
    const destinationFront = input.destinationFrontId ?? input.serviceFrontId;
    if (destinationFront === input.serviceFrontId && input.destinationLocation === input.stockLocation) return "O destino da transferência precisa ser diferente da origem (ex.: Frente → Porto).";
  }
  if (input.equipmentId) {
    if (!equipment) return "Veículo/máquina não encontrado.";
    if (!historical && equipment.serviceFrontId !== input.serviceFrontId)
      return `O equipamento ${equipment.prefix} está em ${equipment.frontName ?? "outra frente"}, não na frente deste lançamento. Transfira o equipamento ou lance pela frente correta.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Custo das saídas: custo médio ponderado de cada estoque (frente + Frente/Porto + combustível).
// Entrada com valor por litro recalcula a média; transferência leva o custo médio da origem para
// o destino; saída custa quantidade × média vigente do estoque de origem naquele momento.
// Calculado ao vivo (nunca gravado), na ordem data + id — editar/excluir uma entrada corrige o
// custo de todas as saídas seguintes. Entrada antiga sem valor soma litros sem mexer na média;
// estoque que nunca teve valor informado deixa o custo da saída como null ("sem valor").
// ---------------------------------------------------------------------------
export type CostMovement = LedgerMovement & { id: number; unitPrice?: number | null };
export type FuelCost = { unitCost: number | null; cost: number | null };

export function computeFuelCosts(movements: CostMovement[]) {
  const ordered = [...movements].sort((a, b) => a.movementDate.localeCompare(b.movementDate) || a.id - b.id);
  const stocks = new Map<string, { quantity: number; average: number | null }>();
  const stock = (frontId: number, location: FuelLocation, fuelTypeId: number) => {
    const key = `${frontId}:${location}:${fuelTypeId}`;
    let value = stocks.get(key);
    if (!value) { value = { quantity: 0, average: null }; stocks.set(key, value); }
    return value;
  };
  const receive = (target: { quantity: number; average: number | null }, quantity: number, unitCost: number | null) => {
    if (unitCost !== null) {
      const base = Math.max(target.quantity, 0);
      target.average = target.average === null || base === 0 ? unitCost : (base * target.average + quantity * unitCost) / (base + quantity);
    }
    target.quantity += quantity;
  };
  const costs = new Map<number, FuelCost>();
  const money = (value: number) => Math.round(value * 100) / 100;
  for (const movement of ordered) {
    const origin = stock(movement.serviceFrontId, movement.stockLocation ?? "FRENTE", movement.fuelTypeId);
    if (movement.movementType === "ENTRADA") {
      const price = movement.unitPrice != null && movement.unitPrice > 0 ? movement.unitPrice : null;
      receive(origin, movement.quantity, price);
      costs.set(movement.id, { unitCost: price, cost: price === null ? null : money(price * movement.quantity) });
      continue;
    }
    const unitCost = origin.average;
    origin.quantity -= movement.quantity;
    costs.set(movement.id, { unitCost, cost: unitCost === null ? null : money(unitCost * movement.quantity) });
    if (movement.movementType === "TRANSFERENCIA") {
      receive(stock(movement.destinationFrontId ?? movement.serviceFrontId, movement.destinationLocation ?? "FRENTE", movement.fuelTypeId), movement.quantity, unitCost);
    }
  }
  return costs;
}
