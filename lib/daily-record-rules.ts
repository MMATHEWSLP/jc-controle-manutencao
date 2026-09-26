// Regras do Controle Diário, compartilhadas entre o formulário (navegador) e a API
// (servidor): o botão "Revisar e Enviar" só habilita quando validateDailyRecord não
// devolve erro, e o servidor roda exatamente a mesma validação antes de gravar.
// Sem dependências de banco ou de React — testável isoladamente.

export type ProductionType = "BALDEIO" | "PORTO";
export type ReadingUnit = "HOURS" | "KM";

export type FuelingDraft = { liters: string; location: string };
export type TripDraft = { logs: string; meters: string };

export type DailyRecordDraft = {
  recordDate: string;
  equipmentId: number | null;
  workedToday: boolean;
  noWorkReason: string;
  serviceFrontId: number | null;
  location: string;
  startReading: string;
  endReading: string;
  fuelingCount: string;
  fuelings: FuelingDraft[];
  inactiveOrProblem: boolean | null;
  problemReason: string;
  hadProduction: boolean | null;
  productionType: ProductionType | null;
  tripCount: string;
  trips: TripDraft[];
  notes: string;
  hasProblemPhoto: boolean;
  hasProductionPhoto: boolean;
  // Operador confirmou (segundo toque) uma leitura fora do plausível — ver checkReading().
  confirmUnusualReading?: boolean;
};

export type DailyRecordValue = {
  recordDate: string;
  equipmentId: number;
  workedToday: boolean;
  noWorkReason: string | null;
  serviceFrontId: number | null;
  location: string | null;
  startReading: number | null;
  endReading: number | null;
  fuelings: Array<{ liters: number; location: string }>;
  inactiveOrProblem: boolean;
  problemReason: string | null;
  hadProduction: boolean;
  productionType: ProductionType | null;
  trips: Array<{ logs: number; meters: number | null }>;
  notes: string | null;
};

export const MAX_FUELINGS = 20;
export const MAX_TRIPS = 60;

export function emptyFueling(): FuelingDraft { return { liters: "", location: "" }; }
export function emptyTrip(): TripDraft { return { logs: "", meters: "" }; }

// Ajusta a lista de cards dinâmicos ao número digitado: preserva os primeiros
// (com o que já foi preenchido), remove os excedentes a partir do último e
// acrescenta cards vazios quando o número aumenta. Vazio/0/inválido => nenhum card.
export function resizeCards<T>(list: T[], count: string | number, factory: () => T, max: number): T[] {
  const parsed = typeof count === "number" ? count : parseCount(count);
  const target = parsed === null ? 0 : Math.min(Math.max(parsed, 0), max);
  if (target === list.length) return list;
  if (target < list.length) return list.slice(0, target);
  return [...list, ...Array.from({ length: target - list.length }, factory)];
}

export function parseCount(value: string | number | null | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

// Aceita "1.234,5", "1234,5" e "1234.5" (teclado de celular varia).
export function parseDecimal(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim().replace(/\s+/g, "");
  if (!raw) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw) ? raw.replaceAll(".", "").replace(",", ".") : raw.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Mesma regra usada no resto do sistema (lib/maintenance-history.ts): equipamento só KM ou só
// horas segue o cadastro; nos mistos, caminhão "CM-" é por KM e o restante por horímetro.
export function readingUnitFor(controlType: string, prefix: string): ReadingUnit {
  if (controlType === "KM") return "KM";
  if (controlType === "HOURS") return "HOURS";
  return prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").startsWith("CM") ? "KM" : "HOURS";
}

export function readingLabel(unit: ReadingUnit) { return unit === "KM" ? "KM" : "Horímetro"; }

const clean = (value: string | null | undefined) => String(value ?? "").trim();

/**
 * Valida o rascunho e devolve os erros por campo (chaves estáveis usadas pelo formulário,
 * ex.: "fuelings.0.liters") e, quando não há erro, o valor normalizado pronto para gravar.
 * `today` (YYYY-MM-DD) limita datas futuras — tolera 1 dia por causa de fuso horário.
 */
export function validateDailyRecord(draft: DailyRecordDraft, today: string): { errors: Record<string, string>; value: DailyRecordValue | null } {
  const errors: Record<string, string> = {};
  if (!isIsoDate(draft.recordDate)) errors.recordDate = "Informe a data do registro.";
  else if (isIsoDate(today)) {
    const limit = new Date(`${today}T12:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 1);
    if (draft.recordDate > limit.toISOString().slice(0, 10)) errors.recordDate = "A data do registro não pode ser futura.";
  }
  if (!draft.equipmentId || !Number.isInteger(draft.equipmentId) || draft.equipmentId <= 0) errors.equipmentId = "Selecione o equipamento.";

  if (!draft.workedToday) {
    if (!clean(draft.noWorkReason)) errors.noWorkReason = "Informe o motivo por não ter trabalhado.";
    if (Object.keys(errors).length) return { errors, value: null };
    return {
      errors,
      value: {
        recordDate: draft.recordDate, equipmentId: draft.equipmentId!, workedToday: false, noWorkReason: clean(draft.noWorkReason),
        serviceFrontId: null, location: null, startReading: null, endReading: null, fuelings: [],
        inactiveOrProblem: false, problemReason: null, hadProduction: false, productionType: null, trips: [], notes: clean(draft.notes) || null,
      },
    };
  }

  if (!draft.serviceFrontId) errors.serviceFrontId = "Selecione a frente de serviço.";
  if (!clean(draft.location)) errors.location = "Informe a localização.";
  const start = parseDecimal(draft.startReading);
  const end = parseDecimal(draft.endReading);
  if (start === null) errors.startReading = "Informe a leitura inicial.";
  if (end === null) errors.endReading = "Informe a leitura final.";
  if (start !== null && end !== null && end < start) errors.endReading = "A leitura final não pode ser menor que a inicial.";

  const fuelingCount = clean(draft.fuelingCount) === "" ? 0 : parseCount(draft.fuelingCount);
  if (fuelingCount === null || fuelingCount > MAX_FUELINGS) errors.fuelingCount = `Informe um número de 0 a ${MAX_FUELINGS}.`;
  const fuelings = (fuelingCount ? draft.fuelings.slice(0, fuelingCount) : []).map((item, index) => {
    const liters = parseDecimal(item.liters);
    if (liters === null || liters <= 0) errors[`fuelings.${index}.liters`] = "Informe os litros.";
    if (!clean(item.location)) errors[`fuelings.${index}.location`] = "Informe o local/posto.";
    return { liters: liters ?? 0, location: clean(item.location) };
  });
  if (fuelingCount && draft.fuelings.length < fuelingCount) errors.fuelingCount = "Preencha todos os abastecimentos.";

  if (draft.inactiveOrProblem === null) errors.inactiveOrProblem = "Responda se o equipamento ficou inativo ou com problema.";
  if (draft.inactiveOrProblem && !clean(draft.problemReason)) errors.problemReason = "Descreva o motivo.";

  if (draft.hadProduction === null) errors.hadProduction = "Responda se teve produção.";
  let trips: Array<{ logs: number; meters: number | null }> = [];
  if (draft.hadProduction) {
    if (!draft.productionType) errors.productionType = "Selecione o tipo de produção.";
    const tripCount = parseCount(draft.tripCount);
    if (tripCount === null || tripCount < 1 || tripCount > MAX_TRIPS) errors.tripCount = `Informe a quantidade de viagens (1 a ${MAX_TRIPS}).`;
    else if (draft.trips.length < tripCount) errors.tripCount = "Preencha todas as viagens.";
    const isPort = draft.productionType === "PORTO";
    trips = (tripCount ? draft.trips.slice(0, tripCount) : []).map((item, index) => {
      const logs = parseCount(item.logs);
      if (logs === null || logs <= 0) errors[`trips.${index}.logs`] = "Informe a quantidade de toras.";
      const meters = isPort ? parseDecimal(item.meters) : null;
      if (isPort && (meters === null || meters <= 0)) errors[`trips.${index}.meters`] = "Informe a metragem.";
      return { logs: logs ?? 0, meters };
    });
    if (draft.productionType && !draft.hasProductionPhoto) {
      errors.productionPhoto = draft.productionType === "BALDEIO" ? "Anexe a foto da ficha do baldeio." : "Anexe a foto da produção.";
    }
  }

  if (Object.keys(errors).length) return { errors, value: null };
  return {
    errors,
    value: {
      recordDate: draft.recordDate, equipmentId: draft.equipmentId!, workedToday: true, noWorkReason: null,
      serviceFrontId: draft.serviceFrontId, location: clean(draft.location), startReading: start, endReading: end, fuelings,
      inactiveOrProblem: draft.inactiveOrProblem === true, problemReason: draft.inactiveOrProblem ? clean(draft.problemReason) : null,
      hadProduction: draft.hadProduction === true, productionType: draft.hadProduction ? draft.productionType : null, trips,
      notes: clean(draft.notes) || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Leitura plausível: pega erro de digitação (ex.: um zero a mais) antes de gravar.
// Ajuste os limites aqui — a mesma regra roda na tela e na API (app/api/daily-records).
// ---------------------------------------------------------------------------
export const MAX_HOURS_PER_DAY = 24;
export const MAX_KM_PER_DAY = 800;
// Leitura final maior que N vezes a inicial também é suspeita (dígito a mais).
export const ABSURD_JUMP_FACTOR = 10;

export type ReadingCheck = {
  level: "OK" | "ZERO" | "HIGH" | "INVALID";
  worked: number | null;
  days: number;
  perDay: number | null;
  message: string | null;
};

const readingNumber = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const suffix = (unit: ReadingUnit) => (unit === "KM" ? "km" : "h");
const brDate = (iso: string) => iso.split("-").reverse().join("/");

// Dias entre a última leitura conhecida e a data do registro (mínimo 1).
export function daysBetween(from: string | null, to: string) {
  if (!from || !isIsoDate(from.slice(0, 10)) || !isIsoDate(to)) return 1;
  const diff = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
  return Math.max(1, diff);
}

export function checkReading(input: { unit: ReadingUnit; start: number | null; end: number | null; lastDate: string | null; recordDate: string }): ReadingCheck {
  const days = daysBetween(input.lastDate, input.recordDate);
  const { start, end, unit } = input;
  if (start === null || end === null) return { level: "OK", worked: null, days, perDay: null, message: null };
  const worked = end - start;
  const perDay = worked / days;
  if (worked < 0) {
    return { level: "INVALID", worked, days, perDay, message: `A leitura final (${readingNumber.format(end)} ${suffix(unit)}) é menor que a inicial (${readingNumber.format(start)} ${suffix(unit)}). Confira ${unit === "KM" ? "o odômetro" : "o horímetro"}.` };
  }
  if (worked === 0) return { level: "ZERO", worked, days, perDay, message: "Nenhuma hora/KM trabalhado no período. Confirme se o equipamento ficou parado." };
  const limit = (unit === "KM" ? MAX_KM_PER_DAY : MAX_HOURS_PER_DAY) * days;
  const jump = start > 0 && end > start * ABSURD_JUMP_FACTOR;
  if (worked > limit || jump) {
    const period = days === 1 ? "1 dia" : `${days} dias (desde ${input.lastDate ? brDate(input.lastDate.slice(0, 10)) : "a última leitura"})`;
    return { level: "HIGH", worked, days, perDay, message: `Isso dá ${readingNumber.format(worked)} ${suffix(unit)} trabalhados em ${period}. Confira se digitou o valor certo.` };
  }
  return { level: "OK", worked, days, perDay, message: null };
}
