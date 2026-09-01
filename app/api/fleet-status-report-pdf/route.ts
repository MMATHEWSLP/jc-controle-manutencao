import { getD1 } from "../../../db";
import { authorize } from "../../../lib/auth";
import { FLEET_STATUS_LABELS, fleetDayWindow, fleetLocalDay, type FleetStatus } from "../../../lib/fleet-status";
import { createFleetStatusPdf, type FleetPdfItem } from "../../../lib/fleet-pdf";
import { allowedEquipmentIds } from "../../../lib/front-scope";

type Row = Record<string, unknown>;
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const valueList = (search: URLSearchParams, key: string) => [...new Set(search.getAll(key).map(clean).filter(Boolean))];
const ptDateTime = (value: string) => new Intl.DateTimeFormat("pt-BR", { timeZone:"America/Fortaleza", dateStyle:"short", timeStyle:"short" }).format(new Date(value));
const ptDate = (value: string) => value.split("-").reverse().join("/");
const durationLabel = (startedAt: string, endedAt: string | null, reportEnd: string) => {
  const start = new Date(startedAt).getTime();
  const cap = Math.min(endedAt ? new Date(endedAt).getTime() : Date.now(), new Date(reportEnd).getTime());
  const minutes = Math.max(0, Math.round((cap - start) / 60_000));
  const days = Math.floor(minutes / 1_440); const hours = Math.floor(minutes % 1_440 / 60); const rest = minutes % 60;
  return `${days ? `${days}d ` : ""}${hours}h ${rest}min`;
};

function statusIntersects(events: Row[], status: FleetStatus, start: string, end: string) {
  const startMs = new Date(start).getTime(); const endMs = new Date(end).getTime();
  return events.some((event, index) => {
    if (String(event.new_status) !== status) return false;
    const eventStart = new Date(String(event.occurred_at)).getTime();
    const eventEnd = index + 1 < events.length ? new Date(String(events[index + 1].occurred_at)).getTime() : Number.POSITIVE_INFINITY;
    return eventStart < endMs && eventEnd > startMs;
  });
}

export async function GET(request: Request) {
  const auth = await authorize(request, "fleet.report");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const reportDate = url.searchParams.get("date") || fleetLocalDay();
    const { start, end } = fleetDayWindow(reportDate);
    const fronts = new Set(valueList(url.searchParams, "front"));
    const categories = new Set(valueList(url.searchParams, "category"));
    const equipmentIds = new Set(valueList(url.searchParams, "equipment").map(Number).filter((id) => Number.isInteger(id) && id > 0));
    const statuses = new Set(valueList(url.searchParams, "status"));
    const mechanics = new Set(valueList(url.searchParams, "mechanic"));
    const d1 = await getD1();
    const [fleetResult, occurrenceResult, eventResult, orderResult, snapshotResult,allowed] = await Promise.all([
      d1.prepare(`SELECT e.id,e.status FROM equipment e`).all<Row>(),
      d1.prepare(`SELECT o.*,e.prefix,e.brand,e.model,e.type AS category,COALESCE(historical.name,'Frente não registrada') AS front
        FROM fleet_occurrences o INNER JOIN equipment e ON e.id=o.equipment_id LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
        LEFT JOIN service_fronts historical ON historical.id=o.service_front_id
        WHERE o.started_at<? AND COALESCE(o.ended_at,'9999-12-31T23:59:59.999Z')>=? ORDER BY o.started_at`).bind(end, start).all<Row>(),
      d1.prepare(`SELECT ev.*,COALESCE(STRING_AGG(em.mechanic_name,'||'),'') AS mechanic_names
        FROM fleet_status_events ev LEFT JOIN fleet_event_mechanics em ON em.event_id=ev.id
        WHERE ev.occurred_at<? GROUP BY ev.id ORDER BY ev.occurred_at`).bind(end).all<Row>(),
      d1.prepare(`SELECT * FROM fleet_orders ORDER BY requested_at`).all<Row>(),
      d1.prepare(`SELECT equipment_id,new_status FROM (
        SELECT equipment_id,new_status,ROW_NUMBER() OVER (PARTITION BY equipment_id ORDER BY occurred_at DESC,created_at DESC) AS position
        FROM fleet_status_events WHERE occurred_at<?) WHERE position=1`).bind(end).all<Row>(),
      allowedEquipmentIds(d1,auth.user!,"OPERATIONAL"),
    ]);
    fleetResult.results=fleetResult.results.filter((row)=>allowed.has(Number(row.id)));occurrenceResult.results=occurrenceResult.results.filter((row)=>allowed.has(Number(row.equipment_id)));

    const eventsByOccurrence = new Map<string, Row[]>();
    const mechanicsByOccurrence = new Map<string, Set<string>>();
    for (const event of eventResult.results) {
      if (!event.occurrence_id) continue;
      const occurrenceId = String(event.occurrence_id);
      const values = eventsByOccurrence.get(occurrenceId) ?? [];
      values.push(event); eventsByOccurrence.set(occurrenceId, values);
      const names = mechanicsByOccurrence.get(occurrenceId) ?? new Set<string>();
      for (const name of clean(event.mechanic_names).split("||").filter(Boolean)) names.add(name);
      mechanicsByOccurrence.set(occurrenceId, names);
    }
    const ordersByOccurrence = new Map<string, Row[]>();
    for (const order of orderResult.results) {
      const occurrenceId = String(order.occurrence_id);
      const values = ordersByOccurrence.get(occurrenceId) ?? [];
      values.push(order); ordersByOccurrence.set(occurrenceId, values);
    }
    const snapshot = new Map(snapshotResult.results.map((row) => [Number(row.equipment_id), String(row.new_status) as FleetStatus]));
    const finalStatus = (equipmentId: number) => snapshot.get(equipmentId) ?? (fleetResult.results.find((row) => Number(row.id) === equipmentId)?.status === "INACTIVE" ? "INACTIVE" : "OPERATING");
    const filtered = occurrenceResult.results.filter((row) => {
      const occurrenceId = String(row.id); const names = mechanicsByOccurrence.get(occurrenceId) ?? new Set<string>();
      const status = finalStatus(Number(row.equipment_id));
      if (fronts.size && !fronts.has(String(row.front))) return false;
      if (categories.size && !categories.has(String(row.category))) return false;
      if (equipmentIds.size && !equipmentIds.has(Number(row.equipment_id))) return false;
      if (statuses.size && !statuses.has(status)) return false;
      if (mechanics.size && ![...mechanics].some((name) => names.has(name))) return false;
      return true;
    });
    const toPdfItem = (row: Row): FleetPdfItem => {
      const occurrenceId = String(row.id); const events = eventsByOccurrence.get(occurrenceId) ?? [];
      const orders = ordersByOccurrence.get(occurrenceId) ?? [];
      const lastEvent = events[events.length - 1];
      return {
        occurrenceId, prefix: String(row.prefix), model: `${row.brand} ${row.model}`.trim(), category: String(row.category), front: String(row.front),
        startedAt: ptDateTime(String(row.started_at)), endedAt: row.ended_at ? ptDateTime(String(row.ended_at)) : null,
        returnedAt: row.returned_to_operation_at ? ptDateTime(String(row.returned_to_operation_at)) : null,
        reason: String(row.reason ?? row.problem_description ?? "Não informado"),
        currentStatus: FLEET_STATUS_LABELS[String(lastEvent?.new_status ?? finalStatus(Number(row.equipment_id))) as FleetStatus] ?? String(lastEvent?.new_status ?? ""),
        mechanics: [...(mechanicsByOccurrence.get(occurrenceId) ?? new Set<string>())],
        servicePerformed: String(row.service_performed ?? ""),
        orders: orders.map((order) => `${order.order_number} — ${order.description}`),
        duration: durationLabel(String(row.started_at), row.ended_at ? String(row.ended_at) : null, end),
      };
    };
    const stillStopped = filtered.filter((row) => !row.ended_at || String(row.ended_at) >= end).map(toPdfItem);
    const released = filtered.filter((row) => row.ended_at && String(row.ended_at) >= start && String(row.ended_at) < end).map(toPdfItem);
    const operatingAtEnd = fleetResult.results.filter((row) => finalStatus(Number(row.id)) === "OPERATING").length;
    const hadMaintenance = filtered.filter((row) => statusIntersects(eventsByOccurrence.get(String(row.id)) ?? [], "MAINTENANCE", start, end)).length;
    const waitingPart = filtered.filter((row) => statusIntersects(eventsByOccurrence.get(String(row.id)) ?? [], "WAITING_PART", start, end)).length;
    const filters = [fronts.size ? `Frente: ${[...fronts].join(", ")}` : "Todas as frentes", categories.size ? `Categoria: ${[...categories].join(", ")}` : "Todas as categorias", equipmentIds.size ? `${equipmentIds.size} equipamento(s)` : "Todos os equipamentos", statuses.size ? `Status: ${[...statuses].map((status) => FLEET_STATUS_LABELS[status as FleetStatus] ?? status).join(", ")}` : "Todos os status", mechanics.size ? `Mecânico: ${[...mechanics].join(", ")}` : "Todos os mecânicos"].join(" · ");
    const pdf = createFleetStatusPdf({
      reportDate: ptDate(reportDate), generatedAt: ptDateTime(new Date().toISOString()), filters,
      metrics: { fleet: fleetResult.results.length, operating: operatingAtEnd, stoppedInPeriod: new Set(filtered.map((row) => Number(row.equipment_id))).size, maintenance: hadMaintenance, waitingPart, released: released.length, occurrences: filtered.length },
      stillStopped, released,
    });
    return new Response(pdf, { headers: { "Content-Type":"application/pdf", "Content-Disposition":`attachment; filename="status-da-frota-${reportDate}.pdf"`, "Cache-Control":"private, no-store" } });
  } catch (error) {
    console.error("[fleet-status-report.get]", error);
    return Response.json({ error:"Não foi possível gerar o relatório diário da frota." }, { status:500 });
  }
}
