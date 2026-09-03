import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, pgTable, serial, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

// Gera texto no mesmo formato de `new Date().toISOString()` (usado pelo app em JS),
// para que colunas de data continuem sendo strings ISO-8601 mesmo vindas de um DEFAULT do banco.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const timestamps = {
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
};

export const serviceFronts = pgTable("service_fronts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  location: text("location"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [uniqueIndex("service_fronts_name_unique").on(table.name)]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  username: text("username"),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  role: text("role", { enum:["ADMIN","GESTOR","OFICINA","OPERADOR","ALMOXARIFADO"] }).notNull(),
  // Nível hierárquico organizacional, usado exclusivamente pelas regras de visibilidade/autorização
  // do módulo Tarefas (quem é superior de quem). É independente do "role" acima, que continua
  // controlando as permissões de tela/ação em todo o restante do sistema.
  hierarchyLevel: text("hierarchy_level", { enum:["ADMIN","GESTOR","SUB1","SUB2","SUB3","USUARIO"] }).notNull().default("USUARIO"),
  status: text("status", { enum:["ACTIVE","INACTIVE"] }).notNull().default("ACTIVE"),
  theme: text("theme", { enum:["LIGHT","DARK"] }).notNull().default("LIGHT"),
  isPrimaryAdmin: boolean("is_primary_admin").notNull().default(false),
  lastAccessAt: text("last_access_at"),
  passwordUpdatedAt: text("password_updated_at"),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
  uniqueIndex("users_username_unique").on(table.username),
  index("users_status_role_idx").on(table.status, table.role),
  index("users_service_front_idx").on(table.serviceFrontId),
]);

export const userPermissions = pgTable("user_permissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  permission: text("permission").notNull(),
  enabled: boolean("enabled").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("user_permission_unique").on(table.userId, table.permission),
  index("user_permission_user_idx").on(table.userId),
]);

export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull().default(isoNow),
  ...timestamps,
}, (table) => [
  uniqueIndex("user_session_token_unique").on(table.tokenHash),
  index("user_session_user_idx").on(table.userId),
  index("user_session_expiry_idx").on(table.expiresAt),
]);

export const authBootstrap = pgTable("auth_bootstrap", {
  key: text("key").primaryKey(),
  completedAt: text("completed_at").notNull().default(isoNow),
});

export const equipment = pgTable("equipment", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  prefix: text("prefix").notNull(),
  type: text("type").notNull(),
  brand: text("brand").notNull(),
  model: text("model").notNull(),
  year: integer("year"),
  serialNumber: text("serial_number"),
  chassis: text("chassis"),
  identificationType: text("identification_type", { enum:["SERIAL_NUMBER","CHASSIS"] }).notNull().default("SERIAL_NUMBER"),
  plate: text("plate"),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  location: text("location"),
  currentHours: doublePrecision("current_hours").notNull().default(0),
  currentKm: doublePrecision("current_km").notNull().default(0),
  controlType: text("control_type", { enum:["HOURS","KM","HOURS_KM"] }).notNull().default("HOURS"),
  status: text("status", { enum:["ACTIVE","STOPPED","MAINTENANCE","INACTIVE"] }).notNull().default("ACTIVE"),
  notes: text("notes"),
  photoKey: text("photo_key"),
  qrToken: text("qr_token"),
  oilChangeEnabled: boolean("oil_change_enabled").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("equipment_code_unique").on(table.code),
  uniqueIndex("equipment_prefix_unique").on(table.prefix),
  uniqueIndex("equipment_serial_unique").on(table.serialNumber),
  uniqueIndex("equipment_qr_token_unique").on(table.qrToken),
  index("equipment_front_idx").on(table.serviceFrontId),
  index("equipment_oil_front_idx").on(table.oilChangeEnabled, table.serviceFrontId),
]);

export const equipmentTransfers = pgTable("equipment_transfers", {
  id: text("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  previousServiceFrontId: integer("previous_service_front_id").references(() => serviceFronts.id),
  newServiceFrontId: integer("new_service_front_id").notNull().references(() => serviceFronts.id),
  transferredAt: text("transferred_at").notNull(),
  transferredBy: integer("transferred_by").notNull().references(() => users.id),
  note: text("note"),
  ...timestamps,
}, (table) => [
  index("equipment_transfer_equipment_date_idx").on(table.equipmentId, table.transferredAt),
  index("equipment_transfer_front_date_idx").on(table.newServiceFrontId, table.transferredAt),
]);

export const fleetOccurrences = pgTable("fleet_occurrences", {
  id: text("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  returnedToOperationAt: text("returned_to_operation_at"),
  reason: text("reason"),
  problemDescription: text("problem_description"),
  location: text("location"),
  servicePerformed: text("service_performed"),
  partsUsed: text("parts_used"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  closedBy: integer("closed_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("fleet_occurrence_equipment_started_idx").on(table.equipmentId, table.startedAt),
  index("fleet_occurrence_period_idx").on(table.startedAt, table.endedAt),
]);

export const fleetStatusEvents = pgTable("fleet_status_events", {
  id: text("id").primaryKey(),
  occurrenceId: text("occurrence_id").references(() => fleetOccurrences.id),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  previousStatus: text("previous_status").notNull(),
  newStatus: text("new_status").notNull(),
  occurredAt: text("occurred_at").notNull(),
  reason: text("reason"),
  problemDescription: text("problem_description"),
  serviceDescription: text("service_description"),
  servicePerformed: text("service_performed"),
  location: text("location"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("fleet_event_equipment_date_idx").on(table.equipmentId, table.occurredAt),
  index("fleet_event_occurrence_date_idx").on(table.occurrenceId, table.occurredAt),
]);

export const fleetCurrentStatus = pgTable("fleet_current_status", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  status: text("status").notNull().default("OPERATING"),
  sinceAt: text("since_at").notNull(),
  activeOccurrenceId: text("active_occurrence_id").references(() => fleetOccurrences.id),
  latestEventId: text("latest_event_id").references(() => fleetStatusEvents.id),
  updatedBy: integer("updated_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("fleet_current_equipment_unique").on(table.equipmentId),
  index("fleet_current_status_idx").on(table.status, table.sinceAt),
]);

export const fleetMechanics = pgTable("fleet_mechanics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [uniqueIndex("fleet_mechanics_name_unique").on(table.name)]);

export const fleetEventMechanics = pgTable("fleet_event_mechanics", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => fleetStatusEvents.id),
  mechanicName: text("mechanic_name").notNull(),
  role: text("role").notNull().default("MECHANIC"),
  ...timestamps,
}, (table) => [
  uniqueIndex("fleet_event_mechanic_unique").on(table.eventId, table.mechanicName),
  index("fleet_event_mechanic_name_idx").on(table.mechanicName),
]);

export const fleetOrders = pgTable("fleet_orders", {
  id: text("id").primaryKey(),
  occurrenceId: text("occurrence_id").notNull().references(() => fleetOccurrences.id),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  orderNumber: text("order_number").notNull(),
  requestedAt: text("requested_at").notNull(),
  description: text("description").notNull(),
  quantity: doublePrecision("quantity"),
  unit: text("unit"),
  requester: text("requester"),
  supplier: text("supplier"),
  status: text("status").notNull().default("REQUESTED"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("fleet_order_occurrence_number_unique").on(table.occurrenceId, table.orderNumber),
  index("fleet_order_equipment_status_idx").on(table.equipmentId, table.status),
]);

export const fleetSettings = pgTable("fleet_settings", {
  id: integer("id").primaryKey().default(1),
  attentionHours: doublePrecision("attention_hours").notNull().default(4),
  highHours: doublePrecision("high_hours").notNull().default(12),
  criticalHours: doublePrecision("critical_hours").notNull().default(24),
  ...timestamps,
});

export const meterReadings = pgTable("meter_readings", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  readingDate: text("reading_date").notNull(),
  hours: doublePrecision("hours"),
  km: doublePrecision("km"),
  operator: text("operator"),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  notes: text("notes"),
  source: text("source", { enum:["MANUAL","EXCEL_IMPORT","QR_CODE","MAINTENANCE"] }).notNull().default("MANUAL"),
  authorizedRegression: boolean("authorized_regression").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("meter_equipment_date_idx").on(table.equipmentId, table.readingDate),
]);

export const readingImports = pgTable("reading_imports", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  importedBy: integer("imported_by").notNull().references(() => users.id),
  totalRows: integer("total_rows").notNull(),
  readyRows: integer("ready_rows").notNull(),
  updatedRows: integer("updated_rows").notNull(),
  skippedRows: integer("skipped_rows").notNull(),
  errorRows: integer("error_rows").notNull(),
  errorsJson: text("errors_json").notNull().default("[]"),
  importedAt: text("imported_at").notNull().default(isoNow),
  ...timestamps,
}, (table) => [
  index("reading_imports_user_date_idx").on(table.importedBy, table.importedAt),
]);

export const maintenanceTypes = pgTable("maintenance_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [uniqueIndex("maintenance_types_name_unique").on(table.name)]);

export const maintenanceIntervalConfigs = pgTable("maintenance_interval_configs", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  maintenanceTypeId: integer("maintenance_type_id").notNull().references(() => maintenanceTypes.id),
  intervalValue: doublePrecision("interval_value").notNull(),
  unit: text("unit", { enum:["HOURS","KM"] }).notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("maintenance_interval_category_type_unique").on(table.category, table.maintenanceTypeId),
  index("maintenance_interval_category_active_idx").on(table.category, table.active),
]);

export const maintenanceRecalculationState = pgTable("maintenance_recalculation_state", {
  key: text("key").primaryKey(),
  signature: text("signature").notNull(),
  recalculatedAt: text("recalculated_at").notNull(),
});

export const equipmentMaintenanceTypes = pgTable("equipment_maintenance_types", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  maintenanceTypeId: integer("maintenance_type_id").notNull().references(() => maintenanceTypes.id),
  applicable: boolean("applicable").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("equipment_maintenance_type_unique").on(table.equipmentId, table.maintenanceTypeId),
  index("equipment_maintenance_applicable_idx").on(table.equipmentId, table.applicable),
]);

export const maintenancePlans = pgTable("maintenance_plans", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  maintenanceTypeId: integer("maintenance_type_id").notNull().references(() => maintenanceTypes.id),
  intervalHours: doublePrecision("interval_hours"),
  intervalKm: doublePrecision("interval_km"),
  intervalDays: integer("interval_days"),
  triggerMode: text("trigger_mode", { enum:["HOURS","KM","TIME","HOURS_OR_TIME","KM_OR_TIME"] }).notNull().default("HOURS"),
  lastHours: doublePrecision("last_hours"),
  lastKm: doublePrecision("last_km"),
  lastDate: text("last_date"),
  nextHours: doublePrecision("next_hours"),
  nextKm: doublePrecision("next_km"),
  nextDate: text("next_date"),
  expectedQuantity: doublePrecision("expected_quantity"),
  oilType: text("oil_type"),
  viscosity: text("viscosity"),
  brand: text("brand"),
  filterReference: text("filter_reference"),
  warningHours: doublePrecision("warning_hours").default(100),
  criticalHours: doublePrecision("critical_hours").default(50),
  warningKm: doublePrecision("warning_km"),
  criticalKm: doublePrecision("critical_km"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("plan_equipment_type_unique").on(table.equipmentId, table.maintenanceTypeId),
  index("plan_next_hours_idx").on(table.nextHours),
  index("plan_next_km_idx").on(table.nextKm),
]);

export const maintenances = pgTable("maintenances", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  planId: integer("plan_id").references(() => maintenancePlans.id),
  maintenanceTypeId: integer("maintenance_type_id").notNull().references(() => maintenanceTypes.id),
  performedAt: text("performed_at").notNull(),
  hours: doublePrecision("hours"),
  km: doublePrecision("km"),
  mechanic: text("mechanic"),
  workOrder: text("work_order").notNull(),
  cost: doublePrecision("cost").notNull().default(0),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("maintenances_work_order_type_unique").on(table.workOrder, table.maintenanceTypeId),
  uniqueIndex("maintenances_equipment_plan_performed_unique").on(table.equipmentId, table.planId, table.performedAt),
  index("maintenance_equipment_date_idx").on(table.equipmentId, table.performedAt),
]);

export const importedMaintenanceHistory = pgTable("imported_maintenance_history", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  maintenanceTypeId: integer("maintenance_type_id").references(() => maintenanceTypes.id),
  prefix: text("prefix").notNull(),
  service: text("service").notNull(),
  readingRaw: text("reading_raw").notNull().default(""),
  readingValue: doublePrecision("reading_value"),
  controlType: text("control_type", { enum:["HOURS","KM"] }).notNull(),
  performedAt: text("performed_at"),
  source: text("source").notNull().default("PLANILHA_IMPORTADA"),
  importType: text("import_type"),
  importKey: text("import_key"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("imported_history_fingerprint_unique").on(table.prefix, table.service, table.readingRaw, table.performedAt),
  uniqueIndex("imported_history_import_key_unique").on(table.importKey),
  index("imported_history_equipment_type_idx").on(table.equipmentId, table.maintenanceTypeId),
  index("imported_history_date_idx").on(table.performedAt),
  index("imported_history_prefix_idx").on(table.prefix),
]);

export const maintenanceImportRuns = pgTable("maintenance_import_runs", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  source: text("source").notNull(),
  observation: text("observation").notNull(),
  status: text("status", { enum:["SIMULATED","COMPLETED","COMPLETED_WITH_ERRORS"] }).notNull(),
  totalAnalyzed: integer("total_analyzed").notNull().default(0),
  imported: integer("imported").notNull().default(0),
  alreadyExisting: integer("already_existing").notNull().default(0),
  newerExisting: integer("newer_existing").notNull().default(0),
  zeroValues: integer("zero_values").notNull().default(0),
  equipmentNotFound: integer("equipment_not_found").notNull().default(0),
  categoriesNotFound: integer("categories_not_found").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  completedAt: text("completed_at"),
  ...timestamps,
});

export const maintenanceImportResults = pgTable("maintenance_import_results", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().references(() => maintenanceImportRuns.id),
  rowNumber: integer("row_number").notNull(),
  equipmentPrefix: text("equipment_prefix").notNull(),
  category: text("category").notNull(),
  readingValue: doublePrecision("reading_value").notNull(),
  unit: text("unit", { enum:["HOURS","KM"] }).notNull(),
  status: text("status", { enum:["PENDING","IMPORTED","ALREADY_EXISTS","NEWER_EXISTS","IGNORED_ZERO","EQUIPMENT_NOT_FOUND","CATEGORY_NOT_FOUND","ERROR"] }).notNull().default("PENDING"),
  detail: text("detail"),
  importedHistoryId: integer("imported_history_id").references(() => importedMaintenanceHistory.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("maintenance_import_result_row_unique").on(table.runId, table.rowNumber),
  index("maintenance_import_result_status_idx").on(table.runId, table.status),
]);

export const maintenanceItems = pgTable("maintenance_items", {
  id: serial("id").primaryKey(),
  maintenanceId: integer("maintenance_id").notNull().references(() => maintenances.id),
  description: text("description").notNull(),
  itemType: text("item_type", { enum:["OIL","FILTER","PART","OTHER"] }).notNull(),
  quantity: doublePrecision("quantity").notNull().default(1),
  unit: text("unit").notNull().default("UN"),
  brand: text("brand"),
  reference: text("reference"),
  unitCost: doublePrecision("unit_cost").default(0),
  ...timestamps,
}, (table) => [index("maintenance_items_parent_idx").on(table.maintenanceId)]);

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  planId: integer("plan_id").notNull().references(() => maintenancePlans.id),
  level: text("level", { enum:["OK","WARNING","NEAR","OVERDUE","CRITICAL"] }).notNull(),
  controlType: text("control_type", { enum:["HOURS","KM"] }).notNull().default("HOURS"),
  currentValue: doublePrecision("current_value").notNull().default(0),
  plannedValue: doublePrecision("planned_value").notNull().default(0),
  remainingValue: doublePrecision("remaining_value").notNull().default(0),
  overdueValue: doublePrecision("overdue_value").notNull().default(0),
  maintenanceStatus: text("maintenance_status", { enum:["OK","WARNING","NEAR","OVERDUE"] }).notNull().default("OK"),
  status: text("status", { enum:["OPEN","ACKNOWLEDGED","CLOSED"] }).notNull().default("OPEN"),
  message: text("message").notNull(),
  generatedAt: text("generated_at").notNull().default(isoNow),
  viewedAt: text("viewed_at"),
  closedAt: text("closed_at"),
  closedByMaintenanceId: integer("closed_by_maintenance_id").references(() => maintenances.id),
  fingerprint: text("fingerprint").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("alerts_fingerprint_unique").on(table.fingerprint),
  index("alerts_status_level_idx").on(table.status, table.level),
]);

export const whatsappSettings = pgTable("whatsapp_settings", {
  id: integer("id").primaryKey().default(1),
  connectionName: text("connection_name"),
  senderPhone: text("sender_phone"),
  phoneNumberId: text("phone_number_id"),
  wabaId: text("waba_id"),
  accessTokenEncrypted: text("access_token_encrypted"),
  apiVersion: text("api_version").notNull().default("v23.0"),
  connectionStatus: text("connection_status", { enum:["NOT_CONFIGURED","CONNECTED","ERROR"] }).notNull().default("NOT_CONFIGURED"),
  lastConnectionError: text("last_connection_error"),
  lastTestedAt: text("last_tested_at"),
  automaticEnabled: boolean("automatic_enabled").notNull().default(false),
  sendMode: text("send_mode", { enum:["MANUAL","API"] }).notNull().default("MANUAL"),
  overdueRepeatDays: integer("overdue_repeat_days").notNull().default(0),
  templateName: text("template_name"),
  templateLanguage: text("template_language").notNull().default("pt_BR"),
  ...timestamps,
});

export const whatsappRecipients = pgTable("whatsapp_recipients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  active: boolean("active").notNull().default(true),
  categories: text("categories").notNull().default('["ALL"]'),
  alertTypes: text("alert_types").notNull().default('["WARNING","NEAR","OVERDUE"]'),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("whatsapp_recipients_phone_unique").on(table.phone),
  index("whatsapp_recipients_active_idx").on(table.active),
]);

export const whatsappDeliveries = pgTable("whatsapp_deliveries", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").references(() => alerts.id),
  planId: integer("plan_id").references(() => maintenancePlans.id),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  recipientId: integer("recipient_id").references(() => whatsappRecipients.id),
  equipmentPrefix: text("equipment_prefix").notNull(),
  category: text("category").notNull(),
  maintenanceName: text("maintenance_name").notNull(),
  alertStatus: text("alert_status").notNull(),
  currentValue: doublePrecision("current_value"),
  lastValue: doublePrecision("last_value"),
  nextValue: doublePrecision("next_value"),
  remainingValue: doublePrecision("remaining_value"),
  unit: text("unit", { enum:["HOURS","KM"] }),
  recipientName: text("recipient_name").notNull(),
  recipientPhone: text("recipient_phone").notNull(),
  message: text("message").notNull(),
  result: text("result", { enum:["SENT","DELIVERED","PENDING","FAILED"] }).notNull().default("PENDING"),
  providerMessageId: text("provider_message_id"),
  errorReason: text("error_reason"),
  triggerType: text("trigger_type", { enum:["AUTOMATIC","MANUAL","TEST","OVERDUE_REPEAT"] }).notNull(),
  dedupeKey: text("dedupe_key"),
  sentAt: text("sent_at"),
  deliveredAt: text("delivered_at"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("whatsapp_deliveries_dedupe_unique").on(table.dedupeKey),
  index("whatsapp_deliveries_plan_recipient_idx").on(table.planId, table.recipientId),
  index("whatsapp_deliveries_result_date_idx").on(table.result, table.createdAt),
]);

export const attachments = pgTable("attachments", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  maintenanceId: integer("maintenance_id").references(() => maintenances.id),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  ...timestamps,
});

export const systemSettings = pgTable("system_settings", {
  id: integer("id").primaryKey().default(1),
  alertaHorasVerde: doublePrecision("alerta_horas_verde").notNull().default(100),
  alertaHorasAmareloInicio: doublePrecision("alerta_horas_amarelo_inicio").notNull().default(51),
  alertaHorasAmareloFim: doublePrecision("alerta_horas_amarelo_fim").notNull().default(100),
  alertaHorasLaranjaInicio: doublePrecision("alerta_horas_laranja_inicio").notNull().default(1),
  alertaHorasLaranjaFim: doublePrecision("alerta_horas_laranja_fim").notNull().default(50),
  alertaKmVerde: doublePrecision("alerta_km_verde").notNull().default(2000),
  alertaKmAmareloInicio: doublePrecision("alerta_km_amarelo_inicio").notNull().default(1001),
  alertaKmAmareloFim: doublePrecision("alerta_km_amarelo_fim").notNull().default(2000),
  alertaKmLaranjaInicio: doublePrecision("alerta_km_laranja_inicio").notNull().default(1),
  alertaKmLaranjaFim: doublePrecision("alerta_km_laranja_fim").notNull().default(1000),
  urgencyPercent: doublePrecision("urgency_percent").notNull().default(20),
  ...timestamps,
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  occurredAt: text("occurred_at").notNull().default(isoNow),
}, (table) => [index("audit_entity_idx").on(table.entityType, table.entityId)]);

export const materialRequests = pgTable("material_requests", {
  id: serial("id").primaryKey(),
  requesterId: integer("requester_id").notNull().references(() => users.id),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  requestedAt: text("requested_at").notNull().default(isoNow),
  status: text("status", { enum:["PENDING","IN_SEPARATION","SENT","PARTIALLY_SENT","NOT_FULFILLED"] }).notNull().default("PENDING"),
  notes: text("notes"),
  shippedBy: integer("shipped_by").references(() => users.id),
  shippedAt: text("shipped_at"),
  shipmentNotes: text("shipment_notes"),
  ...timestamps,
}, (table) => [
  index("material_requests_requester_idx").on(table.requesterId, table.requestedAt),
  index("material_requests_status_idx").on(table.status, table.requestedAt),
  index("material_requests_front_idx").on(table.serviceFrontId),
]);

export const materialRequestItems = pgTable("material_request_items", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull().references(() => materialRequests.id),
  description: text("description").notNull(),
  reference: text("reference"),
  quantityRequested: doublePrecision("quantity_requested").notNull(),
  itemStatus: text("item_status", { enum:["PENDING","SENT","NOT_AVAILABLE"] }).notNull().default("PENDING"),
  quantitySent: doublePrecision("quantity_sent"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [index("material_request_items_request_idx").on(table.requestId)]);

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  parentTaskId: integer("parent_task_id").references((): AnyPgColumn => tasks.id),
  title: text("title").notNull(),
  description: text("description"),
  // Obrigatório na aplicação (validado nas rotas de API); mantido opcional aqui no banco
  // apenas para não quebrar com eventuais registros legados sem responsável definido.
  assigneeId: integer("assignee_id").references(() => users.id),
  urgency: text("urgency", { enum:["LOW","MEDIUM","HIGH","URGENT"] }).notNull().default("MEDIUM"),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum:["TODO","IN_PROGRESS","DONE","NOT_DONE"] }).notNull().default("TODO"),
  createdBy: integer("created_by").references(() => users.id),
  completedAt: text("completed_at"),
  completedBy: integer("completed_by").references(() => users.id),
  completionNote: text("completion_note"),
  notDoneAt: text("not_done_at"),
  notDoneBy: integer("not_done_by").references(() => users.id),
  notDoneReason: text("not_done_reason"),
  deletedAt: text("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("tasks_parent_idx").on(table.parentTaskId),
  index("tasks_assignee_idx").on(table.assigneeId, table.status),
  index("tasks_due_date_idx").on(table.dueDate),
  index("tasks_deleted_idx").on(table.deletedAt),
]);
