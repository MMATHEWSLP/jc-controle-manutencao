import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getD1, type getDb } from "../db";
import { auditLogs, equipment, fuelImportBatches, fuelMovements, fuelTypes, meterReadings, serviceFronts, thirdParties, thirdPartyVehicles, users } from "../db/schema";
import type { SessionUser } from "./auth";
import { createFuelMovement, FuelCreateError } from "./fuel-create";
import { fuelBalances, fuelLocalDay, fuelVisibleFronts } from "./fuel";
import {
  average, duplicateKey, estimatedConsumption, FUEL_IMPORT_TYPE_LABELS, importKey, originLocation, parseFullTank, parseImportDate, parseImportNumber, parseImportType,
  patternWarnings, type FuelImportRaw, type FuelImportType, type FuelImportValues,
} from "./fuel-import-rules";
import { recalculateMaintenanceCycles } from "./maintenance-recalculation";
import { ReadingOperationError, saveReading } from "./readings";
import { refreshVehicleLastReading, ThirdPartyError } from "./third-parties";

// ---------------------------------------------------------------------------
// Importação de abastecimentos por planilha (Combustível → Importar planilha).
//  - analyze: prévia sem gravar (status OK / AVISO / ERRO por linha, leitura anterior, diferença,
//    consumo estimado). A confirmação analisa de novo no servidor: nunca confia no status da tela.
//  - confirm: grava as linhas OK/AVISO escolhidas, na ordem da planilha, com a MESMA função do
//    formulário (lib/fuel-create.ts). Leitura maior que a atual do equipamento da frota também
//    atualiza o equipamento (saveReading: ciclos e alertas), ligada ao lote.
//  - revert (ADMIN): desfaz o lote se não houver lançamento/leitura posterior nos mesmos equipamentos.
// Só ADMIN e GESTOR importam.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Unit = "KM" | "HOURS";

export const canImportFuel = (user: SessionUser) => user.profile === "ADMIN" || user.profile === "GESTOR";

export class FuelImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type FuelImportStatus = "OK" | "AVISO" | "ERRO";
export type FuelImportPreviewRow = {
  rowNumber: number; values: FuelImportValues; status: FuelImportStatus; messages: string[];
  date: string | null; type: FuelImportType | null; typeLabel: string | null; frontId: number | null; frontName: string | null; location: "FRENTE" | "PORTO";
  fuelTypeId: number | null; fuelName: string | null;
  target: { kind: "FROTA" | "TERCEIRO"; equipmentId: number | null; vehicleId: number | null; thirdPartyId: number | null; code: string; plate: string | null; model: string; unit: Unit | null } | null;
  liters: number | null; reading: number | null; fullTank: boolean; previousReading: number | null; difference: number | null;
  consumption: { value: number; unit: string } | null;
};

type EquipmentRow = { id: number; prefix: string; plate: string | null; brand: string; model: string; controlType: string; currentKm: number; currentHours: number; serviceFrontId: number | null; frontName: string | null };
type VehicleRow = { id: number; thirdPartyId: number; plate: string; plateKey: string; description: string | null; meterType: "KM" | "HORIMETRO"; tankCapacityLiters: number | null; lastReading: number | null };
type History = { date: string; id: number; reading: number | null; liters: number };

const fmt = (value: number, digits = 2) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
const unitOf = (controlType: string): Unit => (controlType === "KM" ? "KM" : "HOURS");
const unitLabel = (unit: Unit) => (unit === "KM" ? "km" : "h");

async function loadContext(db: Db, user: SessionUser) {
  const [fronts, visible, types, fleet, parties, vehicles] = await Promise.all([
    db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)),
    fuelVisibleFronts(db, user),
    db.select({ id: fuelTypes.id, code: fuelTypes.code, name: fuelTypes.name }).from(fuelTypes).where(eq(fuelTypes.active, true)),
    db.select({
      id: equipment.id, prefix: equipment.prefix, plate: equipment.plate, brand: equipment.brand, model: equipment.model, controlType: equipment.controlType,
      currentKm: equipment.currentKm, currentHours: equipment.currentHours, serviceFrontId: equipment.serviceFrontId, frontName: serviceFronts.name,
    }).from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId)).where(isNull(equipment.soldAt)),
    db.select({ id: thirdParties.id, name: thirdParties.name, kind: thirdParties.kind }).from(thirdParties).where(eq(thirdParties.active, true)),
    db.select({
      id: thirdPartyVehicles.id, thirdPartyId: thirdPartyVehicles.thirdPartyId, plate: thirdPartyVehicles.plate, plateKey: thirdPartyVehicles.plateKey, description: thirdPartyVehicles.description,
      meterType: thirdPartyVehicles.meterType, tankCapacityLiters: thirdPartyVehicles.tankCapacityLiters, lastReading: thirdPartyVehicles.lastReading,
    }).from(thirdPartyVehicles).where(eq(thirdPartyVehicles.active, true)),
  ]);
  const byKey = <T,>(items: T[], key: (item: T) => string[]) => {
    const map = new Map<string, T[]>();
    for (const item of items) for (const value of key(item)) { const k = importKey(value); if (!k) continue; const list = map.get(k) ?? []; if (!list.includes(item)) list.push(item); map.set(k, list); }
    return map;
  };
  return {
    frontsByKey: byKey(fronts, (front) => [front.name]), visibleIds: new Set(visible.map((front) => front.id)),
    typesByKey: byKey(types, (type) => [type.name, type.code]),
    fleetByKey: byKey(fleet as EquipmentRow[], (item) => [item.prefix, item.plate ?? ""]),
    partiesByKey: byKey(parties, (party) => [party.name]),
    vehicles: vehicles as VehicleRow[],
  };
}

// Histórico por equipamento/veículo: abastecimentos (litros e leitura) e leituras de horímetro/KM.
async function loadHistory(db: Db, equipmentIds: number[], vehicleIds: number[]) {
  const fleet = new Map<number, History[]>(), third = new Map<number, History[]>(), meters = new Map<number, Array<{ date: string; hours: number | null; km: number | null }>>();
  const dupes = new Set<string>();
  if (equipmentIds.length) {
    const [fuelings, readings] = await Promise.all([
      db.select({ id: fuelMovements.id, targetId: fuelMovements.equipmentId, date: fuelMovements.movementDate, reading: fuelMovements.meterReading, liters: fuelMovements.quantity })
        .from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), eq(fuelMovements.balanceAdjustment, false), inArray(fuelMovements.equipmentId, equipmentIds))),
      db.select({ equipmentId: meterReadings.equipmentId, date: meterReadings.readingDate, hours: meterReadings.hours, km: meterReadings.km })
        .from(meterReadings).where(inArray(meterReadings.equipmentId, equipmentIds)),
    ]);
    for (const row of fuelings) {
      const list = fleet.get(row.targetId!) ?? []; list.push({ date: row.date, id: row.id, reading: row.reading, liters: row.liters }); fleet.set(row.targetId!, list);
      dupes.add(duplicateKey(`E${row.targetId}`, row.date, row.liters, row.reading));
    }
    for (const row of readings) { const list = meters.get(row.equipmentId) ?? []; list.push({ date: row.date.slice(0, 10), hours: row.hours, km: row.km }); meters.set(row.equipmentId, list); }
  }
  if (vehicleIds.length) {
    const fuelings = await db.select({ id: fuelMovements.id, targetId: fuelMovements.thirdPartyVehicleId, date: fuelMovements.movementDate, reading: fuelMovements.meterReading, liters: fuelMovements.quantity })
      .from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), inArray(fuelMovements.thirdPartyVehicleId, vehicleIds)));
    for (const row of fuelings) {
      const list = third.get(row.targetId!) ?? []; list.push({ date: row.date, id: row.id, reading: row.reading, liters: row.liters }); third.set(row.targetId!, list);
      dupes.add(duplicateKey(`V${row.targetId}`, row.date, row.liters, row.reading));
    }
  }
  for (const list of [...fleet.values(), ...third.values()]) list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  return { fleet, third, meters, dupes };
}

// Média do intervalo entre leituras consecutivas e dos litros (últimos 10 abastecimentos).
function patternOf(history: History[]) {
  const recent = history.slice(-11);
  const readings = recent.filter((item) => item.reading !== null).map((item) => item.reading!);
  const intervals = readings.slice(1).map((value, index) => value - readings[index]).filter((value) => value > 0);
  return { averageInterval: average(intervals.slice(-10)), averageLiters: average(recent.slice(-10).map((item) => item.liters)) };
}

export async function analyzeFuelImport(db: Db, user: SessionUser, raws: FuelImportRaw[]): Promise<FuelImportPreviewRow[]> {
  const context = await loadContext(db, user);
  const today = fuelLocalDay();
  // 1ª passada: resolve cada linha (sem histórico) para saber quais equipamentos/veículos carregar.
  const firstPass = raws.map((raw) => {
    const v = raw.values;
    const messages: string[] = [];
    const errors: string[] = [];
    const date = parseImportDate(v.data);
    if (!v.data) errors.push("Data vazia."); else if (!date) errors.push(`Data inválida ("${v.data}"). Use DD/MM/AAAA.`); else if (date > today) errors.push("Data futura.");
    const type = parseImportType(v.tipo);
    if (!type) errors.push(v.tipo ? `Tipo inválido ("${v.tipo}"). Use SAIDA_FROTA, SAIDA_TERCEIRO ou SAIDA_PRESTADOR.` : "Tipo vazio.");
    const frontMatches = context.frontsByKey.get(importKey(v.frente)) ?? [];
    const front = frontMatches[0] ?? null;
    if (!v.frente) errors.push("Frente vazia."); else if (!front) errors.push(`Frente "${v.frente}" não encontrada.`); else if (!context.visibleIds.has(front.id)) errors.push(`Você não tem permissão para lançar na frente ${front.name}.`);
    if (!v.origem) messages.push("Origem vazia: considerado o estoque da Frente.");
    const fuel = (context.typesByKey.get(importKey(v.combustivel)) ?? [])[0] ?? null;
    if (!v.combustivel) errors.push("Combustível vazio."); else if (!fuel) errors.push(`Combustível "${v.combustivel}" não encontrado.`);
    const liters = parseImportNumber(v.litros);
    if (liters === null || liters === 0) errors.push("Litros vazio ou zero."); else if (Number.isNaN(liters) || liters < 0) errors.push(`Litros inválido ("${v.litros}").`);
    const reading = parseImportNumber(v.leitura);
    if (reading !== null && (Number.isNaN(reading) || reading < 0)) errors.push(`Leitura inválida ("${v.leitura}").`);
    const fullTank = parseFullTank(v.tanque_cheio);
    if (fullTank === null) errors.push(`tanque_cheio inválido ("${v.tanque_cheio}"). Use SIM ou NAO.`);
    if (!v.motorista) errors.push("Motorista vazio (quem recebeu o combustível).");
    let target: FuelImportPreviewRow["target"] = null;
    let vehicle: VehicleRow | null = null;
    if (type === "SAIDA_FROTA") {
      const matches = context.fleetByKey.get(importKey(v.equipamento)) ?? [];
      if (!v.equipamento) errors.push("Equipamento vazio.");
      else if (matches.length === 0) errors.push(`Equipamento "${v.equipamento}" não encontrado (código ou placa).`);
      else if (matches.length > 1) errors.push(`"${v.equipamento}" corresponde a mais de um equipamento (${matches.map((item) => item.prefix).join(", ")}).`);
      else {
        const item = matches[0];
        target = { kind: "FROTA", equipmentId: item.id, vehicleId: null, thirdPartyId: null, code: item.prefix, plate: item.plate, model: `${item.brand} ${item.model}`.trim(), unit: unitOf(item.controlType) };
        if (front && item.serviceFrontId !== front.id) errors.push(`O equipamento ${item.prefix} está em ${item.frontName ?? "outra frente"}, não em ${front.name}.`);
        if (reading !== null && item.controlType === "HOURS_KM") messages.push("Equipamento com horímetro e KM: a leitura fica só no lançamento (não atualiza o equipamento).");
      }
      if (v.empresa && !["JC", "JCSERVICOSFLORESTAIS"].includes(importKey(v.empresa))) messages.push(`Empresa "${v.empresa}" ignorada: saída da frota própria.`);
    } else if (type) {
      const parties = context.partiesByKey.get(importKey(v.empresa)) ?? [];
      const party = parties[0] ?? null;
      if (!v.empresa) errors.push("Empresa vazia (obrigatória para terceiro/prestador).");
      else if (!party) errors.push(`Empresa "${v.empresa}" não encontrada no cadastro de Terceiros.`);
      else if (type === "SAIDA_PRESTADOR" && party.kind === "PESSOA_FISICA") errors.push(`${party.name} é pessoa física: use SAIDA_TERCEIRO.`);
      if (party) {
        vehicle = v.equipamento ? context.vehicles.find((item) => item.thirdPartyId === party.id && item.plateKey === importKey(v.equipamento)) ?? null : null;
        if (v.equipamento && !vehicle) errors.push(`Veículo "${v.equipamento}" não encontrado entre os veículos de ${party.name}.`);
        else if (!v.equipamento && party.kind !== "PESSOA_FISICA") errors.push(`Informe a placa do veículo de ${party.name}.`);
        target = { kind: "TERCEIRO", equipmentId: null, vehicleId: vehicle?.id ?? null, thirdPartyId: party.id, code: party.name, plate: vehicle?.plate ?? null, model: vehicle?.description ?? "", unit: vehicle ? (vehicle.meterType === "KM" ? "KM" : "HOURS") : null };
        if (vehicle && reading === null) errors.push("Leitura obrigatória para veículo de terceiro.");
        if (vehicle?.tankCapacityLiters && liters && liters > vehicle.tankCapacityLiters) messages.push(`${fmt(liters)} L passa da capacidade do tanque do ${vehicle.plate} (${fmt(vehicle.tankCapacityLiters)} L).`);
      }
    }
    return { raw, date, type, front, fuel, liters: typeof liters === "number" && Number.isFinite(liters) ? liters : null, reading: typeof reading === "number" && Number.isFinite(reading) ? reading : null, fullTank: fullTank ?? true, target, vehicle, errors, messages };
  });

  const equipmentIds = [...new Set(firstPass.flatMap((row) => row.target?.equipmentId ? [row.target.equipmentId] : []))];
  const vehicleIds = [...new Set(firstPass.flatMap((row) => row.target?.vehicleId ? [row.target.vehicleId] : []))];
  const history = await loadHistory(db, equipmentIds, vehicleIds);
  // Saldo corrente por frente/estoque/combustível para avisar quando ficaria negativo.
  const frontIds = [...new Set(firstPass.flatMap((row) => row.front ? [row.front.id] : []))];
  const balances = frontIds.length ? await fuelBalances(db, frontIds, "0000-01-01", "9999-12-31") : null;
  const running = new Map<string, number>();
  // Leituras já aceitas nesta planilha (a linha seguinte do mesmo equipamento compara com elas).
  const sheetReadings = new Map<string, Array<{ date: string; reading: number }>>();
  const sheetKeys = new Map<string, number>();

  return firstPass.map((row): FuelImportPreviewRow => {
    const { raw, target } = row;
    const errors = [...row.errors], messages = [...row.messages];
    let previousReading: number | null = null, difference: number | null = null, consumption: FuelImportPreviewRow["consumption"] = null;
    const targetKey = target?.equipmentId ? `E${target.equipmentId}` : target?.vehicleId ? `V${target.vehicleId}` : null;
    if (targetKey && row.date && row.liters) {
      const list = target!.equipmentId ? history.fleet.get(target!.equipmentId) ?? [] : history.third.get(target!.vehicleId!) ?? [];
      const beforeDate = list.filter((item) => item.date <= row.date! && item.reading !== null);
      const candidates = beforeDate.map((item) => item.reading!);
      if (target!.equipmentId && target!.unit) for (const meter of history.meters.get(target!.equipmentId) ?? []) {
        const value = target!.unit === "KM" ? meter.km : meter.hours;
        // Leitura de horímetro/KM do mesmo dia pode ser posterior ao abastecimento: só dias anteriores.
        if (meter.date < row.date && value !== null) candidates.push(value);
      }
      if (target!.vehicleId && !list.some((item) => item.reading !== null) && row.vehicle?.lastReading != null) candidates.push(row.vehicle.lastReading);
      for (const item of sheetReadings.get(targetKey) ?? []) if (item.date <= row.date) candidates.push(item.reading);
      previousReading = candidates.length ? Math.max(...candidates) : null;
      // Leitura de lançamento posterior (ficha antiga digitada depois): a desta linha não pode passar dela.
      const later: Array<{ date: string; reading: number }> = list.filter((item) => item.date > row.date! && item.reading !== null).map((item) => ({ date: item.date, reading: item.reading! }));
      if (target!.equipmentId && target!.unit) for (const meter of history.meters.get(target!.equipmentId) ?? []) {
        const value = target!.unit === "KM" ? meter.km : meter.hours;
        if (meter.date > row.date && value !== null) later.push({ date: meter.date, reading: value });
      }
      const nextKnown = later.sort((a, b) => a.reading - b.reading)[0] ?? null;
      if (row.reading !== null && nextKnown && row.reading > nextKnown.reading)
        errors.push(`Leitura ${fmt(row.reading)} maior que a de um registro posterior (${nextKnown.date.split("-").reverse().join("/")}: ${fmt(nextKnown.reading)}). Confira o número.`);
      if (row.reading !== null && previousReading !== null) {
        difference = Math.round((row.reading - previousReading) * 100) / 100;
        const label = unitLabel(target!.unit ?? "KM");
        if (target!.kind === "TERCEIRO" && row.reading <= previousReading) errors.push(`Leitura ${fmt(row.reading)} não é maior que a anterior (${fmt(previousReading)} ${label}).`);
        else if (row.reading < previousReading) errors.push(`Leitura ${fmt(row.reading)} menor que a anterior (${fmt(previousReading)} ${label}).`);
        else if (row.reading === previousReading) messages.push("Leitura igual à anterior.");
        const pattern = patternOf(list.filter((item) => item.date <= row.date!));
        messages.push(...patternWarnings({ difference: difference > 0 ? difference : null, averageInterval: pattern.averageInterval, liters: row.liters, averageLiters: pattern.averageLiters, unitLabel: label }));
        if (target!.unit) consumption = estimatedConsumption(target!.unit, difference, row.liters, row.fullTank);
      } else {
        const pattern = patternOf(list);
        messages.push(...patternWarnings({ difference: null, averageInterval: null, liters: row.liters, averageLiters: pattern.averageLiters, unitLabel: "" }));
      }
      const key = duplicateKey(targetKey, row.date, row.liters, row.reading);
      if (history.dupes.has(key)) errors.push("Duplicado: já existe lançamento com o mesmo equipamento, data, litros e leitura.");
      else if (sheetKeys.has(key)) errors.push(`Duplicado: igual à linha ${sheetKeys.get(key)} da planilha.`);
      else sheetKeys.set(key, raw.rowNumber);
    }
    const location = originLocation(raw.values.origem);
    if (errors.length === 0 && row.front && row.fuel && row.liters) {
      const key = `${row.front.id}|${location}|${row.fuel.id}`;
      const start = running.has(key) ? running.get(key)! : balances?.get(row.fuel.id)?.byFront.get(row.front.id)?.byLocation[location].balance ?? 0;
      const after = Math.round((start - row.liters) * 100) / 100;
      running.set(key, after);
      if (after < 0) messages.push(`Saldo de ${row.fuel.name} em ${location === "PORTO" ? "Porto" : "Frente"} ${row.front.name} ficaria negativo (${fmt(after)} L).`);
      if (targetKey && row.reading !== null && row.date) { const list = sheetReadings.get(targetKey) ?? []; list.push({ date: row.date, reading: row.reading }); sheetReadings.set(targetKey, list); }
    }
    const status: FuelImportStatus = errors.length ? "ERRO" : messages.length ? "AVISO" : "OK";
    return {
      rowNumber: raw.rowNumber, values: raw.values, status, messages: [...errors, ...messages],
      date: row.date, type: row.type, typeLabel: row.type ? FUEL_IMPORT_TYPE_LABELS[row.type] : null, frontId: row.front?.id ?? null, frontName: row.front?.name ?? null, location,
      fuelTypeId: row.fuel?.id ?? null, fuelName: row.fuel?.name ?? null, target, liters: row.liters, reading: row.reading, fullTank: row.fullTank,
      previousReading, difference, consumption,
    };
  });
}

export function importSummary(rows: FuelImportPreviewRow[]) {
  const valid = rows.filter((row) => row.status !== "ERRO");
  return {
    total: rows.length, ok: rows.filter((row) => row.status === "OK").length, warnings: rows.filter((row) => row.status === "AVISO").length,
    errors: rows.filter((row) => row.status === "ERRO").length, liters: Math.round(valid.reduce((sum, row) => sum + (row.liters ?? 0), 0) * 100) / 100,
  };
}

type Details = { equipment: Array<{ id: number; hours: number; km: number }> };

export async function confirmFuelImport(db: Db, user: SessionUser, fileName: string, raws: FuelImportRaw[], selected: Set<number>) {
  const preview = await analyzeFuelImport(db, user, raws);
  const chosen = preview.filter((row) => selected.has(row.rowNumber) && row.status !== "ERRO");
  if (!chosen.length) throw new FuelImportError("Nenhuma linha OK/AVISO selecionada para importar.");
  const affected = [...new Map(chosen.map((row) => [`${row.frontId}|${row.location}|${row.fuelTypeId}`, row])).values()];
  const frontIds = [...new Set(chosen.map((row) => row.frontId!))];
  const before = await fuelBalances(db, frontIds, "0000-01-01", "9999-12-31");
  const batch = (await db.insert(fuelImportBatches).values({ userId: user.id, fileName: fileName.slice(0, 180) }).returning({ id: fuelImportBatches.id }))[0];
  const d1 = await getD1();
  const details: Details = { equipment: [] };
  const imported: Array<{ rowNumber: number; movementId: number; message: string }> = [];
  const failed: Array<{ rowNumber: number; error: string }> = [];
  const notes: Array<{ rowNumber: number; note: string }> = [];
  let liters = 0;
  for (const row of chosen) {
    const t = row.target!;
    const third = t.kind === "TERCEIRO";
    const body: Record<string, unknown> = {
      serviceFrontId: row.frontId, fuelTypeId: row.fuelTypeId, movementType: "SAIDA", movementDate: row.date, quantity: row.liters, stockLocation: row.location,
      notes: row.values.observacao || null, responsible: row.values.motorista, responsibleEmployeeId: null,
      thirdParty: third, thirdPartyKind: third ? (row.type === "SAIDA_PRESTADOR" ? "PRESTADOR" : "GERAL") : null,
      ...(third
        ? { thirdPartyId: t.thirdPartyId, thirdPartyVehicleId: t.vehicleId, thirdPartyReading: row.reading, fullTank: row.fullTank, confirmTank: true, confirmOutlier: true, readingException: false }
        : { equipmentId: t.equipmentId, meterReading: row.reading }),
    };
    try {
      const result = await createFuelMovement(db, user, body, { displayedFronts: "ALL", importBatchId: batch.id, referenceByDate: true });
      imported.push({ rowNumber: row.rowNumber, movementId: result.id, message: result.message });
      liters += row.liters ?? 0;
      // Frota: leitura maior que a atual atualiza o equipamento (ciclos e alertas), ligada ao lote.
      if (!third && t.equipmentId && row.reading !== null && t.unit) {
        const current = (await db.select({ hours: equipment.currentHours, km: equipment.currentKm, controlType: equipment.controlType, frontId: equipment.serviceFrontId }).from(equipment).where(eq(equipment.id, t.equipmentId)).limit(1))[0];
        const currentValue = current ? (t.unit === "KM" ? current.km : current.hours) : null;
        if (current && current.controlType !== "HOURS_KM" && currentValue !== null && row.reading > currentValue) {
          if (!details.equipment.some((item) => item.id === t.equipmentId)) details.equipment.push({ id: t.equipmentId, hours: current.hours, km: current.km });
          try {
            await saveReading(d1, {
              equipmentId: t.equipmentId, readingDate: `${row.date}T12:00`, hours: t.unit === "HOURS" ? row.reading : null, km: t.unit === "KM" ? row.reading : null,
              operator: row.values.motorista, notes: `Abastecimento importado (lote ${batch.id}, linha ${row.rowNumber})`, serviceFrontId: current.frontId, actor: { id: user.id, name: user.name, profile: user.profile },
              source: "EXCEL_IMPORT", fuelImportBatchId: batch.id,
            });
          } catch (error) {
            notes.push({ rowNumber: row.rowNumber, note: error instanceof ReadingOperationError ? `Lançado, mas a leitura do equipamento não foi atualizada: ${error.message}` : "Lançado, mas a leitura do equipamento não foi atualizada." });
          }
        }
      }
    } catch (error) {
      const message = error instanceof FuelCreateError || error instanceof ThirdPartyError ? error.message : "Erro inesperado ao gravar esta linha.";
      if (!(error instanceof FuelCreateError || error instanceof ThirdPartyError)) console.error("[fuel.import.row]", error);
      failed.push({ rowNumber: row.rowNumber, error: message });
    }
  }
  if (!imported.length) {
    await db.delete(fuelImportBatches).where(eq(fuelImportBatches.id, batch.id));
  } else {
    await db.update(fuelImportBatches).set({ rowCount: imported.length, liters: Math.round(liters * 100) / 100, details: JSON.stringify(details), updatedAt: new Date().toISOString() }).where(eq(fuelImportBatches.id, batch.id));
    await db.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_IMPORT_BATCH", entityId: String(batch.id), action: "IMPORTAÇÃO DE ABASTECIMENTOS", newValue: JSON.stringify({ fileName, imported: imported.length, failed: failed.length, liters }) });
  }
  const after = await fuelBalances(db, frontIds, "0000-01-01", "9999-12-31");
  const frontNames = new Map(chosen.map((row) => [row.frontId, row.frontName]));
  return {
    batchId: imported.length ? batch.id : null, imported: imported.length, failed, notes, liters: Math.round(liters * 100) / 100,
    previewErrors: preview.filter((row) => row.status === "ERRO").length, notSelected: preview.filter((row) => row.status !== "ERRO" && !selected.has(row.rowNumber)).length,
    balances: affected.map((row) => ({
      front: frontNames.get(row.frontId) ?? "", location: row.location, fuel: row.fuelName ?? "",
      before: before.get(row.fuelTypeId!)?.byFront.get(row.frontId!)?.byLocation[row.location].balance ?? 0,
      after: after.get(row.fuelTypeId!)?.byFront.get(row.frontId!)?.byLocation[row.location].balance ?? 0,
    })),
  };
}

export async function listFuelImportBatches(db: Db) {
  const rows = await db.select({
    id: fuelImportBatches.id, fileName: fuelImportBatches.fileName, rowCount: fuelImportBatches.rowCount, liters: fuelImportBatches.liters, status: fuelImportBatches.status,
    createdAt: fuelImportBatches.createdAt, revertedAt: fuelImportBatches.revertedAt, userName: users.name,
  }).from(fuelImportBatches).leftJoin(users, eq(users.id, fuelImportBatches.userId)).orderBy(desc(fuelImportBatches.id)).limit(30);
  return rows;
}

// Desfaz um lote: lançamentos saem do saldo (exclusão lógica), as leituras que o lote gravou são
// apagadas e cada equipamento volta à leitura de antes; ciclos e alertas são recalculados.
export async function revertFuelImport(db: Db, user: SessionUser, batchId: number) {
  if (user.profile !== "ADMIN") throw new FuelImportError("Somente administrador pode desfazer uma importação.", 403);
  const batch = (await db.select().from(fuelImportBatches).where(eq(fuelImportBatches.id, batchId)).limit(1))[0];
  if (!batch) throw new FuelImportError("Importação não encontrada.", 404);
  if (batch.status !== "ACTIVE") throw new FuelImportError("Esta importação já foi desfeita.", 409);
  const movements = await db.select({ id: fuelMovements.id, equipmentId: fuelMovements.equipmentId, vehicleId: fuelMovements.thirdPartyVehicleId })
    .from(fuelMovements).where(and(eq(fuelMovements.importBatchId, batchId), isNull(fuelMovements.deletedAt)));
  const equipmentIds = [...new Set(movements.flatMap((row) => row.equipmentId ? [row.equipmentId] : []))];
  const vehicleIds = [...new Set(movements.flatMap((row) => row.vehicleId ? [row.vehicleId] : []))];
  const notThisBatch = sql`${fuelMovements.importBatchId} IS DISTINCT FROM ${batchId}`;
  const laterFuel = equipmentIds.length || vehicleIds.length ? await db.select({ id: fuelMovements.id, prefix: equipment.prefix, plate: thirdPartyVehicles.plate }).from(fuelMovements)
    .leftJoin(equipment, eq(equipment.id, fuelMovements.equipmentId)).leftJoin(thirdPartyVehicles, eq(thirdPartyVehicles.id, fuelMovements.thirdPartyVehicleId))
    .where(and(isNull(fuelMovements.deletedAt), notThisBatch, sql`${fuelMovements.createdAt} > ${batch.createdAt}`,
      sql`(${equipmentIds.length ? sql`${fuelMovements.equipmentId} IN (${sql.join(equipmentIds.map((id) => sql`${id}`), sql`, `)})` : sql`FALSE`} OR ${vehicleIds.length ? sql`${fuelMovements.thirdPartyVehicleId} IN (${sql.join(vehicleIds.map((id) => sql`${id}`), sql`, `)})` : sql`FALSE`})`)).limit(10) : [];
  const details = (batch.details ? JSON.parse(batch.details) : { equipment: [] }) as Details;
  const touched = details.equipment.map((item) => item.id);
  const laterReadings = touched.length ? await db.select({ id: meterReadings.id, prefix: equipment.prefix }).from(meterReadings).innerJoin(equipment, eq(equipment.id, meterReadings.equipmentId))
    .where(and(inArray(meterReadings.equipmentId, touched), sql`${meterReadings.fuelImportBatchId} IS DISTINCT FROM ${batchId}`, sql`${meterReadings.createdAt} > ${batch.createdAt}`)).limit(10) : [];
  if (laterFuel.length || laterReadings.length) {
    const names = [...new Set([...laterFuel.map((row) => row.prefix ?? row.plate ?? `#${row.id}`), ...laterReadings.map((row) => row.prefix)])];
    throw new FuelImportError(`Não é possível desfazer: já há lançamentos ou leituras posteriores nos mesmos equipamentos (${names.join(", ")}).`, 409);
  }
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(fuelMovements).set({ deletedAt: now, updatedAt: now }).where(and(eq(fuelMovements.importBatchId, batchId), isNull(fuelMovements.deletedAt)));
    await tx.delete(meterReadings).where(eq(meterReadings.fuelImportBatchId, batchId));
    for (const item of details.equipment) await tx.update(equipment).set({ currentHours: item.hours, currentKm: item.km, updatedAt: now }).where(eq(equipment.id, item.id));
    await tx.update(fuelImportBatches).set({ status: "REVERTED", revertedAt: now, revertedBy: user.id, updatedAt: now }).where(eq(fuelImportBatches.id, batchId));
    await tx.insert(auditLogs).values({ userId: user.id, entityType: "FUEL_IMPORT_BATCH", entityId: String(batchId), action: "IMPORTAÇÃO DE ABASTECIMENTOS DESFEITA", previousValue: JSON.stringify({ movements: movements.length, equipment: details.equipment }) });
  });
  const d1 = await getD1();
  for (const item of details.equipment) await recalculateMaintenanceCycles(d1, { equipmentId: item.id, force: true });
  for (const id of vehicleIds) await refreshVehicleLastReading(db, id);
  return { movements: movements.length, equipment: details.equipment.length };
}
