// Regras puras do Lançamento de Combustível (sem banco), testadas em tests/fuel-rules.test.mjs.

export const FUEL_MOVEMENT_TYPES = ["ENTRADA", "SAIDA", "TRANSFERENCIA"] as const;
export type FuelMovementType = typeof FUEL_MOVEMENT_TYPES[number];
export const FUEL_MOVEMENT_LABELS: Record<FuelMovementType, string> = { ENTRADA: "Entrada", SAIDA: "Saída", TRANSFERENCIA: "Transferência" };
export const THIRD_PARTY_LABEL = "Saída para terceiros";

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

export function fuelMovementLabel(movement: { movementType: FuelMovementType; thirdParty?: boolean }) {
  return movement.movementType === "SAIDA" && movement.thirdParty ? THIRD_PARTY_LABEL : FUEL_MOVEMENT_LABELS[movement.movementType];
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
function apply(totals: FuelTotals, legs: Leg[], allLegs: number, inPeriod: boolean) {
  if (legs.length === 0) return;
  for (const leg of legs) totals.balance += leg.delta;
  if (!inPeriod || (allLegs === 2 && legs.length === 2)) return;
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
    apply(balance, scoped, legs.length, inPeriod);
    for (const location of FUEL_LOCATIONS) apply(balance.byLocation[location], scoped.filter((leg) => leg.location === location), legs.length, inPeriod);
    for (const frontId of new Set(scoped.map((leg) => leg.frontId))) {
      let front = balance.byFront.get(frontId);
      if (!front) { front = emptyLocationTotals(); balance.byFront.set(frontId, front); }
      const frontLegs = scoped.filter((leg) => leg.frontId === frontId);
      apply(front, frontLegs, legs.length, inPeriod);
      for (const location of FUEL_LOCATIONS) apply(front.byLocation[location], frontLegs.filter((leg) => leg.location === location), legs.length, inPeriod);
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
  thirdPartyDescription: string | null;
  responsible: string | null;
};

export type FuelEquipmentContext = { id: number; prefix: string; serviceFrontId: number | null; frontName: string | null } | null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Devolve a mensagem de erro (ou null se o lançamento é válido). A regra mais importante: nunca
// lançar combustível para um equipamento que está em outra frente que não a do lançamento.
export function validateFuelMovement(input: FuelMovementInput, equipment: FuelEquipmentContext, today: string): string | null {
  if (!isFuelMovementType(input.movementType)) return "Escolha o tipo de movimentação (Entrada, Saída ou Transferência).";
  if (!Number.isInteger(input.serviceFrontId) || input.serviceFrontId <= 0) return "Escolha a frente de serviço do lançamento.";
  if (!isFuelLocation(input.stockLocation)) return "Escolha a origem do lançamento (Frente ou Porto).";
  if (!Number.isInteger(input.fuelTypeId) || input.fuelTypeId <= 0) return "Escolha o tipo de combustível.";
  if (!DATE.test(input.movementDate) || Number.isNaN(new Date(`${input.movementDate}T12:00:00Z`).getTime())) return "Informe uma data válida.";
  if (input.movementDate > today) return "A data do lançamento não pode ser futura.";
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return "Informe a quantidade em litros (maior que zero).";
  if (input.meterReading !== null && (!Number.isFinite(input.meterReading) || input.meterReading < 0)) return "Informe um hodômetro/horímetro válido (zero ou mais).";
  if (input.thirdParty) {
    if (input.movementType !== "SAIDA") return "Saída para terceiros só vale para o tipo Saída.";
    if (!input.thirdPartyDescription?.trim()) return "Na saída para terceiros, informe o Destino/Descrição (quem recebeu o combustível).";
    if (!input.responsible?.trim()) return "Informe o responsável pela saída para terceiros.";
    if (input.equipmentId) return "Saída para terceiros não usa equipamento da frota.";
  } else if (input.movementType === "SAIDA" && !input.equipmentId) return "Na saída, informe o veículo/máquina abastecido (ou use Saída para terceiros).";
  if (input.movementType === "TRANSFERENCIA") {
    if (!isFuelLocation(input.destinationLocation)) return "Na transferência, informe o estoque de destino (Frente ou Porto).";
    const destinationFront = input.destinationFrontId ?? input.serviceFrontId;
    if (destinationFront === input.serviceFrontId && input.destinationLocation === input.stockLocation) return "O destino da transferência precisa ser diferente da origem (ex.: Frente → Porto).";
  }
  if (input.equipmentId) {
    if (!equipment) return "Veículo/máquina não encontrado.";
    if (equipment.serviceFrontId !== input.serviceFrontId)
      return `O equipamento ${equipment.prefix} está em ${equipment.frontName ?? "outra frente"}, não na frente deste lançamento. Transfira o equipamento ou lance pela frente correta.`;
  }
  return null;
}
