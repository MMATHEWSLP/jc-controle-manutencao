// Regras puras do cadastro de Terceiros e do consumo dos veículos deles (sem banco), testadas em
// tests/third-party-rules.test.mjs.

export const THIRD_PARTY_KINDS = ["PRESTADOR", "TERCEIRIZADA", "PESSOA_FISICA"] as const;
export type ThirdPartyKindCode = typeof THIRD_PARTY_KINDS[number];
export const THIRD_PARTY_KIND_LABELS: Record<ThirdPartyKindCode, string> = { PRESTADOR: "Prestador de serviço", TERCEIRIZADA: "Terceirizada", PESSOA_FISICA: "Pessoa física" };

export const VEHICLE_TYPES = ["CAMINHAO", "MAQUINA", "VEICULO_LEVE", "OUTRO"] as const;
export type VehicleType = typeof VEHICLE_TYPES[number];
export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = { CAMINHAO: "Caminhão", MAQUINA: "Máquina", VEICULO_LEVE: "Veículo leve", OUTRO: "Outro" };

export const METER_TYPES = ["KM", "HORIMETRO"] as const;
export type MeterType = typeof METER_TYPES[number];
export const METER_LABELS: Record<MeterType, string> = { KM: "Hodômetro (km)", HORIMETRO: "Horímetro (h)" };
// Para frases: "Informe a leitura atual do hodômetro (km)."
export const METER_PHRASES: Record<MeterType, string> = { KM: "do hodômetro (km)", HORIMETRO: "do horímetro (h)" };
// Consumo: km/L para quem mede KM; L/h para horímetro.
export const CONSUMPTION_UNITS: Record<MeterType, string> = { KM: "km/L", HORIMETRO: "L/h" };
// Desvio a partir do qual o abastecimento é "fora da média" (pede confirmação e fica marcado).
export const OUTLIER_TOLERANCE = 0.25;

export const isThirdPartyKind = (value: unknown): value is ThirdPartyKindCode => typeof value === "string" && (THIRD_PARTY_KINDS as readonly string[]).includes(value);
export const isVehicleType = (value: unknown): value is VehicleType => typeof value === "string" && (VEHICLE_TYPES as readonly string[]).includes(value);
export const isMeterType = (value: unknown): value is MeterType => typeof value === "string" && (METER_TYPES as readonly string[]).includes(value);

// CNPJ/CPF só com dígitos; placa só com letras/números em maiúsculas (para não duplicar "ABC-1234" e "abc1234").
export const documentDigits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
export const plateKey = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "") || null;
const optionalNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : NaN;
};

export type ThirdPartyInput = { name: string; kind: ThirdPartyKindCode; document: string | null; contactName: string | null; phone: string | null; serviceFrontId: number | null; notes: string | null };

export function parseThirdParty(body: Record<string, unknown>): { value?: ThirdPartyInput; error?: string } {
  const name = text(body.name)?.toUpperCase() ?? "";
  if (name.length < 2) return { error: "Informe o nome da empresa ou pessoa." };
  if (!isThirdPartyKind(body.kind)) return { error: "Escolha o tipo: Prestador, Terceirizada ou Pessoa física." };
  const document = documentDigits(body.document) || null;
  if (document && document.length !== 11 && document.length !== 14) return { error: "O documento deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos)." };
  const serviceFrontId = Number(body.serviceFrontId) || null;
  return { value: { name, kind: body.kind, document, contactName: text(body.contactName), phone: text(body.phone), serviceFrontId, notes: text(body.notes) } };
}

// Funcionários dos terceiros (aba "Funcionários" da empresa): recebem combustível ou peças sem veículo.
export type ThirdPartyEmployeeInput = { name: string; jobTitle: string | null; cpf: string | null; phone: string | null };
export function parseThirdPartyEmployee(body: Record<string, unknown>): { value?: ThirdPartyEmployeeInput; error?: string } {
  const name = (text(body.name) ?? "").toUpperCase();
  if (name.length < 3) return { error: "Informe o nome do funcionário." };
  const cpf = documentDigits(body.cpf) || null;
  if (cpf && cpf.length !== 11) return { error: "O CPF deve ter 11 dígitos (ou deixe em branco)." };
  return { value: { name, jobTitle: text(body.jobTitle)?.toUpperCase() ?? null, cpf, phone: text(body.phone) } };
}

// Saída para terceiro: destino Veículo (leitura e média de consumo) ou Funcionário (com finalidade,
// sem leitura e fora de qualquer média de consumo).
export const THIRD_PARTY_DESTINATIONS = ["VEICULO", "FUNCIONARIO"] as const;
export type ThirdPartyDestination = typeof THIRD_PARTY_DESTINATIONS[number];
export const THIRD_PARTY_DESTINATION_LABELS: Record<ThirdPartyDestination, string> = { VEICULO: "Veículo", FUNCIONARIO: "Funcionário" };
export const FUEL_PURPOSES = ["MOTOSSERRA", "GERADOR", "GALAO", "MAQUINA_NAO_CADASTRADA", "OUTROS"] as const;
export type FuelPurpose = typeof FUEL_PURPOSES[number];
export const FUEL_PURPOSE_LABELS: Record<FuelPurpose, string> = { MOTOSSERRA: "Motosserra", GERADOR: "Gerador", GALAO: "Galão / reserva", MAQUINA_NAO_CADASTRADA: "Máquina não cadastrada", OUTROS: "Outros" };
export const isFuelPurpose = (value: unknown): value is FuelPurpose => typeof value === "string" && (FUEL_PURPOSES as readonly string[]).includes(value);
export const purposeText = (purpose: FuelPurpose | null | undefined, note: string | null | undefined) => (purpose ? (purpose === "OUTROS" && note ? `Outros: ${note}` : FUEL_PURPOSE_LABELS[purpose]) : null);

export type VehicleInput = {
  plate: string; plateKey: string; description: string | null; vehicleType: VehicleType; meterType: MeterType; fuelTypeId: number | null;
  tankCapacityLiters: number | null; expectedConsumption: number | null; lastReading: number | null;
};

export function parseVehicle(body: Record<string, unknown>): { value?: VehicleInput; error?: string } {
  const plate = text(body.plate)?.toUpperCase() ?? "";
  const key = plateKey(plate);
  if (!key) return { error: "Informe a placa ou identificação do veículo/máquina." };
  if (!isVehicleType(body.vehicleType)) return { error: "Escolha o tipo do veículo (caminhão, máquina, veículo leve ou outro)." };
  if (!isMeterType(body.meterType)) return { error: "Escolha a medição: KM ou horímetro." };
  const tankCapacityLiters = optionalNumber(body.tankCapacityLiters);
  const expectedConsumption = optionalNumber(body.expectedConsumption);
  const lastReading = optionalNumber(body.lastReading);
  if (Number.isNaN(tankCapacityLiters) || (tankCapacityLiters !== null && tankCapacityLiters <= 0)) return { error: "A capacidade do tanque deve ser maior que zero." };
  if (Number.isNaN(expectedConsumption) || (expectedConsumption !== null && expectedConsumption <= 0)) return { error: "O consumo esperado deve ser maior que zero." };
  if (Number.isNaN(lastReading) || (lastReading !== null && lastReading < 0)) return { error: "A leitura inicial deve ser zero ou mais." };
  return { value: { plate, plateKey: key, description: text(body.description), vehicleType: body.vehicleType, meterType: body.meterType, fuelTypeId: Number(body.fuelTypeId) || null, tankCapacityLiters, expectedConsumption, lastReading } };
}

// ---------------------------------------------------------------------------
// Consumo. Entre dois abastecimentos com leitura: distância = leitura atual − leitura base.
// KM: km/L = distância ÷ litros. HORÍMETRO: L/h = litros ÷ horas. Abastecimento com tanque parcial
// só acumula litros para o próximo tanque cheio (a base continua a do último tanque cheio). O primeiro
// abastecimento (sem leitura anterior) e o aceito como exceção de leitura viram base, sem consumo.
// ---------------------------------------------------------------------------
export type Fueling = { id: number; date: string; liters: number; reading: number | null; fullTank: boolean; readingException?: boolean };
export type FuelingConsumption = { distance: number; liters: number; value: number };

export function computeConsumption(meterType: MeterType, fuelings: Fueling[]) {
  const ordered = [...fuelings].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const result = new Map<number, FuelingConsumption | null>();
  let base: number | null = null;
  let accumulated = 0;
  for (const fueling of ordered) {
    if (fueling.reading === null || !Number.isFinite(fueling.reading)) { accumulated += fueling.liters; result.set(fueling.id, null); continue; }
    if (base === null || fueling.readingException) { base = fueling.reading; accumulated = 0; result.set(fueling.id, null); continue; }
    accumulated += fueling.liters;
    if (!fueling.fullTank) { result.set(fueling.id, null); continue; }
    const distance = fueling.reading - base;
    const value = consumptionValue(meterType, distance, accumulated);
    result.set(fueling.id, value === null ? null : { distance, liters: accumulated, value });
    base = fueling.reading;
    accumulated = 0;
  }
  return result;
}

export function consumptionValue(meterType: MeterType, distance: number, liters: number) {
  if (!(distance > 0) || !(liters > 0)) return null;
  return meterType === "KM" ? distance / liters : liters / distance;
}

// Média do período = total rodado ÷ total de litros (KM) ou litros ÷ horas (horímetro), só com os
// abastecimentos que têm consumo calculado.
export function averageConsumption(meterType: MeterType, entries: Array<FuelingConsumption | null | undefined>) {
  let distance = 0; let liters = 0;
  for (const entry of entries) if (entry) { distance += entry.distance; liters += entry.liters; }
  return { distance, liters, value: consumptionValue(meterType, distance, liters) };
}

export function isOutlier(value: number | null, reference: number | null, tolerance = OUTLIER_TOLERANCE) {
  if (value === null || reference === null || !(reference > 0)) return false;
  return Math.abs(value - reference) / reference > tolerance;
}
