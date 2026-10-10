// ---------------------------------------------------------------------------
// Regras puras da PRODUÇÃO (Derruba → Arraste → Medição → Transporte), sem banco, testadas em
// tests/production-rules.test.mjs. lib/production.ts busca e grava; aqui ficam situação das etapas,
// filtro de frentes, preço efetivo, funções dos funcionários e os indicadores (saldo, médias, % refugo,
// m³ por árvore), para todas as telas e relatórios fazerem a mesma conta.
// ---------------------------------------------------------------------------

export const PRODUCTION_STAGES = [
  { key: "DERRUBA", label: "Derruba", status: "fellingStatus", notes: "fellingNotes" },
  { key: "ARRASTE", label: "Arraste", status: "skiddingStatus", notes: "skiddingNotes" },
  { key: "MEDICAO", label: "Medição", status: "measurementStatus", notes: "measurementNotes" },
  { key: "TRANSPORTE", label: "Transporte", status: "haulingStatus", notes: "haulingNotes" },
] as const;
export type ProductionStage = typeof PRODUCTION_STAGES[number]["key"];
export type StageStatus = "NAO_INICIADO" | "EM_ANDAMENTO" | "FINALIZADO";
export const STAGE_STATUS_LABELS: Record<StageStatus, string> = { NAO_INICIADO: "-", EM_ANDAMENTO: "Em andamento", FINALIZADO: "Finalizado" };

export function isProductionStage(value: unknown): value is ProductionStage {
  return typeof value === "string" && PRODUCTION_STAGES.some((stage) => stage.key === value);
}
export const stageInfo = (stage: ProductionStage) => PRODUCTION_STAGES.find((item) => item.key === stage)!;

// Finalizar vale para etapa não iniciada ou em andamento (projeto sem arraste, por exemplo); reabrir,
// só para etapa finalizada, que volta a "em andamento".
export function nextStageStatus(current: StageStatus, action: "FINALIZAR" | "REABRIR"): { status: StageStatus } | { error: string } {
  if (action === "FINALIZAR") return current === "FINALIZADO" ? { error: "Esta etapa já está finalizada." } : { status: "FINALIZADO" };
  return current === "FINALIZADO" ? { status: "EM_ANDAMENTO" } : { error: "Só uma etapa finalizada pode ser reaberta." };
}
// Etapa finalizada recusa lançamentos; o primeiro lançamento de uma etapa não iniciada a coloca em andamento.
export const acceptsLaunch = (status: StageStatus) => status !== "FINALIZADO";
export const statusAfterLaunch = (status: StageStatus): StageStatus => (status === "NAO_INICIADO" ? "EM_ANDAMENTO" : status);

// Projetos em andamento primeiro (alguma etapa em andamento), depois em ordem alfabética.
export function compareProjects(a: { name: string; statuses: StageStatus[] }, b: { name: string; statuses: StageStatus[] }) {
  const running = (item: { statuses: StageStatus[] }) => (item.statuses.includes("EM_ANDAMENTO") ? 0 : 1);
  return running(a) - running(b) || a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" });
}

// ---------------------------------------------------------------------------
// Filtro de frentes do módulo (?frentes=1,2). Só restringe: frente que a pessoa não vê é ignorada, e
// uma seleção sem nenhuma frente válida vale como "todas as frentes" que ela vê.
// ---------------------------------------------------------------------------
export function parseFrontIds(raw: string | null | undefined): number[] {
  return [...new Set(String(raw ?? "").split(",").map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0))];
}
export function scopeFrontIds(visible: readonly number[], selected: readonly number[]): number[] {
  const chosen = visible.filter((id) => selected.includes(id));
  return chosen.length ? chosen : [...visible];
}

// Nomes de projeto/equipe: sem espaços sobrando, em maiúsculas (mesmo padrão dos nomes do cadastro).
export const cleanName = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
// Busca sem acento e sem diferenciar maiúsculas.
export const searchKey = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDay = (value: unknown): value is string => typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());
// Período padrão dos filtros: do dia 1º do mês até hoje.
export const monthStartOf = (day: string) => `${day.slice(0, 7)}-01`;

// "1.234,56", "1234,56", "1234.56" ou número. Vazio/inválido = NaN.
export function parseDecimal(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const text = String(value ?? "").trim().replace(/^R\$\s*/i, "");
  if (!text) return Number.NaN;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

// Preço efetivo de um produto na Produção: o da frente, se houver; senão o do cadastro do produto.
export function effectivePrice(productPrice: number | null | undefined, frontPrice: number | null | undefined) {
  return frontPrice !== null && frontPrice !== undefined && Number.isFinite(frontPrice) ? frontPrice : Number(productPrice ?? 0);
}

// ---------------------------------------------------------------------------
// Funções dos funcionários nos autocompletes. As funções do cadastro podem estar desatualizadas, por
// isso as telas oferecem "mostrar todos os funcionários". O mesmo padrão serve no SQL (~*) e aqui.
// ---------------------------------------------------------------------------
export const FUNCTION_GROUPS = {
  MOTOSSERRA: { label: "Operador de motosserra", pattern: "^(OP\\.?|OPERADOR)( DE)? MOTOSSERRA" },
  AJUDANTE_MOTOSSERRA: { label: "Ajudante de motosserra", pattern: "AJUD.*MOTOSSERRA" },
  SKIDDER: { label: "Operador de skidder", pattern: "SKIDD?ER|ARRASTE" },
  MOTORISTA: { label: "Motorista", pattern: "^MOT(ORISTA|\\.)" },
} as const;
export type FunctionGroup = keyof typeof FUNCTION_GROUPS;
export const isFunctionGroup = (value: unknown): value is FunctionGroup => typeof value === "string" && value in FUNCTION_GROUPS;
export const matchesFunctionGroup = (jobTitle: string | null | undefined, group: FunctionGroup) => new RegExp(FUNCTION_GROUPS[group].pattern, "i").test(searchKey(jobTitle ?? ""));

// ---------------------------------------------------------------------------
// Indicadores. null = não dá para calcular (divisão por zero); a tela mostra "—".
// ---------------------------------------------------------------------------
export const roundTo = (value: number, digits: number) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

// Média por dia: árvores ÷ dias trabalhados (datas distintas no card do projeto; dias-operador na análise).
export const perDay = (trees: number, days: number) => ratio(trees, days);
// Arraste: cada lançamento baixa árvores + refugos do saldo que nasceu na derruba.
export const skiddingWriteOff = (trees: number, rejects: number) => trees + rejects;
export const skiddingBalance = (felled: number, skidded: number, rejects: number) => felled - skiddingWriteOff(skidded, rejects);
export const processedPercent = (felled: number, skidded: number, rejects: number) => { const value = ratio(skiddingWriteOff(skidded, rejects), felled); return value === null ? null : value * 100; };
export const rejectPercent = (skidded: number, rejects: number) => { const value = ratio(rejects, skiddingWriteOff(skidded, rejects)); return value === null ? null : value * 100; };
// Medição: m³ Francon por árvore medida e árvores ainda a medir.
export const franconPerTree = (francon: number, measuredTrees: number) => ratio(francon, measuredTrees);
export const treesToMeasure = (skidded: number, measured: number) => skidded - measured;
// Gasolina da derruba (decisão D2): litros × custo médio do estoque, sem mexer no estoque.
export const fuelValue = (liters: number, unitCost: number | null) => (unitCost === null ? null : roundTo(liters * unitCost, 2));

// ---------------------------------------------------------------------------
// DERRUBA — grade do lançamento diário (projeto + data). Linha vazia é ignorada; o mesmo operador não
// se repete no dia; ipês ≤ árvores; motivo obrigatório quando árvores = 0. A grade é o dia inteiro do
// projeto: quem sai da grade sai do dia (a tela confirma antes).
// ---------------------------------------------------------------------------
export type FellingLineInput = {
  operatorEmployeeId?: unknown; helperEmployeeId?: unknown; trees?: unknown; ipes?: unknown; gasolineLiters?: unknown; reasonId?: unknown; justification?: unknown;
};
export type FellingLine = { operatorEmployeeId: number; helperEmployeeId: number | null; trees: number; ipes: number; gasolineLiters: number; reasonId: number | null; justification: string | null };
export type LineError = { line: number; field: string; message: string };

const filled = (value: unknown) => value !== null && value !== undefined && String(value).trim() !== "";
const idOrNull = (value: unknown) => { const id = Number(value); return Number.isInteger(id) && id > 0 ? id : null; };
const wholeNumber = (value: unknown) => { const parsed = parseDecimal(value); return Number.isInteger(parsed) ? parsed : Number.NaN; };
export const MAX_TREES_PER_DAY = 2000;
export const MAX_GASOLINE_PER_DAY = 200;

export function validateFellingDay(input: readonly FellingLineInput[]): { lines: FellingLine[]; errors: LineError[] } {
  const lines: FellingLine[] = [];
  const errors: LineError[] = [];
  const seen = new Map<number, number>();
  input.forEach((raw, index) => {
    const line = index + 1;
    const operator = idOrNull(raw.operatorEmployeeId);
    const any = operator !== null || filled(raw.trees) || filled(raw.ipes) || filled(raw.gasolineLiters) || idOrNull(raw.helperEmployeeId) !== null || idOrNull(raw.reasonId) !== null;
    if (!any) return;
    const before = errors.length;
    if (operator === null) errors.push({ line, field: "operatorEmployeeId", message: "Escolha o operador." });
    else if (seen.has(operator)) errors.push({ line, field: "operatorEmployeeId", message: `Operador repetido (já está na linha ${seen.get(operator)}).` });
    const helper = idOrNull(raw.helperEmployeeId);
    if (helper !== null && helper === operator) errors.push({ line, field: "helperEmployeeId", message: "O ajudante não pode ser o próprio operador." });
    const trees = filled(raw.trees) ? wholeNumber(raw.trees) : Number.NaN;
    if (!Number.isFinite(trees) || trees < 0) errors.push({ line, field: "trees", message: "Informe as árvores (número inteiro, zero ou mais)." });
    else if (trees > MAX_TREES_PER_DAY) errors.push({ line, field: "trees", message: `Mais de ${MAX_TREES_PER_DAY} árvores num dia: confira.` });
    const ipes = filled(raw.ipes) ? wholeNumber(raw.ipes) : 0;
    if (!Number.isFinite(ipes) || ipes < 0) errors.push({ line, field: "ipes", message: "Ipês: número inteiro, zero ou mais." });
    else if (Number.isFinite(trees) && ipes > trees) errors.push({ line, field: "ipes", message: "Os ipês já fazem parte do total: não podem passar das árvores." });
    const gasoline = filled(raw.gasolineLiters) ? parseDecimal(raw.gasolineLiters) : 0;
    if (!Number.isFinite(gasoline) || gasoline < 0) errors.push({ line, field: "gasolineLiters", message: "Gasolina: litros, zero ou mais." });
    else if (gasoline > MAX_GASOLINE_PER_DAY) errors.push({ line, field: "gasolineLiters", message: `Mais de ${MAX_GASOLINE_PER_DAY} L num dia: confira.` });
    const reasonId = idOrNull(raw.reasonId);
    if (trees === 0 && reasonId === null) errors.push({ line, field: "reasonId", message: "Árvores zero: escolha o motivo." });
    if (operator !== null && !seen.has(operator)) seen.set(operator, line);
    if (errors.length === before) lines.push({
      operatorEmployeeId: operator!, helperEmployeeId: helper, trees, ipes, gasolineLiters: roundTo(gasoline, 3), reasonId,
      justification: filled(raw.justification) ? String(raw.justification).trim().replace(/\s+/g, " ").slice(0, 300) : null,
    });
  });
  return { lines, errors };
}

// Resultado do dia contra a meta da frente (árvores por operador por dia).
export type TargetResult = "NA_META" | "ABAIXO" | "SEM_META";
export const TARGET_RESULT_LABELS: Record<TargetResult, string> = { NA_META: "Na meta", ABAIXO: "Abaixo da meta", SEM_META: "Meta não definida" };
export const targetResult = (trees: number, target: number | null | undefined): TargetResult => (target === null || target === undefined || target <= 0 ? "SEM_META" : trees >= target ? "NA_META" : "ABAIXO");
export const reasonLabel = (code: string | null | undefined, description: string | null | undefined) => (code ? `(${code}) ${description ?? ""}`.trim() : null);

// Acumulado por operador (cards): árvores, dias distintos, ipês e média por dia.
export type FellingRecord = { operatorId: number; operatorName: string; helperId: number | null; helperName: string | null; projectId: number; frontId: number; frontName: string; date: string; trees: number; ipes: number; gasolineLiters: number };
export function operatorTotals(records: readonly FellingRecord[]) {
  const map = new Map<number, { operatorId: number; operatorName: string; trees: number; ipes: number; dates: Set<string> }>();
  for (const record of records) {
    const item = map.get(record.operatorId) ?? { operatorId: record.operatorId, operatorName: record.operatorName, trees: 0, ipes: 0, dates: new Set<string>() };
    item.trees += record.trees; item.ipes += record.ipes; item.dates.add(record.date);
    map.set(record.operatorId, item);
  }
  return [...map.values()].map((item) => ({ operatorId: item.operatorId, operatorName: item.operatorName, trees: item.trees, ipes: item.ipes, days: item.dates.size, perDay: perDay(item.trees, item.dates.size) }))
    .sort((a, b) => b.trees - a.trees || a.operatorName.localeCompare(b.operatorName, "pt-BR"));
}

// Produção multi-frente (só produção, sem despesas): por operador, os dias e as árvores contra a meta da
// frente de cada dia. Um operador-dia numa frente = soma dos projetos daquela frente no dia.
// "Árv. acima da meta" = Σ(árvores − meta) nos dias acima da meta (base para premiação por produção).
export function multiFrontSummary(records: readonly FellingRecord[], targets: ReadonlyMap<number, number>) {
  type Day = { date: string; frontId: number; frontName: string; trees: number; helpers: Map<string, number> };
  const operators = new Map<number, { operatorId: number; operatorName: string; days: Map<string, Day> }>();
  for (const record of records) {
    const operator = operators.get(record.operatorId) ?? { operatorId: record.operatorId, operatorName: record.operatorName, days: new Map<string, Day>() };
    const key = `${record.date}:${record.frontId}`;
    const day = operator.days.get(key) ?? { date: record.date, frontId: record.frontId, frontName: record.frontName, trees: 0, helpers: new Map<string, number>() };
    day.trees += record.trees;
    if (record.helperName) day.helpers.set(record.helperName, 1);
    operator.days.set(key, day);
    operators.set(record.operatorId, operator);
  }
  const rows = [...operators.values()].map((operator) => {
    let trees = 0, daysOnTarget = 0, daysBelow = 0, treesOnTargetDays = 0, treesAboveTarget = 0;
    const helperDays = new Map<string, number>();
    const fronts = new Set<string>();
    const dates = new Set<string>();
    for (const day of operator.days.values()) {
      trees += day.trees; fronts.add(day.frontName); dates.add(day.date);
      const target = targets.get(day.frontId);
      const result = targetResult(day.trees, target);
      if (result === "NA_META") {
        daysOnTarget += 1; treesOnTargetDays += day.trees; treesAboveTarget += day.trees - target!;
        for (const helper of day.helpers.keys()) helperDays.set(helper, (helperDays.get(helper) ?? 0) + 1);
      } else if (result === "ABAIXO") daysBelow += 1;
    }
    return {
      operatorId: operator.operatorId, operatorName: operator.operatorName, fronts: [...fronts].sort((a, b) => a.localeCompare(b, "pt-BR")),
      helpers: [...helperDays].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR")).map(([name, days]) => ({ name, days })),
      days: dates.size, trees, daysOnTarget, daysBelow, treesOnTargetDays, treesAboveTarget, perDay: perDay(trees, dates.size),
    };
  }).sort((a, b) => b.trees - a.trees || a.operatorName.localeCompare(b.operatorName, "pt-BR"));
  const operatorDays = rows.reduce((sum, row) => sum + row.days, 0);
  const totals = {
    operators: rows.length, trees: rows.reduce((sum, row) => sum + row.trees, 0), treesOnTargetDays: rows.reduce((sum, row) => sum + row.treesOnTargetDays, 0),
    treesAboveTarget: rows.reduce((sum, row) => sum + row.treesAboveTarget, 0), perDay: 0 as number | null,
  };
  totals.perDay = perDay(totals.trees, operatorDays);
  return { rows, totals };
}

// Datas das planilhas: "dd/mm/aaaa", "aaaa-mm-dd" ou número de série do Excel. Inválida = null.
export function parseSheetDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  let iso: string | null = null;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (br) iso = `${br[3].length === 2 ? `20${br[3]}` : br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  else if (/^\d{4}-\d{2}-\d{2}/.test(text)) iso = text.slice(0, 10);
  else if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial > 20000 && serial < 80000) iso = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  if (!iso || !isIsoDay(iso)) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? iso : null;
}
