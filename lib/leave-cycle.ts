// Ciclo de folga — ÚNICO lugar com a conta de dias do módulo Funcionários (Painel, abas de viagem/
// folga, Histórico, Perfil e alertas usam só isto). Regras puras, testadas em
// tests/leave-cycle.test.mjs.
//
// Etapas (datas lançadas à mão, AAAA-MM-DD):
//   1. workStart      — início do ciclo: chegou/voltou à frente e começa a contar dias trabalhados
//   2. frontDeparture — saída da frente rumo a casa
//   3. homeArrival    — chegada em casa (a folga só começa a contar aqui)
//   4. homeDeparture  — saída de casa (retorno)
//   5. frontArrival   — chegada na frente: fecha o ciclo e o próximo começa nesta data
// Dias trabalhados = frontDeparture − workStart; viagem de ida = homeArrival − frontDeparture;
// folga = homeDeparture − homeArrival; viagem de volta = frontArrival − homeDeparture.
// Enquanto a etapa seguinte não tem data, conta-se até hoje.

export type CycleDates = {
  workStart: string | null;
  frontDeparture: string | null;
  homeArrival: string | null;
  homeDeparture: string | null;
  frontArrival: string | null;
};
export type CycleTargets = { workDaysTarget: number; offDaysTarget: number };

export const CYCLE_STEPS = ["workStart", "frontDeparture", "homeArrival", "homeDeparture", "frontArrival"] as const;
export type CycleStep = typeof CYCLE_STEPS[number];
export const CYCLE_STEP_LABELS: Record<CycleStep, string> = {
  workStart: "Início do ciclo", frontDeparture: "Saída da frente", homeArrival: "Chegada em casa",
  homeDeparture: "Saída de casa", frontArrival: "Chegada na frente",
};

// Fase atual: TRABALHANDO → VIAGEM_IDA → FOLGA → VIAGEM_VOLTA → FECHADO.
// SEM_CICLO = funcionário sem data de início (ex.: importado, ainda não configurado).
export type CyclePhase = "SEM_CICLO" | "TRABALHANDO" | "VIAGEM_IDA" | "FOLGA" | "VIAGEM_VOLTA" | "FECHADO";
export const CYCLE_PHASE_LABELS: Record<CyclePhase, string> = {
  SEM_CICLO: "Ciclo não iniciado", TRABALHANDO: "Trabalhando", VIAGEM_IDA: "Em viagem (ida)",
  FOLGA: "De folga", VIAGEM_VOLTA: "Viagem de retorno", FECHADO: "Ciclo fechado",
};

// Alerta de folga se aproximando: faltando até 5 dias (níveis 5, 3 e 1).
export const APPROACHING_THRESHOLDS = [5, 3, 1] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isCycleDate(value: unknown): value is string {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());
}

export function daysBetween(from: string, to: string) {
  return Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
}

export function cyclePhase(dates: CycleDates): CyclePhase {
  if (dates.frontArrival) return "FECHADO";
  if (dates.homeDeparture) return "VIAGEM_VOLTA";
  if (dates.homeArrival) return "FOLGA";
  if (dates.frontDeparture) return "VIAGEM_IDA";
  if (dates.workStart) return "TRABALHANDO";
  return "SEM_CICLO";
}

// Próxima etapa a registrar (null quando o ciclo está fechado).
export function nextStep(dates: CycleDates): CycleStep | null {
  return CYCLE_STEPS.find((step) => !dates[step]) ?? null;
}

const span = (from: string | null, to: string | null, today: string, open: boolean) =>
  from ? Math.max(0, daysBetween(from, to ?? (open ? today : from))) : null;

export type CycleSummary = {
  phase: CyclePhase;
  phaseLabel: string;
  nextStep: CycleStep | null;
  workedDays: number | null;
  travelOutDays: number | null;
  offDays: number | null;
  travelBackDays: number | null;
  travelDays: number;
  // Dias que faltam para completar o ciclo de trabalho (negativo = passou do ciclo).
  daysToLeave: number | null;
  // Folga estourada: dias de folga além do previsto sem ter saído de casa.
  overdueOffDays: number;
  alert: null | { kind: "APPROACHING"; level: number; daysLeft: number } | { kind: "WORK_EXCEEDED"; days: number } | { kind: "OFF_OVERDUE"; days: number };
};

export function summarizeCycle(dates: CycleDates, targets: CycleTargets, today: string): CycleSummary {
  const phase = cyclePhase(dates);
  const workedDays = span(dates.workStart, dates.frontDeparture, today, phase === "TRABALHANDO");
  const travelOutDays = span(dates.frontDeparture, dates.homeArrival, today, phase === "VIAGEM_IDA");
  const offDays = span(dates.homeArrival, dates.homeDeparture, today, phase === "FOLGA");
  const travelBackDays = span(dates.homeDeparture, dates.frontArrival, today, phase === "VIAGEM_VOLTA");
  const daysToLeave = phase === "TRABALHANDO" && workedDays !== null ? targets.workDaysTarget - workedDays : null;
  const overdueOffDays = phase === "FOLGA" && offDays !== null ? Math.max(0, offDays - targets.offDaysTarget) : 0;
  let alert: CycleSummary["alert"] = null;
  if (overdueOffDays > 0) alert = { kind: "OFF_OVERDUE", days: overdueOffDays };
  else if (daysToLeave !== null && daysToLeave <= 0) alert = { kind: "WORK_EXCEEDED", days: -daysToLeave };
  else if (daysToLeave !== null && daysToLeave <= APPROACHING_THRESHOLDS[0]) {
    const level = [...APPROACHING_THRESHOLDS].reverse().find((threshold) => daysToLeave <= threshold) ?? APPROACHING_THRESHOLDS[0];
    alert = { kind: "APPROACHING", level, daysLeft: daysToLeave };
  }
  return {
    phase, phaseLabel: CYCLE_PHASE_LABELS[phase], nextStep: nextStep(dates),
    workedDays, travelOutDays, offDays, travelBackDays, travelDays: (travelOutDays ?? 0) + (travelBackDays ?? 0),
    daysToLeave, overdueOffDays, alert,
  };
}

// As datas do ciclo precisam estar em ordem (cada etapa no mesmo dia ou depois da anterior) e não
// podem ser futuras. Datas intermediárias podem faltar (ciclo convertido de uma folga antiga).
export function validateCycleDates(dates: CycleDates, today: string): string | null {
  let previous: { step: CycleStep; date: string } | null = null;
  for (const step of CYCLE_STEPS) {
    const value = dates[step];
    if (!value) continue;
    if (!isCycleDate(value)) return `Data inválida em "${CYCLE_STEP_LABELS[step]}".`;
    if (value > today) return `"${CYCLE_STEP_LABELS[step]}" não pode ser uma data futura.`;
    if (previous && value < previous.date) return `"${CYCLE_STEP_LABELS[step]}" não pode ser antes de "${CYCLE_STEP_LABELS[previous.step]}".`;
    previous = { step, date: value };
  }
  return null;
}

// Ciclo gravado: um ciclo encerrado sem chegada na frente (demissão ou folga vendida) para de contar
// na data do encerramento e não gera alerta.
export type StoredCycle = CycleDates & CycleTargets & { endedAt?: string | null; leaveKind?: "USUFRUIDA" | "VENDIDA" | null };
export function summarizeStoredCycle(cycle: StoredCycle, today: string): CycleSummary {
  if (!cycle.endedAt) return summarizeCycle(cycle, cycle, today);
  const until = cycle.endedAt < today ? cycle.endedAt : today;
  if (cycle.leaveKind === "VENDIDA") {
    // Folga vendida: trabalhou do início até o encerramento, sem viagem nem folga.
    const summary = summarizeCycle({ ...cycle, frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null }, cycle, until);
    return { ...summary, phase: "FECHADO", phaseLabel: "Folga vendida", nextStep: null, daysToLeave: null, overdueOffDays: 0, alert: null };
  }
  const summary = summarizeCycle(cycle, cycle, until);
  return { ...summary, phaseLabel: "Encerrado (demissão)", daysToLeave: null, overdueOffDays: 0, alert: null };
}

// Totais do perfil a partir de todos os ciclos (fechados e o atual).
export function cycleTotals(cycles: StoredCycle[], today: string) {
  let offDays = 0;
  let travelDays = 0;
  for (const cycle of cycles) {
    const summary = summarizeStoredCycle(cycle, today);
    offDays += summary.offDays ?? 0;
    travelDays += summary.travelDays;
  }
  return { offDays, travelDays, cycles: cycles.length };
}

// Situação cadastral que acompanha a etapa do ciclo: da saída da frente até a chegada na frente o
// funcionário fica "De folga"; ao chegar na frente volta a "Ativo". Afastado/Demitido não mudam.
export function statusForPhase(current: string, phase: CyclePhase) {
  if (current === "AFASTADO" || current === "DEMITIDO") return current;
  return phase === "VIAGEM_IDA" || phase === "FOLGA" || phase === "VIAGEM_VOLTA" ? "FOLGA" : "ATIVO";
}

// Dias corridos entre duas datas, contando até hoje quando o fim está em aberto (ausências,
// tempo de casa etc.).
export function openSpan(from: string, to: string | null, today: string) {
  return Math.max(0, daysBetween(from, to && to < today ? to : today));
}

// Tempo de casa desde a admissão, em dias e no formato "2 anos, 3 meses e 10 dias".
export function tenure(admissionDate: string, today: string) {
  const days = openSpan(admissionDate, null, today);
  const [y1, m1, d1] = admissionDate.split("-").map(Number);
  const [y2, m2, d2] = today.split("-").map(Number);
  let years = y2 - y1;
  let months = m2 - m1;
  let rest = d2 - d1;
  if (rest < 0) { months -= 1; rest += new Date(Date.UTC(y2, m2 - 1, 0)).getUTCDate(); }
  if (months < 0) { years -= 1; months += 12; }
  if (days === 0 || years < 0) return { days: Math.max(0, days), label: "0 dias" };
  const parts = [years ? `${years} ${years === 1 ? "ano" : "anos"}` : null, months ? `${months} ${months === 1 ? "mês" : "meses"}` : null, rest ? `${rest} ${rest === 1 ? "dia" : "dias"}` : null].filter(Boolean) as string[];
  return { days, label: parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}` : parts[0] };
}

// Permanência em cada frente a partir do histórico de transferências (em qualquer ordem): cada
// período vai da data da transferência até a próxima (ou até hoje, na frente atual).
export function frontStays<T extends { transferDate: string; id: number }>(transfers: T[], today: string) {
  const ordered = [...transfers].sort((a, b) => a.transferDate.localeCompare(b.transferDate) || a.id - b.id);
  return ordered.map((transfer, index) => {
    const until = ordered[index + 1]?.transferDate ?? null;
    return { ...transfer, until, current: until === null, days: openSpan(transfer.transferDate, until, today) };
  }).reverse();
}
