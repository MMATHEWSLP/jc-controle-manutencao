import { emptyValues, FUEL_IMPORT_COLUMNS, importKey, parseImportDate, parseImportType, type FuelImportColumn, type FuelImportValues } from "./fuel-import-rules";

// ---------------------------------------------------------------------------
// Leitor de fichas de abastecimento (Assistente JC) — regras puras aplicadas pelo SERVIDOR sobre o
// JSON que o modelo extraiu das fotos. O modelo lê; estas regras garantem o formato do modelo de
// importação (lib/fuel-import-rules.ts) mesmo que ele esqueça alguma instrução.
// ---------------------------------------------------------------------------
export type FichaDoubt = { coluna: FuelImportColumn; motivo: string };
export type FichaExtraction = {
  data: string; frente: string; combustivel: string; origem: string;
  linhas: Array<Partial<Record<FuelImportColumn, string>> & { duvidas?: FichaDoubt[] }>;
  avisos: string[];
};
export type FichaRow = { values: FuelImportValues; doubts: Partial<Record<FuelImportColumn, string[]>> };

// Esquema de saída estruturada enviado ao modelo (JSON garantido pela API).
export const FICHA_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["data", "frente", "combustivel", "origem", "linhas", "avisos"],
  properties: {
    data: { type: "string", description: "Data do cabeçalho da ficha, DD/MM/AAAA (vazio se ilegível)." },
    frente: { type: "string", description: "Frente de serviço do cabeçalho." },
    combustivel: { type: "string", description: "Combustível do cabeçalho/colunas impressas." },
    origem: { type: "string", description: "Estoque de onde saiu: 'Frente <nome>' ou 'Porto <nome>'." },
    linhas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...FUEL_IMPORT_COLUMNS, "duvidas"],
        properties: {
          ...Object.fromEntries(FUEL_IMPORT_COLUMNS.map((column) => [column, { type: "string" }])),
          duvidas: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["coluna", "motivo"],
              properties: { coluna: { type: "string", enum: [...FUEL_IMPORT_COLUMNS] }, motivo: { type: "string" } },
            },
          },
        },
      },
    },
    avisos: { type: "array", items: { type: "string" } },
  },
} as const;

const LOWER_WORDS = new Set(["da", "das", "de", "do", "dos", "e"]);
// "JOSÉ DE SOUSA" / "josé sousa" → "José de Sousa".
export function titleCaseName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR").split(" ")
    .map((word, index) => (index > 0 && LOWER_WORDS.has(word) ? word : word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1)))
    .join(" ");
}

const OWN_COMPANY = new Set(["", "JC", "JCSERVICOS", "JCSERVICOSFLORESTAIS", "FROTA", "FROTAPROPRIA"]);
export const isOwnCompany = (value: string) => OWN_COMPANY.has(importKey(value));

// Normaliza as linhas extraídas: cabeçalho vale para todas, JC/vazio = frota, leitura 0000 = vazia,
// nomes com iniciais maiúsculas, observação padrão "Ficha de abastecimento DD/MM/AAAA".
export function normalizeFicha(extraction: FichaExtraction): { header: { data: string; frente: string; combustivel: string; origem: string }; rows: FichaRow[]; warnings: string[] } {
  const headerIso = parseImportDate(extraction.data ?? "");
  const headerDate = headerIso ? `${headerIso.slice(8, 10)}/${headerIso.slice(5, 7)}/${headerIso.slice(0, 4)}` : String(extraction.data ?? "").trim();
  const header = { data: headerDate, frente: String(extraction.frente ?? "").trim(), combustivel: String(extraction.combustivel ?? "").trim(), origem: String(extraction.origem ?? "").trim() };
  const warnings = (extraction.avisos ?? []).map((item) => String(item).trim()).filter(Boolean);
  if (!headerIso) warnings.unshift("Data do cabeçalho ilegível: confira a coluna data.");
  const rows: FichaRow[] = [];
  for (const line of extraction.linhas ?? []) {
    const values = emptyValues();
    for (const column of FUEL_IMPORT_COLUMNS) values[column] = String(line[column] ?? "").trim();
    const doubts: FichaRow["doubts"] = {};
    const doubt = (column: FuelImportColumn, reason: string) => { const list = (doubts[column] ??= []); if (!list.includes(reason)) list.push(reason); };
    for (const item of line.duvidas ?? []) if (item && FUEL_IMPORT_COLUMNS.includes(item.coluna) && item.motivo) doubt(item.coluna, String(item.motivo).trim());
    // Linha totalmente vazia (ficha com linhas em branco): ignora.
    if (!values.equipamento && !values.litros && !values.motorista && !values.leitura) continue;
    // A data do cabeçalho vale para todas as linhas (hora ignorada).
    values.data = headerDate || values.data.replace(/\s.*$/, "");
    values.frente = values.frente || header.frente;
    values.combustivel = values.combustivel || header.combustivel;
    values.origem = values.origem || header.origem || (header.frente ? `Frente ${header.frente}` : "");
    if (isOwnCompany(values.empresa)) { values.empresa = ""; values.tipo = "SAIDA_FROTA"; }
    else if (parseImportType(values.tipo) === null || parseImportType(values.tipo) === "SAIDA_FROTA") { values.tipo = "SAIDA_TERCEIRO"; doubt("tipo", "empresa de fora: confira se é terceiro ou prestador"); }
    // Leitura 0000, riscada ou em branco = vazia.
    const reading = values.leitura.replace(/\s/g, "");
    if (!reading || /^[0.,]+$/.test(reading) || /^[-–—xX/\\]+$/.test(reading)) values.leitura = "";
    else values.leitura = reading;
    values.litros = values.litros.replace(/\s/g, "").replace(/l$/i, "");
    values.tanque_cheio = values.tanque_cheio || "SIM";
    values.motorista = values.motorista ? titleCaseName(values.motorista) : "";
    if (!values.motorista) doubt("motorista", "nome do motorista em branco ou ilegível");
    if (!values.litros) doubt("litros", "litros em branco ou ilegível");
    values.observacao = values.observacao || (headerDate ? `Ficha de abastecimento ${headerDate}` : "Ficha de abastecimento");
    rows.push({ values, doubts });
  }
  return { header, rows, warnings };
}
