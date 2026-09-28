import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { auditLogs, companies, employeeAbsences, employeeDismissals, employeeLeaveCycles, employees, employeeTransfers, serviceFronts, users } from "../db/schema";
import { frentesVisiveisCadastro } from "./access";
import { frentesEmExibicao, frentesEmExibicaoCadastro } from "./active-front";
import type { SessionUser } from "./auth";
import { ABSENCE_LABELS, absenceBadge, currentAbsence, EMPLOYEE_STATUS_LABELS, formatCpf, nameKey, onlyDigits, type AbsenceKind } from "./employee-rules";
import { fuelLocalDay } from "./fuel";
import { CYCLE_STEP_LABELS, CYCLE_STEPS, cycleTotals, frontStays, openSpan, statusForPhase, summarizeCycle, summarizeStoredCycle, tenure, validateCycleDates, type CycleDates, type CycleStep } from "./leave-cycle";

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const employeeToday = fuelLocalDay;

export class EmployeeError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400, public extra?: Record<string, unknown>) { super(message); }
}
export function employeeErrorResponse(error: unknown) {
  return error instanceof EmployeeError ? Response.json({ error: error.message, ...error.extra }, { status: error.status }) : null;
}

// Frentes ativas que a pessoa enxerga — mesma regra de visibilidade dos equipamentos (inclusive a
// permissão de ver todas as frentes só em Equipamentos/Funcionários, lib/access.ts).
export async function employeeVisibleFronts(db: Db, user: SessionUser) {
  const fronts = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name));
  const visible = frentesVisiveisCadastro(user);
  return visible === "ALL" ? fronts : fronts.filter((front) => visible.includes(front.id));
}

export function canSeeEmployeeFront(user: SessionUser, frontId: number) {
  const visible = frentesVisiveisCadastro(user);
  return visible === "ALL" || visible.includes(frontId);
}

// Frentes em exibição (seletor global ou botões do módulo) ∩ frentes que a pessoa enxerga.
// `ownFrontsOnly`: ignora a permissão de ver todas as frentes (contadores de alerta do menu, que
// continuam só das frentes da própria pessoa).
export async function employeeScope(db: Db, user: SessionUser, request: Request, options: { ownFrontsOnly?: boolean } = {}) {
  const fronts = await employeeVisibleFronts(db, user);
  const displayed = options.ownFrontsOnly ? frentesEmExibicao(user, request) : frentesEmExibicaoCadastro(user, request);
  return { fronts, scope: fronts.map((front) => front.id).filter((id) => displayed === "ALL" || displayed.includes(id)) };
}

export const canSeeSalary = (user: SessionUser) => user.permissions.includes("employees.salary");

// ---------------------------------------------------------------------------------------------
// Ciclo de folga (a conta de dias é toda de lib/leave-cycle.ts; aqui só se lê/grava o banco).
// ---------------------------------------------------------------------------------------------

type CycleRow = typeof employeeLeaveCycles.$inferSelect;

const cycleDates = (cycle: Pick<CycleRow, CycleStep>): CycleDates => ({
  workStart: cycle.workStart, frontDeparture: cycle.frontDeparture, homeArrival: cycle.homeArrival, homeDeparture: cycle.homeDeparture, frontArrival: cycle.frontArrival,
});

// Ciclo em andamento = o último, se não foi fechado (chegada na frente) nem encerrado (demissão).
export function openCycle(cycles: CycleRow[]) {
  const last = [...cycles].sort((a, b) => b.cycleNumber - a.cycleNumber)[0];
  return last && !last.frontArrival && !last.endedAt ? last : null;
}

export function cycleView(cycle: CycleRow, today: string) {
  return { ...cycle, summary: summarizeStoredCycle(cycle, today) };
}

async function loadCycles(db: Db | Tx, employeeIds: number[]) {
  if (employeeIds.length === 0) return new Map<number, CycleRow[]>();
  const rows = await db.select().from(employeeLeaveCycles).where(inArray(employeeLeaveCycles.employeeId, employeeIds)).orderBy(asc(employeeLeaveCycles.cycleNumber));
  const map = new Map<number, CycleRow[]>();
  for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
  return map;
}

type CycleEmployee = { id: number; name: string; status: string; serviceFrontId: number; cycleWorkDays: number; cycleOffDays: number };

// Aplica uma ou mais etapas (em ordem, a partir da próxima pendente) ao ciclo em andamento do
// funcionário. Sem ciclo em andamento, abre um novo — pode começar já pela saída da frente quando o
// início não foi registrado (ex.: funcionário importado). A chegada na frente fecha o ciclo e abre o
// seguinte a partir da mesma data. A situação cadastral acompanha a etapa (statusForPhase).
export async function applyCycleSteps(tx: Tx, employee: CycleEmployee, provided: Partial<CycleDates>, userId: number, today: string) {
  if (employee.status === "DEMITIDO") throw new EmployeeError(`${employee.name}: funcionário demitido não tem ciclo de folga.`);
  const steps = CYCLE_STEPS.filter((step) => provided[step]);
  if (steps.length === 0) throw new EmployeeError("Informe a data da etapa.");
  const cycles = (await loadCycles(tx, [employee.id])).get(employee.id) ?? [];
  const current = openCycle(cycles);
  const base: CycleDates = current ? cycleDates(current) : { workStart: null, frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null };
  const lastFilled = Math.max(-1, ...CYCLE_STEPS.map((step, index) => (base[step] ? index : -1)));
  const first = CYCLE_STEPS.indexOf(steps[0]);
  const indexes = steps.map((step) => CYCLE_STEPS.indexOf(step));
  const contiguous = indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1);
  // Sem nada registrado ainda, pode-se começar pelo início ou direto pela saída da frente.
  const allowedFirst = lastFilled === -1 ? [0, 1] : [lastFilled + 1];
  if (!contiguous || !allowedFirst.includes(first)) {
    const expected = CYCLE_STEPS[lastFilled + 1];
    throw new EmployeeError(expected ? `${employee.name}: a próxima etapa é "${CYCLE_STEP_LABELS[expected]}".` : `${employee.name}: o ciclo já está fechado.`);
  }
  const merged = { ...base, ...Object.fromEntries(steps.map((step) => [step, provided[step]])) } as CycleDates;
  const problem = validateCycleDates(merged, today);
  if (problem) throw new EmployeeError(`${employee.name}: ${problem}`);
  const lastNumber = cycles.reduce((max, cycle) => Math.max(max, cycle.cycleNumber), 0);
  let cycleId = current?.id;
  if (current) {
    await tx.update(employeeLeaveCycles).set({ ...merged, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, current.id));
  } else {
    const [row] = await tx.insert(employeeLeaveCycles).values({ employeeId: employee.id, cycleNumber: lastNumber + 1, serviceFrontId: employee.serviceFrontId, ...merged, workDaysTarget: employee.cycleWorkDays, offDaysTarget: employee.cycleOffDays, createdBy: userId }).returning({ id: employeeLeaveCycles.id });
    cycleId = row.id;
  }
  let phase = summarizeCycle(merged, { workDaysTarget: employee.cycleWorkDays, offDaysTarget: employee.cycleOffDays }, today).phase;
  if (merged.frontArrival) {
    const number = (current?.cycleNumber ?? lastNumber + 1) + 1;
    await tx.insert(employeeLeaveCycles).values({ employeeId: employee.id, cycleNumber: number, serviceFrontId: employee.serviceFrontId, workStart: merged.frontArrival, workDaysTarget: employee.cycleWorkDays, offDaysTarget: employee.cycleOffDays, createdBy: userId });
    phase = "TRABALHANDO";
  }
  const status = statusForPhase(employee.status, phase);
  if (status !== employee.status) await tx.update(employees).set({ status: status as "ATIVO", updatedAt: new Date().toISOString() }).where(eq(employees.id, employee.id));
  return { cycleId: cycleId!, steps, status };
}

// Desfaz a última etapa registrada. Se o ciclo em andamento só tem o início e nasceu do fechamento
// do anterior, desfaz a chegada na frente do ciclo anterior (ele volta a ficar em andamento).
export async function undoLastCycleStep(tx: Tx, employee: CycleEmployee, today: string) {
  const cycles = (await loadCycles(tx, [employee.id])).get(employee.id) ?? [];
  const current = openCycle(cycles);
  if (!current) throw new EmployeeError("Não há etapa em andamento para desfazer.");
  const dates = cycleDates(current);
  const filled = CYCLE_STEPS.filter((step) => dates[step]);
  let undone: CycleStep;
  let phaseDates: CycleDates;
  let targets = current;
  if (filled.length <= 1) {
    const previous = cycles.filter((cycle) => cycle.cycleNumber < current.cycleNumber).sort((a, b) => b.cycleNumber - a.cycleNumber)[0];
    await tx.delete(employeeLeaveCycles).where(eq(employeeLeaveCycles.id, current.id));
    if (previous?.frontArrival && !previous.endedAt && previous.frontArrival === current.workStart) {
      await tx.update(employeeLeaveCycles).set({ frontArrival: null, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, previous.id));
      undone = "frontArrival";
      phaseDates = { ...cycleDates(previous), frontArrival: null };
      targets = previous;
    } else {
      undone = filled[0] ?? "workStart";
      phaseDates = { workStart: null, frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null };
    }
  } else {
    undone = filled[filled.length - 1];
    phaseDates = { ...dates, [undone]: null };
    await tx.update(employeeLeaveCycles).set({ [undone]: null, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, current.id));
  }
  const status = statusForPhase(employee.status, summarizeCycle(phaseDates, targets, today).phase);
  if (status !== employee.status) await tx.update(employees).set({ status: status as "ATIVO", updatedAt: new Date().toISOString() }).where(eq(employees.id, employee.id));
  return { undone, status };
}

// Correção das datas de um ciclo já lançado. No ciclo em andamento a chegada na frente não é
// informada aqui (é a etapa que fecha o ciclo); num ciclo fechado ela é obrigatória e, se mudar, o
// início do ciclo seguinte acompanha.
export async function editCycle(tx: Tx, cycle: CycleRow, employee: CycleEmployee, input: { dates: CycleDates; workDaysTarget: number; offDaysTarget: number; notes: string | null }, today: string) {
  const cycles = (await loadCycles(tx, [employee.id])).get(employee.id) ?? [];
  const isOpen = openCycle(cycles)?.id === cycle.id;
  const next = cycles.find((item) => item.cycleNumber === cycle.cycleNumber + 1);
  if (isOpen && input.dates.frontArrival) throw new EmployeeError("Para fechar o ciclo, use a etapa \"Chegada na frente\".");
  if (!isOpen && cycle.frontArrival && !input.dates.frontArrival) throw new EmployeeError("Ciclo fechado precisa da data de chegada na frente.");
  if (!Number.isInteger(input.workDaysTarget) || input.workDaysTarget < 1 || input.workDaysTarget > 365) throw new EmployeeError("Dias trabalhados do ciclo: informe de 1 a 365.");
  if (!Number.isInteger(input.offDaysTarget) || input.offDaysTarget < 1 || input.offDaysTarget > 120) throw new EmployeeError("Dias de folga do ciclo: informe de 1 a 120.");
  const problem = validateCycleDates(input.dates, today);
  if (problem) throw new EmployeeError(problem);
  if (next && input.dates.frontArrival !== cycle.frontArrival && next.workStart === cycle.frontArrival) {
    const nextProblem = validateCycleDates({ ...cycleDates(next), workStart: input.dates.frontArrival }, today);
    if (nextProblem) throw new EmployeeError(`Ciclo ${next.cycleNumber}: ${nextProblem}`);
    await tx.update(employeeLeaveCycles).set({ workStart: input.dates.frontArrival, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, next.id));
  }
  await tx.update(employeeLeaveCycles).set({ ...input.dates, workDaysTarget: input.workDaysTarget, offDaysTarget: input.offDaysTarget, notes: input.notes, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, cycle.id));
  if (isOpen) {
    const status = statusForPhase(employee.status, summarizeCycle(input.dates, input, today).phase);
    if (status !== employee.status) await tx.update(employees).set({ status: status as "ATIVO", updatedAt: new Date().toISOString() }).where(eq(employees.id, employee.id));
  }
}

// ---------------------------------------------------------------------------------------------
// Listagem, perfil e consultas
// ---------------------------------------------------------------------------------------------

const baseColumns = {
  id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, admissionDate: employees.admissionDate,
  serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name, status: employees.status, notes: employees.notes,
  registration: employees.registration, cpf: employees.cpf, birthDate: employees.birthDate, city: employees.city, salary: employees.salary,
  cycleWorkDays: employees.cycleWorkDays, cycleOffDays: employees.cycleOffDays,
};

type BaseRow = { salary: number | null; cpf: string | null; status: keyof typeof EMPLOYEE_STATUS_LABELS };
function present<T extends BaseRow>(row: T, showSalary: boolean) {
  return { ...row, cpf: row.cpf ? formatCpf(row.cpf) : null, salary: showSalary ? row.salary : null, statusLabel: EMPLOYEE_STATUS_LABELS[row.status] };
}

export async function listEmployees(db: Db, frontIds: number[], options: { includeDismissed?: boolean; showSalary?: boolean } = {}) {
  if (frontIds.length === 0) return [];
  const rows = await db.select(baseColumns).from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id))
    .where(and(inArray(employees.serviceFrontId, frontIds), options.includeDismissed ? undefined : ne(employees.status, "DEMITIDO")))
    .orderBy(asc(employees.name));
  const ids = rows.map((row) => row.id);
  const [absences, arrivals, cycles] = await Promise.all([
    ids.length ? db.select({ id: employeeAbsences.id, employeeId: employeeAbsences.employeeId, kind: employeeAbsences.kind, startDate: employeeAbsences.startDate, endDate: employeeAbsences.endDate })
      .from(employeeAbsences).where(inArray(employeeAbsences.employeeId, ids)) : [],
    // Data da última chegada à frente atual ("há quantos dias nesta frente").
    ids.length ? db.select({ employeeId: employeeTransfers.employeeId, frontId: employeeTransfers.newServiceFrontId, date: sql<string>`max(${employeeTransfers.transferDate})` })
      .from(employeeTransfers).where(inArray(employeeTransfers.employeeId, ids)).groupBy(employeeTransfers.employeeId, employeeTransfers.newServiceFrontId) : [],
    loadCycles(db, ids),
  ]);
  const today = employeeToday();
  return rows.map((row) => {
    const current = currentAbsence(absences.filter((absence) => absence.employeeId === row.id), today);
    const employeeCycles = cycles.get(row.id) ?? [];
    const open = openCycle(employeeCycles);
    const arrival = arrivals.find((item) => item.employeeId === row.id && item.frontId === row.serviceFrontId)?.date ?? row.admissionDate;
    return {
      ...present(row, Boolean(options.showSalary)),
      currentAbsence: current ? { ...current, kindLabel: ABSENCE_LABELS[current.kind], badge: absenceBadge(current) } : null,
      cycle: open ? cycleView(open, today) : null,
      cycleCount: employeeCycles.length,
      daysInFront: openSpan(arrival, null, today),
    };
  });
}
export type EmployeeListItem = Awaited<ReturnType<typeof listEmployees>>[number];

// Alertas do ciclo de folga (folga estourada, ciclo de trabalho vencido e folga se aproximando).
export function employeeAlerts(items: EmployeeListItem[]) {
  const withAlert = items.filter((item) => item.status !== "AFASTADO" && item.cycle?.summary.alert);
  const count = (kind: string) => withAlert.filter((item) => item.cycle!.summary.alert!.kind === kind).length;
  return { offOverdue: count("OFF_OVERDUE"), workExceeded: count("WORK_EXCEEDED"), approaching: count("APPROACHING") };
}

const previousFront = alias(serviceFronts, "previous_front");
const newFront = alias(serviceFronts, "new_front");
const rehiredByUser = alias(users, "rehired_by_user");

export async function employeeDetail(db: Db, id: number, options: { showSalary?: boolean } = {}) {
  const [employee] = await db.select({ ...baseColumns, createdAt: employees.createdAt }).from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id)).where(eq(employees.id, id)).limit(1);
  if (!employee) return null;
  const [transfers, absences, cycles, dismissals] = await Promise.all([
    db.select({ id: employeeTransfers.id, transferDate: employeeTransfers.transferDate, previousFront: previousFront.name, newFront: newFront.name, note: employeeTransfers.note, by: users.name })
      .from(employeeTransfers).leftJoin(previousFront, eq(employeeTransfers.previousServiceFrontId, previousFront.id)).innerJoin(newFront, eq(employeeTransfers.newServiceFrontId, newFront.id))
      .leftJoin(users, eq(employeeTransfers.transferredBy, users.id)).where(eq(employeeTransfers.employeeId, id)),
    db.select({ id: employeeAbsences.id, kind: employeeAbsences.kind, startDate: employeeAbsences.startDate, endDate: employeeAbsences.endDate, notes: employeeAbsences.notes, by: users.name })
      .from(employeeAbsences).leftJoin(users, eq(employeeAbsences.createdBy, users.id)).where(eq(employeeAbsences.employeeId, id)).orderBy(desc(employeeAbsences.startDate), desc(employeeAbsences.id)),
    loadCycles(db, [id]),
    db.select({ id: employeeDismissals.id, dismissedAt: employeeDismissals.dismissedAt, reason: employeeDismissals.reason, rehireAllowed: employeeDismissals.rehireAllowed, previousAdmissionDate: employeeDismissals.previousAdmissionDate, rehiredAt: employeeDismissals.rehiredAt, by: users.name, rehiredBy: rehiredByUser.name })
      .from(employeeDismissals).leftJoin(users, eq(employeeDismissals.createdBy, users.id)).leftJoin(rehiredByUser, eq(employeeDismissals.rehiredBy, rehiredByUser.id))
      .where(eq(employeeDismissals.employeeId, id)).orderBy(desc(employeeDismissals.dismissedAt), desc(employeeDismissals.id)),
  ]);
  const today = employeeToday();
  const employeeCycles = cycles.get(id) ?? [];
  const open = openCycle(employeeCycles);
  const views = employeeCycles.map((cycle) => cycleView(cycle, today));
  const stays = frontStays(transfers, today);
  const current = currentAbsence(absences, today);
  const totals = cycleTotals(employeeCycles, today);
  return {
    ...present(employee, Boolean(options.showSalary)),
    currentAbsence: current ? { ...current, kindLabel: ABSENCE_LABELS[current.kind], badge: absenceBadge(current) } : null,
    cycle: open ? cycleView(open, today) : null,
    cycles: views.reverse(),
    transfers: stays,
    daysInFront: stays.find((stay) => stay.current)?.days ?? openSpan(employee.admissionDate, null, today),
    absences: absences.map((absence) => ({ ...absence, kindLabel: ABSENCE_LABELS[absence.kind as AbsenceKind], days: openSpan(absence.startDate, absence.endDate, today) + 1 })),
    dismissals,
    counters: {
      workedDaysCurrentCycle: open ? cycleView(open, today).summary.workedDays : null,
      totalOffDays: totals.offDays, totalTravelDays: totals.travelDays, cycles: totals.cycles,
      tenure: employee.status === "DEMITIDO" ? null : tenure(employee.admissionDate, today),
    },
  };
}

export async function requireEmployee(db: Db, user: SessionUser, id: number) {
  const row = (await db.select({ id: employees.id, name: employees.name, status: employees.status, serviceFrontId: employees.serviceFrontId, admissionDate: employees.admissionDate, cycleWorkDays: employees.cycleWorkDays, cycleOffDays: employees.cycleOffDays })
    .from(employees).where(eq(employees.id, id)).limit(1))[0];
  if (!row) throw new EmployeeError("Funcionário não encontrado.", 404);
  if (!canSeeEmployeeFront(user, row.serviceFrontId)) throw new EmployeeError("Você não tem acesso a este funcionário.", 403);
  return row;
}

export async function employeeAudit(db: Db | Tx, userId: number, employeeId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  await db.insert(auditLogs).values({
    userId, entityType: "EMPLOYEE", entityId: String(employeeId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

// ---------------------------------------------------------------------------------------------
// Empresas, unicidade e restritos
// ---------------------------------------------------------------------------------------------

export async function listCompanies(db: Db, options: { includeInactive?: boolean } = {}) {
  const rows = await db.select({ id: companies.id, name: companies.name, active: companies.active, employees: sql<number>`(select count(*)::int from employees e where e.company = ${companies.name} and e.status <> 'DEMITIDO')` })
    .from(companies).where(options.includeInactive ? undefined : eq(companies.active, true)).orderBy(asc(companies.name));
  return rows.map((row) => ({ ...row, employees: Number(row.employees) }));
}

// Empresa precisa estar na lista (ativa). Na edição, a empresa atual continua aceita mesmo que
// tenha sido desativada depois.
export async function requireCompany(db: Db, name: string, current?: string) {
  if (current && name === current) return;
  const row = (await db.select({ id: companies.id }).from(companies).where(and(eq(companies.name, name), eq(companies.active, true))).limit(1))[0];
  if (!row) throw new EmployeeError("Escolha uma empresa da lista.");
}

export async function assertUniqueDocuments(db: Db, input: { registration: string | null; cpf: string | null }, ignoreId?: number) {
  const check = async (column: typeof employees.registration | typeof employees.cpf, value: string | null, label: string) => {
    if (!value) return;
    const row = (await db.select({ id: employees.id, name: employees.name }).from(employees).where(and(eq(column, value), ignoreId ? ne(employees.id, ignoreId) : undefined)).limit(1))[0];
    if (row) throw new EmployeeError(`${label} para ${row.name}.`, 409);
  };
  await check(employees.registration, input.registration, "Matrícula já cadastrada");
  await check(employees.cpf, input.cpf, "CPF já cadastrado");
}

// Funcionários Restritos: demitidos sem possibilidade de recontratação (a última demissão vale).
// A lista é da empresa toda — o aviso no cadastro precisa pegar quem saiu de qualquer frente.
export async function listRestricted(db: Db) {
  const rows = await db.select({
    id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, registration: employees.registration, cpf: employees.cpf,
    frontName: serviceFronts.name, dismissedAt: employeeDismissals.dismissedAt, reason: employeeDismissals.reason, dismissalId: employeeDismissals.id,
  }).from(employeeDismissals).innerJoin(employees, eq(employeeDismissals.employeeId, employees.id)).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id))
    .where(and(eq(employees.status, "DEMITIDO"), eq(employeeDismissals.rehireAllowed, false), sql`${employeeDismissals.rehiredAt} is null`,
      sql`${employeeDismissals.id} = (select max(d.id) from employee_dismissals d where d.employee_id = ${employees.id})`))
    .orderBy(asc(employees.name));
  return rows.map((row) => ({ ...row, cpf: row.cpf ? formatCpf(row.cpf) : null }));
}

// Quem, na lista de restritos, bate com o nome, CPF ou matrícula do novo cadastro.
export async function restrictedMatches(db: Db, input: { name: string; cpf: string | null; registration: string | null }, ignoreId?: number) {
  const key = nameKey(input.name);
  return (await listRestricted(db)).filter((row) => row.id !== ignoreId && (nameKey(row.name) === key || (input.cpf && row.cpf && onlyDigits(row.cpf) === input.cpf) || (input.registration && row.registration === input.registration)));
}

// ---------------------------------------------------------------------------------------------
// Histórico (folgas = ciclos; afastamentos = ausências)
// ---------------------------------------------------------------------------------------------

export type HistoryFilters = { name: string; company: string; type: "FOLGA" | "AFASTAMENTO"; from: string | null; to: string | null };

export async function employeeHistory(db: Db, frontIds: number[], filters: HistoryFilters) {
  if (frontIds.length === 0) return [];
  const today = employeeToday();
  const people = await db.select({ id: employees.id, name: employees.name, company: employees.company, frontName: serviceFronts.name, status: employees.status })
    .from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id)).where(inArray(employees.serviceFrontId, frontIds));
  const term = filters.name ? nameKey(filters.name) : "";
  const selected = people.filter((person) => (!term || nameKey(person.name).includes(term)) && (!filters.company || person.company === filters.company));
  const byId = new Map(selected.map((person) => [person.id, person]));
  const overlaps = (start: string | null, end: string | null) => {
    if (!start) return !filters.from && !filters.to;
    const until = end ?? today;
    return (!filters.to || start <= filters.to) && (!filters.from || until >= filters.from);
  };
  if (filters.type === "AFASTAMENTO") {
    const rows = selected.length ? await db.select().from(employeeAbsences).where(inArray(employeeAbsences.employeeId, selected.map((person) => person.id))).orderBy(desc(employeeAbsences.startDate)) : [];
    return rows.filter((row) => overlaps(row.startDate, row.endDate)).map((row) => {
      const person = byId.get(row.employeeId)!;
      return { kind: "AFASTAMENTO" as const, id: row.id, employeeId: row.employeeId, name: person.name, company: person.company, frontName: person.frontName, absenceKind: ABSENCE_LABELS[row.kind as AbsenceKind], startDate: row.startDate, endDate: row.endDate, days: openSpan(row.startDate, row.endDate, today) + 1, notes: row.notes };
    });
  }
  const cycles = await loadCycles(db, selected.map((person) => person.id));
  const rows = [...cycles.values()].flat().map((cycle) => cycleView(cycle, today))
    .filter((cycle) => overlaps(CYCLE_STEPS.map((step) => cycle[step]).find(Boolean) ?? null, cycle.frontArrival ?? cycle.endedAt));
  return rows.map((cycle) => {
    const person = byId.get(cycle.employeeId)!;
    return { kind: "FOLGA" as const, id: cycle.id, employeeId: cycle.employeeId, name: person.name, company: person.company, frontName: person.frontName, cycleNumber: cycle.cycleNumber, workStart: cycle.workStart, frontDeparture: cycle.frontDeparture, homeArrival: cycle.homeArrival, homeDeparture: cycle.homeDeparture, frontArrival: cycle.frontArrival, summary: cycle.summary };
  }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || b.cycleNumber - a.cycleNumber);
}

// Comparação sem acento e sem maiúsculas ("joao" acha "João"), sem depender da extensão unaccent.
const FROM_ACCENTS = "áàâãäéèêëíìîïóòôõöúùûüç";
const TO_ACCENTS = "aaaaaeeeeiiiiooooouuuuc";
function foldAccents(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Busca para os autocompletes de "Responsável"/"Operador" (Combustível, Controle Diário...).
// Prioriza a frente informada, mas procura em todas as frentes que a pessoa enxerga; não traz
// demitidos.
export async function lookupEmployees(db: Db, user: SessionUser, q: string, frontId: number | null) {
  const fronts = (await employeeVisibleFronts(db, user)).map((front) => front.id);
  if (fronts.length === 0) return [];
  const term = q.trim();
  const rows = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name })
    .from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id))
    .where(and(inArray(employees.serviceFrontId, fronts), ne(employees.status, "DEMITIDO"),
      term ? sql`translate(lower(${employees.name}), ${FROM_ACCENTS}, ${TO_ACCENTS}) LIKE ${`%${foldAccents(term)}%`}` : frontId ? eq(employees.serviceFrontId, frontId) : undefined))
    .orderBy(asc(employees.name)).limit(80);
  return rows.map((row) => ({ ...row, inFront: frontId !== null && row.serviceFrontId === frontId }))
    .sort((a, b) => Number(b.inFront) - Number(a.inFront) || a.name.localeCompare(b.name, "pt-BR")).slice(0, 20);
}

// Campos do formulário de cadastro/edição, já normalizados.
export function parseEmployeeBody(body: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  // Aceita "2500.50" (campo numérico) e "2.500,50" (digitado no formato brasileiro).
  const number = (value: unknown) => {
    if (value === "" || value === null || value === undefined) return null;
    const raw = String(value).trim();
    return Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  };
  const int = (value: unknown, fallback: number) => (value === "" || value === null || value === undefined ? fallback : Number(value));
  return {
    name: text(body.name).replace(/\s+/g, " ").toUpperCase(), jobTitle: text(body.jobTitle).toUpperCase(), company: text(body.company).toUpperCase(),
    admissionDate: text(body.admissionDate), serviceFrontId: Number(body.serviceFrontId) || null, status: text(body.status) || "ATIVO",
    registration: text(body.registration) || null, cpf: onlyDigits(text(body.cpf)) || null, birthDate: text(body.birthDate) || null,
    city: text(body.city).toUpperCase() || null, salary: typeof body.salary === "number" ? body.salary : number(body.salary),
    cycleWorkDays: int(body.cycleWorkDays, 90), cycleOffDays: int(body.cycleOffDays, 10), notes: text(body.notes) || null,
  };
}
