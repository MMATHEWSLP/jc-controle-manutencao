import { catalogKey } from "./catalog-rules";
import { nameSimilarity, normalizeProductName } from "./product-rules";

// ---------------------------------------------------------------------------------------------
// Importação do histórico de movimentações do almoxarifado antigo (Produtos → Importar
// movimentações). Só regras puras, sem banco: leitura das células, casamento com os cadastros,
// sugestões de produto, duplicidade e totais. O banco fica em lib/stock-history-import.ts; o script
// scripts/import-movimentacoes-estoque.ts usa estas mesmas funções para a simulação.
//
// REGRA PRINCIPAL: por padrão tudo entra como HISTÓRICO (affects_balance = FALSE). O saldo carregado
// do "Relatório Geral de Estoque Completo" de 07/09/2026 já reflete essas saídas. Só as saídas
// posteriores à data de corte podem baixar estoque, e só se o ADMIN marcar isso na prévia.
// ---------------------------------------------------------------------------------------------

export const HISTORY_ORIGIN = "IMPORTACAO_SISTEMA_ANTIGO";
export const DEFAULT_CUTOFF_DATE = "2026-09-07";
export const DEFAULT_FRONT_NAME = "Arapiuns";
export const HISTORY_IMPORT_SHEET = "Importar";
export const HISTORY_BLOCK_SIZE = 500;
export const HISTORY_MAX_ROWS = 20000;

export const HISTORY_COLUMNS = [
  "data", "tipo", "produto", "quantidade", "valor_unitario", "valor_total", "equipamento", "chassi_serie",
  "proprietario", "descricao_equipamento", "local_destino", "colaborador", "departamento",
] as const;
export type HistoryColumn = typeof HISTORY_COLUMNS[number];

// Cabeçalho exato do modelo (o mesmo da aba "Importar" da planilha limpa).
export const HISTORY_HEADERS: Record<HistoryColumn, string> = {
  data: "Data", tipo: "Tipo", produto: "Produto", quantidade: "Quantidade", valor_unitario: "Valor Unitário", valor_total: "Valor Total",
  equipamento: "Equipamento", chassi_serie: "Chassi/Série", proprietario: "Proprietário", descricao_equipamento: "Descrição equipamento",
  local_destino: "Local/Destino", colaborador: "Colaborador", departamento: "Departamento",
};

export const HISTORY_HELP: Record<HistoryColumn, { required: string; format: string; example: string }> = {
  data: { required: "sim", format: "Data real da movimentação (data do Excel, DD/MM/AAAA ou AAAA-MM-DD). Não pode ser futura.", example: "08/01/2026" },
  tipo: { required: "sim", format: "SAIDA (consumo) ou AJUSTE (Correção de Estoque — fica fora dos relatórios de consumo).", example: "SAIDA" },
  produto: { required: "sim", format: "Nome do produto. Casa com o cadastro sem acento, sem diferença de maiúsculas e com espaços normalizados.", example: "CAT ÓLEO SAE 15W40 20L" },
  quantidade: { required: "sim", format: "Maior que zero. Aceita decimal (vírgula ou ponto).", example: "5" },
  valor_unitario: { required: "sim", format: "R$ por unidade (pode ser 0).", example: "17,50" },
  valor_total: { required: "não", format: "Quantidade × valor unitário. Vazio = calculado.", example: "87,50" },
  equipamento: { required: "não", format: "Código (CM-22, SK-02, PC-27...) ou placa (RXH4G16). Não encontrado = guardado como texto.", example: "TE-02" },
  chassi_serie: { required: "não", format: "Chassi ou série. Usado para achar o equipamento quando o código não casa.", example: "LJR01320" },
  proprietario: { required: "não", format: "Texto livre (empresa dona do equipamento).", example: "DWE EMPREENDIMENTOS" },
  descricao_equipamento: { required: "não", format: "Texto livre.", example: "" },
  local_destino: { required: "não", format: "Texto livre (porto, comunidade, oficina...).", example: "PORTO BOA VENTURA" },
  colaborador: { required: "não", format: "Nome do funcionário. Não encontrado (ou empresa/local) = guardado como texto; nenhum funcionário é criado.", example: "ROBERTO BRAGA DA SILVA" },
  departamento: { required: "não", format: "Nome do departamento cadastrado. Não encontrado = guardado como texto. Vazio = sem departamento.", example: "Manutenção e Gestão da Frota" },
};

export type HistoryCell = string | number | boolean | null;
export type HistoryRawRow = { rowNumber: number; values: HistoryCell[] };
export type HistoryKind = "SAIDA" | "AJUSTE";

// Mesma comparação pedida para os nomes: sem acento, sem diferença de maiúsculas, espaços normalizados.
export function historyNameKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().trim().replace(/\s+/g, " ");
}

// Código/placa/chassi: só letras e números ("CM-22" = "CM 22" = "cm22").
export function equipmentKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function headerKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Posição de cada coluna do modelo na linha de cabeçalho (−1 = ausente).
export function locateHistoryColumns(header: unknown[]) {
  const keys = header.map(headerKey);
  const index = Object.fromEntries(HISTORY_COLUMNS.map((column) => [column, keys.indexOf(headerKey(HISTORY_HEADERS[column]))])) as Record<HistoryColumn, number>;
  const missing = HISTORY_COLUMNS.filter((column) => index[column] < 0 && column !== "valor_total");
  return { index, missing };
}

// Linhas da matriz (planilha já lida) no formato do modelo: acha o cabeçalho nas 25 primeiras linhas.
export function historyRowsFromMatrix(matrix: unknown[][]): HistoryRawRow[] {
  const headerIndex = matrix.slice(0, 25).findIndex((row) => {
    const keys = (row ?? []).map(headerKey);
    return keys.includes("DATA") && keys.includes("PRODUTO") && keys.includes("QUANTIDADE") && keys.includes("TIPO");
  });
  if (headerIndex < 0) throw new Error("Cabeçalho diferente do modelo: não encontrei as colunas Data, Tipo, Produto e Quantidade. Use a aba \"Importar\" ou baixe o modelo.");
  const { index, missing } = locateHistoryColumns(matrix[headerIndex] ?? []);
  if (missing.length) throw new Error(`Faltam colunas do modelo: ${missing.map((column) => HISTORY_HEADERS[column]).join(", ")}.`);
  const rows: HistoryRawRow[] = [];
  matrix.slice(headerIndex + 1).forEach((row, offset) => {
    const values = HISTORY_COLUMNS.map((column) => {
      const value = index[column] < 0 ? null : (row ?? [])[index[column]];
      if (value === undefined || value === null) return null;
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === "number" || typeof value === "boolean") return value;
      const text = String(value).trim();
      return text === "" ? null : text;
    });
    if (values.some((value) => value !== null)) rows.push({ rowNumber: headerIndex + offset + 2, values });
  });
  return rows;
}

// Corpo da requisição → linhas brutas (defensivo: o servidor nunca confia no formato da tela).
export function readHistoryRawRows(input: unknown, max = HISTORY_MAX_ROWS): HistoryRawRow[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, max).map((item, index) => {
    const row = item as { rowNumber?: unknown; values?: unknown };
    const values = Array.isArray(row?.values) ? row.values : [];
    return {
      rowNumber: Number.isInteger(Number(row?.rowNumber)) ? Number(row.rowNumber) : index + 2,
      values: HISTORY_COLUMNS.map((_, position) => {
        const value = values[position];
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "boolean") return value;
        if (value === null || value === undefined) return null;
        const text = String(value).trim().slice(0, 300);
        return text === "" ? null : text;
      }),
    };
  });
}

function cellText(value: HistoryCell) {
  return value === null || value === undefined ? "" : String(value).trim().replace(/\s+/g, " ");
}

// Número: célula numérica direto; texto no formato brasileiro (vírgula decimal, ponto de milhar).
export function parseHistoryNumber(value: HistoryCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let raw = cellText(value).replace(/^R\$\s*/i, "").replace(/\s+/g, "");
  if (!raw) return null;
  if (!/^-?[\d.,]+$/.test(raw)) return null;
  const comma = raw.lastIndexOf(","), dot = raw.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) raw = comma > dot ? raw.replaceAll(".", "").replace(",", ".") : raw.replaceAll(",", "");
  else if (comma >= 0) raw = raw.replaceAll(".", "").replace(",", ".");
  else if (dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replaceAll(".", "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const validDay = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
};

// Data → AAAA-MM-DD. Aceita número de série do Excel, AAAA-MM-DD (com ou sem hora) e DD/MM/AAAA.
export function parseHistoryDate(value: HistoryCell): string | null {
  if (typeof value === "number") {
    if (value < 20000 || value > 80000) return null;
    const date = new Date(Math.round((value - 25569) * 86400000));
    return validDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const raw = cellText(value);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) return validDay(Number(br[3]), Number(br[2]), Number(br[1]));
  return null;
}

export function parseHistoryKind(value: HistoryCell): HistoryKind | null {
  const key = headerKey(value);
  if (key === "SAIDA") return "SAIDA";
  if (key === "AJUSTE" || key === "CORRECAO" || key === "CORRECAODEESTOQUE") return "AJUSTE";
  return null;
}

export type HistoryParsedRow = {
  rowNumber: number; date: string | null; kind: HistoryKind | null; productName: string; productKey: string;
  quantity: number | null; unitPrice: number | null; total: number;
  equipment: string; chassis: string; owner: string; equipmentDescription: string; destination: string; employee: string; department: string;
  errors: string[]; warnings: string[];
};

export function parseHistoryRow(raw: HistoryRawRow, today: string): HistoryParsedRow {
  const cell = (column: HistoryColumn) => raw.values[HISTORY_COLUMNS.indexOf(column)] ?? null;
  const errors: string[] = [], warnings: string[] = [];
  const date = parseHistoryDate(cell("data"));
  if (!date) errors.push(cellText(cell("data")) ? "Data inválida." : "Data não informada.");
  else if (date > today) errors.push("Data futura.");
  const kind = parseHistoryKind(cell("tipo"));
  if (!kind) errors.push(`Tipo inválido (${cellText(cell("tipo")) || "vazio"}): use SAIDA ou AJUSTE.`);
  const productName = cellText(cell("produto"));
  if (!productName) errors.push("Produto não informado.");
  const quantity = parseHistoryNumber(cell("quantidade"));
  if (quantity === null) errors.push("Quantidade inválida.");
  else if (!(quantity > 0)) errors.push("A quantidade precisa ser maior que zero.");
  let unitPrice = parseHistoryNumber(cell("valor_unitario"));
  const totalCell = parseHistoryNumber(cell("valor_total"));
  if (unitPrice === null && totalCell !== null && quantity && quantity > 0) unitPrice = totalCell / quantity;
  if (unitPrice === null) errors.push(cellText(cell("valor_unitario")) ? "Valor unitário inválido." : "Valor unitário não informado.");
  else if (unitPrice < 0) errors.push("Valor unitário negativo.");
  const computed = quantity !== null && unitPrice !== null ? quantity * unitPrice : 0;
  const total = totalCell ?? computed;
  if (totalCell !== null && quantity !== null && unitPrice !== null && Math.abs(totalCell - computed) > 0.05) {
    warnings.push(`Valor total (${totalCell.toFixed(2)}) diferente de quantidade × unitário (${computed.toFixed(2)}).`);
  }
  if (unitPrice === 0) warnings.push("Valor unitário zero.");
  return {
    rowNumber: raw.rowNumber, date, kind, productName, productKey: historyNameKey(productName), quantity, unitPrice, total: errors.length ? 0 : total,
    equipment: cellText(cell("equipamento")), chassis: cellText(cell("chassi_serie")), owner: cellText(cell("proprietario")),
    equipmentDescription: cellText(cell("descricao_equipamento")), destination: cellText(cell("local_destino")),
    employee: cellText(cell("colaborador")), department: cellText(cell("departamento")), errors, warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Contexto (cadastros e lançamentos já existentes) e decisões da prévia.
// ---------------------------------------------------------------------------------------------
export type HistoryProduct = { id: number; tag: string; name: string; price: number; active: boolean };
export type HistoryEquipment = { id: number; code: string; prefix: string; plate: string | null; chassis: string | null; serialNumber: string | null };
export type HistoryContext = {
  products: HistoryProduct[];
  equipment: HistoryEquipment[];
  employees: Array<{ id: number; name: string }>;
  departments: Array<{ id: number; name: string }>;
  fronts: Array<{ id: number; name: string }>;
  // Saídas lançadas pelo sistema novo (Movimentação, O.S., etc.), não estornadas, no período da planilha.
  systemExits: Array<{ id: number; day: string; productId: number; quantity: number; equipmentId: number | null; employeeId: number | null; source: string }>;
  // Linhas de lotes de histórico já importados (ativos), para não importar a mesma planilha duas vezes.
  importedHistory: Array<{ day: string; productNameKey: string; quantity: number; kind: string; employeeKey: string; equipmentKey: string }>;
  // Saldo atual por produto na frente escolhida.
  balances: Map<number, number>;
};

export type ProductDecision = { action: "LINK"; productId: number } | { action: "CREATE" } | { action: "SKIP" };
export type HistoryOptions = { frontId: number; cutoffDate: string; applyBalance: boolean; decisions: Record<string, ProductDecision>; today: string };

export function parseDecisions(input: unknown): Record<string, ProductDecision> {
  const output: Record<string, ProductDecision> = {};
  if (!input || typeof input !== "object") return output;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const decision = value as { action?: unknown; productId?: unknown };
    if (decision?.action === "LINK" && Number.isInteger(Number(decision.productId)) && Number(decision.productId) > 0) output[historyNameKey(key)] = { action: "LINK", productId: Number(decision.productId) };
    else if (decision?.action === "CREATE") output[historyNameKey(key)] = { action: "CREATE" };
    else if (decision?.action === "SKIP") output[historyNameKey(key)] = { action: "SKIP" };
  }
  return output;
}

// Casamento do produto pelo nome. Nome repetido no cadastro: fica o ativo; se ainda sobrar mais de
// um, é ambíguo e vai para a lista de escolha (com os candidatos como sugestão).
export function buildProductIndex(products: HistoryProduct[]) {
  const byKey = new Map<string, HistoryProduct[]>();
  for (const product of products) {
    const key = historyNameKey(product.name);
    byKey.set(key, [...(byKey.get(key) ?? []), product]);
  }
  return (key: string): { product: HistoryProduct | null; candidates: HistoryProduct[] } => {
    const list = byKey.get(key) ?? [];
    if (list.length === 1) return { product: list[0], candidates: list };
    const active = list.filter((product) => product.active);
    if (active.length === 1) return { product: active[0], candidates: list };
    return { product: null, candidates: list };
  };
}

function trigrams(value: string) {
  const text = ` ${value} `;
  const set = new Set<string>();
  for (let index = 0; index < text.length - 2; index++) set.add(text.slice(index, index + 3));
  return set;
}

// Os N produtos mais parecidos (pré-filtro por trigramas, depois a mesma medida do aviso de nome
// parecido do cadastro — lib/product-rules.ts). Sem limite mínimo: sempre devolve os N melhores.
export function productSuggester(products: HistoryProduct[]) {
  const prepared = products.map((product) => ({ product, grams: trigrams(normalizeProductName(product.name)) }));
  return (name: string, limit = 3) => {
    const grams = trigrams(normalizeProductName(name));
    const rough = prepared.map((entry) => {
      let shared = 0;
      for (const gram of grams) if (entry.grams.has(gram)) shared++;
      return { entry, score: (2 * shared) / (grams.size + entry.grams.size || 1) };
    }).sort((a, b) => b.score - a.score).slice(0, 40);
    return rough.map(({ entry }) => ({ id: entry.product.id, tag: entry.product.tag, name: entry.product.name, price: entry.product.price, active: entry.product.active, score: nameSimilarity(name, entry.product.name) }))
      .sort((a, b) => b.score - a.score).slice(0, limit)
      .map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
  };
}

export function buildEquipmentIndex(list: HistoryEquipment[]) {
  const byCode = new Map<string, HistoryEquipment>(), byChassis = new Map<string, HistoryEquipment>();
  for (const item of list) {
    for (const value of [item.code, item.prefix, item.plate]) { const key = equipmentKey(value); if (key && !byCode.has(key)) byCode.set(key, item); }
    for (const value of [item.chassis, item.serialNumber]) { const key = equipmentKey(value); if (key.length >= 5 && !byChassis.has(key)) byChassis.set(key, item); }
  }
  return (code: string, chassis: string) => {
    const byCodeMatch = code ? byCode.get(equipmentKey(code)) : undefined;
    if (byCodeMatch) return byCodeMatch;
    const chassisKey = equipmentKey(chassis);
    return chassisKey.length >= 5 ? byChassis.get(chassisKey) ?? null : null;
  };
}

// ---------------------------------------------------------------------------------------------
// Análise completa (prévia). A confirmação roda esta MESMA função de novo no servidor.
// ---------------------------------------------------------------------------------------------
export type HistoryRowStatus = "IMPORTAR" | "DUPLICADO" | "ERRO" | "PRODUTO_PENDENTE" | "IGNORADO";
export type HistoryResolvedRow = HistoryParsedRow & {
  status: HistoryRowStatus;
  productId: number | null; createProduct: boolean;
  equipmentId: number | null; employeeId: number | null; departmentId: number | null;
  affectsBalance: boolean; duplicateOf: string | null;
};

export type UnmatchedProduct = {
  key: string; name: string; rows: number; quantity: number; value: number; unitPrice: number; firstDate: string | null; lastDate: string | null;
  ambiguous: boolean; suggestions: ReturnType<ReturnType<typeof productSuggester>>; decision: ProductDecision | null;
};
type Tally = { text: string; rows: number };

const round2 = (value: number) => Math.round(value * 100) / 100;
const qtyKey = (value: number) => String(Math.round(value * 1000) / 1000);

export function analyzeHistory(rawRows: HistoryRawRow[], context: HistoryContext, options: HistoryOptions) {
  const findProduct = buildProductIndex(context.products);
  const suggest = productSuggester(context.products);
  const findEquipment = buildEquipmentIndex(context.equipment);
  const productsById = new Map(context.products.map((product) => [product.id, product]));
  const employeesByKey = new Map<string, number>();
  for (const employee of context.employees) { const key = historyNameKey(employee.name); if (!employeesByKey.has(key)) employeesByKey.set(key, employee.id); }
  const departmentsByKey = new Map(context.departments.map((department) => [catalogKey(department.name), department.id]));

  // Saídas do sistema novo por data|produto|quantidade (cada uma casa com no máximo uma linha).
  const systemByKey = new Map<string, Array<HistoryContext["systemExits"][number] & { used?: boolean }>>();
  for (const exit of context.systemExits) {
    const key = `${exit.day}|${exit.productId}|${qtyKey(exit.quantity)}`;
    systemByKey.set(key, [...(systemByKey.get(key) ?? []), { ...exit }]);
  }
  const historyCount = new Map<string, number>();
  const historyKey = (day: string, nameKey: string, quantity: number, kind: string, employee: string, equipment: string) => `${day}|${nameKey}|${qtyKey(quantity)}|${kind}|${employee}|${equipment}`;
  for (const item of context.importedHistory) {
    const key = historyKey(item.day, item.productNameKey, item.quantity, item.kind, item.employeeKey, item.equipmentKey);
    historyCount.set(key, (historyCount.get(key) ?? 0) + 1);
  }

  const unmatched = new Map<string, UnmatchedProduct>();
  const equipmentMissing = new Map<string, Tally>(), employeesMissing = new Map<string, Tally>(), departmentsMissing = new Map<string, Tally>();
  const tally = (map: Map<string, Tally>, text: string) => { const key = historyNameKey(text); const entry = map.get(key) ?? { text, rows: 0 }; entry.rows++; map.set(key, entry); };
  let equipmentMatchedRows = 0, employeeMatchedRows = 0, departmentMatchedRows = 0;

  const rows: HistoryResolvedRow[] = rawRows.map((raw) => {
    const parsed = parseHistoryRow(raw, options.today);
    const row: HistoryResolvedRow = { ...parsed, status: "IMPORTAR", productId: null, createProduct: false, equipmentId: null, employeeId: null, departmentId: null, affectsBalance: false, duplicateOf: null };
    if (parsed.errors.length) { row.status = "ERRO"; return row; }

    // Produto
    const found = findProduct(parsed.productKey);
    const decision = options.decisions[parsed.productKey] ?? null;
    if (found.product) row.productId = found.product.id;
    else {
      const entry = unmatched.get(parsed.productKey) ?? {
        key: parsed.productKey, name: parsed.productName, rows: 0, quantity: 0, value: 0, unitPrice: parsed.unitPrice ?? 0, firstDate: parsed.date, lastDate: parsed.date,
        ambiguous: found.candidates.length > 1,
        suggestions: found.candidates.length > 1
          ? found.candidates.slice(0, 3).map((product) => ({ id: product.id, tag: product.tag, name: product.name, price: product.price, active: product.active, score: 1 }))
          : suggest(parsed.productName, 3),
        decision,
      };
      entry.rows++; entry.quantity += parsed.quantity ?? 0; entry.value += parsed.total;
      if (parsed.date && (!entry.lastDate || parsed.date >= entry.lastDate)) { entry.lastDate = parsed.date; entry.unitPrice = parsed.unitPrice ?? entry.unitPrice; }
      if (parsed.date && (!entry.firstDate || parsed.date < entry.firstDate)) entry.firstDate = parsed.date;
      unmatched.set(parsed.productKey, entry);
      if (decision?.action === "LINK" && productsById.has(decision.productId)) row.productId = decision.productId;
      else if (decision?.action === "CREATE") row.createProduct = true;
      else if (decision?.action === "SKIP") row.status = "IGNORADO";
      else row.status = "PRODUTO_PENDENTE";
    }

    // Equipamento (código/placa; chassi/série como reserva), colaborador e departamento.
    if (parsed.equipment || parsed.chassis) {
      const equipment = findEquipment(parsed.equipment, parsed.chassis);
      if (equipment) { row.equipmentId = equipment.id; equipmentMatchedRows++; }
      else tally(equipmentMissing, parsed.equipment || `(chassi ${parsed.chassis})`);
    }
    if (parsed.employee) {
      const employeeId = employeesByKey.get(historyNameKey(parsed.employee)) ?? null;
      if (employeeId) { row.employeeId = employeeId; employeeMatchedRows++; }
      else tally(employeesMissing, parsed.employee);
    }
    // AJUSTE vem com o "departamento" Correção de Estoque, que é o próprio tipo — não é departamento.
    if (parsed.department && parsed.kind === "SAIDA") {
      const departmentId = departmentsByKey.get(catalogKey(parsed.department)) ?? null;
      if (departmentId) { row.departmentId = departmentId; departmentMatchedRows++; }
      else tally(departmentsMissing, parsed.department);
    }

    // Duplicidade: lote de histórico já importado (mesma linha) ou saída já lançada no sistema novo
    // (mesma data + produto + quantidade + colaborador/equipamento).
    if (row.status === "IMPORTAR" || row.status === "PRODUTO_PENDENTE") {
      const key = historyKey(parsed.date!, parsed.productKey, parsed.quantity!, parsed.kind!, historyNameKey(parsed.employee), equipmentKey(parsed.equipment));
      const count = historyCount.get(key) ?? 0;
      if (count > 0) { historyCount.set(key, count - 1); row.status = "DUPLICADO"; row.duplicateOf = "Já importado em um lote anterior"; return row; }
    }
    if (row.status === "IMPORTAR" && row.productId && parsed.kind === "SAIDA") {
      const candidates = systemByKey.get(`${parsed.date}|${row.productId}|${qtyKey(parsed.quantity!)}`) ?? [];
      const match = candidates.find((exit) => !exit.used && ((row.equipmentId !== null && exit.equipmentId === row.equipmentId) || (row.employeeId !== null && exit.employeeId === row.employeeId)));
      if (match) { match.used = true; row.status = "DUPLICADO"; row.duplicateOf = `Já lançada no sistema (${match.source === "WORK_ORDER" ? "O.S." : match.source === "STOCK_EXIT" ? "Movimentação" : match.source} #${match.id})`; return row; }
    }

    // Só saída posterior ao corte baixa estoque, e só com a opção marcada.
    row.affectsBalance = options.applyBalance && parsed.kind === "SAIDA" && parsed.date! > options.cutoffDate && row.status === "IMPORTAR";
    return row;
  });

  // Totais
  const valid = rows.filter((row) => row.status !== "ERRO");
  const importable = rows.filter((row) => row.status === "IMPORTAR");
  const sum = (list: HistoryResolvedRow[]) => round2(list.reduce((total, row) => total + row.total, 0));
  const dates = valid.map((row) => row.date!).sort();

  // Saídas posteriores ao corte que ainda não estão no sistema novo: impacto no saldo por produto.
  const after = rows.filter((row) => row.kind === "SAIDA" && row.date && row.date > options.cutoffDate && (row.status === "IMPORTAR" || row.status === "PRODUTO_PENDENTE"));
  const impact = new Map<string, { productId: number | null; tag: string | null; name: string; rows: number; quantity: number; value: number; balance: number }>();
  for (const row of after) {
    const product = row.productId ? productsById.get(row.productId) : undefined;
    const key = row.productId ? `#${row.productId}` : row.productKey;
    const entry = impact.get(key) ?? { productId: row.productId, tag: product?.tag ?? null, name: product?.name ?? row.productName, rows: 0, quantity: 0, value: 0, balance: row.productId ? context.balances.get(row.productId) ?? 0 : 0 };
    entry.rows++; entry.quantity += row.quantity!; entry.value += row.total;
    impact.set(key, entry);
  }
  const impactList = [...impact.values()].map((item) => ({ ...item, quantity: Math.round(item.quantity * 1000) / 1000, value: round2(item.value), after: Math.round((item.balance - item.quantity) * 1000) / 1000 }))
    .sort((a, b) => b.value - a.value);

  const sortTally = (map: Map<string, Tally>) => [...map.values()].sort((a, b) => b.rows - a.rows || a.text.localeCompare(b.text));
  const unmatchedList = [...unmatched.values()].map((item) => ({ ...item, quantity: Math.round(item.quantity * 1000) / 1000, value: round2(item.value) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  // Só trava a confirmação o produto que ainda tem linha a importar (todas duplicadas = nada a decidir).
  const pendingKeys = new Set(rows.filter((row) => row.status === "PRODUTO_PENDENTE").map((row) => row.productKey));
  const pending = unmatchedList.filter((item) => pendingKeys.has(item.key));

  return {
    rows,
    summary: {
      totalRows: rows.length, validRows: valid.length,
      exits: valid.filter((row) => row.kind === "SAIDA").length, adjustments: valid.filter((row) => row.kind === "AJUSTE").length,
      totalValue: sum(valid), exitsValue: sum(valid.filter((row) => row.kind === "SAIDA")), adjustmentsValue: sum(valid.filter((row) => row.kind === "AJUSTE")),
      errors: rows.filter((row) => row.status === "ERRO").length,
      duplicates: rows.filter((row) => row.status === "DUPLICADO").length,
      pendingProductRows: rows.filter((row) => row.status === "PRODUTO_PENDENTE").length,
      skippedRows: rows.filter((row) => row.status === "IGNORADO").length,
      toImport: importable.length, toImportValue: sum(importable),
      toImportExits: importable.filter((row) => row.kind === "SAIDA").length, toImportAdjustments: importable.filter((row) => row.kind === "AJUSTE").length,
      balanceRows: importable.filter((row) => row.affectsBalance).length,
      warnings: rows.filter((row) => row.warnings.length).length,
      dateFrom: dates[0] ?? null, dateTo: dates.at(-1) ?? null,
      productsMatched: new Set(valid.filter((row) => row.productId && !unmatched.has(row.productKey)).map((row) => row.productKey)).size,
      productsUnmatched: unmatchedList.length, productsPending: pending.length,
      equipmentMatchedRows, employeeMatchedRows, departmentMatchedRows,
    },
    unmatchedProducts: unmatchedList,
    unmatchedEquipment: sortTally(equipmentMissing),
    unmatchedEmployees: sortTally(employeesMissing),
    unmatchedDepartments: sortTally(departmentsMissing),
    duplicates: rows.filter((row) => row.status === "DUPLICADO").map((row) => ({ rowNumber: row.rowNumber, date: row.date, product: row.productName, quantity: row.quantity, employee: row.employee, equipment: row.equipment, reason: row.duplicateOf })),
    errors: rows.filter((row) => row.status === "ERRO").map((row) => ({ rowNumber: row.rowNumber, product: row.productName, messages: row.errors })),
    warnings: rows.filter((row) => row.warnings.length && row.status !== "ERRO").map((row) => ({ rowNumber: row.rowNumber, product: row.productName, messages: row.warnings })),
    afterCutoff: {
      cutoffDate: options.cutoffDate, rows: after.length, value: sum(after),
      quantity: Math.round(after.reduce((total, row) => total + row.quantity!, 0) * 1000) / 1000,
      pendingProductRows: after.filter((row) => row.status === "PRODUTO_PENDENTE").length,
      products: impactList, applied: options.applyBalance,
    },
  };
}
export type HistoryAnalysis = ReturnType<typeof analyzeHistory>;

// Prévia enviada à tela: sem a lista completa de linhas (9 mil linhas não cabem numa tabela útil).
export function historyPreview(analysis: HistoryAnalysis, limit = 500) {
  const { rows: _rows, ...rest } = analysis;
  void _rows;
  return {
    ...rest,
    duplicates: rest.duplicates.slice(0, limit), errors: rest.errors.slice(0, limit), warnings: rest.warnings.slice(0, limit),
    truncated: { duplicates: rest.duplicates.length > limit, errors: rest.errors.length > limit, warnings: rest.warnings.length > limit },
  };
}

export function chunk<T>(list: T[], size = HISTORY_BLOCK_SIZE) {
  const output: T[][] = [];
  for (let index = 0; index < list.length; index += size) output.push(list.slice(index, index + size));
  return output;
}

export function historyReason(kind: HistoryKind) {
  return kind === "AJUSTE" ? "Correção de Estoque (histórico do sistema antigo)" : "Saída (histórico do sistema antigo)";
}
