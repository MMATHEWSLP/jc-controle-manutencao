import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, fuelMovements, fuelTypes, serviceFronts, stockExits, thirdParties, thirdPartyEmployees, thirdPartyVehicles } from "../db/schema";
import type { SessionUser } from "./auth";
import { computeFuelCosts } from "./fuel-rules";
import {
  averageConsumption, computeConsumption, CONSUMPTION_UNITS, isOutlier, METER_LABELS, METER_PHRASES, THIRD_PARTY_KIND_LABELS,
  isFuelPurpose, purposeText,
  type Fueling, type FuelingConsumption, type FuelPurpose, type MeterType, type ThirdPartyDestination, type ThirdPartyEmployeeInput, type ThirdPartyInput, type VehicleInput,
} from "./third-party-rules";

type Db = Awaited<ReturnType<typeof getDb>>;

// Erro de regra do cadastro/lançamento. `confirm` = o lançamento pode seguir se a pessoa confirmar
// (TANK: litros acima da capacidade; OUTLIER: consumo fora da média); `exception` = leitura menor que
// a última, que ADMIN/GESTOR podem aceitar com justificativa.
export class ThirdPartyError extends Error {
  constructor(message: string, public status = 400, public extra: { confirm?: "TANK" | "OUTLIER"; exception?: boolean } = {}) { super(message); }
}
export function thirdPartyErrorResponse(error: unknown) {
  return error instanceof ThirdPartyError ? Response.json({ error: error.message, ...error.extra }, { status: error.status }) : null;
}

// Consultar/selecionar: quem já usa Combustível ou Movimentação. Cadastrar/editar/inativar:
// third_parties.manage (ADMIN e GESTOR por padrão).
export function canViewThirdParties(user: SessionUser) {
  return ["third_parties.manage", "fuel.view", "fuel.register", "stock.exits_view", "stock.exits_create"].some((permission) => user.permissions.includes(permission as never));
}
export const canManageThirdParties = (user: SessionUser) => user.permissions.includes("third_parties.manage");

const uniqueViolation = (error: unknown) => {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
};

// ---------------------------------------------------------------------------
// Abastecimentos (saídas) dos veículos de terceiros, para o consumo.
// ---------------------------------------------------------------------------
export type VehicleFueling = Fueling & { serviceFrontId: number; outlier: boolean };

export async function vehicleFuelings(db: Db, vehicleIds: number[]) {
  const map = new Map<number, VehicleFueling[]>();
  if (vehicleIds.length === 0) return map;
  const rows = await db.select({
    id: fuelMovements.id, vehicleId: fuelMovements.thirdPartyVehicleId, date: fuelMovements.movementDate, liters: fuelMovements.quantity,
    reading: fuelMovements.meterReading, fullTank: fuelMovements.fullTank, readingException: fuelMovements.readingException,
    serviceFrontId: fuelMovements.serviceFrontId, outlier: fuelMovements.consumptionOutlier,
  }).from(fuelMovements).where(and(inArray(fuelMovements.thirdPartyVehicleId, vehicleIds), isNull(fuelMovements.deletedAt), eq(fuelMovements.movementType, "SAIDA"), eq(fuelMovements.balanceAdjustment, false)));
  for (const row of rows) {
    const list = map.get(row.vehicleId!) ?? [];
    list.push({ id: row.id, date: row.date, liters: row.liters, reading: row.reading, fullTank: row.fullTank, readingException: row.readingException, serviceFrontId: row.serviceFrontId, outlier: row.outlier });
    map.set(row.vehicleId!, list);
  }
  return map;
}

// Consumo por lançamento (Histórico do Combustível): calcula com todo o histórico do veículo.
export async function consumptionByMovement(db: Db, vehicleIds: number[]) {
  const unique = [...new Set(vehicleIds)];
  if (unique.length === 0) return new Map<number, { value: number; unit: string; distance: number; liters: number }>();
  const [fuelings, vehicles] = await Promise.all([
    vehicleFuelings(db, unique),
    db.select({ id: thirdPartyVehicles.id, meterType: thirdPartyVehicles.meterType }).from(thirdPartyVehicles).where(inArray(thirdPartyVehicles.id, unique)),
  ]);
  const result = new Map<number, { value: number; unit: string; distance: number; liters: number }>();
  for (const vehicle of vehicles) {
    for (const [id, entry] of computeConsumption(vehicle.meterType, fuelings.get(vehicle.id) ?? [])) {
      if (entry) result.set(id, { ...entry, unit: CONSUMPTION_UNITS[vehicle.meterType] });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------
export type ThirdPartyFilters = { q?: string; kind?: string | null; active?: "ACTIVE" | "INACTIVE" | "ALL" };

export async function listThirdParties(db: Db, filters: ThirdPartyFilters, visibleFronts: number[] | "ALL") {
  const conditions = [
    filters.q ? or(ilike(thirdParties.name, `%${filters.q}%`), ilike(thirdParties.document, `%${filters.q.replace(/\D/g, "") || filters.q}%`), sql`exists (select 1 from ${thirdPartyVehicles} v where v.third_party_id = ${thirdParties.id} and (v.plate_key ilike ${`%${filters.q.toUpperCase().replace(/[^A-Z0-9]/g, "")}%`} or v.description ilike ${`%${filters.q}%`}))`) : undefined,
    filters.kind ? eq(thirdParties.kind, filters.kind as "PRESTADOR") : undefined,
    filters.active === "INACTIVE" ? eq(thirdParties.active, false) : filters.active === "ALL" ? undefined : eq(thirdParties.active, true),
  ].filter(Boolean);
  const parties = await db.select({
    id: thirdParties.id, name: thirdParties.name, kind: thirdParties.kind, document: thirdParties.document, contactName: thirdParties.contactName,
    phone: thirdParties.phone, serviceFrontId: thirdParties.serviceFrontId, front: serviceFronts.name, notes: thirdParties.notes, active: thirdParties.active,
  }).from(thirdParties).leftJoin(serviceFronts, eq(thirdParties.serviceFrontId, serviceFronts.id))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(thirdParties.active), asc(thirdParties.name)).limit(500);
  const vehicles = parties.length ? await db.select({
    id: thirdPartyVehicles.id, thirdPartyId: thirdPartyVehicles.thirdPartyId, plate: thirdPartyVehicles.plate, description: thirdPartyVehicles.description,
    vehicleType: thirdPartyVehicles.vehicleType, meterType: thirdPartyVehicles.meterType, fuelTypeId: thirdPartyVehicles.fuelTypeId, fuelName: fuelTypes.name,
    tankCapacityLiters: thirdPartyVehicles.tankCapacityLiters, expectedConsumption: thirdPartyVehicles.expectedConsumption, lastReading: thirdPartyVehicles.lastReading, active: thirdPartyVehicles.active,
  }).from(thirdPartyVehicles).leftJoin(fuelTypes, eq(thirdPartyVehicles.fuelTypeId, fuelTypes.id))
    .where(inArray(thirdPartyVehicles.thirdPartyId, parties.map((party) => party.id))).orderBy(desc(thirdPartyVehicles.active), asc(thirdPartyVehicles.plate)) : [];
  const workers = parties.length ? await db.select().from(thirdPartyEmployees).where(inArray(thirdPartyEmployees.thirdPartyId, parties.map((party) => party.id))).orderBy(desc(thirdPartyEmployees.active), asc(thirdPartyEmployees.name)) : [];
  const workerUsage = workers.length ? await Promise.all([
    db.select({ id: fuelMovements.thirdPartyEmployeeId, total: sql<number>`count(*)::int` }).from(fuelMovements).where(inArray(fuelMovements.thirdPartyEmployeeId, workers.map((row) => row.id))).groupBy(fuelMovements.thirdPartyEmployeeId),
    db.select({ id: stockExits.thirdPartyEmployeeId, total: sql<number>`count(*)::int` }).from(stockExits).where(inArray(stockExits.thirdPartyEmployeeId, workers.map((row) => row.id))).groupBy(stockExits.thirdPartyEmployeeId),
  ]) : [[], []];
  const workersUsed = new Set(workerUsage.flat().filter((row) => Number(row.total) > 0).map((row) => row.id));
  const fuelings = await vehicleFuelings(db, vehicles.map((vehicle) => vehicle.id));
  const [usage, exitUsage] = parties.length ? await Promise.all([
    db.select({ id: fuelMovements.thirdPartyId, total: sql<number>`count(*)::int` }).from(fuelMovements).where(inArray(fuelMovements.thirdPartyId, parties.map((party) => party.id))).groupBy(fuelMovements.thirdPartyId),
    db.select({ id: stockExits.thirdPartyId, total: sql<number>`count(*)::int` }).from(stockExits).where(inArray(stockExits.thirdPartyId, parties.map((party) => party.id))).groupBy(stockExits.thirdPartyId),
  ]) : [[], []];
  const used = new Set([...usage, ...exitUsage].filter((row) => Number(row.total) > 0).map((row) => row.id));
  return parties.map((party) => ({
    ...party, kindLabel: THIRD_PARTY_KIND_LABELS[party.kind], hasMovements: used.has(party.id),
    employees: workers.filter((row) => row.thirdPartyId === party.id).map((row) => ({ id: row.id, name: row.name, jobTitle: row.jobTitle, cpf: row.cpf, phone: row.phone, active: row.active, hasMovements: workersUsed.has(row.id) })),
    vehicles: vehicles.filter((vehicle) => vehicle.thirdPartyId === party.id).map((vehicle) => {
      const list = fuelings.get(vehicle.id) ?? [];
      const consumption = computeConsumption(vehicle.meterType, list);
      // Média só com os abastecimentos das frentes que a pessoa enxerga.
      const visible = list.filter((row) => visibleFronts === "ALL" || visibleFronts.includes(row.serviceFrontId));
      const average = averageConsumption(vehicle.meterType, visible.map((row) => consumption.get(row.id)));
      return {
        ...vehicle, meterLabel: METER_LABELS[vehicle.meterType], consumptionUnit: CONSUMPTION_UNITS[vehicle.meterType],
        averageConsumption: average.value, fuelings: visible.length, hasMovements: list.length > 0,
      };
    }),
  }));
}

async function requireFront(db: Db, id: number | null) {
  if (!id) return;
  if (!(await db.select({ id: serviceFronts.id }).from(serviceFronts).where(eq(serviceFronts.id, id)).limit(1))[0]) throw new ThirdPartyError("Frente não encontrada.");
}

export async function createThirdParty(db: Db, user: SessionUser, input: ThirdPartyInput) {
  await requireFront(db, input.serviceFrontId);
  try {
    const [row] = await db.insert(thirdParties).values({ ...input, createdBy: user.id }).returning({ id: thirdParties.id });
    await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY", entityId: String(row.id), action: "TERCEIRO CADASTRADO", newValue: JSON.stringify(input) });
    return row.id;
  } catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError("Já existe um terceiro com este CPF/CNPJ.", 409);
    throw error;
  }
}

export async function updateThirdParty(db: Db, user: SessionUser, id: number, input: ThirdPartyInput | null, active?: boolean) {
  const current = (await db.select().from(thirdParties).where(eq(thirdParties.id, id)).limit(1))[0];
  if (!current) throw new ThirdPartyError("Terceiro não encontrado.", 404);
  if (input) await requireFront(db, input.serviceFrontId);
  const values = { ...(input ?? {}), ...(active === undefined ? {} : { active }), updatedAt: new Date().toISOString() };
  try {
    await db.update(thirdParties).set(values).where(eq(thirdParties.id, id));
  } catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError("Já existe um terceiro com este CPF/CNPJ.", 409);
    throw error;
  }
  await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY", entityId: String(id), action: active === false ? "TERCEIRO INATIVADO" : active === true ? "TERCEIRO REATIVADO" : "TERCEIRO EDITADO", previousValue: JSON.stringify(current), newValue: JSON.stringify(values) });
}

async function partyUsed(db: Db, id: number) {
  const [fuel, exit] = await Promise.all([
    db.select({ id: fuelMovements.id }).from(fuelMovements).where(eq(fuelMovements.thirdPartyId, id)).limit(1),
    db.select({ id: stockExits.id }).from(stockExits).where(eq(stockExits.thirdPartyId, id)).limit(1),
  ]);
  return fuel.length > 0 || exit.length > 0;
}
async function vehicleUsed(db: Db, id: number) {
  const [fuel, exit] = await Promise.all([
    db.select({ id: fuelMovements.id }).from(fuelMovements).where(eq(fuelMovements.thirdPartyVehicleId, id)).limit(1),
    db.select({ id: stockExits.id }).from(stockExits).where(eq(stockExits.thirdPartyVehicleId, id)).limit(1),
  ]);
  return fuel.length > 0 || exit.length > 0;
}

// Excluir de verdade só o que nunca foi usado; com movimentação, só inativar.
export async function deleteThirdParty(db: Db, user: SessionUser, id: number) {
  if (await partyUsed(db, id)) throw new ThirdPartyError("Este terceiro já tem movimentação: não pode ser excluído, só inativado.", 409);
  const vehicles = await db.select({ id: thirdPartyVehicles.id }).from(thirdPartyVehicles).where(eq(thirdPartyVehicles.thirdPartyId, id));
  for (const vehicle of vehicles) if (await vehicleUsed(db, vehicle.id)) throw new ThirdPartyError("Um veículo deste terceiro já tem movimentação: só é possível inativar.", 409);
  await db.transaction(async (tx) => {
    await tx.delete(thirdPartyVehicles).where(eq(thirdPartyVehicles.thirdPartyId, id));
    await tx.delete(thirdPartyEmployees).where(eq(thirdPartyEmployees.thirdPartyId, id));
    const removed = await tx.delete(thirdParties).where(eq(thirdParties.id, id)).returning({ id: thirdParties.id });
    if (!removed.length) throw new ThirdPartyError("Terceiro não encontrado.", 404);
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY", entityId: String(id), action: "TERCEIRO EXCLUÍDO" });
  });
}

export async function createVehicle(db: Db, user: SessionUser, thirdPartyId: number, input: VehicleInput) {
  const party = (await db.select({ id: thirdParties.id }).from(thirdParties).where(eq(thirdParties.id, thirdPartyId)).limit(1))[0];
  if (!party) throw new ThirdPartyError("Terceiro não encontrado.", 404);
  try {
    const [row] = await db.insert(thirdPartyVehicles).values({ ...input, thirdPartyId, createdBy: user.id }).returning({ id: thirdPartyVehicles.id });
    await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_VEHICLE", entityId: String(row.id), action: "VEÍCULO DE TERCEIRO CADASTRADO", newValue: JSON.stringify({ thirdPartyId, ...input }) });
    return row.id;
  } catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError(`Esta empresa já tem um veículo com a placa/identificação ${input.plate}.`, 409);
    throw error;
  }
}

export async function updateVehicle(db: Db, user: SessionUser, id: number, input: VehicleInput | null, active?: boolean) {
  const current = (await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, id)).limit(1))[0];
  if (!current) throw new ThirdPartyError("Veículo não encontrado.", 404);
  const values = { ...(input ?? {}), ...(active === undefined ? {} : { active }), updatedAt: new Date().toISOString() };
  // Com abastecimentos, a leitura vem dos lançamentos: não se sobrescreve pela edição do cadastro.
  if (input && (await vehicleUsed(db, id))) delete (values as Partial<VehicleInput>).lastReading;
  try {
    await db.update(thirdPartyVehicles).set(values).where(eq(thirdPartyVehicles.id, id));
  } catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError("Esta empresa já tem outro veículo com essa placa/identificação.", 409);
    throw error;
  }
  await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_VEHICLE", entityId: String(id), action: active === false ? "VEÍCULO DE TERCEIRO INATIVADO" : active === true ? "VEÍCULO DE TERCEIRO REATIVADO" : "VEÍCULO DE TERCEIRO EDITADO", previousValue: JSON.stringify(current), newValue: JSON.stringify(values) });
}

export async function deleteVehicle(db: Db, user: SessionUser, id: number) {
  if (await vehicleUsed(db, id)) throw new ThirdPartyError("Este veículo já tem movimentação: não pode ser excluído, só inativado.", 409);
  const removed = await db.delete(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, id)).returning({ id: thirdPartyVehicles.id });
  if (!removed.length) throw new ThirdPartyError("Veículo não encontrado.", 404);
  await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_VEHICLE", entityId: String(id), action: "VEÍCULO DE TERCEIRO EXCLUÍDO" });
}

// ---------------------------------------------------------------------------
// Funcionários dos terceiros (aba "Funcionários" da empresa)
// ---------------------------------------------------------------------------
async function employeeUsed(db: Db, id: number) {
  const [fuel, exit] = await Promise.all([
    db.select({ id: fuelMovements.id }).from(fuelMovements).where(eq(fuelMovements.thirdPartyEmployeeId, id)).limit(1),
    db.select({ id: stockExits.id }).from(stockExits).where(eq(stockExits.thirdPartyEmployeeId, id)).limit(1),
  ]);
  return fuel.length > 0 || exit.length > 0;
}

export async function createThirdPartyEmployee(db: Db, user: SessionUser, thirdPartyId: number, input: ThirdPartyEmployeeInput) {
  const party = (await db.select({ id: thirdParties.id }).from(thirdParties).where(eq(thirdParties.id, thirdPartyId)).limit(1))[0];
  if (!party) throw new ThirdPartyError("Terceiro não encontrado.", 404);
  try {
    const [row] = await db.insert(thirdPartyEmployees).values({ ...input, thirdPartyId, createdBy: user.id }).returning({ id: thirdPartyEmployees.id });
    await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_EMPLOYEE", entityId: String(row.id), action: "FUNCIONÁRIO DE TERCEIRO CADASTRADO", newValue: JSON.stringify({ thirdPartyId, ...input }) });
    return row.id;
  } catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError(`Esta empresa já tem um funcionário chamado ${input.name}.`, 409);
    throw error;
  }
}

export async function updateThirdPartyEmployee(db: Db, user: SessionUser, id: number, input: ThirdPartyEmployeeInput | null, active?: boolean) {
  const current = (await db.select().from(thirdPartyEmployees).where(eq(thirdPartyEmployees.id, id)).limit(1))[0];
  if (!current) throw new ThirdPartyError("Funcionário não encontrado.", 404);
  const values = { ...(input ?? {}), ...(active === undefined ? {} : { active }), updatedAt: new Date().toISOString() };
  try { await db.update(thirdPartyEmployees).set(values).where(eq(thirdPartyEmployees.id, id)); }
  catch (error) {
    if (uniqueViolation(error)) throw new ThirdPartyError("Esta empresa já tem outro funcionário com esse nome.", 409);
    throw error;
  }
  await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_EMPLOYEE", entityId: String(id), action: active === false ? "FUNCIONÁRIO DE TERCEIRO INATIVADO" : active === true ? "FUNCIONÁRIO DE TERCEIRO REATIVADO" : "FUNCIONÁRIO DE TERCEIRO EDITADO", previousValue: JSON.stringify(current), newValue: JSON.stringify(values) });
}

export async function deleteThirdPartyEmployee(db: Db, user: SessionUser, id: number) {
  if (await employeeUsed(db, id)) throw new ThirdPartyError("Este funcionário já tem movimentação: não pode ser excluído, só inativado.", 409);
  const removed = await db.delete(thirdPartyEmployees).where(eq(thirdPartyEmployees.id, id)).returning({ id: thirdPartyEmployees.id });
  if (!removed.length) throw new ThirdPartyError("Funcionário não encontrado.", 404);
  await db.insert(auditLogs).values({ userId: user.id, entityType: "THIRD_PARTY_EMPLOYEE", entityId: String(id), action: "FUNCIONÁRIO DE TERCEIRO EXCLUÍDO" });
}

// Funcionário escolhido numa saída (combustível ou produtos): precisa ser da empresa e estar ativo
// (ou já ser o funcionário do lançamento que está sendo editado).
export async function requireThirdPartyEmployee(db: Db, thirdPartyId: number, employeeId: number, currentId?: number | null) {
  const worker = (await db.select().from(thirdPartyEmployees).where(eq(thirdPartyEmployees.id, employeeId)).limit(1))[0];
  if (!worker || worker.thirdPartyId !== thirdPartyId) throw new ThirdPartyError("O funcionário escolhido não pertence a esta empresa.");
  if (!worker.active && currentId !== worker.id) throw new ThirdPartyError(`${worker.name} está inativo no cadastro do terceiro.`);
  return worker;
}

// Última leitura do veículo = a do abastecimento mais recente (data, id); sem abastecimento com
// leitura, fica a do cadastro.
export async function refreshVehicleLastReading(db: Db, vehicleId: number | null | undefined) {
  if (!vehicleId) return;
  const latest = (await db.select({ reading: fuelMovements.meterReading }).from(fuelMovements)
    .where(and(eq(fuelMovements.thirdPartyVehicleId, vehicleId), isNull(fuelMovements.deletedAt), sql`${fuelMovements.meterReading} is not null`))
    .orderBy(desc(fuelMovements.movementDate), desc(fuelMovements.id)).limit(1))[0];
  if (latest) await db.update(thirdPartyVehicles).set({ lastReading: latest.reading, updatedAt: new Date().toISOString() }).where(eq(thirdPartyVehicles.id, vehicleId));
}

// ---------------------------------------------------------------------------
// Saída de combustível para terceiro (Prestadores de Serviço / Saída para terceiros)
// ---------------------------------------------------------------------------
export type ThirdPartyFuelRequest = {
  mode: "PRESTADOR" | "GERAL"; thirdPartyId: number; vehicleId: number | null; reading: number | null; fullTank: boolean; quantity: number;
  movementDate: string; notes: string | null; readingException: boolean; confirmTank: boolean; confirmOutlier: boolean; editingId: number | null;
  current: { thirdPartyId: number | null; thirdPartyVehicleId: number | null; thirdPartyEmployeeId?: number | null } | null;
  // Destino: VEICULO (padrão; leitura e consumo) ou FUNCIONARIO (funcionário da empresa + finalidade, sem leitura).
  destination?: ThirdPartyDestination; employeeId?: number | null; purpose?: FuelPurpose | null; purposeNote?: string | null;
  // Importação de fichas antigas: a leitura de referência é a do último abastecimento até a data
  // deste (não a última leitura do veículo, que pode ser de um dia posterior).
  referenceByDate?: boolean;
};

const fmt = (value: number, digits = 2) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });

export async function prepareThirdPartyFuel(db: Db, user: SessionUser, request: ThirdPartyFuelRequest) {
  const party = (await db.select().from(thirdParties).where(eq(thirdParties.id, request.thirdPartyId)).limit(1))[0];
  if (!party) throw new ThirdPartyError("Terceiro não encontrado no cadastro.", 404);
  if (!party.active && request.current?.thirdPartyId !== party.id) throw new ThirdPartyError(`${party.name} está inativo no cadastro de terceiros.`);
  if (request.mode === "PRESTADOR" && party.kind === "PESSOA_FISICA") throw new ThirdPartyError("Prestadores de Serviço aceitam só empresas prestadoras ou terceirizadas. Para pessoa física, use Saída para terceiros.");
  if (request.destination === "FUNCIONARIO") {
    if (!request.employeeId) throw new ThirdPartyError(`Escolha o funcionário de ${party.name} que recebeu o combustível (ou cadastre com “+ Novo”).`);
    const worker = await requireThirdPartyEmployee(db, party.id, request.employeeId, request.current?.thirdPartyEmployeeId);
    if (!isFuelPurpose(request.purpose)) throw new ThirdPartyError("Escolha a finalidade (motosserra, gerador, galão/reserva, máquina não cadastrada ou outros).");
    const note = request.purposeNote?.trim() || null;
    if (request.purpose === "OUTROS" && !note) throw new ThirdPartyError("Descreva a finalidade em “Outros”.");
    if (!(request.quantity > 0)) throw new ThirdPartyError("Informe a quantidade em litros (maior que zero).");
    const label = `Funcionário: ${worker.name} (${purposeText(request.purpose, note)})`;
    // Sem veículo, sem leitura e fora da média de consumo de qualquer veículo.
    return {
      thirdPartyId: party.id, thirdPartyVehicleId: null, thirdPartyEmployeeId: worker.id, thirdPartyDestination: "FUNCIONARIO" as const, purpose: request.purpose, purposeNote: request.purpose === "OUTROS" ? note : null,
      meterReading: null, meterUnit: null, fullTank: true, readingException: false, consumptionOutlier: false,
      providerCompany: request.mode === "PRESTADOR" ? party.name : null, providerEquipment: request.mode === "PRESTADOR" ? label : null,
      thirdPartyDescription: request.mode === "GERAL" ? [party.name, label].join(" · ") : null,
    };
  }
  let vehicle: typeof thirdPartyVehicles.$inferSelect | undefined;
  if (request.vehicleId) {
    vehicle = (await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, request.vehicleId)).limit(1))[0];
    if (!vehicle || vehicle.thirdPartyId !== party.id) throw new ThirdPartyError("O veículo escolhido não pertence a este terceiro.");
    if (!vehicle.active && request.current?.thirdPartyVehicleId !== vehicle.id) throw new ThirdPartyError(`O veículo ${vehicle.plate} está inativo no cadastro.`);
  } else if (party.kind !== "PESSOA_FISICA") throw new ThirdPartyError("Escolha o veículo/máquina do terceiro (ou cadastre com “+ Novo”).");

  let readingException = false;
  let consumptionOutlier = false;
  if (vehicle) {
    if (request.reading === null || !Number.isFinite(request.reading) || request.reading < 0) throw new ThirdPartyError(`Informe a leitura atual ${METER_PHRASES[vehicle.meterType]}.`);
    if (!(request.quantity > 0)) throw new ThirdPartyError("Informe a quantidade em litros (maior que zero).");
    const all = (await vehicleFuelings(db, [vehicle.id])).get(vehicle.id) ?? [];
    const others = all.filter((row) => row.id !== request.editingId);
    // Referência: na inclusão, a última leitura do veículo; na edição, o abastecimento anterior a este.
    const reference = request.editingId
      ? [...others].filter((row) => row.reading !== null && (row.date < request.movementDate || (row.date === request.movementDate && row.id < request.editingId!))).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).pop()?.reading ?? null
      : request.referenceByDate
        ? [...others].filter((row) => row.reading !== null && row.date <= request.movementDate).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).pop()?.reading ?? (others.some((row) => row.reading !== null) ? null : vehicle.lastReading)
        : vehicle.lastReading;
    if (reference !== null && request.reading <= reference) {
      if (!canManageThirdParties(user)) throw new ThirdPartyError(`A leitura informada (${fmt(request.reading)}) não é maior que a última do veículo ${vehicle.plate} (${fmt(reference)}). Só ADMIN/GESTOR podem aceitar, com justificativa.`, 400, { exception: false });
      if (!request.readingException) throw new ThirdPartyError(`A leitura informada (${fmt(request.reading)}) não é maior que a última do veículo ${vehicle.plate} (${fmt(reference)}). Marque a exceção e justifique em Observações.`, 400, { exception: true });
      if (!request.notes?.trim()) throw new ThirdPartyError("Para aceitar leitura menor que a última, escreva a justificativa em Observações.", 400, { exception: true });
      readingException = true;
    }
    if (vehicle.tankCapacityLiters && request.quantity > vehicle.tankCapacityLiters && !request.confirmTank)
      throw new ThirdPartyError(`${fmt(request.quantity)} L passa da capacidade do tanque do ${vehicle.plate} (${fmt(vehicle.tankCapacityLiters)} L). Confirme se está certo.`, 409, { confirm: "TANK" });
    const id = request.editingId ?? -1;
    const withThis = [...others, { id, date: request.movementDate, liters: request.quantity, reading: request.reading, fullTank: request.fullTank, readingException, serviceFrontId: 0, outlier: false }];
    const current = computeConsumption(vehicle.meterType, withThis).get(id) ?? null;
    const history = computeConsumption(vehicle.meterType, others);
    const average = averageConsumption(vehicle.meterType, [...history.values()]).value ?? vehicle.expectedConsumption ?? null;
    if (current && isOutlier(current.value, average)) {
      consumptionOutlier = true;
      const unit = CONSUMPTION_UNITS[vehicle.meterType];
      if (!request.confirmOutlier) throw new ThirdPartyError(`Consumo deste abastecimento: ${fmt(current.value)} ${unit}, mais de 25% diferente da média do ${vehicle.plate} (${fmt(average!)} ${unit}). Confirme para lançar marcado como “fora da média”.`, 409, { confirm: "OUTLIER" });
    }
  }
  const vehicleLabel = vehicle ? [vehicle.plate, vehicle.description].filter(Boolean).join(" — ") : null;
  return {
    thirdPartyId: party.id, thirdPartyVehicleId: vehicle?.id ?? null, thirdPartyEmployeeId: null, thirdPartyDestination: vehicle ? "VEICULO" as const : null, purpose: null, purposeNote: null,
    meterReading: vehicle ? request.reading : null, meterUnit: vehicle ? (vehicle.meterType === "KM" ? "KM" as const : "HOURS" as const) : null,
    fullTank: request.fullTank, readingException, consumptionOutlier,
    // Textos livres antigos preenchidos a partir do cadastro (histórico e exportações continuam iguais).
    providerCompany: request.mode === "PRESTADOR" ? party.name : null,
    providerEquipment: request.mode === "PRESTADOR" ? vehicleLabel : null,
    thirdPartyDescription: request.mode === "GERAL" ? [party.name, vehicleLabel].filter(Boolean).join(" · ") : null,
  };
}

// ---------------------------------------------------------------------------
// Relatório "Consumo de Terceiros"
// ---------------------------------------------------------------------------
export type ConsumptionFilters = { from: string; to: string; thirdPartyId: number | null; vehicleId: number | null };

export async function thirdPartyConsumptionReport(db: Db, scopeFronts: number[], filters: ConsumptionFilters) {
  if (scopeFronts.length === 0) return { vehicles: [], companies: [] };
  const vehicles = await db.select({
    id: thirdPartyVehicles.id, plate: thirdPartyVehicles.plate, description: thirdPartyVehicles.description, meterType: thirdPartyVehicles.meterType,
    lastReading: thirdPartyVehicles.lastReading, thirdPartyId: thirdParties.id, company: thirdParties.name, kind: thirdParties.kind,
  }).from(thirdPartyVehicles).innerJoin(thirdParties, eq(thirdPartyVehicles.thirdPartyId, thirdParties.id))
    .where(and(filters.thirdPartyId ? eq(thirdParties.id, filters.thirdPartyId) : undefined, filters.vehicleId ? eq(thirdPartyVehicles.id, filters.vehicleId) : undefined))
    .orderBy(asc(thirdParties.name), asc(thirdPartyVehicles.plate));
  const fuelings = await vehicleFuelings(db, vehicles.map((vehicle) => vehicle.id));
  const rows = vehicles.map((vehicle) => {
    const all = fuelings.get(vehicle.id) ?? [];
    const consumption = computeConsumption(vehicle.meterType, all);
    const inScope = all.filter((row) => scopeFronts.includes(row.serviceFrontId) && row.date >= filters.from && row.date <= filters.to);
    const entries: Array<FuelingConsumption | null | undefined> = inScope.map((row) => consumption.get(row.id));
    const average = averageConsumption(vehicle.meterType as MeterType, entries);
    return {
      ...vehicle, unit: CONSUMPTION_UNITS[vehicle.meterType], fuelings: inScope.length, liters: inScope.reduce((sum, row) => sum + row.liters, 0),
      distance: average.distance, average: average.value, outliers: inScope.filter((row) => row.outlier).length,
    };
  }).filter((row) => row.fuelings > 0);
  const companies = new Map<number, { thirdPartyId: number; company: string; vehicles: number; fuelings: number; liters: number; outliers: number }>();
  for (const row of rows) {
    const company = companies.get(row.thirdPartyId) ?? { thirdPartyId: row.thirdPartyId, company: row.company, vehicles: 0, fuelings: 0, liters: 0, outliers: 0 };
    company.vehicles += 1; company.fuelings += row.fuelings; company.liters += row.liters; company.outliers += row.outliers;
    companies.set(row.thirdPartyId, company);
  }
  return { vehicles: rows, companies: [...companies.values()] };
}

// Opções para os selects (só ativos, com os veículos ativos) — Combustível e Movimentação.
export async function thirdPartyOptions(db: Db) {
  const parties = await db.select({ id: thirdParties.id, name: thirdParties.name, kind: thirdParties.kind, document: thirdParties.document })
    .from(thirdParties).where(eq(thirdParties.active, true)).orderBy(asc(thirdParties.name));
  const vehicles = parties.length ? await db.select({
    id: thirdPartyVehicles.id, thirdPartyId: thirdPartyVehicles.thirdPartyId, plate: thirdPartyVehicles.plate, description: thirdPartyVehicles.description,
    meterType: thirdPartyVehicles.meterType, lastReading: thirdPartyVehicles.lastReading, tankCapacityLiters: thirdPartyVehicles.tankCapacityLiters,
  }).from(thirdPartyVehicles).where(and(eq(thirdPartyVehicles.active, true), inArray(thirdPartyVehicles.thirdPartyId, parties.map((party) => party.id)))).orderBy(asc(thirdPartyVehicles.plate)) : [];
  const workers = parties.length ? await db.select({ id: thirdPartyEmployees.id, thirdPartyId: thirdPartyEmployees.thirdPartyId, name: thirdPartyEmployees.name, jobTitle: thirdPartyEmployees.jobTitle })
    .from(thirdPartyEmployees).where(and(eq(thirdPartyEmployees.active, true), inArray(thirdPartyEmployees.thirdPartyId, parties.map((party) => party.id)))).orderBy(asc(thirdPartyEmployees.name)) : [];
  return parties.map((party) => ({ ...party, vehicles: vehicles.filter((vehicle) => vehicle.thirdPartyId === party.id), employees: workers.filter((worker) => worker.thirdPartyId === party.id) }));
}


// ---------------------------------------------------------------------------
// Relatório por empresa (Terceiros → "Resumo por empresa"): no período e nas frentes do escopo,
// combustível em veículos × para funcionários (litros e valor pelo custo médio do estoque) e peças
// em veículos × para funcionários (valor da saída), com o total em R$.
// ---------------------------------------------------------------------------
export async function thirdPartySummary(db: Db, scopeFronts: number[], filters: { from: string; to: string; thirdPartyId?: number | null }) {
  type Linha = { thirdPartyId: number; company: string; fuelVehicleLiters: number; fuelVehicleValue: number; fuelEmployeeLiters: number; fuelEmployeeValue: number; fuelOtherLiters: number; fuelOtherValue: number;
    partsVehicleValue: number; partsEmployeeValue: number; partsOtherValue: number; partsQuantity: number; totalValue: number };
  if (scopeFronts.length === 0) return { companies: [] as Linha[] };
  const [fuel, parts, costs] = await Promise.all([
    db.select({ id: fuelMovements.id, thirdPartyId: fuelMovements.thirdPartyId, company: thirdParties.name, destination: fuelMovements.thirdPartyDestination, vehicleId: fuelMovements.thirdPartyVehicleId, liters: fuelMovements.quantity })
      .from(fuelMovements).innerJoin(thirdParties, eq(thirdParties.id, fuelMovements.thirdPartyId))
      .where(and(isNull(fuelMovements.deletedAt), eq(fuelMovements.movementType, "SAIDA"), eq(fuelMovements.balanceAdjustment, false), inArray(fuelMovements.serviceFrontId, scopeFronts),
        sql`${fuelMovements.movementDate} >= ${filters.from}`, sql`${fuelMovements.movementDate} <= ${filters.to}`, filters.thirdPartyId ? eq(fuelMovements.thirdPartyId, filters.thirdPartyId) : undefined)),
    db.execute(sql`SELECT se.third_party_id, tp.name AS company,
        CASE WHEN se.third_party_employee_id IS NOT NULL THEN 'FUNCIONARIO' WHEN se.third_party_vehicle_id IS NOT NULL THEN 'VEICULO' ELSE 'OUTRO' END AS destino,
        sum(i.quantity)::float AS quantidade, sum(i.quantity * coalesce(i.unit_price, 0))::float AS valor
      FROM stock_exits se JOIN stock_exit_items i ON i.exit_id = se.id JOIN third_parties tp ON tp.id = se.third_party_id
      WHERE se.cancelled_at IS NULL AND se.service_front_id IN (${sql.join(scopeFronts.map((id) => sql`${id}`), sql`, `)})
        AND se.exit_date >= ${filters.from} AND se.exit_date <= ${filters.to} ${filters.thirdPartyId ? sql`AND se.third_party_id = ${filters.thirdPartyId}` : sql``}
      GROUP BY 1, 2, 3`),
    (async () => {
      const rows = await db.select({
        id: fuelMovements.id, serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
        destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType,
        movementDate: fuelMovements.movementDate, quantity: fuelMovements.quantity, unitPrice: fuelMovements.unitPrice,
      }).from(fuelMovements).where(isNull(fuelMovements.deletedAt));
      return computeFuelCosts(rows);
    })(),
  ]);
  const mapa = new Map<number, Linha>();
  const linha = (id: number, company: string) => {
    let item = mapa.get(id);
    if (!item) { item = { thirdPartyId: id, company, fuelVehicleLiters: 0, fuelVehicleValue: 0, fuelEmployeeLiters: 0, fuelEmployeeValue: 0, fuelOtherLiters: 0, fuelOtherValue: 0, partsVehicleValue: 0, partsEmployeeValue: 0, partsOtherValue: 0, partsQuantity: 0, totalValue: 0 }; mapa.set(id, item); }
    return item;
  };
  for (const row of fuel) {
    const item = linha(row.thirdPartyId!, row.company);
    const value = costs.get(row.id)?.cost ?? 0;
    if (row.destination === "FUNCIONARIO") { item.fuelEmployeeLiters += row.liters; item.fuelEmployeeValue += value; }
    else if (row.destination === "VEICULO" || row.vehicleId) { item.fuelVehicleLiters += row.liters; item.fuelVehicleValue += value; }
    else { item.fuelOtherLiters += row.liters; item.fuelOtherValue += value; }
  }
  for (const row of (parts as unknown as { rows: Array<{ third_party_id: number; company: string; destino: string; quantidade: number; valor: number }> }).rows) {
    const item = linha(Number(row.third_party_id), row.company);
    item.partsQuantity += Number(row.quantidade);
    if (row.destino === "FUNCIONARIO") item.partsEmployeeValue += Number(row.valor);
    else if (row.destino === "VEICULO") item.partsVehicleValue += Number(row.valor);
    else item.partsOtherValue += Number(row.valor);
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  const companies = [...mapa.values()].map((item) => {
    const total = item.fuelVehicleValue + item.fuelEmployeeValue + item.fuelOtherValue + item.partsVehicleValue + item.partsEmployeeValue + item.partsOtherValue;
    return Object.fromEntries(Object.entries({ ...item, totalValue: total }).map(([key, value]) => [key, typeof value === "number" && key !== "thirdPartyId" ? round(value) : value])) as Linha;
  }).sort((a, b) => b.totalValue - a.totalValue);
  return { companies };
}
