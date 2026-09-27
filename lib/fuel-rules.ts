// Regras puras do Lançamento de Combustível (sem banco), testadas em tests/fuel-rules.test.mjs.

export const FUEL_MOVEMENT_TYPES = ["ENTRADA", "SAIDA", "TRANSFERENCIA"] as const;
export type FuelMovementType = typeof FUEL_MOVEMENT_TYPES[number];
export const FUEL_MOVEMENT_LABELS: Record<FuelMovementType, string> = { ENTRADA: "Entrada", SAIDA: "Saída", TRANSFERENCIA: "Transferência" };

export function isFuelMovementType(value: unknown): value is FuelMovementType {
  return typeof value === "string" && (FUEL_MOVEMENT_TYPES as readonly string[]).includes(value);
}

export type LedgerMovement = {
  serviceFrontId: number;
  destinationFrontId: number | null;
  fuelTypeId: number;
  movementType: FuelMovementType;
  movementDate: string;
  quantity: number;
};

export type FuelTotals = { balance: number; entries: number; exits: number };
export type FuelBalance = FuelTotals & { byFront: Map<number, FuelTotals> };

const round = (value: number) => Math.round(value * 1000) / 1000;
const emptyTotals = (): FuelTotals => ({ balance: 0, entries: 0, exits: 0 });

// Saldo = tudo o que entrou − tudo o que saiu, desde sempre (nunca gravado; sempre recalculado).
// Entradas/saídas do período = só os lançamentos entre `from` e `to` (datas AAAA-MM-DD, inclusive).
// Transferência: saída na frente de origem e entrada na frente destino. No consolidado, uma
// transferência entre duas frentes que estão AMBAS em exibição é movimento interno: não mexe no
// saldo total e também não conta como entrada/saída do consolidado (só no detalhe por frente).
export function computeFuelBalances(movements: LedgerMovement[], scope: { fronts: number[]; from: string; to: string }) {
  const inScope = new Set(scope.fronts);
  const result = new Map<number, FuelBalance>();
  const get = (fuelTypeId: number) => {
    let balance = result.get(fuelTypeId);
    if (!balance) { balance = { ...emptyTotals(), byFront: new Map() }; result.set(fuelTypeId, balance); }
    return balance;
  };
  const front = (balance: FuelBalance, id: number) => {
    let totals = balance.byFront.get(id);
    if (!totals) { totals = emptyTotals(); balance.byFront.set(id, totals); }
    return totals;
  };
  for (const movement of movements) {
    const inPeriod = movement.movementDate >= scope.from && movement.movementDate <= scope.to;
    const quantity = movement.quantity;
    const legs: Array<{ frontId: number; delta: number }> =
      movement.movementType === "ENTRADA" ? [{ frontId: movement.serviceFrontId, delta: quantity }]
        : movement.movementType === "SAIDA" ? [{ frontId: movement.serviceFrontId, delta: -quantity }]
          : [{ frontId: movement.serviceFrontId, delta: -quantity }, ...(movement.destinationFrontId ? [{ frontId: movement.destinationFrontId, delta: quantity }] : [])];
    const internal = movement.movementType === "TRANSFERENCIA" && legs.length === 2 && legs.every((leg) => inScope.has(leg.frontId));
    const scopedLegs = legs.filter((leg) => inScope.has(leg.frontId));
    if (scopedLegs.length === 0) continue;
    const balance = get(movement.fuelTypeId);
    for (const leg of scopedLegs) {
      const totals = front(balance, leg.frontId);
      totals.balance += leg.delta;
      balance.balance += leg.delta;
      if (!inPeriod) continue;
      if (leg.delta > 0) totals.entries += leg.delta; else totals.exits -= leg.delta;
      if (internal) continue;
      if (leg.delta > 0) balance.entries += leg.delta; else balance.exits -= leg.delta;
    }
  }
  for (const balance of result.values()) {
    balance.balance = round(balance.balance); balance.entries = round(balance.entries); balance.exits = round(balance.exits);
    for (const totals of balance.byFront.values()) { totals.balance = round(totals.balance); totals.entries = round(totals.entries); totals.exits = round(totals.exits); }
  }
  return result;
}

export type FuelMovementInput = {
  serviceFrontId: number;
  fuelTypeId: number;
  movementType: FuelMovementType;
  movementDate: string;
  quantity: number;
  equipmentId: number | null;
  meterReading: number | null;
  destinationFrontId: number | null;
};

export type FuelEquipmentContext = { id: number; prefix: string; serviceFrontId: number | null; frontName: string | null } | null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Devolve a mensagem de erro (ou null se o lançamento é válido). A regra mais importante: nunca
// lançar combustível para um equipamento que está em outra frente que não a do lançamento.
export function validateFuelMovement(input: FuelMovementInput, equipment: FuelEquipmentContext, today: string): string | null {
  if (!isFuelMovementType(input.movementType)) return "Escolha o tipo de movimentação (Entrada, Saída ou Transferência).";
  if (!Number.isInteger(input.serviceFrontId) || input.serviceFrontId <= 0) return "Escolha a frente de serviço do lançamento.";
  if (!Number.isInteger(input.fuelTypeId) || input.fuelTypeId <= 0) return "Escolha o tipo de combustível.";
  if (!DATE.test(input.movementDate) || Number.isNaN(new Date(`${input.movementDate}T12:00:00Z`).getTime())) return "Informe uma data válida.";
  if (input.movementDate > today) return "A data do lançamento não pode ser futura.";
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return "Informe a quantidade em litros (maior que zero).";
  if (input.meterReading !== null && (!Number.isFinite(input.meterReading) || input.meterReading < 0)) return "Informe um hodômetro/horímetro válido (zero ou mais).";
  if (input.movementType === "SAIDA" && !input.equipmentId) return "Na saída, informe o veículo/máquina abastecido.";
  if (input.movementType === "TRANSFERENCIA") {
    if (!input.destinationFrontId) return "Na transferência, informe a filial destino.";
    if (input.destinationFrontId === input.serviceFrontId) return "A filial destino precisa ser diferente da frente de origem.";
  }
  if (input.equipmentId) {
    if (!equipment) return "Veículo/máquina não encontrado.";
    if (equipment.serviceFrontId !== input.serviceFrontId)
      return `O equipamento ${equipment.prefix} está em ${equipment.frontName ?? "outra frente"}, não na frente deste lançamento. Transfira o equipamento ou lance pela frente correta.`;
  }
  return null;
}
