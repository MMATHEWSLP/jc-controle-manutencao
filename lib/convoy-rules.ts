// ---------------------------------------------------------------------------
// Abastecimentos do comboio — regras puras (sem banco), usadas no celular (avisos na hora, mesmo
// offline com o cadastro baixado) e no servidor (etiquetas da aprovação). Testadas em
// tests/convoy-rules.test.mjs.
// ---------------------------------------------------------------------------
export type ConvoyUnit = "HOURS" | "KM";
export type NoPhotoReason = "OPERADOR_AUSENTE" | "EQUIPAMENTO_FECHADO" | "PAINEL_DEFEITO" | "OUTRO";
export const NO_PHOTO_REASONS: Array<[NoPhotoReason, string]> = [
  ["OPERADOR_AUSENTE", "Operador ausente"], ["EQUIPAMENTO_FECHADO", "Equipamento fechado"], ["PAINEL_DEFEITO", "Painel com defeito"], ["OUTRO", "Outro"],
];
export const NO_PHOTO_LABELS = Object.fromEntries(NO_PHOTO_REASONS) as Record<NoPhotoReason, string>;
export const isNoPhotoReason = (value: unknown): value is NoPhotoReason => NO_PHOTO_REASONS.some(([key]) => key === value);

// Etiquetas da aprovação. Aprovar em lote só vale para itens sem nenhuma etiqueta.
export type ConvoyFlag = "SEM_FOTO" | "LEITURA_MENOR" | "SALTO_ALTO" | "LITRAGEM_ALTA" | "FOTO_DIVERGE";
export const CONVOY_FLAG_LABELS: Record<ConvoyFlag, string> = {
  SEM_FOTO: "SEM FOTO", LEITURA_MENOR: "Leitura menor", SALTO_ALTO: "Salto alto", LITRAGEM_ALTA: "Litragem alta", FOTO_DIVERGE: "Foto diverge",
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
export type ConvoyWarning = { code: Exclude<ConvoyFlag, "SEM_FOTO" | "FOTO_DIVERGE">; message: string };

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
  const stats = input.litersStats;
  if (input.liters > MAX_LITERS_ABSOLUTE) warnings.push({ code: "LITRAGEM_ALTA", message: `Litragem muito alta (${formatNumber(input.liters)} L).` });
  else if (stats && stats.count >= 3 && (input.liters > stats.max * 1.2 || input.liters > stats.average * 1.8))
    warnings.push({ code: "LITRAGEM_ALTA", message: `Litragem acima do normal deste equipamento (média ${formatNumber(stats.average)} L, maior ${formatNumber(stats.max)} L).` });
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

export type ConvoyPayload = {
  clientUuid: string; equipmentId: number; operatorEmployeeId: number | null; operatorName: string; liters: number; reading: number | null;
  recordedAt: string; recordDate: string; dateJustification: string | null; noPhoto: boolean; noPhotoReason: NoPhotoReason | null; noPhotoNote: string | null;
  notes: string | null; latitude: number | null; longitude: number | null; gpsAccuracy: number | null; photoTakenAt: string | null;
  deviceLastReading: number | null; deviceWarnings: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "") || null;
const finite = (value: unknown) => { const number = typeof value === "number" ? value : parseConvoyNumber(value); return number !== null && Number.isFinite(number) ? number : null; };

export function readConvoyPayload(raw: Record<string, unknown>): ConvoyPayload {
  const noPhoto = raw.noPhoto === true;
  const warnings = Array.isArray(raw.deviceWarnings) ? raw.deviceWarnings.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  return {
    clientUuid: typeof raw.clientUuid === "string" ? raw.clientUuid.toLowerCase() : "",
    equipmentId: Number(raw.equipmentId) || 0,
    operatorEmployeeId: Number(raw.operatorEmployeeId) || null,
    operatorName: clean(raw.operatorName, 120) ?? "",
    liters: parseConvoyNumber(raw.liters) ?? NaN,
    reading: parseConvoyNumber(raw.reading),
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

// Regras de preenchimento (o celular confere antes de guardar; o servidor confere de novo).
// today = dia de hoje (Fortaleza) no momento da conferência; no servidor o registro pode chegar dias
// depois (offline), então a data vale contra o dia em que foi registrado (recordedAt).
export function validateConvoyPayload(input: ConvoyPayload, options: { hasMeterPhoto: boolean; hasPumpPhoto: boolean; pumpPhotoRequired: boolean; today?: string }): string | null {
  if (!UUID.test(input.clientUuid)) return "Registro sem identificação. Atualize o app e registre de novo.";
  if (!input.equipmentId) return "Escolha o equipamento abastecido.";
  if (!input.operatorName) return "Escolha o motorista/operador do equipamento.";
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
  if (input.noPhoto) {
    if (!input.noPhotoReason) return "Escolha o motivo de estar sem foto do medidor.";
    if (input.noPhotoReason === "OUTRO" && !input.noPhotoNote) return "Escreva o motivo de estar sem foto do medidor.";
  } else {
    if (!options.hasMeterPhoto) return "Tire a foto do KM/horímetro (ou marque \"Sem foto do medidor\").";
    if (input.reading === null) return "Informe a leitura do KM/horímetro.";
  }
  if (options.pumpPhotoRequired && !options.hasPumpPhoto) return "Tire a foto da bomba/totalizador do comboio.";
  return null;
}

// Foto conferida pelo Assistente JC: diverge quando a diferença passa de 0,5% da leitura (mínimo 2 unidades).
export function aiReadingDiverges(typed: number, read: number) {
  return Math.abs(typed - read) > Math.max(2, Math.abs(typed) * 0.005);
}
