// ---------------------------------------------------------------------------
// Importação de abastecimentos por planilha — regras puras (sem banco), usadas pelo servidor
// (lib/fuel-import.ts), pelo gerador do modelo (lib/fuel-import-model.ts) e pela tela.
// ---------------------------------------------------------------------------

// Cabeçalho EXATO do modelo, nesta ordem (aba "Lançamentos").
export const FUEL_IMPORT_COLUMNS = ["data", "tipo", "frente", "origem", "combustivel", "equipamento", "empresa", "litros", "leitura", "tanque_cheio", "motorista", "observacao"] as const;
export type FuelImportColumn = typeof FUEL_IMPORT_COLUMNS[number];
export type FuelImportValues = Record<FuelImportColumn, string>;
export type FuelImportRaw = { rowNumber: number; values: FuelImportValues };

export const FUEL_IMPORT_TYPES = ["SAIDA_FROTA", "SAIDA_TERCEIRO", "SAIDA_PRESTADOR"] as const;
export type FuelImportType = typeof FUEL_IMPORT_TYPES[number];
export const FUEL_IMPORT_TYPE_LABELS: Record<FuelImportType, string> = { SAIDA_FROTA: "Saída frota", SAIDA_TERCEIRO: "Saída terceiro", SAIDA_PRESTADOR: "Saída prestador" };

// Explicação de cada coluna (aba "Instruções" do modelo e ajuda da tela).
export const FUEL_IMPORT_HELP: Record<FuelImportColumn, { required: string; format: string; example: string }> = {
  data: { required: "Sim", format: "DD/MM/AAAA", example: "29/09/2026" },
  tipo: { required: "Sim", format: "SAIDA_FROTA, SAIDA_TERCEIRO ou SAIDA_PRESTADOR", example: "SAIDA_FROTA" },
  frente: { required: "Sim", format: "Nome da frente de serviço (aba Listas)", example: "Arapiuns" },
  origem: { required: "Sim", format: "Estoque de onde saiu o combustível: Frente ou Porto (pode ter o nome da frente)", example: "Frente Arapiuns" },
  combustivel: { required: "Sim", format: "Nome do combustível (aba Listas)", example: "Diesel S10" },
  equipamento: { required: "Sim (terceiro pessoa física pode ficar vazio)", format: "Código da frota (CM-35) ou placa (QVN6E34); para terceiro/prestador, a placa do veículo", example: "CM-35" },
  empresa: { required: "Só para SAIDA_TERCEIRO e SAIDA_PRESTADOR", format: "Nome da empresa/pessoa no cadastro de Terceiros", example: "GREGOLETO" },
  litros: { required: "Sim", format: "Número; aceita 297 ou 297,5", example: "297,5" },
  leitura: { required: "Não (obrigatória para veículo de terceiro)", format: "KM ou horímetro do painel; vazio = sem leitura", example: "411208" },
  tanque_cheio: { required: "Não", format: "SIM ou NAO (vazio = SIM)", example: "SIM" },
  motorista: { required: "Sim", format: "Nome de quem recebeu o combustível", example: "José Sousa" },
  observacao: { required: "Não", format: "Texto livre", example: "Ficha de abastecimento 29/09/2026" },
};

export const importKey = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function emptyValues(): FuelImportValues {
  return Object.fromEntries(FUEL_IMPORT_COLUMNS.map((column) => [column, ""])) as FuelImportValues;
}

// Linha vinda do navegador: só as 12 colunas, como texto aparado.
export function readRawRows(input: unknown, limit = 1000): FuelImportRaw[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, limit).map((item, index) => {
    const source = (item && typeof item === "object" ? item : {}) as { rowNumber?: unknown; values?: Record<string, unknown> };
    const values = emptyValues();
    for (const column of FUEL_IMPORT_COLUMNS) values[column] = String(source.values?.[column] ?? "").trim().slice(0, 300);
    return { rowNumber: Number(source.rowNumber) > 0 ? Math.floor(Number(source.rowNumber)) : index + 2, values };
  });
}

// DD/MM/AAAA (também D/M/AAAA, AAAA-MM-DD e número de série do Excel) → AAAA-MM-DD, ou null.
export function parseImportDate(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let year: number, month: number, day: number;
  const br = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (br) { day = Number(br[1]); month = Number(br[2]); year = Number(br[3]); }
  else if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const date = new Date(Math.round((Number(raw) - 25569) * 86400000));
    year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
  } else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Número em formato brasileiro: 297 | 297,5 | 1.234,50 | 411.208 (milhar). Vazio = null; inválido = NaN.
export function parseImportNumber(value: string): number | null {
  const raw = value.trim().replace(/\s/g, "");
  if (!raw) return null;
  if (!/^-?[\d.,]+$/.test(raw)) return NaN;
  let normalized = raw;
  const comma = raw.lastIndexOf(","), dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) normalized = comma > dot ? raw.replaceAll(".", "").replace(",", ".") : raw.replaceAll(",", "");
  else if (comma >= 0) normalized = raw.replaceAll(".", "").replace(",", ".");
  else if (dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replaceAll(".", "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// SIM/NAO (vazio = SIM). Outro texto = null (erro na linha).
export function parseFullTank(value: string): boolean | null {
  const key = importKey(value);
  if (!key || ["SIM", "S", "TRUE", "1", "X"].includes(key)) return true;
  if (["NAO", "N", "FALSE", "0"].includes(key)) return false;
  return null;
}

export function parseImportType(value: string): FuelImportType | null {
  const key = importKey(value);
  return FUEL_IMPORT_TYPES.find((type) => importKey(type) === key) ?? null;
}

// Origem: estoque Porto quando o texto fala em porto; senão Frente.
export const originLocation = (value: string): "FRENTE" | "PORTO" => (importKey(value).includes("PORTO") ? "PORTO" : "FRENTE");

// Consumo estimado entre a leitura anterior e esta (km/L para KM, L/h para horímetro).
export function estimatedConsumption(unit: "KM" | "HOURS", difference: number | null, liters: number, fullTank: boolean) {
  if (!fullTank || difference === null || difference <= 0 || !(liters > 0)) return null;
  return unit === "KM" ? { value: Math.round((difference / liters) * 100) / 100, unit: "km/L" } : { value: Math.round((liters / difference) * 100) / 100, unit: "L/h" };
}

// Média simples (null com menos de 3 valores: pouca história para comparar).
export function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length >= 3 ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

// Avisos de padrão: salto de leitura > 3× o intervalo médio; litros > 1,5× a média do equipamento.
export const JUMP_FACTOR = 3;
export const LITERS_FACTOR = 1.5;
export function patternWarnings(input: { difference: number | null; averageInterval: number | null; liters: number; averageLiters: number | null; unitLabel: string }) {
  const warnings: string[] = [];
  const fmt = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (input.difference !== null && input.averageInterval !== null && input.difference > input.averageInterval * JUMP_FACTOR)
    warnings.push(`Salto de leitura fora do padrão: ${fmt(input.difference)} ${input.unitLabel} desde o último abastecimento (o normal é ~${fmt(input.averageInterval)} ${input.unitLabel}).`);
  if (input.averageLiters !== null && input.liters > input.averageLiters * LITERS_FACTOR)
    warnings.push(`Litragem acima da média do equipamento (${fmt(input.liters)} L; média ${fmt(input.averageLiters)} L).`);
  return warnings;
}

// Chave de duplicidade: mesmo equipamento/veículo + data + litros + leitura.
export const duplicateKey = (target: string, date: string, liters: number, reading: number | null) => `${target}|${date}|${liters.toFixed(3)}|${reading === null ? "" : reading.toFixed(3)}`;
