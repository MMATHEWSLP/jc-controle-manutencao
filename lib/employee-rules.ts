// Regras puras do módulo Funcionários (sem banco), testadas em tests/employee-rules.test.mjs.
// A conta de dias (ciclo de folga, permanência nas frentes, tempo de casa) fica em lib/leave-cycle.ts.

export const EMPLOYEE_STATUSES = ["ATIVO", "FOLGA", "AFASTADO", "DEMITIDO"] as const;
export type EmployeeStatus = typeof EMPLOYEE_STATUSES[number];
export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = { ATIVO: "Ativo", FOLGA: "De folga", AFASTADO: "Afastado", DEMITIDO: "Demitido" };
// Situações que o cadastro escolhe à mão. "De folga" acompanha o ciclo de folga e "Demitido" só vem
// do botão Demitir.
export const MANUAL_STATUSES = ["ATIVO", "AFASTADO"] as const;

// "FOLGA" continua existindo só para exibir registros antigos: a folga agora é o ciclo de folga.
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

export const onlyDigits = (value: string) => value.replace(/\D/g, "");

// CPF com dígitos verificadores válidos (aceita com ou sem pontuação).
export function isValidCpf(value: string) {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (length + 1 - index);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}
export function formatCpf(value: string | null) {
  const digits = onlyDigits(value ?? "");
  return digits.length === 11 ? `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` : value ?? "";
}

export type EmployeeInput = {
  name: string; jobTitle: string; company: string; admissionDate: string; serviceFrontId: number | null; status: string;
  registration?: string | null; cpf?: string | null; birthDate?: string | null; city?: string | null; salary?: number | null;
  cycleWorkDays?: number; cycleOffDays?: number;
};

// Obrigatórios: nome completo, função, empresa, admissão e frente (a frente só no cadastro; depois
// muda por transferência). Matrícula, CPF, nascimento, cidade e salário são opcionais, mas quando
// informados precisam ser válidos (a unicidade de matrícula/CPF é conferida no banco).
export function validateEmployee(input: EmployeeInput, options: { requireFront: boolean; today?: string }): string | null {
  if (!input.name.trim()) return "Informe o nome completo.";
  if (input.name.trim().split(/\s+/).length < 2) return "Informe o nome completo (nome e sobrenome).";
  if (!input.jobTitle.trim()) return "Informe a função/cargo.";
  if (!input.company.trim()) return "Informe a empresa.";
  if (!validDate(input.admissionDate)) return "Informe a data de admissão.";
  if (options.today && input.admissionDate > options.today) return "A data de admissão não pode ser futura.";
  if (options.requireFront && !input.serviceFrontId) return "Escolha a frente de serviço.";
  if (!isEmployeeStatus(input.status)) return "Escolha a situação do funcionário.";
  if (input.registration && !/^\d{1,12}$/.test(input.registration)) return "A matrícula deve ter só números.";
  if (input.cpf && !isValidCpf(input.cpf)) return "CPF inválido — confira os números.";
  if (input.birthDate) {
    if (!validDate(input.birthDate)) return "Informe uma data de nascimento válida.";
    if (input.birthDate >= input.admissionDate) return "A data de nascimento precisa ser antes da admissão.";
  }
  if (input.salary !== undefined && input.salary !== null && (!Number.isFinite(input.salary) || input.salary < 0)) return "Informe um salário válido.";
  if (input.cycleWorkDays !== undefined && (!Number.isInteger(input.cycleWorkDays) || input.cycleWorkDays < 1 || input.cycleWorkDays > 365)) return "Dias trabalhados do ciclo: informe de 1 a 365.";
  if (input.cycleOffDays !== undefined && (!Number.isInteger(input.cycleOffDays) || input.cycleOffDays < 1 || input.cycleOffDays > 120)) return "Dias de folga do ciclo: informe de 1 a 120.";
  return null;
}

export type DismissalInput = { dismissedAt: string; reason: string; rehireAllowed: unknown };
export function validateDismissal(input: DismissalInput, admissionDate: string, today: string): string | null {
  if (!validDate(input.dismissedAt)) return "Informe a data da demissão.";
  if (input.dismissedAt > today) return "A data da demissão não pode ser futura.";
  if (input.dismissedAt < admissionDate) return "A demissão não pode ser antes da admissão.";
  if (input.reason.trim().length < 3) return "Informe o motivo da demissão.";
  if (typeof input.rehireAllowed !== "boolean") return "Informe se o funcionário pode ser recontratado.";
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
// vale a que começou por último. É o que alimenta o badge "De férias" / "Afastado" da listagem.
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

// Chave de comparação de nomes (sem acento, caixa e pontuação) — usada no aviso de restritos.
export function nameKey(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
