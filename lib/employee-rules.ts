// Regras puras do módulo Funcionários (sem banco), testadas em tests/employee-rules.test.mjs.

export const EMPLOYEE_STATUSES = ["ATIVO", "AFASTADO", "DESLIGADO"] as const;
export type EmployeeStatus = typeof EMPLOYEE_STATUSES[number];
export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = { ATIVO: "Ativo", AFASTADO: "Afastado", DESLIGADO: "Desligado" };

export const ABSENCE_KINDS = ["FOLGA", "FERIAS", "ATESTADO", "AFASTAMENTO", "OUTRO"] as const;
export type AbsenceKind = typeof ABSENCE_KINDS[number];
export const ABSENCE_LABELS: Record<AbsenceKind, string> = { FOLGA: "Folga", FERIAS: "Férias", ATESTADO: "Atestado médico", AFASTAMENTO: "Afastamento", OUTRO: "Outro" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string) => DATE.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());

export function isEmployeeStatus(value: unknown): value is EmployeeStatus {
  return typeof value === "string" && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}
export function isAbsenceKind(value: unknown): value is AbsenceKind {
  return typeof value === "string" && (ABSENCE_KINDS as readonly string[]).includes(value);
}

export type EmployeeInput = { name: string; jobTitle: string; company: string; admissionDate: string; serviceFrontId: number | null; status: string };

// Todos os campos do cadastro são obrigatórios (a frente só no cadastro; depois muda por transferência).
export function validateEmployee(input: EmployeeInput, options: { requireFront: boolean }): string | null {
  if (!input.name.trim()) return "Informe o nome completo.";
  if (input.name.trim().split(/\s+/).length < 2) return "Informe o nome completo (nome e sobrenome).";
  if (!input.jobTitle.trim()) return "Informe a função/cargo.";
  if (!input.company.trim()) return "Informe a empresa.";
  if (!validDate(input.admissionDate)) return "Informe a data de admissão.";
  if (options.requireFront && !input.serviceFrontId) return "Escolha a frente de serviço.";
  if (!isEmployeeStatus(input.status)) return "Escolha a situação do funcionário.";
  return null;
}

export type AbsenceInput = { kind: string; startDate: string; endDate: string | null };

export function validateAbsence(input: AbsenceInput): string | null {
  if (!isAbsenceKind(input.kind)) return "Escolha o tipo de ausência.";
  if (!validDate(input.startDate)) return "Informe a data de início.";
  if (input.endDate !== null) {
    if (!validDate(input.endDate)) return "Informe uma data de término válida (ou deixe em aberto).";
    if (input.endDate < input.startDate) return "A data de término não pode ser antes do início.";
  }
  return null;
}

export type AbsencePeriod = { id: number; kind: AbsenceKind; startDate: string; endDate: string | null };

// Ausência vigente hoje: começou até hoje e não terminou (ou está em aberto). Havendo mais de uma,
// vale a que começou por último. É o que alimenta o badge "De folga" / "Afastado" da listagem.
export function currentAbsence<T extends AbsencePeriod>(absences: T[], today: string): T | null {
  const active = absences.filter((absence) => absence.startDate <= today && (absence.endDate === null || absence.endDate >= today));
  return active.sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id - a.id)[0] ?? null;
}

// Texto do badge da listagem: folga/férias = "De folga"/"De férias"; atestado e afastamento = "Afastado".
export function absenceBadge(absence: AbsencePeriod | null) {
  if (!absence) return null;
  const label = absence.kind === "FOLGA" ? "De folga" : absence.kind === "FERIAS" ? "De férias" : absence.kind === "OUTRO" ? "Ausente" : "Afastado";
  const returnDate = absence.endDate ? nextDay(absence.endDate) : null;
  return { label, returnDate };
}

// Data prevista de retorno = dia seguinte ao término do período.
export function nextDay(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
