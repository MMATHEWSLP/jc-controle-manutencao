// ---------------------------------------------------------------------------
// Abastecimentos do comboio — regras puras (sem banco), usadas no celular (avisos na hora, mesmo
// offline com o cadastro baixado) e no servidor (etiquetas da aprovação). Testadas em
// tests/convoy-rules.test.mjs.
// ---------------------------------------------------------------------------
import { isFuelPurpose, type FuelPurpose, type ThirdPartyKindCode } from "./third-party-rules";

export type ConvoyUnit = "HOURS" | "KM";
// Tipo de saída, igual ao Combustível → Saída do computador.
export type ConvoyExitKind = "FROTA" | "TERCEIROS" | "PRESTADOR";
export const CONVOY_EXIT_KINDS: Array<[ConvoyExitKind, string]> = [["FROTA", "Frota (veículo/máquina)"], ["TERCEIROS", "Saída para terceiros"], ["PRESTADOR", "Prestadores de Serviço"]];
export const CONVOY_EXIT_LABELS = Object.fromEntries(CONVOY_EXIT_KINDS) as Record<ConvoyExitKind, string>;
export const isConvoyExitKind = (value: unknown): value is ConvoyExitKind => CONVOY_EXIT_KINDS.some(([key]) => key === value);
// Prestadores de Serviço só aceitam empresas prestadoras ou terceirizadas (mesma regra do computador).
export const exitKindAccepts = (exitKind: ConvoyExitKind, companyKind: ThirdPartyKindCode) => exitKind !== "PRESTADOR" || companyKind !== "PESSOA_FISICA";
export type NoPhotoReason = "OPERADOR_AUSENTE" | "EQUIPAMENTO_FECHADO" | "PAINEL_DEFEITO" | "OUTRO";
export const NO_PHOTO_REASONS: Array<[NoPhotoReason, string]> = [
  ["OPERADOR_AUSENTE", "Operador ausente"], ["EQUIPAMENTO_FECHADO", "Equipamento fechado"], ["PAINEL_DEFEITO", "Painel com defeito"], ["OUTRO", "Outro"],
];
export const NO_PHOTO_LABELS = Object.fromEntries(NO_PHOTO_REASONS) as Record<NoPhotoReason, string>;
export const isNoPhotoReason = (value: unknown): value is NoPhotoReason => NO_PHOTO_REASONS.some(([key]) => key === value);

// Etiquetas da aprovação. Aprovar em lote só vale para itens sem nenhuma etiqueta.
// CADASTRO_PENDENTE: o motorista marcou "Não cadastrado" (empresa, veículo ou funcionário do terceiro);
// o aprovador cadastra ou vincula a um cadastro existente antes de aprovar.
export type ConvoyFlag = "SEM_FOTO" | "LEITURA_MENOR" | "SALTO_ALTO" | "LITRAGEM_ALTA" | "ACIMA_TANQUE" | "FOTO_DIVERGE" | "CADASTRO_PENDENTE";
export const CONVOY_FLAG_LABELS: Record<ConvoyFlag, string> = {
  SEM_FOTO: "SEM FOTO", LEITURA_MENOR: "Leitura menor", SALTO_ALTO: "Salto alto", LITRAGEM_ALTA: "Litragem alta", ACIMA_TANQUE: "Acima do tanque", FOTO_DIVERGE: "Foto diverge",
  CADASTRO_PENDENTE: "CADASTRO PENDENTE",
};
export type ConvoyStatus = "PENDENTE" | "APROVANDO" | "APROVADO" | "REJEITADO" | "CORRECAO";
export const CONVOY_STATUS_LABELS: Record<ConvoyStatus, string> = {
  PENDENTE: "Pendente de aprovação", APROVANDO: "Em aprovação", APROVADO: "Aprovado", REJEITADO: "Rejeitado", CORRECAO: "Correção pedida",
};

// Limites dos avisos. Horímetro: no máximo 24 h por dia; KM: 1.000 km por dia. Com média de uso por
// dia conhecida (Controle Diário), salto acima de 3× o esperado também avisa (com piso, para não
// avisar por poucas horas/km). Litragem: acima de 20% do maior abastecimento já feito ou de 1,8× a
// média (com pelo menos 3 abastecimentos no histórico); acima de 1.200 L sempre.
const MAX_PER_DAY: Record<ConvoyUnit, number> = { HOURS: 24, KM: 1000 };
const JUMP_FLOOR: Record<ConvoyUnit, number> = { HOURS: 20, KM: 500 };
const UNKNOWN_DATE_JUMP: Record<ConvoyUnit, number> = { HOURS: 300, KM: 10000 };
export const MAX_LITERS_ABSOLUTE = 1200;
export const MAX_LITERS_INPUT = 5000;

export type LitersStats = { count: number; average: number; max: number };
export type WarningInput = {
  liters: number; reading: number | null; unit: ConvoyUnit;
  lastReading: number | null; lastReadingDate: string | null; recordDate: string;
  litersStats: LitersStats | null; avgPerDay: number | null;
};
export type ConvoyWarning = { code: Exclude<ConvoyFlag, "SEM_FOTO" | "FOTO_DIVERGE" | "CADASTRO_PENDENTE">; message: string };

const unitText = (unit: ConvoyUnit) => (unit === "KM" ? "km" : "h");
export const formatNumber = (value: number, digits = 1) => value.toLocaleString("pt-BR", { maximumFractionDigits: digits });

export function daysBetween(from: string, to: string) {
  const a = Date.parse(`${from.slice(0, 10)}T12:00:00Z`), b = Date.parse(`${to.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// Avisos da hora: não bloqueiam (o celular pode estar offline com cadastro antigo), viram etiqueta na aprovação.
export function convoyWarnings(input: WarningInput): ConvoyWarning[] {
  const warnings: ConvoyWarning[] = [];
  const unit = unitText(input.unit);
  if (input.reading !== null && input.lastReading !== null) {
    const diff = input.reading - input.lastReading;
    if (diff < 0) warnings.push({ code: "LEITURA_MENOR", message: `Leitura menor que a última conhecida (${formatNumber(input.lastReading)} ${unit}).` });
    else {
      const days = input.lastReadingDate ? daysBetween(input.lastReadingDate, input.recordDate) : null;
      const elapsed = days === null ? null : Math.max(1, days);
      const physical = elapsed === null ? UNKNOWN_DATE_JUMP[input.unit] : elapsed * MAX_PER_DAY[input.unit];
      const expected = elapsed !== null && input.avgPerDay && input.avgPerDay > 0 ? Math.max(JUMP_FLOOR[input.unit], input.avgPerDay * elapsed * 3) : null;
      if (diff > physical || (expected !== null && diff > expected))
        warnings.push({ code: "SALTO_ALTO", message: `Salto muito grande: ${formatNumber(diff)} ${unit} desde a última leitura (${formatNumber(input.lastReading)} ${unit}${input.lastReadingDate ? ` em ${input.lastReadingDate.slice(0, 10).split("-").reverse().join("/")}` : ""}).` });
    }
  }
  const liters = litersWarning(input.liters, input.litersStats, "deste equipamento");
  if (liters) warnings.push(liters);
  return warnings;
}

function litersWarning(liters: number, stats: LitersStats | null, whose: string): ConvoyWarning | null {
  if (liters > MAX_LITERS_ABSOLUTE) return { code: "LITRAGEM_ALTA", message: `Litragem muito alta (${formatNumber(liters)} L).` };
  if (stats && stats.count >= 3 && (liters > stats.max * 1.2 || liters > stats.average * 1.8))
    return { code: "LITRAGEM_ALTA", message: `Litragem acima do normal ${whose} (média ${formatNumber(stats.average)} L, maior ${formatNumber(stats.max)} L).` };
  return null;
}

// Avisos do veículo de terceiro (as mesmas conferências do computador, que lá pedem confirmação e
// aqui só avisam, porque o celular pode estar offline): leitura que não é maior que a última,
// litros acima da capacidade do tanque e litragem acima da média do veículo.
export type ThirdPartyWarningInput = { liters: number; reading: number | null; unit: ConvoyUnit; lastReading: number | null; tankCapacity: number | null; litersStats: LitersStats | null };
export function thirdPartyConvoyWarnings(input: ThirdPartyWarningInput): ConvoyWarning[] {
  const warnings: ConvoyWarning[] = [];
  if (input.reading !== null && input.lastReading !== null && input.reading <= input.lastReading)
    warnings.push({ code: "LEITURA_MENOR", message: `Leitura não é maior que a última do veículo (${formatNumber(input.lastReading)} ${unitText(input.unit)}). Na aprovação, só quem gerencia Terceiros aceita, com justificativa.` });
  if (input.tankCapacity && input.liters > input.tankCapacity)
    warnings.push({ code: "ACIMA_TANQUE", message: `${formatNumber(input.liters)} L passa da capacidade do tanque (${formatNumber(input.tankCapacity)} L).` });
  const liters = litersWarning(input.liters, input.litersStats, "deste veículo");
  if (liters) warnings.push(liters);
  return warnings;
}

// Consumo estimado deste abastecimento: L/h (horímetro) ou km/L (KM), usando a diferença de leitura.
export function estimatedConsumption(unit: ConvoyUnit, liters: number, diff: number | null) {
  if (diff === null || diff <= 0 || liters <= 0) return null;
  return unit === "KM" ? { value: diff / liters, unit: "km/L" } : { value: liters / diff, unit: "L/h" };
}

// Número digitado no celular: "1.234,5", "1234.5", "411208".
export function parseConvoyNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value).trim().replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : /^\d{1,3}(\.\d{3})+$/.test(text) ? text.replaceAll(".", "") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Busca local sem acento/maiúsculas/sinais (PC20 acha "PC-20", "joao" acha "JOÃO").
export const searchKey = (value: string | null | undefined) => (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, "");
export function matchesSearch(query: string, ...fields: Array<string | null | undefined>) {
  const words = searchKey(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.map(searchKey).join(" ");
  const compact = haystack.replace(/ /g, "");
  return words.every((word) => haystack.includes(word) || compact.includes(word));
}

// Dia no horário de Fortaleza (UTC−3, sem horário de verão) — o mesmo "hoje" do Combustível.
export function fortalezaDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function previousDay(day: string) {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
// "2026-10-06T14:05" no horário de Fortaleza (para a leitura do equipamento).
export function fortalezaWallTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Terceiros/Prestadores: empresa, destino e veículo/funcionário vêm do cadastro baixado (ids) ou, com
// "Não cadastrado", só com o nome/placa digitado (pending*). Os *Label guardam o texto mostrado no
// celular (usado se o cadastro sumir até o envio). operatorName = responsável que recebeu.
export type ConvoyThirdPartyPayload = {
  thirdPartyId: number | null; companyLabel: string | null; pendingCompany: string | null;
  destination: "VEICULO" | "FUNCIONARIO" | null;
  thirdPartyVehicleId: number | null; vehicleLabel: string | null; pendingVehicle: string | null;
  thirdPartyEmployeeId: number | null; employeeLabel: string | null; pendingEmployee: string | null;
  purpose: FuelPurpose | null; purposeNote: string | null; fullTank: boolean;
};
export type ConvoyPayload = {
  clientUuid: string; exitKind: ConvoyExitKind; equipmentId: number; operatorEmployeeId: number | null; operatorName: string; liters: number; reading: number | null;
  recordedAt: string; recordDate: string; dateJustification: string | null; noPhoto: boolean; noPhotoReason: NoPhotoReason | null; noPhotoNote: string | null;
  notes: string | null; latitude: number | null; longitude: number | null; gpsAccuracy: number | null; photoTakenAt: string | null;
  deviceLastReading: number | null; deviceWarnings: string[]; thirdParty: ConvoyThirdPartyPayload | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "") || null;
const finite = (value: unknown) => { const number = typeof value === "number" ? value : parseConvoyNumber(value); return number !== null && Number.isFinite(number) ? number : null; };

const id = (value: unknown) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

export function readConvoyPayload(raw: Record<string, unknown>): ConvoyPayload {
  const warnings = Array.isArray(raw.deviceWarnings) ? raw.deviceWarnings.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  // Registro antigo (sem tipo) = Frota.
  const exitKind = isConvoyExitKind(raw.exitKind) ? raw.exitKind : "FROTA";
  // O celular manda os campos do terceiro agrupados em "thirdParty" (formato de ConvoyPayload);
  // campos soltos no payload também são aceitos.
  const nested = raw.thirdParty && typeof raw.thirdParty === "object" ? raw.thirdParty as Record<string, unknown> : null;
  const thirdParty = exitKind === "FROTA" ? null : readThirdPartyPart(nested ? { ...raw, ...nested } : raw);
  // Destino Funcionário não tem medidor: não há leitura nem "sem foto".
  const toWorker = thirdParty?.destination === "FUNCIONARIO";
  const noPhoto = !toWorker && raw.noPhoto === true;
  return {
    clientUuid: typeof raw.clientUuid === "string" ? raw.clientUuid.toLowerCase() : "",
    exitKind,
    thirdParty,
    equipmentId: exitKind === "FROTA" ? Number(raw.equipmentId) || 0 : 0,
    operatorEmployeeId: exitKind === "FROTA" ? Number(raw.operatorEmployeeId) || null : null,
    operatorName: clean(raw.operatorName, 120) ?? "",
    liters: parseConvoyNumber(raw.liters) ?? NaN,
    reading: toWorker ? null : parseConvoyNumber(raw.reading),
    recordedAt: typeof raw.recordedAt === "string" ? raw.recordedAt : "",
    recordDate: typeof raw.recordDate === "string" ? raw.recordDate.slice(0, 10) : "",
    dateJustification: clean(raw.dateJustification, 300),
    noPhoto,
    noPhotoReason: noPhoto && isNoPhotoReason(raw.noPhotoReason) ? raw.noPhotoReason : null,
    noPhotoNote: noPhoto ? clean(raw.noPhotoNote, 200) : null,
    notes: clean(raw.notes, 500),
    latitude: finite(raw.latitude), longitude: finite(raw.longitude), gpsAccuracy: finite(raw.gpsAccuracy),
    photoTakenAt: typeof raw.photoTakenAt === "string" ? raw.photoTakenAt.slice(0, 40) : null,
    deviceLastReading: finite(raw.deviceLastReading),
    deviceWarnings: warnings,
  };
}

function readThirdPartyPart(raw: Record<string, unknown>): ConvoyThirdPartyPayload {
  const destination = raw.destination === "FUNCIONARIO" ? "FUNCIONARIO" : raw.destination === "VEICULO" ? "VEICULO" : null;
  const thirdPartyId = id(raw.thirdPartyId);
  const pendingCompany = thirdPartyId ? null : clean(raw.pendingCompany, 120);
  const vehicleId = destination === "VEICULO" ? id(raw.thirdPartyVehicleId) : null;
  const employeeId = destination === "FUNCIONARIO" ? id(raw.thirdPartyEmployeeId) : null;
  const purpose = destination === "FUNCIONARIO" && isFuelPurpose(raw.purpose) ? raw.purpose : null;
  return {
    thirdPartyId, companyLabel: clean(raw.companyLabel, 160), pendingCompany,
    destination,
    thirdPartyVehicleId: vehicleId, vehicleLabel: destination === "VEICULO" ? clean(raw.vehicleLabel, 160) : null,
    pendingVehicle: destination === "VEICULO" && !vehicleId ? clean(raw.pendingVehicle, 80) : null,
    thirdPartyEmployeeId: employeeId, employeeLabel: destination === "FUNCIONARIO" ? clean(raw.employeeLabel, 160) : null,
    pendingEmployee: destination === "FUNCIONARIO" && !employeeId ? clean(raw.pendingEmployee, 120) : null,
    purpose, purposeNote: purpose === "OUTROS" ? clean(raw.purposeNote, 200) : null,
    fullTank: destination === "FUNCIONARIO" ? true : raw.fullTank !== false,
  };
}

// Algo ainda depende do aprovador cadastrar ou vincular (empresa, veículo ou funcionário).
export function thirdPartyPending(input: { thirdPartyId: number | null; pendingCompany: string | null; pendingVehicle: string | null; pendingEmployee: string | null; thirdPartyVehicleId: number | null; thirdPartyEmployeeId: number | null }) {
  return !input.thirdPartyId || (Boolean(input.pendingVehicle) && !input.thirdPartyVehicleId) || (Boolean(input.pendingEmployee) && !input.thirdPartyEmployeeId);
}

// Regras de preenchimento (o celular confere antes de guardar; o servidor confere de novo).
// today = dia de hoje (Fortaleza) no momento da conferência; no servidor o registro pode chegar dias
// depois (offline), então a data vale contra o dia em que foi registrado (recordedAt).
// companyKind = tipo da empresa escolhida no cadastro (null quando "Não cadastrado").
export function validateConvoyPayload(input: ConvoyPayload, options: { hasMeterPhoto: boolean; hasPumpPhoto: boolean; pumpPhotoRequired: boolean; today?: string; companyKind?: ThirdPartyKindCode | null }): string | null {
  if (!UUID.test(input.clientUuid)) return "Registro sem identificação. Atualize o app e registre de novo.";
  const third = input.exitKind === "FROTA" ? null : input.thirdParty;
  if (input.exitKind !== "FROTA" && !third) return "Preencha a empresa e o destino.";
  if (!third && !input.equipmentId) return "Escolha o equipamento abastecido.";
  if (third) {
    const problem = validateThirdPartyPart(input.exitKind, third, options.companyKind ?? null);
    if (problem) return problem;
    if (!input.operatorName) return "Informe quem recebeu o combustível (responsável).";
  } else if (!input.operatorName) return "Escolha o motorista/operador do equipamento.";
  if (!Number.isFinite(input.liters) || input.liters <= 0) return "Informe a quantidade em litros.";
  if (input.liters > MAX_LITERS_INPUT) return `Quantidade acima de ${formatNumber(MAX_LITERS_INPUT, 0)} L: confira os litros.`;
  if (input.reading !== null && (!Number.isFinite(input.reading) || input.reading < 0)) return "Informe uma leitura válida (KM ou horímetro).";
  if (Number.isNaN(Date.parse(input.recordedAt))) return "Data e hora do registro inválidas.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recordDate)) return "Data do abastecimento inválida.";
  const reference = options.today ?? fortalezaDay(new Date(input.recordedAt));
  if (input.recordDate > reference) return "A data do abastecimento não pode ser futura.";
  if (input.recordDate !== reference) {
    if (input.recordDate !== previousDay(reference)) return "A data só pode ser hoje ou o dia anterior.";
    if (!input.dateJustification) return "Abastecimento do dia anterior: escreva a justificativa.";
  }
  // Medidor: Frota sempre; terceiro só quando o destino é um veículo (cadastrado ou "Não cadastrado").
  const hasMeter = !third || (third.destination === "VEICULO" && Boolean(third.thirdPartyVehicleId || third.pendingVehicle));
  if (hasMeter && input.noPhoto) {
    if (!input.noPhotoReason) return "Escolha o motivo de estar sem foto do medidor.";
    if (input.noPhotoReason === "OUTRO" && !input.noPhotoNote) return "Escreva o motivo de estar sem foto do medidor.";
  } else if (hasMeter) {
    if (!options.hasMeterPhoto) return "Tire a foto do KM/horímetro (ou marque \"Sem foto do medidor\").";
    if (input.reading === null) return third ? "Informe a leitura do KM/horímetro do veículo." : "Informe a leitura do KM/horímetro.";
  }
  if (options.pumpPhotoRequired && !options.hasPumpPhoto) return "Tire a foto da bomba/totalizador do comboio.";
  return null;
}

// Mesmas regras de lib/third-parties.ts:prepareThirdPartyFuel, com "Não cadastrado" no lugar do cadastro.
function validateThirdPartyPart(exitKind: ConvoyExitKind, third: ConvoyThirdPartyPayload, companyKind: ThirdPartyKindCode | null): string | null {
  if (!third.thirdPartyId && !third.pendingCompany) return "Escolha a empresa (ou marque \"Não cadastrado\" e digite o nome).";
  if (companyKind && !exitKindAccepts(exitKind, companyKind)) return "Prestadores de Serviço aceitam só empresas prestadoras ou terceirizadas. Para pessoa física, use Saída para terceiros.";
  if (!third.destination) return "Escolha o destino: Veículo ou Funcionário.";
  if (third.destination === "FUNCIONARIO") {
    if (!third.thirdPartyEmployeeId && !third.pendingEmployee) return "Escolha o funcionário da empresa que recebeu (ou marque \"Não cadastrado\" e digite o nome).";
    if (!third.purpose) return "Escolha a finalidade (motosserra, gerador, galão/reserva, máquina não cadastrada ou outros).";
    if (third.purpose === "OUTROS" && !third.purposeNote) return "Descreva a finalidade em \"Outros\".";
    return null;
  }
  // Pessoa física pode não ter veículo (igual ao computador). Empresa "Não cadastrada" em Saída para
  // terceiros pode ser pessoa física: o aprovador decide ao cadastrar.
  const vehicleOptional = companyKind === "PESSOA_FISICA" || (!third.thirdPartyId && exitKind === "TERCEIROS");
  if (!third.thirdPartyVehicleId && !third.pendingVehicle && !vehicleOptional) return "Escolha o veículo/máquina da empresa (ou marque \"Não cadastrado\" e digite a placa).";
  return null;
}

// Foto conferida pelo Assistente JC: diverge quando a diferença passa de 0,5% da leitura (mínimo 2 unidades).
export function aiReadingDiverges(typed: number, read: number) {
  return Math.abs(typed - read) > Math.max(2, Math.abs(typed) * 0.005);
}
