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
