import type { FuelLocation, FuelMovementType } from "./fuel-rules";

// ---------------------------------------------------------------------------
// Resumo do dia do Combustível (Histórico → "Resumo do dia") — regras puras.
// Um estoque = frente + local (Frente, Porto ou os dois juntos). Cada lançamento vira "pés"
// (entrada +, saída −, transferência = − na origem e + no destino), como em computeFuelBalances:
//  - saldo anterior = soma dos pés no estoque com data ANTERIOR ao dia (inclui ajustes de saldo);
//  - no dia: entradas, transferências recebidas/enviadas, ajustes e consumo (saídas);
//  - transferência com os dois pés no mesmo estoque (ex.: Frente → Porto com "Frente + Porto")
//    é interna: não muda o saldo e não aparece.
// saldo final = anterior + entradas + recebidas − enviadas − consumo (+ ajustes, se houver).
// ---------------------------------------------------------------------------
export type DailyLocation = FuelLocation | "TODOS";
export const DAILY_LOCATION_LABELS: Record<DailyLocation, string> = { FRENTE: "Frente", PORTO: "Porto", TODOS: "Frente + Porto" };

export type DailyMovement = {
  id: number; fuelTypeId: number; movementType: FuelMovementType; movementDate: string; quantity: number; serviceFrontId: number; stockLocation: FuelLocation;
  destinationFrontId: number | null; destinationLocation: FuelLocation | null; balanceAdjustment: boolean;
};
export type DailyTotals = {
  previous: number; entries: number; transfersIn: number; transfersOut: number; adjustments: number; consumption: number; final: number;
  exitIds: number[]; entryIds: number[]; transferIds: number[]; adjustmentIds: number[];
};

const round = (value: number) => Math.round(value * 1000) / 1000;

function legs(movement: DailyMovement) {
  const origin = movement.stockLocation;
  if (movement.movementType === "ENTRADA") return [{ frontId: movement.serviceFrontId, location: origin, delta: movement.quantity }];
  if (movement.movementType === "SAIDA") return [{ frontId: movement.serviceFrontId, location: origin, delta: -movement.quantity }];
  return [
    { frontId: movement.serviceFrontId, location: origin, delta: -movement.quantity },
    { frontId: movement.destinationFrontId ?? movement.serviceFrontId, location: movement.destinationLocation ?? "FRENTE", delta: movement.quantity },
  ];
}

export function dailyTotals(movements: DailyMovement[], scope: { date: string; frontId: number; location: DailyLocation }): DailyTotals {
  const totals: DailyTotals = { previous: 0, entries: 0, transfersIn: 0, transfersOut: 0, adjustments: 0, consumption: 0, final: 0, exitIds: [], entryIds: [], transferIds: [], adjustmentIds: [] };
  const inScope = (leg: { frontId: number; location: FuelLocation }) => leg.frontId === scope.frontId && (scope.location === "TODOS" || leg.location === scope.location);
  for (const movement of movements) {
    if (movement.movementDate > scope.date) continue;
    const all = legs(movement);
    const mine = all.filter(inScope);
    if (mine.length === 0) continue;
    const delta = mine.reduce((sum, leg) => sum + leg.delta, 0);
    if (movement.movementDate < scope.date) { totals.previous += delta; continue; }
    if (movement.balanceAdjustment) { if (delta !== 0) { totals.adjustments += delta; totals.adjustmentIds.push(movement.id); } continue; }
    if (movement.movementType === "ENTRADA") { totals.entries += delta; totals.entryIds.push(movement.id); }
    else if (movement.movementType === "SAIDA") { totals.consumption -= delta; totals.exitIds.push(movement.id); }
    else if (mine.length === all.length) continue; // transferência interna ao estoque escolhido
    else { if (delta > 0) totals.transfersIn += delta; else totals.transfersOut -= delta; totals.transferIds.push(movement.id); }
  }
  for (const key of ["previous", "entries", "transfersIn", "transfersOut", "adjustments", "consumption"] as const) totals[key] = round(totals[key]);
  totals.final = round(totals.previous + totals.entries + totals.transfersIn - totals.transfersOut - totals.consumption + totals.adjustments);
  return totals;
}

// 83.174L · 1.234,5L · -12L (ponto de milhar, vírgula decimal, "L" colado).
export function litersMessage(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return `${(Object.is(rounded, -0) ? 0 : rounded).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}L`;
}
export const brDay = (iso: string) => iso.split("-").reverse().join("/");

// Configuração por frente (ADMIN edita). Aceita {frente}, {combustivel} e {ano}.
export type DailyMessageSettings = { greeting: string; title: string; balanceLabel: string };
export const DEFAULT_DAILY_SETTINGS: DailyMessageSettings = { greeting: "Bom dia a todos!", title: "Controle de {combustivel} {frente} {ano}", balanceLabel: "Saldo {frente}" };

export function fillTemplate(template: string, values: { frente: string; combustivel: string; ano: string }) {
  return template.replace(/\{(frente|combustivel|ano)\}/gi, (_, key: string) => values[key.toLowerCase() as keyof typeof values]).replace(/\s+/g, " ").trim();
}

export function dailyMessage(input: { settings: DailyMessageSettings; frontName: string; fuelName: string; date: string; totals: DailyTotals }) {
  const values = { frente: input.frontName, combustivel: input.fuelName.replace(/\s+S\d+$/i, ""), ano: input.date.slice(0, 4) };
  const { totals } = input;
  const optional = [
    totals.entries > 0 ? `Entrada: ${litersMessage(totals.entries)}` : null,
    totals.transfersIn > 0 ? `Transferência recebida: ${litersMessage(totals.transfersIn)}` : null,
    totals.transfersOut > 0 ? `Transferência enviada: ${litersMessage(totals.transfersOut)}` : null,
    totals.adjustments !== 0 ? `Ajuste de saldo: ${totals.adjustments > 0 ? "+" : ""}${litersMessage(totals.adjustments)}` : null,
  ].filter((line): line is string => line !== null);
  const header = [fillTemplate(input.settings.greeting, values), fillTemplate(input.settings.title, values)].filter(Boolean).join("\n");
  return [
    header,
    `Data: ${brDay(input.date)}`,
    `Saldo anterior: ${litersMessage(totals.previous)}`,
    ...optional,
    `Consumo: ${litersMessage(totals.consumption)}`,
    `${fillTemplate(input.settings.balanceLabel, values) || "Saldo"}: ${litersMessage(totals.final)}`,
  ].join("\n\n");
}
