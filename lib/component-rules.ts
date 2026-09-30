// ---------------------------------------------------------------------------
// Regras puras de Pneus e Baterias (sem banco), usadas pelo servidor e pela tela.
//
// A situação de cada pneu/bateria é recalculada repassando os eventos em ordem (montagem,
// rodízio, desmontagem, recapagem, conserto, inspeção, descarte). Assim, excluir o último evento
// "desfaz" o lançamento sem deixar o cadastro inconsistente.
//
// Uso (km ou horas): cada período montado conta da leitura da montagem até a leitura da
// desmontagem/rodízio/descarte; o período em aberto conta até a leitura atual do equipamento.
// A unidade vem do equipamento: KM quando ele controla KM, horas quando só horímetro.
// ---------------------------------------------------------------------------
export type ComponentKind = "TIRE" | "BATTERY";
export type ComponentStatus = "STOCK" | "MOUNTED" | "DISCARDED";
export type ComponentEventType = "MOUNT" | "ROTATE" | "UNMOUNT" | "RECAP" | "REPAIR" | "INSPECTION" | "DISCARD";
export type UsageUnit = "KM" | "HOURS";

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = { TIRE: "Pneu", BATTERY: "Bateria" };
export const COMPONENT_STATUS_LABELS: Record<ComponentStatus, string> = { STOCK: "Em estoque", MOUNTED: "Montado", DISCARDED: "Descartado" };
export const EVENT_LABELS: Record<ComponentKind, Partial<Record<ComponentEventType, string>>> = {
  TIRE: { MOUNT: "Montagem", ROTATE: "Rodízio", UNMOUNT: "Desmontagem", RECAP: "Recapagem", REPAIR: "Conserto", INSPECTION: "Inspeção (sulco)", DISCARD: "Descarte" },
  BATTERY: { MOUNT: "Instalação", UNMOUNT: "Remoção", REPAIR: "Carga / conserto", INSPECTION: "Teste", DISCARD: "Descarte" },
};
// Posições sugeridas (texto livre é aceito). DE = dianteiro esquerdo, TEI = traseiro esquerdo interno etc.
export const TIRE_POSITIONS = ["DE", "DD", "TEE", "TEI", "TDI", "TDE", "2TEE", "2TEI", "2TDI", "2TDE", "3TEE", "3TEI", "3TDI", "3TDE", "ESTEPE"];
export const BATTERY_POSITIONS = ["BATERIA 1", "BATERIA 2"];

export const usageUnitOf = (controlType: string): UsageUnit => (controlType === "HOURS" ? "HOURS" : "KM");
export const unitLabel = (unit: UsageUnit) => (unit === "KM" ? "km" : "h");

export type ComponentEvent = {
  id?: number; eventType: ComponentEventType; eventDate: string; equipmentId: number | null; position: string | null;
  reading: number | null; unit: UsageUnit | null; cost: number | null; treadDepth?: number | null;
};

export type ComponentState = {
  status: ComponentStatus; equipmentId: number | null; position: string | null; mountedReading: number | null; mountedUnit: UsageUnit | null;
  mountedAt: string | null; recapCount: number; usage: Record<UsageUnit, number>; eventsCost: number; lastTreadDepth: number | null; lastEventDate: string | null;
};

export class ComponentRuleError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}

const round = (value: number) => Math.round(value * 100) / 100;

export function initialState(): ComponentState {
  return { status: "STOCK", equipmentId: null, position: null, mountedReading: null, mountedUnit: null, mountedAt: null, recapCount: 0, usage: { KM: 0, HOURS: 0 }, eventsCost: 0, lastTreadDepth: null, lastEventDate: null };
}

// Aplica um evento (já validado) e devolve a nova situação.
export function applyEvent(state: ComponentState, event: ComponentEvent): ComponentState {
  const next: ComponentState = { ...state, usage: { ...state.usage }, lastEventDate: event.eventDate, eventsCost: round(state.eventsCost + (event.cost ?? 0)) };
  const closeInterval = () => {
    if (state.status === "MOUNTED" && state.mountedReading !== null && state.mountedUnit && event.reading !== null) next.usage[state.mountedUnit] = round(next.usage[state.mountedUnit] + Math.max(0, event.reading - state.mountedReading));
  };
  if (event.treadDepth !== undefined && event.treadDepth !== null) next.lastTreadDepth = event.treadDepth;
  switch (event.eventType) {
    case "MOUNT":
      return { ...next, status: "MOUNTED", equipmentId: event.equipmentId, position: event.position, mountedReading: event.reading, mountedUnit: event.unit, mountedAt: event.eventDate };
    case "ROTATE":
      closeInterval();
      return { ...next, position: event.position, mountedReading: event.reading, mountedAt: event.eventDate };
    case "UNMOUNT":
      closeInterval();
      return { ...next, status: "STOCK", equipmentId: null, position: null, mountedReading: null, mountedUnit: null, mountedAt: null };
    case "DISCARD":
      closeInterval();
      return { ...next, status: "DISCARDED", equipmentId: null, position: null, mountedReading: null, mountedUnit: null, mountedAt: null };
    case "RECAP":
      // Banda nova: o sulco medido antes da recapagem deixa de valer.
      return { ...next, recapCount: state.recapCount + 1, lastTreadDepth: null };
    default:
      return next;
  }
}

export function replay(events: ComponentEvent[]) {
  return events.reduce(applyEvent, initialState());
}

// Confere se o evento pode ser lançado na situação atual. Lança ComponentRuleError com o campo.
export function validateEvent(kind: ComponentKind, state: ComponentState, event: ComponentEvent, today: string) {
  if (!EVENT_LABELS[kind][event.eventType]) throw new ComponentRuleError(`${COMPONENT_KIND_LABELS[kind]} não aceita este tipo de lançamento.`, "eventType");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.eventDate)) throw new ComponentRuleError("Informe a data.", "eventDate");
  if (event.eventDate > today) throw new ComponentRuleError("A data não pode ser futura.", "eventDate");
  if (state.lastEventDate && event.eventDate < state.lastEventDate) throw new ComponentRuleError(`A data não pode ser anterior ao último lançamento (${state.lastEventDate.split("-").reverse().join("/")}).`, "eventDate");
  if (state.status === "DISCARDED") throw new ComponentRuleError("Este item já foi descartado.");
  if (event.cost !== null && (!Number.isFinite(event.cost) || event.cost < 0)) throw new ComponentRuleError("Custo inválido.", "cost");
  const needsReading = event.eventType === "MOUNT" || event.eventType === "ROTATE" || event.eventType === "UNMOUNT" || (event.eventType === "DISCARD" && state.status === "MOUNTED");
  if (needsReading && (event.reading === null || !Number.isFinite(event.reading) || event.reading < 0)) throw new ComponentRuleError("Informe a leitura (KM/horímetro) do equipamento.", "reading");
  if ((event.eventType === "ROTATE" || event.eventType === "UNMOUNT" || event.eventType === "DISCARD") && state.status === "MOUNTED" && event.reading !== null && state.mountedReading !== null && event.reading < state.mountedReading) {
    throw new ComponentRuleError(`A leitura não pode ser menor que a da montagem (${state.mountedReading}).`, "reading");
  }
  switch (event.eventType) {
    case "MOUNT":
      if (state.status !== "STOCK") throw new ComponentRuleError("Só é possível montar um item que está em estoque. Desmonte-o antes.");
      if (!event.equipmentId) throw new ComponentRuleError("Escolha o equipamento.", "equipmentId");
      if (!event.position?.trim()) throw new ComponentRuleError("Informe a posição.", "position");
      break;
    case "ROTATE":
      if (state.status !== "MOUNTED") throw new ComponentRuleError("Rodízio só vale para pneu montado.");
      if (!event.position?.trim()) throw new ComponentRuleError("Informe a nova posição.", "position");
      if (event.position.trim().toUpperCase() === (state.position ?? "").toUpperCase()) throw new ComponentRuleError("A nova posição é igual à atual.", "position");
      break;
    case "UNMOUNT":
      if (state.status !== "MOUNTED") throw new ComponentRuleError("Este item não está montado.");
      break;
    case "RECAP":
      if (state.status !== "STOCK") throw new ComponentRuleError("Desmonte o pneu antes de mandar para recapagem.");
      break;
    case "INSPECTION":
      if (kind === "TIRE" && (event.treadDepth === null || event.treadDepth === undefined || !Number.isFinite(event.treadDepth) || event.treadDepth < 0 || event.treadDepth > 40)) throw new ComponentRuleError("Informe o sulco medido (mm).", "treadDepth");
      break;
    default:
      break;
  }
}

// Uso acumulado incluindo o período em aberto (até a leitura atual do equipamento).
export function totalUsage(state: ComponentState, currentReading: number | null) {
  const usage = { ...state.usage };
  if (state.status === "MOUNTED" && state.mountedUnit && state.mountedReading !== null && currentReading !== null) usage[state.mountedUnit] = round(usage[state.mountedUnit] + Math.max(0, currentReading - state.mountedReading));
  return usage;
}

// Unidade principal = a que tem mais uso (pneus normalmente rodam só em KM ou só em horas).
export function mainUsage(usage: Record<UsageUnit, number>): { unit: UsageUnit; value: number } {
  return usage.HOURS > usage.KM ? { unit: "HOURS", value: usage.HOURS } : { unit: "KM", value: usage.KM };
}

export function costPerUnit(totalCost: number, usage: number) {
  return usage > 0 && totalCost > 0 ? Math.round((totalCost / usage) * 10000) / 10000 : null;
}

// Vida usada (%) quando há vida esperada cadastrada: pneus pelo uso, baterias pela idade em meses.
export function lifeUsedPercent(kind: ComponentKind, expectedLife: number | null, usage: number, ageMonths: number | null) {
  if (!expectedLife || expectedLife <= 0) return null;
  const used = kind === "BATTERY" ? ageMonths : usage;
  return used === null ? null : Math.round((used / expectedLife) * 1000) / 10;
}

export function monthsBetween(from: string | null, to: string) {
  if (!from) return null;
  const [fy, fm, fd] = from.split("-").map(Number), [ty, tm, td] = to.split("-").map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}

// Alerta por item: vida ≥ 90% (ou vencida), sulco baixo (≤ 3 mm) ou bateria fora da garantia.
export function componentAlert(input: { kind: ComponentKind; status: ComponentStatus; lifePercent: number | null; lastTreadDepth: number | null; warrantyMonths: number | null; ageMonths: number | null }) {
  if (input.status === "DISCARDED") return null;
  if (input.kind === "TIRE" && input.lastTreadDepth !== null && input.lastTreadDepth <= 3) return { level: "red" as const, text: `Sulco baixo (${input.lastTreadDepth} mm)` };
  if (input.lifePercent !== null && input.lifePercent >= 100) return { level: "red" as const, text: `Vida esperada atingida (${input.lifePercent}%)` };
  if (input.lifePercent !== null && input.lifePercent >= 90) return { level: "orange" as const, text: `Perto do fim da vida (${input.lifePercent}%)` };
  if (input.kind === "BATTERY" && input.warrantyMonths && input.ageMonths !== null && input.ageMonths >= input.warrantyMonths) return { level: "orange" as const, text: "Fora da garantia" };
  return null;
}
