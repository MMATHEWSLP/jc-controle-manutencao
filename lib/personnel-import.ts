import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import {
  auditLogs, companies, employeeAbsences, employeeDismissals, employeeLeaveCycles, employees, employeeTransfers, jobFunctionAliases, jobFunctions,
  personnelImportBatches, personnelImportChanges, serviceFronts, userServiceFronts, users,
} from "../db/schema";
import type { SessionUser } from "./auth";
import { isValidCpf } from "./employee-rules";
import { fuelLocalDay } from "./fuel";
import { validateCycleDates } from "./leave-cycle";
import { sincronizarAcessoOperador } from "./operadores";
import {
  buildPersonnelPlan, canonicalFunction, nameKey, operatesEquipment, PERSONNEL_SOURCE, REQUIRED_COLUMNS, SHEETS, similarName,
  type ExportSheets, type PersonnelPlan, type PlannedPerson,
} from "./personnel-import-rules";

// ---------------------------------------------------------------------------
// FUNCIONÁRIOS → "Importar do sistema de pessoal" (só ADMIN).
//  1. Prévia (nada é gravado): lê todas as abas, casa cada pessoa com o cadastro (1º ID sistema já
//     importado, 2º CPF, 3º matrícula + empresa, 4º nome normalizado — este para confirmar) e mostra,
//     por aba, o que será criado, alterado (campo a campo), ignorado e as linhas com erro.
//  2. Confirmar: cria o lote, grava empresas/funções e depois as pessoas em blocos (uma requisição
//     por bloco). Cada bloco recalcula a prévia sobre o banco atual: quem já foi gravado casa pelo ID
//     sistema e não muda de novo — rodar de novo (ou com uma exportação mais nova) só atualiza.
//  3. Desfazer: apaga o que o lote criou e devolve o valor anterior do que ele alterou.
// LGPD: CPF, salário, nascimento, motivos de desligamento/afastamento e restrição nunca vão para
// logs nem para a auditoria; a prévia mostra "alterado"/"preenchido" no lugar do valor.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export const PEOPLE_PER_BLOCK = 25;

export class PersonnelImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function requireAdmin(user: SessionUser) {
  if (user.profile !== "ADMIN") throw new PersonnelImportError("Só ADMIN importa do sistema de pessoal.", 403);
}

// ---------------------------------------------------------------------------------------------
// Leitura do arquivo
// ---------------------------------------------------------------------------------------------

const cellText = (value: ExcelJS.CellValue): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return null;
  }
  return String(value);
};

export async function readExport(buffer: ArrayBuffer): Promise<ExportSheets> {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new PersonnelImportError("Não foi possível ler o arquivo. Envie a exportação .xlsx do sistema de pessoal."); }
  const sheets: ExportSheets = {};
  for (const sheet of workbook.worksheets) {
    const header = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((value) => (cellText(value) ?? "").trim());
    const rows: Record<string, string | null>[] = [];
    for (let number = 2; number <= sheet.rowCount; number++) {
      const values = (sheet.getRow(number).values as ExcelJS.CellValue[]).slice(1).map(cellText);
      if (!values.some((value) => value !== null && value.trim() !== "")) continue;
      rows.push(Object.fromEntries(header.map((column, index) => [column, values[index] ?? null])));
    }
    sheets[sheet.name.trim()] = rows;
  }
  const colab = sheets[SHEETS.colaboradores];
  if (!colab) throw new PersonnelImportError(`A exportação não tem a aba "${SHEETS.colaboradores}".`);
  for (const [key, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const name = SHEETS[key as keyof typeof SHEETS];
    const rows = sheets[name];
    if (!rows?.length) continue;
    const missing = columns!.filter((column) => !(column in rows[0]));
    if (missing.length) throw new PersonnelImportError(`Aba "${name}": faltam as colunas ${missing.join(", ")}.`);
  }
  if (colab.length > 5000) throw new PersonnelImportError("Máximo de 5.000 colaboradores por exportação.");
  return sheets;
}

export const fileHash = (buffer: ArrayBuffer) => createHash("sha256").update(Buffer.from(buffer)).digest("hex");

// ---------------------------------------------------------------------------------------------
// Banco atual
// ---------------------------------------------------------------------------------------------

type EmployeeRow = typeof employees.$inferSelect;
type CycleRow = typeof employeeLeaveCycles.$inferSelect;
type AbsenceRow = typeof employeeAbsences.$inferSelect;
type TransferRow = typeof employeeTransfers.$inferSelect;
type DismissalRow = typeof employeeDismissals.$inferSelect;

async function loadBase(db: Conn) {
  const [people, fronts, companyRows, functionRows, aliasRows, fieldUsers, cycles, absences, transfers, dismissals] = await Promise.all([
    db.select().from(employees),
    db.select({ id: serviceFronts.id, name: serviceFronts.name, active: serviceFronts.active }).from(serviceFronts),
    db.select({ id: companies.id, name: companies.name, active: companies.active }).from(companies),
    db.select({ id: jobFunctions.id, name: jobFunctions.name, operatesEquipment: jobFunctions.operatesEquipment, active: jobFunctions.active }).from(jobFunctions),
    db.select({ alias: jobFunctionAliases.alias, name: jobFunctions.name }).from(jobFunctionAliases).innerJoin(jobFunctions, eq(jobFunctions.id, jobFunctionAliases.jobFunctionId)),
    db.select({ id: users.id, name: users.name, status: users.status, employeeId: users.employeeId, origin: users.fieldAccessOrigin }).from(users).where(eq(users.role, "CAMPO")),
    db.select().from(employeeLeaveCycles),
    db.select().from(employeeAbsences),
    db.select().from(employeeTransfers),
    db.select().from(employeeDismissals),
  ]);
  const group = <T extends { employeeId: number }>(rows: T[]) => {
    const map = new Map<number, T[]>();
    for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
    return map;
  };
  return { people, fronts, companyRows, functionRows, aliasRows, fieldUsers, cycles: group(cycles), absences: group(absences), transfers: group(transfers), dismissals: group(dismissals) };
}
type Base = Awaited<ReturnType<typeof loadBase>>;

// ---------------------------------------------------------------------------------------------
// Prévia
// ---------------------------------------------------------------------------------------------

// Decisão do ADMIN para os casamentos por nome: id do funcionário existente ou "NOVO" (criar).
export type Decisions = Record<string, number | "NOVO">;

type Change = { field: string; label: string; from: string | null; to: string | null };
export type MatchHow = "ID" | "CPF" | "MATRICULA" | "NOME" | "PARECIDO" | "ESCOLHIDO" | "NOVO";
type Candidate = { id: number; name: string; front: string | null; company: string; registration: string | null; status: string };

export type PersonPreview = {
  externalId: string; row: number; name: string; front: string; company: string; jobTitle: string; active: boolean;
  how: MatchHow; employeeId: number | null; employee: Candidate | null; candidates: Candidate[];
  action: "CRIAR" | "ATUALIZAR" | "SEM_MUDANCA" | "ERRO";
  changes: Change[]; history: { cycles: number; absences: number; transfers: number; dismissals: number; kept: string[] };
  warnings: string[]; errors: string[];
};

const SENSITIVE = new Set(["cpf", "salary", "birthDate"]);
const FIELD_LABELS: Record<string, string> = {
  name: "Nome", jobTitle: "Função", company: "Empresa (vínculo)", registration: "Matrícula", cpf: "CPF", birthDate: "Nascimento", city: "Cidade",
  admissionDate: "Admissão", salary: "Salário", serviceFrontId: "Frente", status: "Situação", atHeadquarters: "Fica na sede", externalId: "ID sistema",
};
const STATUS_TEXT: Record<string, string> = { ATIVO: "Ativo", FOLGA: "De folga", AFASTADO: "Afastado", DEMITIDO: "Desligado" };
const br = (day: string | null) => (day ? day.split("-").reverse().join("/") : null);
const STEP_LABELS: Record<string, string> = { workStart: "início", frontDeparture: "saída da frente", homeArrival: "chegada em casa", homeDeparture: "saída de casa", frontArrival: "chegada na frente" };

function resolveFunctions(plan: PersonnelPlan, base: Base) {
  // Grafia da origem → nome da função no cadastro (apelidos aprovados + apelidos gravados no banco +
  // mesma função com outra acentuação).
  const dbAliases = Object.fromEntries(base.aliasRows.map((row) => [nameKey(row.alias), row.name]));
  const byKey = new Map(base.functionRows.map((row) => [nameKey(row.name), row]));
  const finalName = (original: string) => {
    const canonical = canonicalFunction(original, dbAliases);
    return byKey.get(nameKey(canonical))?.name ?? canonical;
  };
  const create = new Map<string, { name: string; operates: boolean; people: number }>();
  const aliases = new Map<string, string>(); // apelido (grafia da origem) → função
  const markOperates = new Map<number, string>();
  for (const person of plan.people) {
    if (!person.jobTitleOriginal) continue;
    const name = finalName(person.jobTitleOriginal);
    person.jobTitle = name;
    const existing = byKey.get(nameKey(name));
    if (!existing) {
      const item = create.get(name) ?? { name, operates: operatesEquipment(name), people: 0 };
      item.people++;
      create.set(name, item);
    } else if (!existing.operatesEquipment && operatesEquipment(name)) markOperates.set(existing.id, existing.name);
    if (nameKey(person.jobTitleOriginal) !== nameKey(name) && !dbAliases[nameKey(person.jobTitleOriginal)]) aliases.set(person.jobTitleOriginal, name);
  }
  return { create: [...create.values()], aliases: [...aliases.entries()].map(([alias, name]) => ({ alias, name })), markOperates: [...markOperates.entries()].map(([id, name]) => ({ id, name })) };
}

function matchPeople(plan: PersonnelPlan, base: Base, decisions: Decisions) {
  const used = new Set<number>();
  const result = new Map<string, { employee: EmployeeRow | null; how: MatchHow; candidates: EmployeeRow[] }>();
  const free = (row: EmployeeRow, person: PlannedPerson) => !used.has(row.id) && !(row.externalSource === PERSONNEL_SOURCE && row.externalId !== person.externalId);
  const take = (person: PlannedPerson, row: EmployeeRow, how: MatchHow) => { used.add(row.id); result.set(person.externalId, { employee: row, how, candidates: [] }); };
  const pending = () => plan.people.filter((person) => !result.has(person.externalId));
  for (const person of plan.people) {
    const row = base.people.find((item) => item.externalSource === PERSONNEL_SOURCE && item.externalId === person.externalId);
    if (row) take(person, row, "ID");
  }
  for (const person of pending()) {
    const row = person.cpf ? base.people.find((item) => item.cpf === person.cpf && free(item, person)) : undefined;
    if (row) take(person, row, "CPF");
  }
  for (const person of pending()) {
    const row = person.registration ? base.people.find((item) => item.registration === person.registration && nameKey(item.company) === nameKey(person.company) && free(item, person)) : undefined;
    if (row) take(person, row, "MATRICULA");
  }
  // Candidatos do cadastro para a pessoa (mesmo nome ou parecido), oferecidos na prévia.
  const candidatesFor = (person: PlannedPerson) => base.people.filter((item) => free(item, person) && item.externalSource !== PERSONNEL_SOURCE
    && (nameKey(item.name) === nameKey(person.name) || similarName(item.name, person.name))).slice(0, 5);
  // Decisões do ADMIN na prévia (casamentos por nome ou parecidos).
  for (const person of pending()) {
    const decision = decisions[person.externalId];
    if (decision === "NOVO") { result.set(person.externalId, { employee: null, how: "NOVO", candidates: candidatesFor(person) }); continue; }
    if (typeof decision === "number") {
      const row = base.people.find((item) => item.id === decision);
      if (row && free(row, person)) { const candidates = candidatesFor(person); take(person, row, "ESCOLHIDO"); result.get(person.externalId)!.candidates = candidates; }
    }
  }
  for (const person of pending()) {
    const key = nameKey(person.name);
    const exact = base.people.filter((item) => nameKey(item.name) === key && free(item, person) && item.externalSource !== PERSONNEL_SOURCE);
    if (exact.length === 1) { take(person, exact[0], "NOME"); continue; }
    const similar = candidatesFor(person);
    result.set(person.externalId, { employee: null, how: similar.length ? "PARECIDO" : "NOVO", candidates: similar });
  }
  return result;
}

type PersonPlanDb = {
  preview: PersonPreview;
  person: PlannedPerson;
  employee: EmployeeRow | null;
  // Valores (nomes do Drizzle) a gravar no funcionário.
  set: Partial<EmployeeRow>;
  cycles: Array<{ existing: CycleRow | null; values: Partial<CycleRow> }>;
  absences: Array<{ existing: AbsenceRow | null; values: Partial<AbsenceRow> }>;
  transfers: Array<{ existing: TransferRow | null; values: Partial<TransferRow> }>;
  dismissals: Array<{ existing: DismissalRow | null; values: Partial<DismissalRow> }>;
  linkUserId: number | null;
};

function sameValue(a: unknown, b: unknown) {
  return (a ?? null) === (b ?? null);
}

function display(field: string, value: unknown, base: Base): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (SENSITIVE.has(field)) return "preenchido";
  if (field === "serviceFrontId") return base.fronts.find((front) => front.id === value)?.name ?? String(value);
  if (field === "status") return STATUS_TEXT[String(value)] ?? String(value);
  if (field === "atHeadquarters") return value ? "Sim" : "Não";
  if (field === "admissionDate") return br(String(value));
  return String(value);
}

function planPerson(person: PlannedPerson, match: { employee: EmployeeRow | null; how: MatchHow; candidates: EmployeeRow[] }, base: Base, exportDate: string | null, today: string): PersonPlanDb {
  const frontId = (key: string | null) => (key ? base.fronts.find((front) => nameKey(front.name) === key)?.id ?? null : null);
  const candidate = (row: EmployeeRow): Candidate => ({ id: row.id, name: row.name, front: base.fronts.find((front) => front.id === row.serviceFrontId)?.name ?? null, company: row.company, registration: row.registration, status: row.status });
  const employee = match.employee;
  const warnings = [...person.warnings];
  const errors: string[] = [];
  const front = frontId(person.front);
  if (!front) errors.push(`Frente "${person.front}" não existe no cadastro`);

  // Cadastro: só o que a planilha tem (vazio/"-" nunca apaga).
  const wanted: Partial<EmployeeRow> = {
    name: person.name, jobTitle: person.jobTitle || undefined, company: person.company || undefined, registration: person.registration ?? undefined,
    cpf: person.cpf && isValidCpf(person.cpf) ? person.cpf : undefined, birthDate: person.birthDate ?? undefined, city: person.city ?? undefined,
    admissionDate: person.admissionDate ?? undefined, salary: person.salary ?? undefined, serviceFrontId: front ?? undefined, status: person.status,
    atHeadquarters: person.atHeadquarters, externalSource: PERSONNEL_SOURCE, externalId: person.externalId,
  };
  if (person.cpf && !isValidCpf(person.cpf)) warnings.push("CPF inválido na origem (não gravado)");
  // Unicidade: CPF e matrícula+empresa de outra pessoa do cadastro não são sobrescritos.
  if (wanted.cpf) {
    const other = base.people.find((row) => row.cpf === wanted.cpf && row.id !== employee?.id);
    if (other) { warnings.push(`CPF já cadastrado para ${other.name} (não gravado)`); delete wanted.cpf; }
  }
  if (wanted.registration) {
    const company = wanted.company ?? employee?.company ?? "";
    const other = base.people.find((row) => row.registration === wanted.registration && nameKey(row.company) === nameKey(company) && row.id !== employee?.id);
    if (other) { warnings.push(`Matrícula ${wanted.registration} (${company}) já é de ${other.name} (não gravada)`); delete wanted.registration; }
  }
  const set: Partial<EmployeeRow> = {};
  const changes: Change[] = [];
  for (const [field, value] of Object.entries(wanted) as Array<[keyof EmployeeRow, unknown]>) {
    if (value === undefined) continue;
    if (employee && sameValue(employee[field], value)) continue;
    (set as Record<string, unknown>)[field] = value;
    if (field === "externalSource") continue;
    if (employee) {
      const from = display(field, employee[field], base);
      const to = display(field, value, base);
      if (field === "externalId" && from === null) continue;
      changes.push({ field, label: FIELD_LABELS[field] ?? field, from: SENSITIVE.has(field) ? (from ? "preenchido" : null) : from, to: SENSITIVE.has(field) ? (from ? "alterado" : "preenchido") : to });
    }
  }
  if (!employee) for (const error of person.errors) errors.push(error);

  // Ciclos de folga.
  const existingCycles = employee ? base.cycles.get(employee.id) ?? [] : [];
  const cycles: PersonPlanDb["cycles"] = [];
  const kept: string[] = [];
  const exportLimit = exportDate ? `${exportDate}T23:59:59.999Z` : null;
  for (const cycle of person.cycles) {
    const dates = { workStart: cycle.workStart, frontDeparture: cycle.frontDeparture, homeArrival: cycle.homeArrival, homeDeparture: cycle.homeDeparture, frontArrival: cycle.frontArrival };
    const existing = existingCycles.find((row) => row.externalKey === cycle.key) ?? existingCycles.find((row) => row.cycleNumber === cycle.cycleNumber) ?? null;
    const values: Partial<CycleRow> = { cycleNumber: cycle.cycleNumber, ...dates, endedAt: cycle.endedAt, leaveKind: cycle.leaveKind, externalKey: cycle.key, ...(cycle.notes ? { notes: cycle.notes } : {}) };
    if (!existing) { cycles.push({ existing: null, values }); continue; }
    // Lançado/corrigido no sistema depois da exportação: o que está no sistema vale.
    if (!existing.externalKey && exportLimit && existing.updatedAt > exportLimit) { kept.push(`ciclo ${cycle.cycleNumber} (alterado no sistema depois da exportação)`); continue; }
    // Datas da origem preenchem/corrigem; as que a origem não informa ficam como estão (se ficar
    // incoerente, valem só as da origem).
    let merged = { ...dates };
    const keptSteps: string[] = [];
    for (const step of Object.keys(dates) as Array<keyof typeof dates>) if (!merged[step] && existing[step]) { merged[step] = existing[step]; keptSteps.push(`${STEP_LABELS[step]} ${br(existing[step])}`); }
    if (validateCycleDates(merged, today)) merged = dates;
    else if (keptSteps.length && !cycle.endedAt) kept.push(`ciclo ${cycle.cycleNumber}: ${keptSteps.join(", ")} mantida(s) — a exportação não informa`);
    const next: Partial<CycleRow> = { ...values, ...merged };
    const diff = Object.fromEntries(Object.entries(next).filter(([key, value]) => !sameValue(existing[key as keyof CycleRow], value)));
    if (Object.keys(diff).length) cycles.push({ existing, values: diff });
  }
  if (employee) {
    const maxPlanned = Math.max(0, ...person.cycles.map((cycle) => cycle.cycleNumber));
    const later = existingCycles.filter((row) => row.cycleNumber > maxPlanned && !row.frontArrival && !row.endedAt);
    if (later.length && person.cycles.length) kept.push(`ciclo ${later.map((row) => row.cycleNumber).join(", ")} aberto no sistema além do ciclo da origem`);
  }

  // Afastamentos.
  const existingAbsences = employee ? base.absences.get(employee.id) ?? [] : [];
  const absences: PersonPlanDb["absences"] = [];
  for (const absence of person.absences) {
    const existing = existingAbsences.find((row) => row.externalKey === absence.key) ?? existingAbsences.find((row) => row.startDate === absence.startDate && row.kind !== "FOLGA" && row.kind !== "FERIAS") ?? null;
    const values: Partial<AbsenceRow> = { kind: absence.kind, startDate: absence.startDate, endDate: absence.endDate, externalKey: absence.key, ...(absence.notes ? { notes: absence.notes } : {}) };
    if (!existing) { absences.push({ existing: null, values }); continue; }
    const diff = Object.fromEntries(Object.entries(values).filter(([key, value]) => !sameValue(existing[key as keyof AbsenceRow], value)));
    if (Object.keys(diff).length) absences.push({ existing, values: diff });
  }

  // Histórico de frentes.
  const existingTransfers = employee ? base.transfers.get(employee.id) ?? [] : [];
  const transfers: PersonPlanDb["transfers"] = [];
  const planned = [...person.transfers].sort((a, b) => a.date.localeCompare(b.date) || (a.from === null ? -1 : 1));
  for (const transfer of planned) {
    const to = frontId(transfer.to);
    if (!to) { warnings.push(`Transferência de ${br(transfer.date)}: frente "${transfer.to}" não existe no cadastro`); continue; }
    const from = frontId(transfer.from);
    const values: Partial<TransferRow> = { previousServiceFrontId: from, newServiceFrontId: to, transferDate: transfer.date, note: transfer.note, externalKey: transfer.key };
    const existing = existingTransfers.find((row) => row.externalKey === transfer.key)
      ?? existingTransfers.find((row) => row.transferDate === transfer.date && row.newServiceFrontId === to)
      ?? (transfer.from === null ? existingTransfers.find((row) => row.transferDate === transfer.date && row.previousServiceFrontId === null) : undefined) ?? null;
    if (!existing) { transfers.push({ existing: null, values }); continue; }
    if (existing.newServiceFrontId !== to && existing.previousServiceFrontId === null && transfer.from === null) transfers.push({ existing, values: { newServiceFrontId: to, externalKey: transfer.key } });
    else if (!existing.externalKey) transfers.push({ existing, values: { externalKey: transfer.key } });
  }
  // A frente atual precisa ser a última do histórico.
  const finalFront = front ?? employee?.serviceFrontId ?? null;
  const timeline = [
    ...existingTransfers.map((row) => ({ date: row.transferDate, to: transfers.find((item) => item.existing?.id === row.id)?.values.newServiceFrontId ?? row.newServiceFrontId })),
    ...transfers.filter((item) => !item.existing).map((item) => ({ date: item.values.transferDate!, to: item.values.newServiceFrontId! })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = timeline.at(-1);
  if (finalFront && (!last || last.to !== finalFront) && exportDate) {
    const previous = last?.to ?? employee?.serviceFrontId ?? null;
    const date = person.admissionDate && !last ? person.admissionDate : exportDate;
    transfers.push({ existing: null, values: { previousServiceFrontId: last ? previous : null, newServiceFrontId: finalFront, transferDate: date, note: last ? "Frente atualizada pela importação do sistema de pessoal" : "Frente inicial (sistema de pessoal)", externalKey: `frente:${date}:${finalFront}` } });
  }

  // Desligamentos (atual e revertidos).
  const existingDismissals = employee ? base.dismissals.get(employee.id) ?? [] : [];
  const dismissals: PersonPlanDb["dismissals"] = [];
  for (const dismissal of person.dismissals) {
    const values: Partial<DismissalRow> = {
      dismissedAt: dismissal.dismissedAt, reason: dismissal.reason, rehireAllowed: dismissal.rehireAllowed, rehiredAt: dismissal.rehiredAt, externalKey: dismissal.key,
      previousAdmissionDate: person.admissionDate ?? employee?.admissionDate ?? null,
    };
    const existing = existingDismissals.find((row) => row.externalKey === dismissal.key) ?? existingDismissals.find((row) => row.dismissedAt === dismissal.dismissedAt && !row.externalKey) ?? null;
    if (!existing) { dismissals.push({ existing: null, values }); continue; }
    const diff = Object.fromEntries(Object.entries(values).filter(([key, value]) => key !== "previousAdmissionDate" && !sameValue(existing[key as keyof DismissalRow], value)));
    if (Object.keys(diff).length) dismissals.push({ existing, values: diff });
  }
  if (employee?.status === "DEMITIDO" && person.active && !existingDismissals.every((row) => row.rehiredAt) && !person.dismissals.some((item) => !item.current && item.rehiredAt))
    warnings.push("Está desligado no sistema e ativo na origem: será reativado (confira a readmissão)");

  // Acesso de campo com o mesmo nome e ainda sem vínculo.
  const hasUser = employee ? base.fieldUsers.some((row) => row.employeeId === employee.id) : false;
  const sameName = hasUser ? [] : base.fieldUsers.filter((row) => row.employeeId === null && nameKey(row.name) === nameKey(person.name));
  const linkUserId = sameName.length === 1 ? sameName[0].id : null;

  const historyCount = { cycles: cycles.length, absences: absences.length, transfers: transfers.filter((item) => !item.existing || item.values.newServiceFrontId !== undefined).length, dismissals: dismissals.length, kept };
  const hasHistory = historyCount.cycles + historyCount.absences + historyCount.transfers + historyCount.dismissals > 0 || transfers.length > 0;
  const action: PersonPreview["action"] = errors.length && !employee ? "ERRO" : !employee ? "CRIAR" : Object.keys(set).length || hasHistory || linkUserId ? "ATUALIZAR" : "SEM_MUDANCA";
  return {
    person, employee, set, cycles, absences, transfers, dismissals, linkUserId: action === "ERRO" ? null : linkUserId,
    preview: {
      externalId: person.externalId, row: person.row, name: person.name, front: person.front, company: person.company, jobTitle: person.jobTitle, active: person.active,
      how: employee ? match.how : match.how, employeeId: employee?.id ?? null, employee: employee ? candidate(employee) : null,
      candidates: match.candidates.map(candidate), action, changes, history: historyCount, warnings, errors,
    },
  };
}

export async function computeImport(db: Conn, sheets: ExportSheets, decisions: Decisions) {
  const today = fuelLocalDay();
  const plan = buildPersonnelPlan(sheets, today);
  const base = await loadBase(db);
  const functions = resolveFunctions(plan, base);
  const matches = matchPeople(plan, base, decisions);
  const people = plan.people.map((person) => planPerson(person, matches.get(person.externalId)!, base, plan.exportDate, today))
    .sort((a, b) => Number(a.person.externalId) - Number(b.person.externalId) || a.person.externalId.localeCompare(b.person.externalId));
  const companiesToCreate = [...new Set(plan.people.map((person) => person.company).filter(Boolean))].filter((name) => !base.companyRows.some((row) => nameKey(row.name) === nameKey(name)));
  return { plan, base, functions, people, companiesToCreate, today };
}

// Resumo para a tela (sem CPF, salário, nascimento nem motivos).
// Acesso de campo ativo que a importação desativa: desligado, ou acesso automático (pela função) cuja
// nova função não opera equipamento.
function willDeactivate(item: PersonPlanDb, base: Base, operatesNames: Set<string>) {
  const user = base.fieldUsers.find((row) => row.employeeId === item.employee?.id && row.status === "ACTIVE");
  if (!user) return false;
  if (item.person.status === "DEMITIDO") return true;
  return user.origin !== "MANUAL" && item.set.jobTitle !== undefined && !operatesNames.has(item.person.jobTitle);
}

export function previewOf(result: Awaited<ReturnType<typeof computeImport>>) {
  const { plan, base, functions, people, companiesToCreate } = result;
  const count = (fn: (item: PersonPlanDb) => boolean) => people.filter(fn).length;
  const sum = (key: "cycles" | "absences" | "transfers" | "dismissals", fn: (item: PersonPlanDb[typeof key][number]) => boolean) =>
    people.filter((item) => item.preview.action !== "ERRO").reduce((total, item) => total + (item[key] as Array<PersonPlanDb[typeof key][number]>).filter(fn).length, 0);
  const operatesNames = new Set([...base.functionRows.filter((row) => row.operatesEquipment).map((row) => row.name), ...functions.create.filter((item) => item.operates).map((item) => item.name), ...functions.markOperates.map((item) => item.name)]);
  const fieldAccess = {
    link: people.filter((item) => item.linkUserId).map((item) => ({ name: item.person.name, userId: item.linkUserId })),
    deactivate: people.filter((item) => item.employee && willDeactivate(item, base, operatesNames)).map((item) => ({ name: item.person.name, reason: item.person.status === "DEMITIDO" ? "desligado" : `função ${item.person.jobTitle} não opera equipamento` })),
    operatorsWithoutAccess: people.filter((item) => item.person.active && item.preview.action !== "ERRO" && operatesNames.has(item.person.jobTitle) && !item.linkUserId && !(item.employee && base.fieldUsers.some((row) => row.employeeId === item.employee!.id && row.status === "ACTIVE")))
      .map((item) => ({ name: item.person.name, jobTitle: item.person.jobTitle, front: item.person.front })),
  };
  return {
    exportDate: plan.exportDate,
    totals: plan.totals,
    sheets: plan.sheets,
    people: people.map((item) => item.preview),
    counts: {
      create: count((item) => item.preview.action === "CRIAR"), update: count((item) => item.preview.action === "ATUALIZAR"),
      unchanged: count((item) => item.preview.action === "SEM_MUDANCA"), errors: count((item) => item.preview.action === "ERRO"),
      byName: count((item) => item.preview.how === "NOME" || item.preview.how === "PARECIDO"),
      cyclesNew: sum("cycles", (item) => !item.existing), cyclesUpdated: sum("cycles", (item) => Boolean(item.existing)),
      absencesNew: sum("absences", (item) => !item.existing), absencesUpdated: sum("absences", (item) => Boolean(item.existing)),
      transfersNew: sum("transfers", (item) => !item.existing), dismissalsNew: sum("dismissals", (item) => !item.existing), dismissalsUpdated: sum("dismissals", (item) => Boolean(item.existing)),
    },
    ignored: plan.ignored, unlinked: plan.unlinked, checks: plan.checks,
    functions: { list: plan.functions.map((item) => ({ ...item, name: people.find((person) => person.person.jobTitleOriginal === item.original[0])?.person.jobTitle ?? item.name })), create: functions.create, aliases: functions.aliases, markOperates: functions.markOperates, looksAlike: plan.looksAlike },
    companiesToCreate,
    fieldAccess,
  };
}
export type PersonnelPreview = ReturnType<typeof previewOf>;

export async function previewImport(user: SessionUser, buffer: ArrayBuffer, fileName: string, decisions: Decisions) {
  requireAdmin(user);
  const db = await getDb();
  const sheets = await readExport(buffer);
  const result = await computeImport(db, sheets, decisions);
  return { fileName, hash: fileHash(buffer), blocks: Math.ceil(result.people.length / PEOPLE_PER_BLOCK), ...previewOf(result) };
}

// ---------------------------------------------------------------------------------------------
// Gravação (com registro para o "Desfazer")
// ---------------------------------------------------------------------------------------------

const TRACKED = { employees, employee_leave_cycles: employeeLeaveCycles, employee_absences: employeeAbsences, employee_transfers: employeeTransfers, employee_dismissals: employeeDismissals, companies, job_functions: jobFunctions, job_function_aliases: jobFunctionAliases, users } as const;
type TrackedName = keyof typeof TRACKED;

// Colunas do Drizzle (camelCase) → nomes no banco, para o "Desfazer" devolver o valor anterior.
function toColumns(table: PgTable, values: Record<string, unknown>) {
  const columns = getTableColumns(table) as Record<string, { name: string }>;
  return Object.fromEntries(Object.entries(values).filter(([key]) => columns[key]).map(([key, value]) => [columns[key].name, value]));
}

async function track(tx: Conn, batchId: number, table: TrackedName, rowId: number, action: "INSERT" | "UPDATE", previous?: Record<string, unknown>) {
  await tx.insert(personnelImportChanges).values({ batchId, tableName: table, rowId, action, previous: previous ? JSON.stringify(toColumns(TRACKED[table] as unknown as PgTable, previous)) : null });
}

function pick<T extends Record<string, unknown>>(row: T, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

async function batchOf(db: Conn, batchId: number) {
  const row = (await db.select().from(personnelImportBatches).where(eq(personnelImportBatches.id, batchId)).limit(1))[0];
  if (!row) throw new PersonnelImportError("Lote de importação não encontrado.", 404);
  return row;
}

// Passo 1 da confirmação: cria o lote e grava empresas e funções (novas, apelidos e "Opera equipamento").
export async function startImport(user: SessionUser, buffer: ArrayBuffer, fileName: string, decisions: Decisions) {
  requireAdmin(user);
  const db = await getDb();
  const sheets = await readExport(buffer);
  const running = (await db.select({ id: personnelImportBatches.id }).from(personnelImportBatches).where(eq(personnelImportBatches.status, "EM_ANDAMENTO")).limit(1))[0];
  if (running) throw new PersonnelImportError(`Há uma importação em andamento (lote ${running.id}): conclua ou desfaça antes de começar outra.`, 409);
  const result = await computeImport(db, sheets, decisions);
  const now = new Date().toISOString();
  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx.insert(personnelImportBatches).values({ fileName: fileName.slice(0, 200), fileHash: fileHash(buffer), exportDate: result.plan.exportDate, importedBy: user.id }).returning({ id: personnelImportBatches.id });
    for (const name of result.companiesToCreate) {
      const [row] = await tx.insert(companies).values({ name }).onConflictDoNothing().returning({ id: companies.id });
      if (row) await track(tx, batch.id, "companies", row.id, "INSERT");
    }
    const ids = new Map<string, number>();
    for (const item of result.functions.create) {
      const [row] = await tx.insert(jobFunctions).values({ name: item.name, operatesEquipment: item.operates }).onConflictDoNothing().returning({ id: jobFunctions.id });
      if (row) { await track(tx, batch.id, "job_functions", row.id, "INSERT"); ids.set(item.name, row.id); }
    }
    for (const item of result.functions.markOperates) {
      await tx.update(jobFunctions).set({ operatesEquipment: true, updatedAt: now }).where(eq(jobFunctions.id, item.id));
      await track(tx, batch.id, "job_functions", item.id, "UPDATE", { operatesEquipment: false });
    }
    for (const item of result.functions.aliases) {
      const target = ids.get(item.name) ?? result.base.functionRows.find((row) => row.name === item.name)?.id;
      if (!target) continue;
      const [row] = await tx.insert(jobFunctionAliases).values({ alias: item.alias, jobFunctionId: target }).onConflictDoNothing().returning({ id: jobFunctionAliases.id });
      if (row) await track(tx, batch.id, "job_function_aliases", row.id, "INSERT");
    }
    return batch.id;
  });
  return { batchId, blocks: Math.ceil(result.people.length / PEOPLE_PER_BLOCK), people: result.people.length };
}

async function applyPerson(tx: Tx, batchId: number, item: PersonPlanDb, user: SessionUser, now: string) {
  let employeeId = item.employee?.id ?? null;
  if (!employeeId) {
    const values = item.set as typeof employees.$inferInsert;
    const [row] = await tx.insert(employees).values({ ...values, notes: "Importado do sistema de pessoal", createdBy: user.id, createdAt: now, updatedAt: now }).returning({ id: employees.id });
    employeeId = row.id;
    await track(tx, batchId, "employees", employeeId, "INSERT");
  } else if (Object.keys(item.set).length) {
    await tx.update(employees).set({ ...item.set, updatedAt: now }).where(eq(employees.id, employeeId));
    await track(tx, batchId, "employees", employeeId, "UPDATE", { ...pick(item.employee!, Object.keys(item.set)), updatedAt: item.employee!.updatedAt });
  }
  const targets = { workDaysTarget: item.employee?.cycleWorkDays ?? 90, offDaysTarget: item.employee?.cycleOffDays ?? 10 };
  // Ciclos: primeiro os que já existem (podem fechar um ciclo aberto), depois os novos.
  for (const cycle of item.cycles.filter((entry) => entry.existing)) {
    await tx.update(employeeLeaveCycles).set({ ...cycle.values, updatedAt: now }).where(eq(employeeLeaveCycles.id, cycle.existing!.id));
    await track(tx, batchId, "employee_leave_cycles", cycle.existing!.id, "UPDATE", { ...pick(cycle.existing!, Object.keys(cycle.values)), updatedAt: cycle.existing!.updatedAt });
  }
  for (const cycle of item.cycles.filter((entry) => !entry.existing)) {
    const [row] = await tx.insert(employeeLeaveCycles).values({ ...targets, ...cycle.values, employeeId, cycleNumber: cycle.values.cycleNumber!, serviceFrontId: item.set.serviceFrontId ?? item.employee?.serviceFrontId ?? null, createdBy: user.id, createdAt: now, updatedAt: now })
      .returning({ id: employeeLeaveCycles.id });
    await track(tx, batchId, "employee_leave_cycles", row.id, "INSERT");
  }
  for (const absence of item.absences) {
    if (absence.existing) {
      await tx.update(employeeAbsences).set({ ...absence.values, updatedAt: now }).where(eq(employeeAbsences.id, absence.existing.id));
      await track(tx, batchId, "employee_absences", absence.existing.id, "UPDATE", { ...pick(absence.existing, Object.keys(absence.values)), updatedAt: absence.existing.updatedAt });
    } else {
      const [row] = await tx.insert(employeeAbsences).values({ ...(absence.values as typeof employeeAbsences.$inferInsert), employeeId, createdBy: user.id, createdAt: now, updatedAt: now }).returning({ id: employeeAbsences.id });
      await track(tx, batchId, "employee_absences", row.id, "INSERT");
    }
  }
  for (const transfer of item.transfers) {
    if (transfer.existing) {
      await tx.update(employeeTransfers).set({ ...transfer.values, updatedAt: now }).where(eq(employeeTransfers.id, transfer.existing.id));
      await track(tx, batchId, "employee_transfers", transfer.existing.id, "UPDATE", { ...pick(transfer.existing, Object.keys(transfer.values)), updatedAt: transfer.existing.updatedAt });
    } else {
      const [row] = await tx.insert(employeeTransfers).values({ ...(transfer.values as typeof employeeTransfers.$inferInsert), employeeId, transferredBy: user.id, createdAt: now, updatedAt: now }).returning({ id: employeeTransfers.id });
      await track(tx, batchId, "employee_transfers", row.id, "INSERT");
    }
  }
  for (const dismissal of item.dismissals) {
    if (dismissal.existing) {
      await tx.update(employeeDismissals).set({ ...dismissal.values, updatedAt: now }).where(eq(employeeDismissals.id, dismissal.existing.id));
      await track(tx, batchId, "employee_dismissals", dismissal.existing.id, "UPDATE", { ...pick(dismissal.existing, Object.keys(dismissal.values)), updatedAt: dismissal.existing.updatedAt });
    } else {
      const [row] = await tx.insert(employeeDismissals).values({ ...(dismissal.values as typeof employeeDismissals.$inferInsert), employeeId, createdBy: user.id, createdAt: now, updatedAt: now }).returning({ id: employeeDismissals.id });
      await track(tx, batchId, "employee_dismissals", row.id, "INSERT");
    }
  }
  if (item.linkUserId) {
    const linked = (await tx.select({ id: users.id }).from(users).where(eq(users.employeeId, employeeId)).limit(1))[0];
    if (!linked) {
      await tx.update(users).set({ employeeId, updatedAt: now }).where(and(eq(users.id, item.linkUserId), sql`${users.employeeId} is null`));
      await track(tx, batchId, "users", item.linkUserId, "UPDATE", { employeeId: null });
    }
  }
  return employeeId;
}

const USER_SNAPSHOT = ["status", "name", "jobTitle", "serviceFrontId", "employeeId"] as const;

// Acesso de campo acompanha o cadastro (desligado = inativo). Nunca cria acesso nesta etapa.
async function syncFieldAccess(db: Db, batchId: number, employeeIds: number[], actorId: number) {
  if (!employeeIds.length) return { deactivated: 0 };
  const before = await db.select().from(users).where(inArray(users.employeeId, employeeIds));
  let deactivated = 0;
  for (const user of before) {
    const result = await sincronizarAcessoOperador(db, user.employeeId!, actorId, { criar: false, motivo: "importação do sistema de pessoal" });
    if (result.acao === "DESATIVADO") deactivated++;
    if (result.acao === "DESATIVADO" || result.acao === "ATUALIZADO") await track(db, batchId, "users", user.id, "UPDATE", pick(user, [...USER_SNAPSHOT, "updatedAt"]));
  }
  return { deactivated };
}

// Passo 2 (repetido): grava um bloco de pessoas.
export async function applyBlock(user: SessionUser, batchId: number, block: number, buffer: ArrayBuffer, decisions: Decisions) {
  requireAdmin(user);
  const db = await getDb();
  const batch = await batchOf(db, batchId);
  if (batch.status !== "EM_ANDAMENTO") throw new PersonnelImportError("Este lote não está em andamento.", 409);
  if (batch.fileHash !== fileHash(buffer)) throw new PersonnelImportError("O arquivo enviado não é o mesmo da prévia confirmada.", 409);
  const sheets = await readExport(buffer);
  const result = await computeImport(db, sheets, decisions);
  const slice = result.people.slice(block * PEOPLE_PER_BLOCK, (block + 1) * PEOPLE_PER_BLOCK).filter((item) => item.preview.action === "CRIAR" || item.preview.action === "ATUALIZAR");
  const now = new Date().toISOString();
  const touched: number[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const item of slice) {
    try {
      const employeeId = await db.transaction((tx) => applyPerson(tx, batchId, item, user, now));
      // O acesso de campo só é revisto quando muda o que ele acompanha (desligamento, nome, função, frente).
      if (!item.employee || ["status", "name", "jobTitle", "serviceFrontId"].some((field) => field in item.set) || item.linkUserId) touched.push(employeeId);
    } catch (error) {
      // Nunca registra o conteúdo da linha (dados pessoais): só a pessoa e o tipo do erro.
      const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "erro";
      console.error(`[personnel-import.block] lote ${batchId} ID ${item.person.externalId}:`, message);
      failed.push({ name: item.person.name, error: /unique|duplicate/i.test(message) ? "Conflito com um registro existente (matrícula, CPF ou ciclo)" : "Não foi possível gravar esta pessoa" });
    }
  }
  const access = await syncFieldAccess(db, batchId, touched, user.id);
  return { block, saved: touched.length, failed, ...access, done: (block + 1) * PEOPLE_PER_BLOCK >= result.people.length };
}

// Passo 3: conclui o lote (resumo só com totais).
export async function finishImport(user: SessionUser, batchId: number) {
  requireAdmin(user);
  const db = await getDb();
  const batch = await batchOf(db, batchId);
  if (batch.status !== "EM_ANDAMENTO") throw new PersonnelImportError("Este lote não está em andamento.", 409);
  const rows = await db.select({ table: personnelImportChanges.tableName, action: personnelImportChanges.action, total: sql<number>`count(*)::int` })
    .from(personnelImportChanges).where(eq(personnelImportChanges.batchId, batchId)).groupBy(personnelImportChanges.tableName, personnelImportChanges.action);
  const summary = Object.fromEntries(rows.map((row) => [`${row.table}.${row.action}`, Number(row.total)]));
  const now = new Date().toISOString();
  await db.update(personnelImportBatches).set({ status: "CONCLUIDO", summary: JSON.stringify(summary), finishedAt: now, updatedAt: now }).where(eq(personnelImportBatches.id, batchId));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "PERSONNEL_IMPORT", entityId: String(batchId), action: "IMPORTAÇÃO DO SISTEMA DE PESSOAL CONCLUÍDA", newValue: JSON.stringify(summary), occurredAt: now });
  return { summary };
}

// Desfazer: do último registro para o primeiro — apaga o que foi criado e devolve o que foi alterado.
export async function undoImport(user: SessionUser, batchId: number) {
  requireAdmin(user);
  const db = await getDb();
  const batch = await batchOf(db, batchId);
  if (batch.status === "DESFEITO") throw new PersonnelImportError("Este lote já foi desfeito.", 409);
  const changes = await db.select().from(personnelImportChanges).where(eq(personnelImportChanges.batchId, batchId)).orderBy(desc(personnelImportChanges.id));
  let undone = 0;
  const failed: string[] = [];
  const restoredUsers = new Set<number>();
  for (const change of changes) {
    const name = change.tableName as TrackedName;
    if (!(name in TRACKED)) continue;
    try {
      if (change.action === "INSERT") {
        await db.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE id = ${change.rowId}`);
      } else {
        const previous = JSON.parse(change.previous ?? "{}") as Record<string, unknown>;
        const entries = Object.entries(previous);
        if (entries.length) await db.execute(sql`UPDATE ${sql.identifier(name)} SET ${sql.join(entries.map(([column, value]) => sql`${sql.identifier(column)} = ${value as string | number | boolean | null}`), sql`, `)} WHERE id = ${change.rowId}`);
        if (name === "users") restoredUsers.add(change.rowId);
      }
      undone++;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "erro";
      console.error(`[personnel-import.undo] lote ${batchId} ${name}#${change.rowId}:`, message);
      failed.push(`${name} #${change.rowId}: ${/foreign key/i.test(message) ? "já usado em outro lançamento do sistema" : "não foi possível desfazer"}`);
    }
  }
  const now = new Date().toISOString();
  // Acesso automático (pela função) volta a enxergar só a frente restaurada.
  for (const id of restoredUsers) {
    const row = (await db.select({ id: users.id, frontId: users.serviceFrontId, origin: users.fieldAccessOrigin }).from(users).where(eq(users.id, id)).limit(1))[0];
    if (!row?.frontId || row.origin === "MANUAL") continue;
    await db.delete(userServiceFronts).where(eq(userServiceFronts.userId, id));
    await db.insert(userServiceFronts).values({ userId: id, serviceFrontId: row.frontId, createdAt: now, updatedAt: now });
  }
  await db.update(personnelImportBatches).set({ status: "DESFEITO", undoneAt: now, undoneBy: user.id, updatedAt: now }).where(eq(personnelImportBatches.id, batchId));
  await db.insert(auditLogs).values({ userId: user.id, entityType: "PERSONNEL_IMPORT", entityId: String(batchId), action: "IMPORTAÇÃO DO SISTEMA DE PESSOAL DESFEITA", newValue: JSON.stringify({ undone, failed: failed.length }), occurredAt: now });
  return { undone, failed };
}

export async function listBatches(user: SessionUser) {
  requireAdmin(user);
  const db = await getDb();
  const rows = await db.select({
    id: personnelImportBatches.id, fileName: personnelImportBatches.fileName, exportDate: personnelImportBatches.exportDate, status: personnelImportBatches.status,
    summary: personnelImportBatches.summary, createdAt: personnelImportBatches.createdAt, finishedAt: personnelImportBatches.finishedAt, undoneAt: personnelImportBatches.undoneAt, importedBy: users.name,
  }).from(personnelImportBatches).innerJoin(users, eq(users.id, personnelImportBatches.importedBy)).orderBy(desc(personnelImportBatches.id)).limit(20);
  return rows.map((row) => ({ ...row, summary: row.summary ? JSON.parse(row.summary) as Record<string, number> : null }));
}
