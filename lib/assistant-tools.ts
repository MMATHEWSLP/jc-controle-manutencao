import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { getD1, type getDb } from "../db";
import { equipment, fuelMovements, fuelTypes, serviceFronts, thirdParties, thirdPartyVehicles } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { Permission, SessionUser } from "./auth";
import { fleetCostReport } from "./fleet-costs";
import { fuelHistory, fuelHistorySummary, fuelLocalDay, fuelVisibleFronts, monthStart, type FuelFilters } from "./fuel";
import { importKey, parseImportDate } from "./fuel-import-rules";
import { computeFuelBalances } from "./fuel-rules";
import { allowedEquipmentIds } from "./front-scope";
import { loadHistoryEntries } from "./history-data";
import { recalculateMaintenanceIfStale } from "./maintenance-recalculation";
import { thirdPartyConsumptionReport } from "./third-parties";
import { loadWhatsappAlerts } from "./whatsapp";

// ---------------------------------------------------------------------------
// Assistente JC — ferramentas de CONSULTA. Nenhuma grava nada e nenhuma aceita SQL: cada uma chama
// as mesmas funções das telas (Combustível, Custos e Consumo, Central de alertas, Histórico),
// sempre com o usuário logado e as frentes que ele enxerga. Números e datas já saem no formato
// brasileiro (1.234,5 · DD/MM/AAAA) para o modelo repetir sem converter.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
export type AssistantToolContext = { db: Db; user: SessionUser; displayed: number[] | "ALL" };
type Input = Record<string, unknown>;

export class AssistantToolError extends Error {}

export const brNumber = (value: number | null | undefined, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? null : value.toLocaleString("pt-BR", { maximumFractionDigits: digits }));
export const brDate = (value: string | null | undefined) => {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value ?? null;
};
const text = (input: Input, key: string) => (typeof input[key] === "string" ? String(input[key]).trim().slice(0, 120) : typeof input[key] === "number" ? String(input[key]) : "");
const needs = (user: SessionUser, permissions: Permission[], what: string) => {
  if (!permissions.some((permission) => user.permissions.includes(permission))) throw new AssistantToolError(`Seu usuário não tem acesso a ${what}.`);
};

// Período: datas DD/MM/AAAA ou AAAA-MM-DD; padrão = mês corrente até hoje.
function period(input: Input) {
  const today = fuelLocalDay();
  const rawFrom = text(input, "data_inicio"), rawTo = text(input, "data_fim");
  const from = rawFrom ? parseImportDate(rawFrom) : monthStart(today);
  const to = rawTo ? parseImportDate(rawTo) : today;
  if (!from) throw new AssistantToolError(`Data inicial inválida: "${rawFrom}". Use DD/MM/AAAA.`);
  if (!to) throw new AssistantToolError(`Data final inválida: "${rawTo}". Use DD/MM/AAAA.`);
  return from <= to ? { from, to } : { from: to, to: from };
}

// Frentes consideradas: a frente pedida (se o usuário a enxerga) ou as frentes em exibição no seletor.
async function frontScope(ctx: AssistantToolContext, input: Input) {
  const visible = await fuelVisibleFronts(ctx.db, ctx.user);
  if (visible.length === 0) throw new AssistantToolError("Seu usuário não está vinculado a nenhuma frente de serviço.");
  const asked = text(input, "frente");
  if (asked) {
    const key = importKey(asked);
    const found = visible.filter((front) => importKey(front.name) === key);
    const partial = found.length ? found : visible.filter((front) => importKey(front.name).includes(key) || key.includes(importKey(front.name)));
    if (partial.length === 0) throw new AssistantToolError(`Frente "${asked}" não encontrada entre as frentes do seu usuário (${visible.map((front) => front.name).join(", ")}).`);
    return partial;
  }
  const displayed = ctx.displayed === "ALL" ? visible : visible.filter((front) => (ctx.displayed as number[]).includes(front.id));
  return displayed.length ? displayed : visible;
}

async function fuelTypeByName(db: Db, name: string) {
  if (!name) return null;
  const key = importKey(name);
  const types = await db.select({ id: fuelTypes.id, name: fuelTypes.name, code: fuelTypes.code }).from(fuelTypes).where(eq(fuelTypes.active, true));
  const found = types.find((type) => importKey(type.name) === key || importKey(type.code) === key) ?? types.find((type) => importKey(type.name).includes(key) || key.includes(importKey(type.name)));
  if (!found) throw new AssistantToolError(`Combustível "${name}" não encontrado (${types.map((type) => type.name).join(", ")}).`);
  return found;
}

// ---------------------------------------------------------------------------
// Busca de equipamento da frota (código, placa ou modelo) e de veículo de terceiro (placa).
// ---------------------------------------------------------------------------
type FleetMatch = { id: number; prefix: string; plate: string | null; type: string; brand: string; model: string; controlType: string; currentHours: number; currentKm: number; status: string; serviceFrontId: number | null; frontName: string | null };
type VehicleMatch = { id: number; plate: string; plateKey: string; description: string | null; meterType: string; lastReading: number | null; thirdPartyId: number; company: string; kind: string };

export type EquipmentIndex = { fleet: FleetMatch[]; vehicles: VehicleMatch[] };

export async function loadEquipmentIndex(ctx: AssistantToolContext): Promise<EquipmentIndex> {
  const visible = frentesVisiveis(ctx.user);
  const [fleet, vehicles] = await Promise.all([
    ctx.db.select({
      id: equipment.id, prefix: equipment.prefix, plate: equipment.plate, type: equipment.type, brand: equipment.brand, model: equipment.model, controlType: equipment.controlType,
      currentHours: equipment.currentHours, currentKm: equipment.currentKm, status: equipment.status, serviceFrontId: equipment.serviceFrontId, frontName: serviceFronts.name,
    }).from(equipment).leftJoin(serviceFronts, eq(serviceFronts.id, equipment.serviceFrontId))
      .where(and(isNull(equipment.soldAt), visible === "ALL" ? undefined : visible.length ? inArray(equipment.serviceFrontId, visible) : eq(equipment.id, -1))),
    ctx.db.select({
      id: thirdPartyVehicles.id, plate: thirdPartyVehicles.plate, plateKey: thirdPartyVehicles.plateKey, description: thirdPartyVehicles.description, meterType: thirdPartyVehicles.meterType,
      lastReading: thirdPartyVehicles.lastReading, thirdPartyId: thirdParties.id, company: thirdParties.name, kind: thirdParties.kind,
    }).from(thirdPartyVehicles).innerJoin(thirdParties, eq(thirdParties.id, thirdPartyVehicles.thirdPartyId)).where(and(eq(thirdPartyVehicles.active, true), eq(thirdParties.active, true))),
  ]);
  return { fleet: fleet as FleetMatch[], vehicles: vehicles as VehicleMatch[] };
}

// Exato por código ou placa; se nada bater, parecidos (código/placa contendo o termo, ou modelo).
export function matchEquipment(index: EquipmentIndex, term: string) {
  const key = importKey(term);
  if (key.length < 2) throw new AssistantToolError("Informe o código, a placa ou o modelo (pelo menos 2 caracteres).");
  const exactCode = index.fleet.filter((item) => importKey(item.prefix) === key);
  const exactPlate = index.fleet.filter((item) => item.plate && importKey(item.plate) === key);
  let fleet: Array<FleetMatch & { foundBy: string }> = [...exactCode.map((item) => ({ ...item, foundBy: "código" })), ...exactPlate.filter((item) => !exactCode.includes(item)).map((item) => ({ ...item, foundBy: "placa" }))];
  let vehicles = index.vehicles.filter((item) => item.plateKey === key).map((item) => ({ ...item, foundBy: "placa" }));
  if (fleet.length === 0 && vehicles.length === 0) {
    fleet = index.fleet.filter((item) => importKey(item.prefix).includes(key) || (item.plate && importKey(item.plate).includes(key)) || importKey(`${item.type} ${item.brand} ${item.model}`).includes(key))
      .slice(0, 12).map((item) => ({ ...item, foundBy: importKey(item.prefix).includes(key) ? "código parecido" : item.plate && importKey(item.plate).includes(key) ? "placa parecida" : "modelo" }));
    vehicles = index.vehicles.filter((item) => item.plateKey.includes(key) || importKey(item.description).includes(key)).slice(0, 8).map((item) => ({ ...item, foundBy: "placa parecida" }));
  }
  return { fleet, vehicles };
}

export async function searchEquipment(ctx: AssistantToolContext, term: string) {
  return matchEquipment(await loadEquipmentIndex(ctx), term);
}

async function resolveTarget(ctx: AssistantToolContext, term: string) {
  const found = await searchEquipment(ctx, term);
  const exactFleet = found.fleet.filter((item) => item.foundBy === "código" || item.foundBy === "placa");
  const exactVehicles = found.vehicles.filter((item) => item.foundBy === "placa");
  if (exactFleet.length === 1 && exactVehicles.length === 0) return { kind: "FROTA" as const, item: exactFleet[0] };
  if (exactVehicles.length === 1 && exactFleet.length === 0) return { kind: "TERCEIRO" as const, item: exactVehicles[0] };
  const options = [...found.fleet.map((item) => item.prefix), ...found.vehicles.map((item) => `${item.plate} (${item.company})`)].slice(0, 10);
  throw new AssistantToolError(options.length ? `"${term}" não identifica um único equipamento. Possíveis: ${options.join(", ")}.` : `Equipamento/veículo "${term}" não encontrado (código ou placa).`);
}

async function thirdPartyByName(db: Db, name: string) {
  if (!name) return null;
  const key = importKey(name);
  const parties = await db.select({ id: thirdParties.id, name: thirdParties.name }).from(thirdParties);
  const found = parties.filter((party) => importKey(party.name) === key);
  const list = found.length ? found : parties.filter((party) => importKey(party.name).includes(key));
  if (list.length === 0) throw new AssistantToolError(`Empresa "${name}" não encontrada no cadastro de Terceiros.`);
  if (list.length > 1) throw new AssistantToolError(`"${name}" corresponde a mais de uma empresa: ${list.slice(0, 8).map((party) => party.name).join(", ")}.`);
  return list[0];
}

const STATUS_LABELS: Record<string, string> = { ACTIVE: "Ativo", STOPPED: "Parado", MAINTENANCE: "Em manutenção", INACTIVE: "Inativo" };

async function buscarEquipamento(ctx: AssistantToolContext, input: Input) {
  const found = await searchEquipment(ctx, text(input, "termo"));
  return {
    frota: found.fleet.map((item) => ({
      codigo: item.prefix, placa: item.plate, tipo: item.type, marca_modelo: `${item.brand} ${item.model}`.trim(), frente: item.frontName, situacao: STATUS_LABELS[item.status] ?? item.status,
      controle: item.controlType === "KM" ? "KM" : item.controlType === "HOURS_KM" ? "Horímetro e KM" : "Horímetro",
      leitura_atual: item.controlType === "KM" ? `${brNumber(item.currentKm, 1)} km` : item.controlType === "HOURS_KM" ? `${brNumber(item.currentHours, 1)} h / ${brNumber(item.currentKm, 1)} km` : `${brNumber(item.currentHours, 1)} h`,
      encontrado_por: item.foundBy,
    })),
    veiculos_de_terceiros: found.vehicles.map((item) => ({
      placa: item.plate, descricao: item.description, empresa: item.company, tipo_empresa: item.kind, medidor: item.meterType === "KM" ? "KM" : "Horímetro",
      ultima_leitura: brNumber(item.lastReading, 1), encontrado_por: item.foundBy,
    })),
    observacao: found.fleet.length + found.vehicles.length === 0 ? "Nada encontrado nas frentes do usuário." : undefined,
  };
}

const FUEL_TYPE_FILTERS: Record<string, FuelFilters["movementType"]> = { ENTRADA: "ENTRADA", SAIDA: "SAIDA", TRANSFERENCIA: "TRANSFERENCIA", TERCEIROS: "TERCEIROS", PRESTADORES: "PRESTADORES" };

async function historicoCombustivel(ctx: AssistantToolContext, input: Input) {
  needs(ctx.user, ["fuel.view"], "Combustível");
  const { from, to } = period(input);
  const fronts = await frontScope(ctx, input);
  const fuel = await fuelTypeByName(ctx.db, text(input, "combustivel"));
  const type = importKey(text(input, "tipo"));
  if (type && !FUEL_TYPE_FILTERS[type]) throw new AssistantToolError(`Tipo "${text(input, "tipo")}" inválido. Use ENTRADA, SAIDA, TRANSFERENCIA, TERCEIROS ou PRESTADORES.`);
  const party = await thirdPartyByName(ctx.db, text(input, "empresa"));
  const targetTerm = text(input, "equipamento");
  const target = targetTerm ? await resolveTarget(ctx, targetTerm) : null;
  const filters: FuelFilters = {
    from, to, fuelTypeId: fuel?.id ?? null, movementType: type ? FUEL_TYPE_FILTERS[type] : null, location: null, frontId: null, q: "", pending: null,
    thirdPartyId: party?.id ?? null, vehicleId: target?.kind === "TERCEIRO" ? target.item.id : null, equipmentId: target?.kind === "FROTA" ? target.item.id : null,
  };
  const limit = Math.min(Math.max(Number(input.limite) || 20, 1), 50);
  const scope = fronts.map((front) => front.id);
  const [{ rows, total }, summary] = await Promise.all([fuelHistory(ctx.db, scope, filters, limit), fuelHistorySummary(ctx.db, scope, filters)]);
  const totals = (value: { count: number; liters: number }) => ({ lancamentos: value.count, litros: brNumber(value.liters) });
  return {
    periodo: `${brDate(from)} a ${brDate(to)}`, frentes: fronts.map((front) => front.name),
    filtros: { combustivel: fuel?.name ?? "todos", tipo: type || "todos", empresa: party?.name ?? null, equipamento: target ? (target.kind === "FROTA" ? target.item.prefix : target.item.plate) : null },
    resumo: {
      ...(summary.show.entries ? { entradas: totals(summary.entries) } : {}), ...(summary.show.exits ? { saidas: totals(summary.exits) } : {}),
      ...(summary.show.transfers ? { transferencias: totals(summary.transfers) } : {}), ...(summary.balance !== null ? { entradas_menos_saidas: brNumber(summary.balance) } : {}),
      por_combustivel: summary.byFuel.map((item) => ({ combustivel: item.fuelName, entradas_litros: brNumber(item.entries.liters), saidas_litros: brNumber(item.exits.liters), transferencias_litros: brNumber(item.transfers.liters) })),
    },
    total_lancamentos: total, mostrando: rows.length,
    lancamentos: rows.map((row) => ({
      data: brDate(row.movementDate), tipo: row.movementLabel, frente: row.frontName, estoque: row.stockLocationLabel, destino: row.destinationFrontName ? `${row.destinationFrontName} (${row.destinationLocationLabel ?? ""})` : null,
      combustivel: row.fuelName, litros: brNumber(row.quantity),
      equipamento: row.equipmentPrefix ?? row.vehiclePlate ?? row.providerEquipment ?? row.importedVehicle ?? null, empresa: row.thirdPartyName ?? row.providerCompany ?? null,
      leitura: row.meterReading === null ? null : `${brNumber(row.meterReading, 1)} ${row.meterUnit === "KM" ? "km" : "h"}`,
      consumo: row.consumption ? `${brNumber(row.consumption.value)} ${row.consumption.unit}` : null, motorista: row.responsible, observacao: row.notes,
    })),
  };
}

async function consumoVeiculo(ctx: AssistantToolContext, input: Input) {
  needs(ctx.user, ["fuel.view", "fleet.report"], "consumo de combustível");
  const { from, to } = period(input);
  const fronts = await frontScope(ctx, input);
  const scope = fronts.map((front) => front.id);
  const term = text(input, "equipamento");
  const target = term ? await resolveTarget(ctx, term) : null;
  const party = !target ? await thirdPartyByName(ctx.db, text(input, "empresa")) : null;
  const base = { periodo: `${brDate(from)} a ${brDate(to)}`, frentes: fronts.map((front) => front.name) };
  const thirdPartyRows = async (filters: { thirdPartyId: number | null; vehicleId: number | null }) => (await thirdPartyConsumptionReport(ctx.db, scope, { from, to, ...filters })).vehicles.map((row) => ({
    placa: row.plate, descricao: row.description, empresa: row.company, abastecimentos: row.fuelings, litros: brNumber(row.liters),
    percorrido: row.distance ? `${brNumber(row.distance, 1)} ${row.meterType === "KM" ? "km" : "h"}` : null, consumo_medio: row.average === null ? null : `${brNumber(row.average)} ${row.unit}`,
    fora_da_media: row.outliers,
  }));
  if (target?.kind === "TERCEIRO" || party) {
    const rows = await thirdPartyRows({ thirdPartyId: party?.id ?? null, vehicleId: target?.kind === "TERCEIRO" ? target.item.id : null });
    return { ...base, origem: "terceiros", veiculos: rows, observacao: rows.length ? "Consumo médio só com tanques cheios consecutivos." : "Sem abastecimentos no período." };
  }
  const fleetRows = async () => {
    const report = await fleetCostReport(await getD1(), ctx.user, { from, to, frontId: scope.length === 1 ? scope[0] : null });
    return report.rows.filter((row) => (!target || row.equipmentId === target.item.id) && (scope.length === 1 || fronts.some((front) => front.name === row.front)));
  };
  const rows = await fleetRows();
  const unit = (row: (typeof rows)[number]) => (row.unit === "KM" ? "km/L" : "L/h");
  const mapped = rows.map((row) => ({
    codigo: row.prefix, tipo: row.type, frente: row.front, litros: brNumber(row.liters), uso_no_periodo: row.usage === null ? null : `${brNumber(row.usage, 1)} ${row.unit === "KM" ? "km" : "h"}`,
    consumo: row.consumption === null ? null : `${brNumber(row.consumption)} ${unit(row)}`, media_do_tipo: row.typeAverage === null ? null : `${brNumber(row.typeAverage)} ${unit(row)}`,
    situacao: row.outlier === "ACIMA" ? "consumo pior que a média do tipo" : row.outlier === "ABAIXO" ? "consumo melhor que a média do tipo" : null,
  }));
  if (target) return { ...base, origem: "frota própria", equipamento: target.item.prefix, resultado: mapped[0] ?? null, observacao: mapped[0] ? "Uso = diferença das leituras de horímetro/KM no período." : "Sem abastecimento ou leitura desse equipamento no período." };
  const withConsumption = mapped.filter((row) => row.consumo !== null);
  return { ...base, frota_propria: withConsumption.slice(0, 25), equipamentos_sem_leitura_no_periodo: mapped.filter((row) => row.consumo === null && row.litros !== "0").map((row) => row.codigo).slice(0, 30), terceiros: (await thirdPartyRows({ thirdPartyId: null, vehicleId: null })).slice(0, 15) };
}

async function saldoFrente(ctx: AssistantToolContext, input: Input) {
  needs(ctx.user, ["fuel.view"], "Combustível");
  const fronts = await frontScope(ctx, input);
  const scope = fronts.map((front) => front.id);
  const fuel = await fuelTypeByName(ctx.db, text(input, "combustivel"));
  const today = fuelLocalDay();
  const rawDate = text(input, "ate_data");
  const until = rawDate ? parseImportDate(rawDate) : null;
  if (rawDate && !until) throw new AssistantToolError(`Data inválida: "${rawDate}". Use DD/MM/AAAA.`);
  const rows = await ctx.db.select({
    serviceFrontId: fuelMovements.serviceFrontId, stockLocation: fuelMovements.stockLocation, destinationFrontId: fuelMovements.destinationFrontId,
    destinationLocation: fuelMovements.destinationLocation, fuelTypeId: fuelMovements.fuelTypeId, movementType: fuelMovements.movementType, movementDate: fuelMovements.movementDate,
    quantity: fuelMovements.quantity, balanceAdjustment: fuelMovements.balanceAdjustment,
  }).from(fuelMovements).where(and(isNull(fuelMovements.deletedAt), or(inArray(fuelMovements.serviceFrontId, scope), inArray(fuelMovements.destinationFrontId, scope)),
    fuel ? eq(fuelMovements.fuelTypeId, fuel.id) : undefined, until ? lte(fuelMovements.movementDate, until) : undefined));
  const monthFrom = monthStart(until ?? today);
  const balances = computeFuelBalances(rows, { fronts: scope, from: monthFrom, to: until ?? today });
  const types = await ctx.db.select({ id: fuelTypes.id, name: fuelTypes.name }).from(fuelTypes);
  const typeName = new Map(types.map((type) => [type.id, type.name]));
  const result = [];
  for (const [fuelTypeId, balance] of balances) for (const front of fronts) {
    const totals = balance.byFront.get(front.id);
    if (!totals) continue;
    result.push({
      frente: front.name, combustivel: typeName.get(fuelTypeId) ?? `#${fuelTypeId}`, saldo_litros: brNumber(totals.balance),
      estoque_frente: brNumber(totals.byLocation.FRENTE.balance), estoque_porto: brNumber(totals.byLocation.PORTO.balance),
      entradas_no_mes: brNumber(totals.entries), saidas_no_mes: brNumber(totals.exits),
    });
  }
  return {
    posicao: until ? `saldo até ${brDate(until)}` : `saldo atual (${brDate(today)})`, mes_considerado_para_entradas_saidas: `${brDate(monthFrom)} a ${brDate(until ?? today)}`,
    frentes: fronts.map((front) => front.name), saldos: result, observacao: result.length ? "Saldo calculado de todos os lançamentos (entradas − saídas ± transferências)." : "Nenhum lançamento de combustível nessas frentes.",
  };
}

const LEVELS: Record<string, { label: string; order: number }> = { OVERDUE: { label: "vencida", order: 0 }, NEAR: { label: "próxima", order: 1 }, WARNING: { label: "atenção", order: 2 } };

async function trocasEAlertas(ctx: AssistantToolContext, input: Input) {
  needs(ctx.user, ["alerts.view", "maintenance.view"], "Troca de óleo e alertas");
  const fronts = await frontScope(ctx, input);
  const d1 = await getD1();
  await recalculateMaintenanceIfStale(d1);
  const allowed = await allowedEquipmentIds(d1, ctx.user, "OIL", fronts.map((front) => front.id));
  const situation = importKey(text(input, "situacao"));
  const levels = situation === "VENCIDAS" ? ["OVERDUE"] : situation === "PROXIMAS" ? ["NEAR"] : situation === "ATENCAO" ? ["WARNING"] : ["OVERDUE", "NEAR", "WARNING"];
  const term = text(input, "equipamento");
  const target = term ? await resolveTarget(ctx, term) : null;
  if (target && target.kind !== "FROTA") throw new AssistantToolError("Troca de óleo e alertas só existem para equipamentos da frota própria.");
  const alerts = (await loadWhatsappAlerts(d1, target ? { equipmentId: target.item.id } : {}))
    .filter((alert) => allowed.has(alert.equipmentId) && levels.includes(alert.level))
    .sort((a, b) => LEVELS[a.level].order - LEVELS[b.level].order || a.remainingValue - b.remainingValue);
  const unit = (value: "HOURS" | "KM") => (value === "KM" ? "km" : "h");
  return {
    frentes: fronts.map((front) => front.name), data: brDate(fuelLocalDay()),
    totais: { vencidas: alerts.filter((alert) => alert.level === "OVERDUE").length, proximas: alerts.filter((alert) => alert.level === "NEAR").length, atencao: alerts.filter((alert) => alert.level === "WARNING").length },
    alertas: alerts.slice(0, 60).map((alert) => ({
      equipamento: alert.prefix, frente: alert.front, manutencao: alert.maintenanceName, situacao: LEVELS[alert.level].label,
      leitura_atual: `${brNumber(alert.currentValue, 1)} ${unit(alert.unit)}`, proxima_troca: `${brNumber(alert.nextValue, 1)} ${unit(alert.unit)}`,
      [alert.remainingValue < 0 ? "passou" : "faltam"]: `${brNumber(Math.abs(alert.remainingValue), 1)} ${unit(alert.unit)}`,
    })),
    mostrando: Math.min(alerts.length, 60),
  };
}

async function historicoManutencao(ctx: AssistantToolContext, input: Input) {
  needs(ctx.user, ["maintenance.history"], "Histórico de manutenção");
  const term = text(input, "equipamento");
  if (!term) throw new AssistantToolError("Informe o código ou a placa do equipamento.");
  const target = await resolveTarget(ctx, term);
  if (target.kind !== "FROTA") throw new AssistantToolError("O histórico de manutenção só existe para equipamentos da frota própria.");
  const d1 = await getD1();
  const allowed = await allowedEquipmentIds(d1, ctx.user, "OIL");
  if (!allowed.has(target.item.id)) throw new AssistantToolError(`O equipamento ${target.item.prefix} não participa da Troca de óleo ou está fora das frentes do seu usuário.`);
  const withReadings = input.incluir_leituras === true;
  const limit = Math.min(Math.max(Number(input.limite) || 15, 1), 40);
  const entries = (await loadHistoryEntries(d1, { equipmentId: target.item.id }))
    .filter((entry) => withReadings || entry.kind !== "READING")
    .sort((a, b) => b.date.localeCompare(a.date));
  const showCost = ctx.user.profile === "ADMIN" || ctx.user.profile === "GESTOR";
  const unit = (value: "HOURS" | "KM") => (value === "KM" ? "km" : "h");
  return {
    equipamento: target.item.prefix, frente: target.item.frontName, total_registros: entries.length, mostrando: Math.min(entries.length, limit),
    registros: entries.slice(0, limit).map((entry) => ({
      data: brDate(entry.date), tipo: entry.kind === "READING" ? "leitura" : entry.kind === "IMPORTED" ? "troca (importada)" : "troca/manutenção",
      servico: entry.service || entry.action, leitura: entry.newReading === null ? null : `${brNumber(entry.newReading, 1)} ${unit(entry.unit)}`,
      proxima: entry.nextReading === null ? null : `${brNumber(entry.nextReading, 1)} ${unit(entry.unit)}`, responsavel: entry.responsible || null, os: entry.workOrder || null,
      observacao: entry.notes, ...(showCost && entry.cost ? { custo: `R$ ${brNumber(entry.cost)}` } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Definições enviadas ao modelo.
// ---------------------------------------------------------------------------
const periodProps = {
  data_inicio: { type: "string", description: "Início do período, DD/MM/AAAA. Omitir = primeiro dia do mês corrente." },
  data_fim: { type: "string", description: "Fim do período, DD/MM/AAAA. Omitir = hoje." },
};
const frontProp = { frente: { type: "string", description: "Nome da frente de serviço. Omitir = frentes em exibição para o usuário." } };

export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "buscar_equipamento",
    description: "Procura um equipamento da frota própria pelo código (ex.: CM-35), placa (ex.: QVN6E34) ou modelo/tipo, e veículos de terceiros pela placa. Devolve código cadastrado, placa, modelo, frente, situação, tipo de controle e leitura atual, e como foi encontrado (código, placa, parecido).",
    input_schema: { type: "object", properties: { termo: { type: "string", description: "Código, placa ou modelo." } }, required: ["termo"] },
  },
  {
    name: "historico_combustivel",
    description: "Lançamentos de combustível num período com resumo (entradas, saídas, transferências, por combustível) e até 50 lançamentos mais recentes. Filtra por frente, combustível, tipo, equipamento/veículo e empresa terceira.",
    input_schema: {
      type: "object",
      properties: {
        ...periodProps, ...frontProp,
        combustivel: { type: "string", description: "Nome do combustível (ex.: Diesel S10)." },
        tipo: { type: "string", enum: ["ENTRADA", "SAIDA", "TRANSFERENCIA", "TERCEIROS", "PRESTADORES"], description: "SAIDA inclui frota, terceiros e prestadores." },
        equipamento: { type: "string", description: "Código ou placa do equipamento da frota ou do veículo de terceiro." },
        empresa: { type: "string", description: "Nome da empresa no cadastro de Terceiros." },
        limite: { type: "integer", description: "Quantos lançamentos listar (1 a 50, padrão 20)." },
      },
    },
  },
  {
    name: "consumo_veiculo",
    description: "Consumo médio no período: km/L (veículos a KM) ou L/h (horímetro). Frota própria: litros ÷ uso pelas leituras, comparado com a média do tipo. Terceiros: média dos tanques cheios. Sem equipamento/empresa, lista a frota e os terceiros da(s) frente(s).",
    input_schema: {
      type: "object",
      properties: {
        ...periodProps, ...frontProp,
        equipamento: { type: "string", description: "Código ou placa (frota própria ou veículo de terceiro)." },
        empresa: { type: "string", description: "Empresa terceira (todos os veículos dela)." },
      },
    },
  },
  {
    name: "saldo_frente",
    description: "Saldo de combustível por frente e combustível (total, estoque Frente e estoque Porto) e entradas/saídas do mês. Opcionalmente o saldo até uma data.",
    input_schema: {
      type: "object",
      properties: { ...frontProp, combustivel: { type: "string", description: "Nome do combustível." }, ate_data: { type: "string", description: "Saldo até esta data (DD/MM/AAAA). Omitir = saldo atual." } },
    },
  },
  {
    name: "trocas_e_alertas",
    description: "Trocas de óleo/manutenções preventivas vencidas, próximas ou em atenção, por frente ou equipamento, com leitura atual, próxima troca e quanto falta ou passou.",
    input_schema: {
      type: "object",
      properties: {
        ...frontProp,
        situacao: { type: "string", enum: ["VENCIDAS", "PROXIMAS", "ATENCAO", "TODAS"], description: "Padrão TODAS." },
        equipamento: { type: "string", description: "Código ou placa de um equipamento." },
      },
    },
  },
  {
    name: "historico_manutencao",
    description: "Histórico de trocas/manutenções de um equipamento da frota (data, serviço, leitura, próxima, responsável, OS, observação), do mais recente para o mais antigo.",
    input_schema: {
      type: "object",
      properties: {
        equipamento: { type: "string", description: "Código ou placa." },
        limite: { type: "integer", description: "Quantos registros (1 a 40, padrão 15)." },
        incluir_leituras: { type: "boolean", description: "Incluir também as leituras de horímetro/KM." },
      },
      required: ["equipamento"],
    },
  },
];

const HANDLERS: Record<string, (ctx: AssistantToolContext, input: Input) => Promise<unknown>> = {
  buscar_equipamento: buscarEquipamento,
  historico_combustivel: historicoCombustivel,
  consumo_veiculo: consumoVeiculo,
  saldo_frente: saldoFrente,
  trocas_e_alertas: trocasEAlertas,
  historico_manutencao: historicoManutencao,
};

const MAX_RESULT_CHARS = 40_000;

// Executa uma ferramenta. Erro de regra (sem acesso, não encontrado) volta como texto para o modelo
// explicar ao usuário; erro inesperado vira mensagem genérica (o detalhe fica no log do servidor).
export async function runAssistantTool(ctx: AssistantToolContext, name: string, input: unknown): Promise<{ ok: boolean; content: string }> {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, content: `Ferramenta desconhecida: ${name}.` };
  try {
    const result = await handler(ctx, input && typeof input === "object" ? (input as Input) : {});
    const json = JSON.stringify(result);
    return { ok: true, content: json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… (resultado cortado; peça um filtro menor)` : json };
  } catch (error) {
    if (error instanceof AssistantToolError) return { ok: false, content: error.message };
    console.error(`[assistente.tool.${name}]`, error);
    return { ok: false, content: "Falha ao consultar o sistema agora." };
  }
}
