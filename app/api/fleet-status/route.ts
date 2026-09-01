import { getD1 } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import {
  FLEET_ORDER_STATUS_LABELS,
  FLEET_STATUS_LABELS,
  fleetDayWindow,
  fleetLocalDay,
  fleetOccurrenceId,
  isFleetOrderStatus,
  isFleetStatus,
  type FleetOrderStatus,
  type FleetStatus,
} from "../../../lib/fleet-status";
import { allowedEquipmentIds,equipmentAccessResponse,requireEquipmentAccess } from "../../../lib/front-scope";

type Row = Record<string, unknown>;
type FleetOrderInput = {
  id?: string;
  orderNumber?: string;
  requestedAt?: string;
  description?: string;
  quantity?: number | string | null;
  unit?: string;
  requester?: string;
  supplier?: string;
  status?: FleetOrderStatus;
  notes?: string;
};

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const numberOrNull = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
const list = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
const isoDate = (value: unknown) => {
  const date = new Date(clean(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const rowText = (value: unknown) => value === null || value === undefined ? null : String(value);

function serializeEvent(row: Row) {
  const status = String(row.new_status) as FleetStatus;
  return {
    id: String(row.id),
    occurrenceId: rowText(row.occurrence_id),
    equipmentId: Number(row.equipment_id),
    prefix: String(row.prefix ?? ""),
    model: `${String(row.brand ?? "")} ${String(row.model ?? "")}`.trim(),
    front: String(row.front ?? "Sem frente"),
    category: String(row.category ?? ""),
    previousStatus: String(row.previous_status) as FleetStatus,
    status,
    statusLabel: FLEET_STATUS_LABELS[status] ?? status,
    occurredAt: String(row.occurred_at),
    reason: rowText(row.reason),
    problemDescription: rowText(row.problem_description),
    serviceDescription: rowText(row.service_description),
    servicePerformed: rowText(row.service_performed),
    location: rowText(row.location),
    notes: rowText(row.notes),
    mechanics: clean(row.mechanic_names).split("||").filter(Boolean),
    updatedBy: String(row.updated_by ?? "Não informado"),
  };
}

async function equipmentHistory(equipmentId: number) {
  const d1 = await getD1();
  const [equipmentResult, occurrencesResult, eventsResult, ordersResult] = await Promise.all([
    d1.prepare(`SELECT e.id,e.prefix,e.brand,e.model,e.type AS category,COALESCE(sf.name,'Sem frente') AS front
      FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE e.id=?`).bind(equipmentId).all<Row>(),
    d1.prepare(`SELECT o.*,creator.name AS created_by_name,closer.name AS closed_by_name FROM fleet_occurrences o
      LEFT JOIN users creator ON creator.id=o.created_by LEFT JOIN users closer ON closer.id=o.closed_by
      WHERE o.equipment_id=? ORDER BY o.started_at DESC`).bind(equipmentId).all<Row>(),
    d1.prepare(`SELECT ev.*,e.prefix,e.brand,e.model,e.type AS category,COALESCE(sf.name,'Frente não registrada') AS front,u.name AS updated_by,
      COALESCE(STRING_AGG(em.mechanic_name,'||'),'') AS mechanic_names
      FROM fleet_status_events ev INNER JOIN equipment e ON e.id=ev.equipment_id
      LEFT JOIN service_fronts sf ON sf.id=ev.service_front_id LEFT JOIN users u ON u.id=ev.created_by
      LEFT JOIN fleet_event_mechanics em ON em.event_id=ev.id WHERE ev.equipment_id=?
      GROUP BY ev.id,e.id,sf.id,u.id ORDER BY ev.occurred_at DESC`).bind(equipmentId).all<Row>(),
    d1.prepare(`SELECT * FROM fleet_orders WHERE equipment_id=? ORDER BY requested_at DESC,created_at DESC`).bind(equipmentId).all<Row>(),
  ]);
  const equipment = equipmentResult.results[0];
  if (!equipment) return null;
  const ordersByOccurrence = new Map<string, Row[]>();
  for (const order of ordersResult.results) {
    const occurrenceId = String(order.occurrence_id);
    const values = ordersByOccurrence.get(occurrenceId) ?? [];
    values.push(order);
    ordersByOccurrence.set(occurrenceId, values);
  }
  const eventsByOccurrence = new Map<string, ReturnType<typeof serializeEvent>[]>();
  for (const event of eventsResult.results) {
    const occurrenceId = String(event.occurrence_id ?? "SEM_OCORRENCIA");
    const values = eventsByOccurrence.get(occurrenceId) ?? [];
    values.push(serializeEvent(event));
    eventsByOccurrence.set(occurrenceId, values);
  }
  return {
    equipment: {
      id: Number(equipment.id), prefix: String(equipment.prefix), model: `${equipment.brand} ${equipment.model}`,
      category: String(equipment.category), front: String(equipment.front),
    },
    occurrences: occurrencesResult.results.map((row) => ({
      id: String(row.id), startedAt: String(row.started_at), endedAt: rowText(row.ended_at), returnedToOperationAt: rowText(row.returned_to_operation_at),
      reason: rowText(row.reason), problemDescription: rowText(row.problem_description), location: rowText(row.location),
      servicePerformed: rowText(row.service_performed), partsUsed: rowText(row.parts_used), notes: rowText(row.notes),
      createdBy: String(row.created_by_name ?? "Não informado"), closedBy: rowText(row.closed_by_name),
      events: eventsByOccurrence.get(String(row.id)) ?? [],
      orders: (ordersByOccurrence.get(String(row.id)) ?? []).map((order) => ({
        id: String(order.id), orderNumber: String(order.order_number), requestedAt: String(order.requested_at), description: String(order.description),
        quantity: numberOrNull(order.quantity), unit: rowText(order.unit), requester: rowText(order.requester), supplier: rowText(order.supplier),
        status: String(order.status), statusLabel: FLEET_ORDER_STATUS_LABELS[String(order.status) as FleetOrderStatus] ?? String(order.status), notes: rowText(order.notes),
      })),
    })),
    standaloneEvents: eventsByOccurrence.get("SEM_OCORRENCIA") ?? [],
  };
}

export async function GET(request: Request) {
  const auth = await authorize(request, "fleet.view");
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    const equipmentId = Number(url.searchParams.get("equipmentId"));
    if (Number.isInteger(equipmentId) && equipmentId > 0) {
      await requireEquipmentAccess(await getD1(),auth.user!,equipmentId,"OPERATIONAL");
      const history = await equipmentHistory(equipmentId);
      return history ? Response.json(history) : Response.json({ error: "Equipamento não encontrado." }, { status: 404 });
    }

    const selectedDate = url.searchParams.get("date") || fleetLocalDay();
    const { start, end } = fleetDayWindow(selectedDate);
    const d1 = await getD1();
    const [equipmentResult, movementsResult, currentMechanicsResult, ordersResult, mechanicsResult, settingsResult, releasedResult,allowed] = await Promise.all([
      d1.prepare(`SELECT e.id,e.prefix,e.brand,e.model,e.type AS category,COALESCE(sf.name,'Sem frente') AS front,e.status AS registration_status,
        COALESCE(cs.status,CASE WHEN e.status='INACTIVE' THEN 'INACTIVE' ELSE 'OPERATING' END) AS operational_status,
        COALESCE(cs.since_at,e.created_at) AS status_since,cs.active_occurrence_id,cs.latest_event_id,
        COALESCE(ev.reason,o.reason) AS reason,COALESCE(ev.problem_description,o.problem_description) AS problem_description,
        ev.service_description,COALESCE(ev.service_performed,o.service_performed) AS service_performed,
        COALESCE(ev.location,o.location,sf.name,'Sem frente') AS status_location,o.started_at AS stopped_at,o.ended_at,o.returned_to_operation_at,
        COALESCE(u.name,'Não informado') AS updated_by
        FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id
        LEFT JOIN fleet_current_status cs ON cs.equipment_id=e.id LEFT JOIN fleet_status_events ev ON ev.id=cs.latest_event_id
        LEFT JOIN fleet_occurrences o ON o.id=cs.active_occurrence_id LEFT JOIN users u ON u.id=cs.updated_by ORDER BY e.prefix`).all<Row>(),
      d1.prepare(`SELECT ev.*,e.prefix,e.brand,e.model,e.type AS category,COALESCE(sf.name,'Frente não registrada') AS front,u.name AS updated_by,
        COALESCE(STRING_AGG(em.mechanic_name,'||'),'') AS mechanic_names
        FROM fleet_status_events ev INNER JOIN equipment e ON e.id=ev.equipment_id LEFT JOIN service_fronts sf ON sf.id=ev.service_front_id
        LEFT JOIN users u ON u.id=ev.created_by LEFT JOIN fleet_event_mechanics em ON em.event_id=ev.id
        WHERE ev.occurred_at>=? AND ev.occurred_at<? GROUP BY ev.id,e.id,sf.id,u.id ORDER BY ev.occurred_at DESC`).bind(start, end).all<Row>(),
      d1.prepare(`SELECT ev.occurrence_id,COALESCE(STRING_AGG(DISTINCT em.mechanic_name,','),'') AS mechanic_names
        FROM fleet_status_events ev LEFT JOIN fleet_event_mechanics em ON em.event_id=ev.id
        WHERE ev.occurrence_id IS NOT NULL GROUP BY ev.occurrence_id`).all<Row>(),
      d1.prepare(`SELECT fo.* FROM fleet_orders fo INNER JOIN fleet_current_status cs ON cs.active_occurrence_id=fo.occurrence_id
        ORDER BY fo.requested_at DESC,fo.created_at DESC`).all<Row>(),
      d1.prepare(`SELECT name FROM fleet_mechanics WHERE active=1 UNION SELECT name FROM users WHERE status='ACTIVE' AND role='OFICINA' ORDER BY name`).all<Row>(),
      d1.prepare(`SELECT attention_hours,high_hours,critical_hours FROM fleet_settings WHERE id=1`).all<Row>(),
      d1.prepare(`SELECT id,equipment_id FROM fleet_occurrences WHERE ended_at>=? AND ended_at<?`).bind(start, end).all<Row>(),
      allowedEquipmentIds(d1,auth.user!,"OPERATIONAL"),
    ]);

    const mechanicsByOccurrence = new Map(currentMechanicsResult.results.map((row) => [String(row.occurrence_id), clean(row.mechanic_names).split(",").filter(Boolean)]));
    const ordersByOccurrence = new Map<string, Row[]>();
    for (const order of ordersResult.results) {
      const occurrenceId = String(order.occurrence_id);
      const values = ordersByOccurrence.get(occurrenceId) ?? [];
      values.push(order);
      ordersByOccurrence.set(occurrenceId, values);
    }
    const items = equipmentResult.results.filter((row)=>allowed.has(Number(row.id))).map((row) => {
      const status = String(row.operational_status) as FleetStatus;
      const occurrenceId = rowText(row.active_occurrence_id);
      const orders = occurrenceId ? ordersByOccurrence.get(occurrenceId) ?? [] : [];
      return {
        id: Number(row.id), prefix: String(row.prefix), model: `${row.brand} ${row.model}`.trim(), brand: String(row.brand),
        category: String(row.category), front: String(row.front), registrationStatus: String(row.registration_status),
        status, statusLabel: FLEET_STATUS_LABELS[status] ?? status, sinceAt: String(row.status_since), occurrenceId,
        stoppedAt: rowText(row.stopped_at), endedAt: rowText(row.ended_at), returnedToOperationAt: rowText(row.returned_to_operation_at),
        reason: rowText(row.reason), problemDescription: rowText(row.problem_description), serviceDescription: rowText(row.service_description),
        servicePerformed: rowText(row.service_performed), location: rowText(row.status_location), updatedBy: String(row.updated_by),
        mechanics: occurrenceId ? mechanicsByOccurrence.get(occurrenceId) ?? [] : [],
        orders: orders.map((order) => ({
          id: String(order.id), orderNumber: String(order.order_number), requestedAt: String(order.requested_at), description: String(order.description),
          quantity: numberOrNull(order.quantity), unit: rowText(order.unit), requester: rowText(order.requester), supplier: rowText(order.supplier),
          status: String(order.status), statusLabel: FLEET_ORDER_STATUS_LABELS[String(order.status) as FleetOrderStatus] ?? String(order.status), notes: rowText(order.notes),
        })),
        hasPendingOrder: orders.some((order) => !["RECEIVED", "CANCELLED", "CLOSED"].includes(String(order.status))),
      };
    });
    const releasedEquipment = new Set(releasedResult.results.filter((row)=>allowed.has(Number(row.equipment_id))).map((row) => Number(row.equipment_id)));
    const statusCount = (status: FleetStatus) => items.filter((item) => item.status === status).length;
    const settings = settingsResult.results[0] ?? { attention_hours: 4, high_hours: 12, critical_hours: 24 };
    return Response.json({
      generatedAt: new Date().toISOString(), selectedDate,
      metrics: {
        total: items.length, operating: statusCount("OPERATING"),
        stopped: items.filter((item) => !["OPERATING", "READY", "INACTIVE"].includes(item.status)).length,
        maintenance: statusCount("MAINTENANCE"), waitingPart: statusCount("WAITING_PART"), releasedToday: releasedEquipment.size,
      },
      settings: { attentionHours: Number(settings.attention_hours), highHours: Number(settings.high_hours), criticalHours: Number(settings.critical_hours) },
      mechanics: mechanicsResult.results.map((row) => String(row.name)),
      items,
      movements: movementsResult.results.filter((row)=>allowed.has(Number(row.equipment_id))).map(serializeEvent),
    });
  } catch (error) {
    const access=equipmentAccessResponse(error);if(access)return access;
    console.error("[fleet-status.get]", error);
    return Response.json({ error: "Não foi possível carregar o Status da Frota." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fleet.update");
  if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const equipmentId = Number(body.equipmentId);
    const newStatus = body.status;
    const occurredAt = isoDate(body.occurredAt) || new Date().toISOString();
    if (!Number.isInteger(equipmentId) || equipmentId <= 0 || !isFleetStatus(newStatus)) return Response.json({ error: "Equipamento ou status inválido." }, { status: 400 });
    if (new Date(occurredAt).getTime() > Date.now() + 300_000) return Response.json({ error: "A data da atualização não pode estar no futuro." }, { status: 400 });

    const reason = clean(body.reason);
    const problemDescription = clean(body.problemDescription);
    const serviceDescription = clean(body.serviceDescription);
    const servicePerformed = clean(body.servicePerformed);
    const location = clean(body.location);
    const notes = clean(body.notes);
    const partsUsed = clean(body.partsUsed);
    const mechanics = list(body.mechanics);
    const orders = Array.isArray(body.orders) ? body.orders as FleetOrderInput[] : [];
    if (newStatus === "STOPPED" && (!reason || !problemDescription)) return Response.json({ error: "Informe o motivo e a descrição do problema da parada." }, { status: 400 });
    if (newStatus === "MAINTENANCE" && (!serviceDescription || mechanics.length === 0)) return Response.json({ error: "Informe o serviço em execução e ao menos um mecânico." }, { status: 400 });

    const d1 = await getD1();const access=await requireEquipmentAccess(d1,auth.user!,equipmentId,"OPERATIONAL");
    const equipment = (await d1.prepare(`SELECT id,prefix,status FROM equipment WHERE id=?`).bind(equipmentId).all<Row>()).results[0];
    if (!equipment) return Response.json({ error: "Equipamento não encontrado." }, { status: 404 });
    const current = (await d1.prepare(`SELECT status,since_at,active_occurrence_id,latest_event_id FROM fleet_current_status WHERE equipment_id=?`).bind(equipmentId).all<Row>()).results[0];
    const previousStatus = String(current?.status ?? (equipment.status === "INACTIVE" ? "INACTIVE" : "OPERATING")) as FleetStatus;
    let occurrenceId = rowText(current?.active_occurrence_id);
    const requiresOccurrence = newStatus !== "OPERATING" || Boolean(occurrenceId);
    const createsOccurrence = requiresOccurrence && !occurrenceId;
    if (createsOccurrence) occurrenceId = fleetOccurrenceId(occurredAt);
    if ((newStatus === "READY" || (newStatus === "OPERATING" && occurrenceId)) && !servicePerformed) {
      return Response.json({ error: "Informe o serviço realizado / o que foi feito antes de liberar o equipamento." }, { status: 400 });
    }
    if (orders.length && !occurrenceId) return Response.json({ error: "Pedidos precisam estar vinculados a uma ocorrência de parada." }, { status: 400 });

    const normalizedOrders = orders.map((order) => {
      const status = isFleetOrderStatus(order.status) ? order.status : "REQUESTED";
      const orderNumber = clean(order.orderNumber).toUpperCase();
      const requestedAt = clean(order.requestedAt);
      const description = clean(order.description);
      const quantity = numberOrNull(order.quantity);
      if (!orderNumber || !/^\d{4}-\d{2}-\d{2}/.test(requestedAt) || !description) throw new Error("ORDER_REQUIRED_FIELDS");
      if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) throw new Error("ORDER_QUANTITY");
      return {
        id: clean(order.id) || `PED-${crypto.randomUUID()}`,
        orderNumber, requestedAt, description, quantity, unit: clean(order.unit) || null,
        requester: clean(order.requester) || null, supplier: clean(order.supplier) || null,
        status, notes: clean(order.notes) || null,
      };
    });

    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [];
    if (createsOccurrence && occurrenceId) {
      statements.push(d1.prepare(`INSERT INTO fleet_occurrences
        (id,equipment_id,service_front_id,started_at,reason,problem_description,location,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(occurrenceId, equipmentId,access.serviceFrontId,occurredAt, reason || null, problemDescription || null, location || null, notes || null, auth.user!.id, now, now));
    }
    if (occurrenceId) {
      const endedAt = newStatus === "READY" || newStatus === "OPERATING" ? occurredAt : null;
      const returnedAt = newStatus === "OPERATING" ? occurredAt : null;
      statements.push(d1.prepare(`UPDATE fleet_occurrences SET
        reason=CASE WHEN ?<>'' THEN ? ELSE reason END,
        problem_description=CASE WHEN ?<>'' THEN ? ELSE problem_description END,
        location=CASE WHEN ?<>'' THEN ? ELSE location END,
        service_performed=CASE WHEN ?<>'' THEN ? ELSE service_performed END,
        parts_used=CASE WHEN ?<>'' THEN ? ELSE parts_used END,
        notes=CASE WHEN ?<>'' THEN ? ELSE notes END,
        ended_at=COALESCE(ended_at,?),returned_to_operation_at=COALESCE(returned_to_operation_at,?),
        closed_by=CASE WHEN ? IS NOT NULL THEN ? ELSE closed_by END,updated_at=? WHERE id=?`)
        .bind(reason, reason, problemDescription, problemDescription, location, location, servicePerformed, servicePerformed,
          partsUsed, partsUsed, notes, notes, endedAt, returnedAt, endedAt, auth.user!.id, now, occurrenceId));
    }
    statements.push(d1.prepare(`INSERT INTO fleet_status_events
      (id,occurrence_id,equipment_id,service_front_id,previous_status,new_status,occurred_at,reason,problem_description,service_description,service_performed,location,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(eventId, occurrenceId, equipmentId,access.serviceFrontId,previousStatus, newStatus, occurredAt, reason || null,
      problemDescription || null, serviceDescription || null, servicePerformed || null, location || null, notes || null, auth.user!.id, now, now));

    const statusChanged = previousStatus !== newStatus;
    const nextOccurrenceId = newStatus === "OPERATING" ? null : occurrenceId;
    const sinceAt = statusChanged ? occurredAt : String(current?.since_at ?? occurredAt);
    statements.push(d1.prepare(`INSERT INTO fleet_current_status
      (equipment_id,status,since_at,active_occurrence_id,latest_event_id,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(equipment_id) DO UPDATE SET
      status=excluded.status,since_at=excluded.since_at,active_occurrence_id=excluded.active_occurrence_id,
      latest_event_id=excluded.latest_event_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(equipmentId, newStatus, sinceAt, nextOccurrenceId, eventId, auth.user!.id, now, now));

    for (const [index, mechanic] of mechanics.entries()) {
      statements.push(d1.prepare(`INSERT INTO fleet_mechanics (id,name,active,created_at,updated_at) VALUES (?,?,1,?,?)
        ON CONFLICT(name) DO UPDATE SET active=1,updated_at=excluded.updated_at`).bind(crypto.randomUUID(), mechanic, now, now));
      statements.push(d1.prepare(`INSERT INTO fleet_event_mechanics (id,event_id,mechanic_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), eventId, mechanic, index === 0 ? "RESPONSIBLE" : "ASSISTANT", now, now));
    }
    for (const order of normalizedOrders) {
      statements.push(d1.prepare(`INSERT INTO fleet_orders
        (id,occurrence_id,equipment_id,order_number,requested_at,description,quantity,unit,requester,supplier,status,notes,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(occurrence_id,order_number) DO UPDATE SET
        requested_at=excluded.requested_at,description=excluded.description,quantity=excluded.quantity,unit=excluded.unit,
        requester=excluded.requester,supplier=excluded.supplier,status=excluded.status,notes=excluded.notes,updated_at=excluded.updated_at`)
        .bind(order.id, occurrenceId, equipmentId, order.orderNumber, order.requestedAt, order.description, order.quantity, order.unit,
          order.requester, order.supplier, order.status, order.notes, auth.user!.id, now, now));
    }
    statements.push(d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,previous_value,new_value,occurred_at)
      VALUES (?,?,?,?,?,?,?)`).bind(auth.user!.id, "FLEET_OCCURRENCE", occurrenceId ?? String(equipmentId), "FLEET_STATUS_UPDATED",
      JSON.stringify({ status: previousStatus, eventId: current?.latest_event_id ?? null }),
      JSON.stringify({ status: newStatus, eventId, occurredAt, reason, mechanics, orders: normalizedOrders.map((order) => order.orderNumber) }), now));
    await d1.batch(statements);
    return Response.json({ message: `${String(equipment.prefix)} atualizado para ${FLEET_STATUS_LABELS[newStatus]}.`, occurrenceId, eventId });
  } catch (error) {
    const access=equipmentAccessResponse(error);if(access)return access;
    if (error instanceof Error && error.message === "ORDER_REQUIRED_FIELDS") return Response.json({ error: "Preencha número, data e descrição de cada pedido." }, { status: 400 });
    if (error instanceof Error && error.message === "ORDER_QUANTITY") return Response.json({ error: "A quantidade do pedido deve ser maior que zero." }, { status: 400 });
    console.error("[fleet-status.post]", error);
    return Response.json({ error: "Não foi possível registrar a atualização da frota." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "fleet.update");
  if (auth.response) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const attention = Number(body.attentionHours);
    const high = Number(body.highHours);
    const critical = Number(body.criticalHours);
    if (![attention, high, critical].every(Number.isFinite) || attention <= 0 || high <= attention || critical <= high) {
      return Response.json({ error: "Use limites crescentes: atenção, alto e crítico." }, { status: 400 });
    }
    const now = new Date().toISOString();
    const d1 = await getD1();
    await d1.batch([
      d1.prepare(`INSERT INTO fleet_settings (id,attention_hours,high_hours,critical_hours,created_at,updated_at) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET attention_hours=excluded.attention_hours,high_hours=excluded.high_hours,
        critical_hours=excluded.critical_hours,updated_at=excluded.updated_at`).bind(attention, high, critical, now, now),
      d1.prepare(`INSERT INTO audit_logs (user_id,entity_type,entity_id,action,new_value,occurred_at) VALUES (?,?,?,?,?,?)`)
        .bind(auth.user!.id, "FLEET_SETTINGS", "1", "FLEET_THRESHOLDS_UPDATED", JSON.stringify({ attention, high, critical }), now),
    ]);
    return Response.json({ message: "Limites de tempo parado atualizados." });
  } catch (error) {
    console.error("[fleet-status.put]", error);
    return Response.json({ error: "Não foi possível atualizar os limites." }, { status: 500 });
  }
}
