import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import { auditLogs, employeeAbsences, employeeTransfers, employees, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { ABSENCE_LABELS, absenceBadge, currentAbsence, EMPLOYEE_STATUS_LABELS, type AbsenceKind } from "./employee-rules";
import { fuelLocalDay } from "./fuel";

type Db = Awaited<ReturnType<typeof getDb>>;

export const employeeToday = fuelLocalDay;

export class EmployeeError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}
export function employeeErrorResponse(error: unknown) {
  return error instanceof EmployeeError ? Response.json({ error: error.message }, { status: error.status }) : null;
}

// Frentes ativas que a pessoa enxerga — mesma regra de visibilidade dos equipamentos.
export async function employeeVisibleFronts(db: Db, user: SessionUser) {
  const fronts = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name));
  const visible = frentesVisiveis(user);
  return visible === "ALL" ? fronts : fronts.filter((front) => visible.includes(front.id));
}

export function canSeeEmployeeFront(user: SessionUser, frontId: number) {
  const visible = frentesVisiveis(user);
  return visible === "ALL" || visible.includes(frontId);
}

export async function listEmployees(db: Db, frontIds: number[], options: { includeDismissed?: boolean } = {}) {
  if (frontIds.length === 0) return [];
  const rows = await db.select({
    id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, admissionDate: employees.admissionDate,
    serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name, status: employees.status, notes: employees.notes,
  }).from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id))
    .where(and(inArray(employees.serviceFrontId, frontIds), options.includeDismissed ? undefined : ne(employees.status, "DESLIGADO")))
    .orderBy(asc(employees.name));
  const absences = rows.length ? await db.select({ id: employeeAbsences.id, employeeId: employeeAbsences.employeeId, kind: employeeAbsences.kind, startDate: employeeAbsences.startDate, endDate: employeeAbsences.endDate })
    .from(employeeAbsences).where(inArray(employeeAbsences.employeeId, rows.map((row) => row.id))) : [];
  const today = employeeToday();
  return rows.map((row) => {
    const current = currentAbsence(absences.filter((absence) => absence.employeeId === row.id), today);
    return { ...row, statusLabel: EMPLOYEE_STATUS_LABELS[row.status], currentAbsence: current ? { ...current, kindLabel: ABSENCE_LABELS[current.kind], badge: absenceBadge(current) } : null };
  });
}

const previousFront = alias(serviceFronts, "previous_front");
const newFront = alias(serviceFronts, "new_front");

export async function employeeDetail(db: Db, id: number) {
  const [employee] = await db.select({
    id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, admissionDate: employees.admissionDate,
    serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name, status: employees.status, notes: employees.notes, createdAt: employees.createdAt,
  }).from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id)).where(eq(employees.id, id)).limit(1);
  if (!employee) return null;
  const [transfers, absences] = await Promise.all([
    db.select({ id: employeeTransfers.id, transferDate: employeeTransfers.transferDate, previousFront: previousFront.name, newFront: newFront.name, note: employeeTransfers.note, by: users.name })
      .from(employeeTransfers).leftJoin(previousFront, eq(employeeTransfers.previousServiceFrontId, previousFront.id)).innerJoin(newFront, eq(employeeTransfers.newServiceFrontId, newFront.id))
      .leftJoin(users, eq(employeeTransfers.transferredBy, users.id)).where(eq(employeeTransfers.employeeId, id)).orderBy(desc(employeeTransfers.transferDate), desc(employeeTransfers.id)),
    db.select({ id: employeeAbsences.id, kind: employeeAbsences.kind, startDate: employeeAbsences.startDate, endDate: employeeAbsences.endDate, notes: employeeAbsences.notes, by: users.name })
      .from(employeeAbsences).leftJoin(users, eq(employeeAbsences.createdBy, users.id)).where(eq(employeeAbsences.employeeId, id)).orderBy(desc(employeeAbsences.startDate), desc(employeeAbsences.id)),
  ]);
  const current = currentAbsence(absences, employeeToday());
  return {
    ...employee, statusLabel: EMPLOYEE_STATUS_LABELS[employee.status],
    currentAbsence: current ? { ...current, kindLabel: ABSENCE_LABELS[current.kind], badge: absenceBadge(current) } : null,
    transfers,
    absences: absences.map((absence) => ({ ...absence, kindLabel: ABSENCE_LABELS[absence.kind as AbsenceKind] })),
  };
}

export async function requireEmployee(db: Db, user: SessionUser, id: number) {
  const row = (await db.select({ id: employees.id, name: employees.name, serviceFrontId: employees.serviceFrontId }).from(employees).where(eq(employees.id, id)).limit(1))[0];
  if (!row) throw new EmployeeError("Funcionário não encontrado.", 404);
  if (!canSeeEmployeeFront(user, row.serviceFrontId)) throw new EmployeeError("Você não tem acesso a este funcionário.", 403);
  return row;
}

export async function employeeAudit(db: Db, userId: number, employeeId: number, action: string, previousValue?: unknown, newValue?: unknown) {
  await db.insert(auditLogs).values({
    userId, entityType: "EMPLOYEE", entityId: String(employeeId), action,
    previousValue: previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue: newValue === undefined ? null : JSON.stringify(newValue),
  });
}

// Comparação sem acento e sem maiúsculas ("joao" acha "João"), sem depender da extensão unaccent.
const FROM_ACCENTS = "áàâãäéèêëíìîïóòôõöúùûüç";
const TO_ACCENTS = "aaaaaeeeeiiiiooooouuuuc";
function foldAccents(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Busca para os autocompletes de "Responsável"/"Operador" (Combustível, Controle Diário...).
// Prioriza a frente informada, mas procura em todas as frentes que a pessoa enxerga; não traz
// desligados.
export async function lookupEmployees(db: Db, user: SessionUser, q: string, frontId: number | null) {
  const fronts = (await employeeVisibleFronts(db, user)).map((front) => front.id);
  if (fronts.length === 0) return [];
  const term = q.trim();
  const rows = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, company: employees.company, serviceFrontId: employees.serviceFrontId, frontName: serviceFronts.name })
    .from(employees).innerJoin(serviceFronts, eq(employees.serviceFrontId, serviceFronts.id))
    .where(and(inArray(employees.serviceFrontId, fronts), ne(employees.status, "DESLIGADO"),
      term ? sql`translate(lower(${employees.name}), ${FROM_ACCENTS}, ${TO_ACCENTS}) LIKE ${`%${foldAccents(term)}%`}` : frontId ? eq(employees.serviceFrontId, frontId) : undefined))
    .orderBy(asc(employees.name)).limit(80);
  return rows.map((row) => ({ ...row, inFront: frontId !== null && row.serviceFrontId === frontId }))
    .sort((a, b) => Number(b.inFront) - Number(a.inFront) || a.name.localeCompare(b.name, "pt-BR")).slice(0, 20);
}
