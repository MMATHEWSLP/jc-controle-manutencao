export const FLEET_STATUSES = [
  "OPERATING",
  "STOPPED",
  "MAINTENANCE",
  "WAITING_PART",
  "WAITING_ORDER",
  "WAITING_MECHANIC",
  "WAITING_EXTERNAL_SERVICE",
  "READY",
  "INACTIVE",
] as const;

export type FleetStatus = typeof FLEET_STATUSES[number];

export const FLEET_STATUS_LABELS: Record<FleetStatus, string> = {
  OPERATING: "OPERANDO",
  STOPPED: "PARADO",
  MAINTENANCE: "EM MANUTENÇÃO",
  WAITING_PART: "AGUARDANDO PEÇA",
  WAITING_ORDER: "AGUARDANDO PEDIDO",
  WAITING_MECHANIC: "AGUARDANDO MECÂNICO",
  WAITING_EXTERNAL_SERVICE: "AGUARDANDO SERVIÇO EXTERNO",
  READY: "LIBERADO / PRONTO",
  INACTIVE: "INATIVO",
};

export const FLEET_ORDER_STATUSES = [
  "REQUESTED",
  "QUOTING",
  "ORDERED",
  "WAITING_DELIVERY",
  "RECEIVED",
  "CANCELLED",
  "CLOSED",
] as const;

export type FleetOrderStatus = typeof FLEET_ORDER_STATUSES[number];

export const FLEET_ORDER_STATUS_LABELS: Record<FleetOrderStatus, string> = {
  REQUESTED: "SOLICITADO",
  QUOTING: "EM COTAÇÃO",
  ORDERED: "PEDIDO REALIZADO",
  WAITING_DELIVERY: "AGUARDANDO ENTREGA",
  RECEIVED: "RECEBIDO",
  CANCELLED: "CANCELADO",
  CLOSED: "ENCERRADO",
};

export const OPEN_ORDER_STATUSES = new Set<FleetOrderStatus>([
  "REQUESTED",
  "QUOTING",
  "ORDERED",
  "WAITING_DELIVERY",
]);

export function isFleetStatus(value: unknown): value is FleetStatus {
  return typeof value === "string" && (FLEET_STATUSES as readonly string[]).includes(value);
}

export function isFleetOrderStatus(value: unknown): value is FleetOrderStatus {
  return typeof value === "string" && (FLEET_ORDER_STATUSES as readonly string[]).includes(value);
}

export function fleetDayWindow(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Data inválida.");
  const start = new Date(`${value}T00:00:00-03:00`);
  const end = new Date(start.getTime() + 86_400_000);
  if (Number.isNaN(start.getTime())) throw new Error("Data inválida.");
  return { start: start.toISOString(), end: end.toISOString() };
}

export function fleetLocalDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function fleetOccurrenceId(at: string) {
  const day = at.slice(0, 10).replaceAll("-", "");
  return `OC-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}
