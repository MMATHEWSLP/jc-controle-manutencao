// Lógica compartilhada entre o script de importação em massa
// (scripts/import-produtos.ts) e a futura rota de importação via tela
// (POST /api/products/import) — mantém as duas em sintonia sem duplicar regra.
//
// needsReviewData é importado como módulo (não lido do disco em runtime com fs) de propósito:
// um `readFileSync` relativo a `import.meta.url` quebra tanto no build standalone do Next.js
// (que só empacota o que consegue rastrear estaticamente) quanto nos testes empacotados pelo
// esbuild (que reescrevem import.meta.url para o arquivo de saída). Import estático resolve os
// dois problemas de uma vez.
import needsReviewData from "../scripts/import-produtos/data/needs-review.json";

// Compara texto ignorando acentuação, caixa e espaçamento — usado para casar
// "aplicacao" do CSV com equipment_models.name sem exigir grafia idêntica.
export function normalizeMatchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
}

const GENERIC_APPLICATION_SUFFIX = /\(MODELO A DEFINIR\)\s*$/i;

export function isGenericApplication(value: string): boolean {
  return GENERIC_APPLICATION_SUFFIX.test(value.trim());
}

export type EquipmentModelLookup = { id: number; name: string };

// Vínculo 1:1: a "aplicacao" do CSV precisa bater exatamente (ignorando
// acento/caixa/espaço) com o nome de um modelo já cadastrado. Sem match difuso
// aqui — a lista de modelos é curada e o CSV já traz os nomes na mesma grafia.
export function matchEquipmentModel(application: string, models: EquipmentModelLookup[]): EquipmentModelLookup | null {
  const key = normalizeMatchKey(application);
  return models.find((model) => normalizeMatchKey(model.name) === key) ?? null;
}

// Linhas identificadas manualmente durante a curadoria dos dados como
// artefatos da planilha de origem (uma linha de totais/soma e duas linhas de
// teste) — não são produtos reais e nunca devem virar registros em `products`.
export const GARBAGE_TAGS = new Set(["teste1", "teste2", "Totais"]);

type NeedsReviewEntry = { tag: string; reasons: string[] };

let cachedNeedsReview: Map<string, string[]> | null = null;

// needsReviewData vem da aba "Revisar" da planilha tratada
// (Produtos_Tratados_JC_20260907.xlsx), que já traz por TAG o motivo exato de
// revisão (sem referência, sem preço, aplicação genérica, TAG provisória,
// referência inválida, possível duplicidade, quantidade negativa em estoque).
// Fonte mais precisa que tentar re-derivar a regra só a partir do CSV.
export function loadNeedsReviewReasons(): Map<string, string[]> {
  if (cachedNeedsReview) return cachedNeedsReview;
  cachedNeedsReview = new Map((needsReviewData as NeedsReviewEntry[]).map((entry) => [entry.tag, entry.reasons]));
  return cachedNeedsReview;
}

// Regra geral (seção 3 da especificação), usada pela tela "Importar CSV" para qualquer arquivo
// futuro — diferente de needsReviewFor abaixo, que só serve para reimportar exatamente a base
// histórica de 3.027 produtos (a que já tem a aba "Revisar" bundada em needs-review.json).
export function generalNeedsReview(params: { price: number; applicationIsGeneric: boolean }): boolean {
  return params.price === 0 || params.applicationIsGeneric;
}

export function needsReviewFor(tag: string, price: number): { needsReview: boolean; reasons: string[] } {
  const reasons = loadNeedsReviewReasons().get(tag) ?? [];
  // Rede de segurança: mesmo que a planilha "Revisar" não cubra o caso (ex.: um
  // CSV futuro reimportado com outro preço zerado), preço zero sempre marca revisão,
  // conforme a seção 3 da especificação do módulo.
  if (price === 0 && !reasons.includes("Sem preco unitario")) {
    return { needsReview: true, reasons: [...reasons, "Sem preco unitario"] };
  }
  return { needsReview: reasons.length > 0, reasons };
}

export type ProductCsvRow = {
  tag: string;
  nome: string;
  referencia: string;
  preco: string;
  fornecedor: string;
  marca: string;
  aplicacao: string;
};

// Parser simples e suficiente para o formato conhecido do CSV tratado
// (';' como separador, aspas duplas para escapar ';'/quebras de linha dentro
// de um campo, BOM UTF-8 no início do arquivo). Não usa biblioteca externa
// para manter o script rodável só com `npx tsx`.
export function parseProductsCsv(content: string): ProductCsvRow[] {
  const withoutBom = content.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < withoutBom.length; index++) {
    const character = withoutBom[index];
    if (character === '"') {
      if (quoted && withoutBom[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === ";") {
      row.push(value);
      value = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && withoutBom[index + 1] === "\n") index++;
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
      continue;
    }
    value += character;
  }
  row.push(value);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);

  const [header, ...dataRows] = rows;
  const columns = header.map((column) => column.trim().toLowerCase());
  const index = (name: string) => columns.indexOf(name);
  const tagIndex = index("tag");
  const nomeIndex = index("nome");
  const referenciaIndex = index("referencia");
  const precoIndex = index("preco");
  const fornecedorIndex = index("fornecedor");
  const marcaIndex = index("marca");
  const aplicacaoIndex = index("aplicacao");
  if ([tagIndex, nomeIndex, referenciaIndex, precoIndex, fornecedorIndex, marcaIndex, aplicacaoIndex].some((position) => position < 0)) {
    throw new Error("Cabeçalho do CSV não bate com o esperado (tag;nome;referencia;preco;fornecedor;marca;aplicacao).");
  }
  return dataRows.map((cells) => ({
    tag: (cells[tagIndex] ?? "").trim(),
    nome: (cells[nomeIndex] ?? "").trim(),
    referencia: (cells[referenciaIndex] ?? "").trim(),
    preco: (cells[precoIndex] ?? "").trim(),
    fornecedor: (cells[fornecedorIndex] ?? "").trim(),
    marca: (cells[marcaIndex] ?? "").trim(),
    aplicacao: (cells[aplicacaoIndex] ?? "").trim(),
  }));
}

// Preço no CSV vem sempre com ponto decimal (ex.: "57.00"), mas o mesmo parser
// também atende a tela de cadastro manual, onde o operador digita no formato
// brasileiro (vírgula decimal, ponto de milhar) — mesma heurística de
// lib/excel-client.ts:parseBrazilianReading (olha qual separador aparece por
// último para decidir se é decimal ou milhar).
export function parsePrice(raw: string): number | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^-?[\d.,]+$/.test(value)) return null;
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    value = comma > dot ? value.replaceAll(".", "").replace(",", ".") : value.replaceAll(",", "");
  } else if (comma >= 0) {
    value = value.replaceAll(".", "").replace(",", ".");
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
