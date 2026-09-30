import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, pgTable, primaryKey, serial, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

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
  // CAMPO = funcionário de campo: entra só com nome + código (sem senha) e só acessa o Controle
  // Diário — a restrição é aplicada no backend em lib/auth.ts (authorize/FIELD_ALLOWED_API).
  role: text("role", { enum:["ADMIN","GESTOR","OFICINA","OPERADOR","ALMOXARIFADO","CAMPO"] }).notNull(),
  // Nível hierárquico organizacional, usado exclusivamente pelas regras de visibilidade/autorização
  // do módulo Tarefas (quem é superior de quem). É independente do "role" acima, que continua
  // controlando as permissões de tela/ação em todo o restante do sistema.
  // Campo legado (pré-Gestor de Cargos de Tarefas). Não é mais lido nem gravado pela aplicação —
  // preservado apenas para não apagar dado histórico. A fonte de verdade do Cargo de Tarefas de
  // cada usuário agora é `taskRoleId`, abaixo.
  hierarchyLevel: text("hierarchy_level", { enum:["ADMIN","GESTOR","SUB1","SUB2","SUB3","USUARIO"] }).notNull().default("USUARIO"),
  // Cargo de Tarefas (módulo Tarefas): FK para task_roles, independente do `role` (perfil) acima,
  // que continua controlando as permissões de tela/ação em todo o restante do sistema. Nullable
  // para acomodar registros legados/legítimos ainda não regularizados pelo ADMIN (ver seção 9 da
  // especificação) — enquanto nulo, o usuário não pode criar nem receber novas tarefas.
  taskRoleId: integer("task_role_id").references((): AnyPgColumn => taskRoles.id),
  status: text("status", { enum:["ACTIVE","INACTIVE"] }).notNull().default("ACTIVE"),
  theme: text("theme", { enum:["LIGHT","DARK"] }).notNull().default("LIGHT"),
  isPrimaryAdmin: boolean("is_primary_admin").notNull().default(false),
  lastAccessAt: text("last_access_at"),
  passwordUpdatedAt: text("password_updated_at"),
  // Frente principal: padrão em formulários e relatórios. Quem enxerga MAIS de uma frente tem
  // isso registrado em `userServiceFronts` (abaixo) — este campo nunca é a fonte de verdade de
  // visibilidade sozinho, só o valor padrão pré-selecionado.
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  // TRUE = enxerga todas as frentes, inclusive as cadastradas no futuro, sem precisar editar o
  // usuário de novo. Independente do perfil (ADMIN/GESTOR/USUÁRIO) — perfil define o que a pessoa
  // PODE FAZER, frente define o que ela ENXERGA.
  allServiceFronts: boolean("all_service_fronts").notNull().default(false),
  // Libera a exportação de trocas de óleo em Excel para quem não é ADMIN/GESTOR, caso a caso.
  canExport: boolean("can_export").notNull().default(false),
  // Função/cargo exibido no Controle Diário (ex.: "Operador de Baldeio").
  jobTitle: text("job_title"),
  // Só para perfil CAMPO: código numérico de acesso, guardado como "salt:hash" (nunca em texto).
  accessCodeHash: text("access_code_hash"),
  ...timestamps,
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
  uniqueIndex("users_username_unique").on(table.username),
  index("users_status_role_idx").on(table.status, table.role),
  index("users_service_front_idx").on(table.serviceFrontId),
  index("users_task_role_idx").on(table.taskRoleId),
]);

// Frentes visíveis por usuário (além da frente principal acima) — um usuário pode enxergar várias.
// Ignorada quando `users.allServiceFronts` é TRUE ou o perfil é ADMIN (esses dois casos enxergam
// tudo sem precisar de linha aqui). Ver lib/access.ts:frentesVisiveis, o único ponto que decide
// "quais frentes esta pessoa vê" — toda query que filtra por frente passa por ele.
export const userServiceFronts = pgTable("user_service_fronts", {
  userId: integer("user_id").notNull().references(() => users.id),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.userId, table.serviceFrontId] }),
  index("user_service_fronts_front_idx").on(table.serviceFrontId),
]);

// Cargos de Tarefas: papel usado exclusivamente para definir quem pode enviar, receber,
// visualizar e gerenciar tarefas — não confundir com a função profissional do usuário (`role`
// em `users`, ex.: OFICINA/OPERADOR) nem com o `hierarchyLevel` legado acima. Editável só pelo
// ADMIN/cargo raiz através do Gestor de Cargos de Tarefas.
export const taskRoles = pgTable("task_roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  visualOrder: integer("visual_order").notNull().default(0),
  // Cargo raiz (ADMIN): acesso global a todas as tarefas e históricos, único ponto de exceção às
  // regras de conexão. Deve existir exatamente um cargo raiz ativo; a aplicação impede excluir ou
  // desativar esse cargo.
  isRoot: boolean("is_root").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("task_roles_name_unique").on(table.name),
  index("task_roles_active_idx").on(table.active, table.visualOrder),
]);

// Relações direcionadas entre Cargos de Tarefas: "de origem" pode enviar/visualizar/gerenciar
// tarefas "de destino". Não transitivas, não conferem automaticamente a relação inversa. Uma
// linha com sourceRoleId=targetRoleId representa "enviar entre usuários do mesmo cargo".
export const taskRoleConnections = pgTable("task_role_connections", {
  id: serial("id").primaryKey(),
  sourceRoleId: integer("source_role_id").notNull().references(() => taskRoles.id),
  targetRoleId: integer("target_role_id").notNull().references(() => taskRoles.id),
  canSend: boolean("can_send").notNull().default(false),
  canViewReceived: boolean("can_view_received").notNull().default(false),
  canViewSent: boolean("can_view_sent").notNull().default(false),
  canManage: boolean("can_manage").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id),
  updatedBy: integer("updated_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("task_role_connections_pair_unique").on(table.sourceRoleId, table.targetRoleId),
  index("task_role_connections_target_idx").on(table.targetRoleId),
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
  // FK para equipment_models (módulo Produtos), preenchida por rotina de casamento textual best-effort
  // com o `model` acima. Convive com `model`/`brand` (texto livre, nunca sobrescritos) durante a
  // transição: fica NULL sempre que a rotina não tiver certeza do casamento.
  equipmentModelId: integer("equipment_model_id").references((): AnyPgColumn => equipmentModels.id),
  // Chave de ordenação alfanumérica natural derivada do prefixo (ver lib/equipment-sort.ts):
  // maiúsculas, sem acento, cada sequência de dígitos preenchida com zeros à esquerda — assim
  // "EQ-2" ordena antes de "EQ-10". Calculada em toda gravação de equipamento; nunca editada
  // manualmente. Índice permite `ORDER BY sort_key` direto no banco, inclusive paginado.
  sortKey: text("sort_key").notNull().default(""),
  // Empresa em cujo nome o veículo está registrado (mesmo cadastro de Empresas dos Funcionários).
  companyId: integer("company_id").references((): AnyPgColumn => companies.id),
  // Validade do IPVA (AAAA-MM-DD).
  ipvaExpiresAt: text("ipva_expires_at"),
  // Veículo vendido (AAAA-MM-DD da venda). NULL = faz parte da frota ativa. Vendido sai das listas
  // operacionais (troca de óleo, status da frota, lançamentos), mas todo o histórico é preservado
  // e a marcação pode ser desfeita.
  soldAt: text("sold_at"),
  soldBy: integer("sold_by").references(() => users.id),
  soldNotes: text("sold_notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("equipment_code_unique").on(table.code),
  uniqueIndex("equipment_prefix_unique").on(table.prefix),
  uniqueIndex("equipment_serial_unique").on(table.serialNumber),
  uniqueIndex("equipment_qr_token_unique").on(table.qrToken),
  index("equipment_front_idx").on(table.serviceFrontId),
  index("equipment_oil_front_idx").on(table.oilChangeEnabled, table.serviceFrontId),
  index("equipment_sort_key_idx").on(table.sortKey),
  index("equipment_model_idx").on(table.equipmentModelId),
  index("equipment_sold_idx").on(table.soldAt),
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
  index("meter_equipment_date_idx").on(table.equipmentId, table.readingDate), index("meter_front_idx").on(table.serviceFrontId),
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
  index("equipment_maintenance_applicable_idx").on(table.equipmentId, table.applicable), index("equipment_maintenance_type_idx").on(table.maintenanceTypeId),
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
  lastIsGenericDate: boolean("last_is_generic_date").notNull().default(false),
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
  index("plan_next_km_idx").on(table.nextKm), index("plan_maintenance_type_idx").on(table.maintenanceTypeId),
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
  // O.S. do módulo Ordem de Serviço a que esta troca pertence (vínculo automático pela última O.S.
  // do equipamento no QR Code, editável). NULL = número de OS livre/antigo, sem O.S. cadastrada.
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id),
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
  isGenericDate: boolean("is_generic_date").notNull().default(false),
  dateSource: text("date_source", { enum:["ORIGINAL","IMPORT_DEFAULT"] }).notNull().default("ORIGINAL"),
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
  index("alerts_status_level_idx").on(table.status, table.level), index("alerts_plan_idx").on(table.planId), index("alerts_equipment_idx").on(table.equipmentId, table.status),
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
}, (table) => [index("audit_entity_idx").on(table.entityType, table.entityId), index("audit_user_idx").on(table.userId)]);

export const materialRequests = pgTable("material_requests", {
  id: serial("id").primaryKey(),
  requesterId: integer("requester_id").notNull().references(() => users.id),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  requestedAt: text("requested_at").notNull().default(isoNow),
  // PENDING/IN_SEPARATION são os estados ativos "em espera"; SENT/PARTIALLY_SENT/NOT_FULFILLED/
  // CANCELLED são terminais (só aparecem no Histórico — seção 10 da especificação). PARTIALLY_SENT só
  // é gravado quando todos os itens já foram decididos, por isso também é terminal.
  status: text("status", { enum:["PENDING","IN_SEPARATION","SENT","PARTIALLY_SENT","NOT_FULFILLED","CANCELLED"] }).notNull().default("PENDING"),
  notes: text("notes"),
  shippedBy: integer("shipped_by").references(() => users.id),
  shippedAt: text("shipped_at"),
  shipmentNotes: text("shipment_notes"),
  // Frente cujo estoque (módulo Produtos) saiu no envio dos itens vinculados a produtos.
  originServiceFrontId: integer("origin_service_front_id").references((): AnyPgColumn => serviceFronts.id),
  cancelledAt: text("cancelled_at"),
  cancelledBy: integer("cancelled_by").references(() => users.id),
  cancelReason: text("cancel_reason"),
  // Reabertura (seção 10): volta uma solicitação terminal para PENDING. Preserva os campos de
  // envio/cancelamento anteriores como histórico — só o status muda, o evento fica no audit log.
  reopenedAt: text("reopened_at"),
  reopenedBy: integer("reopened_by").references(() => users.id),
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
  // Unidade fiscal (lib/fiscal-units.ts) — a que vai constar na nota/compra. NULL só nos itens
  // anteriores à criação do campo.
  fiscalUnit: text("fiscal_unit"),
  itemStatus: text("item_status", { enum:["PENDING","SENT","NOT_AVAILABLE"] }).notNull().default("PENDING"),
  quantitySent: doublePrecision("quantity_sent"),
  notes: text("notes"),
  // Item vinculado a um produto cadastrado (módulo Produtos): o envio movimenta o estoque por frente
  // (sai da frente de origem, entra na frente que pediu). NULL = item digitado à mão, sem estoque.
  productId: integer("product_id").references((): AnyPgColumn => products.id, { onDelete:"set null" }),
  ...timestamps,
}, (table) => [index("material_request_items_request_idx").on(table.requestId), index("material_request_items_product_idx").on(table.productId)]);

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  parentTaskId: integer("parent_task_id").references((): AnyPgColumn => tasks.id),
  title: text("title").notNull(),
  description: text("description"),
  // Obrigatório na aplicação (validado nas rotas de API); mantido opcional aqui no banco
  // apenas para não quebrar com eventuais registros legados sem responsável definido.
  assigneeId: integer("assignee_id").references(() => users.id),
  // Cargo de Tarefas do criador/responsável no momento do envio — puramente informativo/histórico
  // (exibido no detalhe e no Histórico). As decisões de autorização NUNCA usam estes snapshots:
  // sempre consultam o cargo ATUAL de cada pessoa, para que uma mudança de cargo se reflita
  // imediatamente nas permissões sem reescrever tarefas antigas.
  creatorRoleSnapshotId: integer("creator_role_snapshot_id").references(() => taskRoles.id),
  assigneeRoleSnapshotId: integer("assignee_role_snapshot_id").references(() => taskRoles.id),
  urgency: text("urgency", { enum:["LOW","MEDIUM","HIGH","URGENT"] }).notNull().default("MEDIUM"),
  dueDate: text("due_date").notNull(),
  // AWAITING_COMPLETION_APPROVAL/AWAITING_NON_EXECUTION_APPROVAL: estados intermediários do fluxo
  // de aprovação (seções 12-17 da especificação). O responsável nunca leva a tarefa direto a
  // DONE/NOT_DONE — só o criador (ou o cargo raiz, quando o criador não pode decidir) faz essa
  // transição final, via APPROVE_COMPLETION/REJECT_COMPLETION/AUTHORIZE_NOT_DONE/DENY_NOT_DONE.
  status: text("status", { enum:["TODO","IN_PROGRESS","AWAITING_COMPLETION_APPROVAL","AWAITING_NOT_DONE_AUTHORIZATION","DONE","NOT_DONE","CANCELLED"] }).notNull().default("TODO"),
  createdBy: integer("created_by").references(() => users.id),
  // "Visualizada" não é um status próprio (evitaria voltar a refletir status real depois que o
  // responsável avança para Em andamento/Concluída/etc.) — é um carimbo à parte, e a tela deriva
  // o rótulo "Visualizada" quando status ainda é TODO mas viewedAt já foi preenchido.
  viewedAt: text("viewed_at"),
  viewedBy: integer("viewed_by").references(() => users.id),
  // Guarda o status anterior ao pedido de aprovação (TODO ou IN_PROGRESS) para poder devolver a
  // tarefa exatamente a esse estado se o criador rejeitar/não autorizar (seções 13/14).
  statusBeforeApprovalRequest: text("status_before_approval_request", { enum:["TODO","IN_PROGRESS"] }),
  // Pedido de conclusão (seção 13): preenchidos quando o responsável solicita a conclusão.
  // completionNote guarda a "Observação da conclusão" enviada nesse momento (reaproveitado — já
  // existia com esse mesmo sentido antes da aprovação em duas etapas).
  requestedCompletionBy: integer("requested_completion_by").references(() => users.id),
  requestedCompletionAt: text("requested_completion_at"),
  completedAt: text("completed_at"),
  completedBy: integer("completed_by").references(() => users.id),
  completionNote: text("completion_note"),
  completionApprovedBy: integer("completion_approved_by").references(() => users.id),
  completionApprovedAt: text("completion_approved_at"),
  completionRejectionReason: text("completion_rejection_reason"),
  // Pedido de não realização (seção 14): mesmo desenho do bloco de conclusão acima.
  // notDoneReason guarda a justificativa enviada pelo responsável no pedido (reaproveitado).
  requestedNonExecutionBy: integer("requested_non_execution_by").references(() => users.id),
  requestedNonExecutionAt: text("requested_non_execution_at"),
  notDoneAt: text("not_done_at"),
  notDoneBy: integer("not_done_by").references(() => users.id),
  notDoneReason: text("not_done_reason"),
  nonExecutionApprovedBy: integer("non_execution_approved_by").references(() => users.id),
  nonExecutionApprovedAt: text("non_execution_approved_at"),
  nonExecutionRejectionReason: text("non_execution_rejection_reason"),
  cancelledAt: text("cancelled_at"),
  cancelledBy: integer("cancelled_by").references(() => users.id),
  cancelReason: text("cancel_reason"),
  deletedAt: text("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("tasks_parent_idx").on(table.parentTaskId),
  index("tasks_assignee_idx").on(table.assigneeId, table.status),
  index("tasks_due_date_idx").on(table.dueDate),
  index("tasks_deleted_idx").on(table.deletedAt), index("tasks_created_by_idx").on(table.createdBy),
]);

// Notificações do módulo Tarefas (seção 18): uma linha por destinatário/evento, gerada no mesmo
// momento em que o evento acontece (nunca por varredura), exceto prazo próximo/vencido, que é
// calculado ao vivo na consulta em vez de linhas persistidas (não há job periódico no projeto).
// Nunca cria notificação para quem não pode visualizar a tarefa — a query de criação sempre usa
// o `computeTaskPermissions` do próprio destinatário antes de inserir.
export const taskNotifications = pgTable("task_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  taskId: integer("task_id").notNull().references(() => tasks.id),
  type: text("type").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull().default(isoNow),
  readAt: text("read_at"),
}, (table) => [
  index("task_notifications_user_idx").on(table.userId, table.readAt),
  index("task_notifications_task_idx").on(table.taskId),
]);

// Módulo Produtos (peças, insumos, EPI e mantimentos). Lista usada pelo campo "Aplicação" no
// cadastro de produto (multi-select, via product_equipment_models) e também pela
// rotina best-effort de `equipment.equipmentModelId` acima.
export const equipmentModels = pgTable("equipment_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  manufacturer: text("manufacturer"),
  category: text("category"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("equipment_models_name_unique").on(table.name),
  index("equipment_models_active_idx").on(table.active),
]);

export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  cnpj: text("cnpj"),
  phone: text("phone"),
  email: text("email"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("suppliers_name_unique").on(table.name),
  index("suppliers_active_idx").on(table.active),
]);

// Lista única de marcas (cadastro de Produtos, cotação e recebimento das Compras usam a mesma).
// O nome é gravado em MAIÚSCULAS e `key` (sem acentos, espaços e pontuação) impede grafias duplicadas.
export const productBrands = pgTable("product_brands", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [uniqueIndex("product_brands_key_unique").on(table.key)]);

// Departamentos: lista ÚNICA do sistema (Movimentação e Solicitação de Pedidos usam a mesma).
// `key` (sem acentos, espaços e pontuação) impede o mesmo departamento com grafias diferentes.
export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [uniqueIndex("departments_key_unique").on(table.key)]);

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  tag: text("tag").notNull(),
  name: text("name").notNull(),
  reference: text("reference"),
  price: doublePrecision("price").notNull().default(0),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  brand: text("brand"),
  // Primeiro modelo da Aplicação (a lista completa fica em product_equipment_models). NULL = produto
  // de uso geral (parafuso, abraçadeira, EPI, mantimento).
  equipmentModelId: integer("equipment_model_id").references(() => equipmentModels.id),
  // Marca linhas que vieram incompletas da importação (sem preço, sem referência, aplicação
  // genérica ainda sem modelo definido, TAG provisória, etc.) para revisão manual posterior.
  needsReview: boolean("needs_review").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("products_tag_unique").on(table.tag),
  index("products_name_idx").on(table.name),
  index("products_equipment_model_idx").on(table.equipmentModelId),
  index("products_supplier_idx").on(table.supplierId),
  index("products_needs_review_idx").on(table.needsReview),
]);

// Estoque por frente SEM duplicar o cadastro: a ficha do produto (acima) é uma só; cada frente tem
// no máximo uma linha aqui com a sua quantidade. `active` = o produto "existe" naquela frente
// (aparece normal na listagem). Sem linha, ou com active=FALSE, o produto aparece apagado
// (opacidade reduzida) e pode ser "ativado" pela frente — ativar só cria/reativa esta linha,
// começando com quantidade zerada, nunca copia o produto.
export const productFrontStock = pgTable("product_front_stock", {
  productId: integer("product_id").notNull().references(() => products.id, { onDelete:"cascade" }),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  quantity: doublePrecision("quantity").notNull().default(0),
  active: boolean("active").notNull().default(true),
  activatedAt: text("activated_at"),
  activatedBy: integer("activated_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.productId, table.serviceFrontId] }),
  index("product_front_stock_front_idx").on(table.serviceFrontId, table.active),
]);

// Movimentações de estoque por frente — o rastro de TODA entrada/saída (Solicitação de Materiais,
// Solicitação de Pedidos/Compras, Movimentação, Ordem de Serviço e ajuste manual). O saldo continua
// em product_front_stock; só lib/stock.ts grava aqui e no saldo (nunca direto em outro lugar).
// delta > 0 = entrada, delta < 0 = saída. Estorno não apaga a linha: marca reversedAt e grava o
// movimento contrário no saldo.
export const productStockMovements = pgTable("product_stock_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete:"cascade" }),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  delta: doublePrecision("delta").notNull(),
  reason: text("reason").notNull(),
  // Origem do lançamento (o número exibido vem da tabela de origem: SOL-/PED-/SAI-/OS-).
  source: text("source", { enum:["MATERIAL_REQUEST","PURCHASE","STOCK_EXIT","WORK_ORDER","ADJUSTMENT"] }).notNull().default("MATERIAL_REQUEST"),
  // Data do lançamento (AAAA-MM-DD) quando difere do registro (ex.: peça de uma O.S. aberta há dias).
  movementDate: text("movement_date"),
  // Valor unitário no momento do movimento (R$), para o histórico e o custo da O.S.
  unitPrice: doublePrecision("unit_price"),
  // Destino da saída (Movimentação / O.S.): equipamento ou funcionário.
  equipmentId: integer("equipment_id").references((): AnyPgColumn => equipment.id),
  employeeId: integer("employee_id").references((): AnyPgColumn => employees.id),
  departmentId: integer("department_id").references((): AnyPgColumn => departments.id),
  materialRequestId: integer("material_request_id").references((): AnyPgColumn => materialRequests.id),
  materialRequestItemId: integer("material_request_item_id").references((): AnyPgColumn => materialRequestItems.id),
  purchaseOrderId: integer("purchase_order_id").references((): AnyPgColumn => purchaseOrders.id),
  purchaseOrderItemId: integer("purchase_order_item_id").references((): AnyPgColumn => purchaseOrderItems.id),
  stockExitId: integer("stock_exit_id").references((): AnyPgColumn => stockExits.id),
  stockExitItemId: integer("stock_exit_item_id").references((): AnyPgColumn => stockExitItems.id),
  workOrderId: integer("work_order_id").references((): AnyPgColumn => workOrders.id),
  workOrderItemId: integer("work_order_item_id").references((): AnyPgColumn => workOrderItems.id),
  reversedAt: text("reversed_at"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("product_stock_movements_product_idx").on(table.productId, table.serviceFrontId),
  index("product_stock_movements_request_idx").on(table.materialRequestId),
  index("product_stock_movements_source_idx").on(table.source, table.createdAt),
  index("product_stock_movements_equipment_idx").on(table.equipmentId),
  index("product_stock_movements_employee_idx").on(table.employeeId),
  index("product_stock_movements_work_order_idx").on(table.workOrderId),
  index("product_stock_movements_exit_idx").on(table.stockExitId),
  index("product_stock_movements_purchase_idx").on(table.purchaseOrderId),
]);

// Várias referências por produto. `normalized` (maiúsculas, sem espaço/traço/ponto/barra) é a chave
// da validação de duplicidade GLOBAL feita na aplicação (lib/product-rules.ts). O índice não é
// UNIQUE de propósito: a base histórica importada já traz referências repetidas entre produtos, e
// um índice único impediria a migração — a regra vale para todo cadastro/edição daqui em diante.
// `products.reference` continua existindo (exportações, importação CSV, telas antigas) e passa a
// guardar a lista unida por " / ".
export const productReferences = pgTable("product_references", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete:"cascade" }),
  reference: text("reference").notNull(),
  normalized: text("normalized").notNull(),
  position: integer("position").notNull().default(0),
  ...timestamps,
}, (table) => [
  uniqueIndex("product_references_product_normalized_unique").on(table.productId, table.normalized),
  index("product_references_normalized_idx").on(table.normalized),
]);

// Aplicação multi-select: um produto pode servir a vários modelos de equipamento.
// `products.equipmentModelId` continua preenchido com o primeiro modelo, só por compatibilidade.
export const productEquipmentModels = pgTable("product_equipment_models", {
  productId: integer("product_id").notNull().references(() => products.id, { onDelete:"cascade" }),
  equipmentModelId: integer("equipment_model_id").notNull().references(() => equipmentModels.id),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.productId, table.equipmentModelId] }),
  index("product_equipment_models_model_idx").on(table.equipmentModelId),
]);

// Fotos do produto (uma ou mais). Arquivo em uploads/product-photos, mesmo esquema da foto do
// equipamento (otimizada para WebP no navegador; o servidor só valida a assinatura binária).
export const productPhotos = pgTable("product_photos", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete:"cascade" }),
  storageKey: text("storage_key").notNull(),
  position: integer("position").notNull().default(0),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("product_photos_product_idx").on(table.productId, table.position)]);

// ---------------------------------------------------------------------------
// Lançamento de Combustível. Tipos em tabela (não enum) para permitir incluir ARLA 32 etc. depois
// só com um INSERT. O saldo nunca é gravado: é sempre a soma dos lançamentos da frente
// (lib/fuel.ts), então editar/excluir um lançamento corrige o saldo automaticamente.
// ---------------------------------------------------------------------------
export const fuelTypes = pgTable("fuel_types", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("L"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [uniqueIndex("fuel_types_code_unique").on(table.code)]);

// ---------------------------------------------------------------------------
// Terceiros: empresas prestadoras, terceirizadas e pessoas que não são da JC, com os veículos e
// máquinas delas. Usado na saída de combustível (Prestadores de Serviço / Saída para terceiros) e na
// saída de produtos (destino "Terceiro / Prestador"). Cadastro único para todas as frentes; nunca é
// apagado depois de ter movimentação — só inativado.
// ---------------------------------------------------------------------------
export const thirdParties = pgTable("third_parties", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum:["PRESTADOR","TERCEIRIZADA","PESSOA_FISICA"] }).notNull(),
  // CNPJ/CPF só com os dígitos (único quando preenchido).
  document: text("document"),
  contactName: text("contact_name"),
  phone: text("phone"),
  // Frente principal (opcional; o cadastro vale para todas as frentes).
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("third_parties_document_unique").on(table.document),
  index("third_parties_name_idx").on(table.name),
]);

export const thirdPartyVehicles = pgTable("third_party_vehicles", {
  id: serial("id").primaryKey(),
  thirdPartyId: integer("third_party_id").notNull().references(() => thirdParties.id),
  // Placa ou identificação como digitada; plateKey = só letras/números em maiúsculas (única por empresa).
  plate: text("plate").notNull(),
  plateKey: text("plate_key").notNull(),
  description: text("description"),
  vehicleType: text("vehicle_type", { enum:["CAMINHAO","MAQUINA","VEICULO_LEVE","OUTRO"] }).notNull().default("CAMINHAO"),
  meterType: text("meter_type", { enum:["KM","HORIMETRO"] }).notNull().default("KM"),
  fuelTypeId: integer("fuel_type_id").references(() => fuelTypes.id),
  tankCapacityLiters: doublePrecision("tank_capacity_liters"),
  // Consumo esperado: km/L (KM) ou L/h (HORIMETRO). Referência enquanto o veículo não tem média.
  expectedConsumption: doublePrecision("expected_consumption"),
  // Última leitura registrada (atualizada a cada abastecimento).
  lastReading: doublePrecision("last_reading"),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("third_party_vehicles_plate_unique").on(table.thirdPartyId, table.plateKey),
]);

export const fuelMovements = pgTable("fuel_movements", {
  id: serial("id").primaryKey(),
  // Frente dona do lançamento (a que tem o saldo alterado). Na TRANSFERÊNCIA é a frente de origem.
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  fuelTypeId: integer("fuel_type_id").notNull().references(() => fuelTypes.id),
  movementType: text("movement_type", { enum:["ENTRADA","SAIDA","TRANSFERENCIA"] }).notNull(),
  movementDate: text("movement_date").notNull(),
  quantity: doublePrecision("quantity").notNull(),
  // Texto livre da versão anterior do formulário (antes do "Origem" virar seleção). Só leitura.
  origin: text("origin"),
  // Estoque onde o lançamento acontece: cada frente tem dois saldos independentes, o da Frente e o
  // do Porto. Na TRANSFERÊNCIA é o estoque de origem.
  stockLocation: text("stock_location", { enum:["FRENTE","PORTO"] }).notNull().default("FRENTE"),
  // Saída para terceiros (fora da frota): sem equipamento, com descrição livre de quem recebeu.
  thirdParty: boolean("third_party").notNull().default(false),
  thirdPartyDescription: text("third_party_description"),
  // Subtipo da saída para terceiros: GERAL (texto livre em thirdPartyDescription) ou PRESTADOR
  // (prestador de serviço: empresa + descrição do equipamento dele).
  thirdPartyKind: text("third_party_kind", { enum:["GERAL","PRESTADOR"] }),
  providerCompany: text("provider_company"),
  providerEquipment: text("provider_equipment"),
  // Valor por litro informado na ENTRADA (R$). As saídas não gravam custo: ele é calculado ao vivo
  // pelo custo médio ponderado do estoque (lib/fuel-rules.ts:computeFuelCosts), então editar ou
  // excluir uma entrada recalcula o custo de todas as saídas seguintes.
  unitPrice: doublePrecision("unit_price"),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  meterReading: doublePrecision("meter_reading"),
  meterUnit: text("meter_unit", { enum:["HOURS","KM"] }),
  // Destino da TRANSFERÊNCIA (frente + estoque). Frente↔Porto da mesma frente usa a própria frente
  // como destino; transferência para outra filial usa a frente destino.
  destinationFrontId: integer("destination_front_id").references(() => serviceFronts.id),
  destinationLocation: text("destination_location", { enum:["FRENTE","PORTO"] }),
  responsible: text("responsible"),
  // Funcionário escolhido na lista (módulo Funcionários). `responsible` guarda o nome exibido e
  // continua sendo usado quando o nome foi digitado manualmente (exceção).
  responsibleEmployeeId: integer("responsible_employee_id").references((): AnyPgColumn => employees.id),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  deletedAt: text("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id),
  // Carga retroativa de histórico (importar-abastecimento.mjs). importSource identifica o lote
  // (filtrar/auditar/reverter); importHash impede importar a mesma linha duas vezes.
  // Lançamentos importados não passam pelas validações obrigatórias dos lançamentos novos.
  importSource: text("import_source"),
  importHash: text("import_hash"),
  // FALSE = origem (Frente/Porto) assumida na importação, ainda não conferida por alguém.
  originConfirmed: boolean("origin_confirmed").notNull().default(true),
  // TRUE = abastecimento real sem o veículo identificado (corrigir no Histórico). importedVehicle
  // guarda o texto original da planilha.
  vehiclePending: boolean("vehicle_pending").notNull().default(false),
  importedVehicle: text("imported_vehicle"),
  // Ajuste de saldo (ajustar-saldo-combustivel.mjs): conta no saldo, mas não é movimentação — fica
  // fora do Histórico, da exportação e dos totais de entradas/saídas.
  balanceAdjustment: boolean("balance_adjustment").notNull().default(false),
  // Terceiro do cadastro (saída para Prestadores de Serviço / terceiros). Os textos livres acima
  // (provider_company, provider_equipment, third_party_description) continuam sendo preenchidos,
  // a partir do cadastro, para o histórico antigo e as exportações.
  thirdPartyId: integer("third_party_id").references(() => thirdParties.id),
  thirdPartyVehicleId: integer("third_party_vehicle_id").references(() => thirdPartyVehicles.id),
  // Abastecimento com tanque cheio: só entre tanques cheios o consumo é calculado (parciais acumulam).
  fullTank: boolean("full_tank").notNull().default(true),
  // Consumo do abastecimento desviou mais de 25% da média do veículo (confirmado no lançamento).
  consumptionOutlier: boolean("consumption_outlier").notNull().default(false),
  // Leitura menor/igual à última aceita por ADMIN/GESTOR com justificativa: vira nova base do consumo.
  readingException: boolean("reading_exception").notNull().default(false),
  ...timestamps,
}, (table) => [
  index("fuel_movements_front_date_idx").on(table.serviceFrontId, table.movementDate),
  uniqueIndex("fuel_movements_import_hash_unique").on(table.importHash),
  index("fuel_movements_import_source_idx").on(table.importSource),
  index("fuel_movements_destination_idx").on(table.destinationFrontId),
  index("fuel_movements_equipment_idx").on(table.equipmentId, table.movementDate),
  index("fuel_movements_third_party_vehicle_idx").on(table.thirdPartyVehicleId, table.movementDate),
  index("fuel_movements_third_party_idx").on(table.thirdPartyId), index("fuel_movements_fuel_type_idx").on(table.fuelTypeId), index("fuel_movements_responsible_employee_idx").on(table.responsibleEmployeeId),
]);

// ---------------------------------------------------------------------------
// Conciliação do tanque. fuel_tanks: um tanque por frente + local (Frente/Porto) + combustível,
// com a tabela de arqueação (centímetros da régua → litros, JSON [[cm, litros], ...]) e a
// tolerância aceita entre o medido e o saldo do sistema. fuel_tank_measurements: cada medição
// física guarda o saldo calculado NAQUELE momento (retrato), para o histórico não mudar quando
// lançamentos antigos forem corrigidos. adjustment_movement_id = ajuste de saldo gerado a partir
// da medição (lançamento balance_adjustment), quando o gestor decide igualar o sistema ao medido.
// ---------------------------------------------------------------------------
export const fuelTanks = pgTable("fuel_tanks", {
  id: serial("id").primaryKey(),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  stockLocation: text("stock_location", { enum:["FRENTE","PORTO"] }).notNull().default("FRENTE"),
  fuelTypeId: integer("fuel_type_id").notNull().references(() => fuelTypes.id),
  name: text("name").notNull(),
  capacityLiters: doublePrecision("capacity_liters"),
  calibration: text("calibration"),
  tolerancePercent: doublePrecision("tolerance_percent").notNull().default(1),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [uniqueIndex("fuel_tanks_stock_unique").on(table.serviceFrontId, table.stockLocation, table.fuelTypeId)]);

export const fuelTankMeasurements = pgTable("fuel_tank_measurements", {
  id: serial("id").primaryKey(),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  stockLocation: text("stock_location", { enum:["FRENTE","PORTO"] }).notNull().default("FRENTE"),
  fuelTypeId: integer("fuel_type_id").notNull().references(() => fuelTypes.id),
  tankId: integer("tank_id").references(() => fuelTanks.id),
  measuredAt: text("measured_at").notNull(),
  method: text("method", { enum:["LITROS","REGUA"] }).notNull().default("LITROS"),
  rulerCm: doublePrecision("ruler_cm"),
  measuredLiters: doublePrecision("measured_liters").notNull(),
  calculatedLiters: doublePrecision("calculated_liters").notNull(),
  differenceLiters: doublePrecision("difference_liters").notNull(),
  tolerancePercent: doublePrecision("tolerance_percent").notNull().default(1),
  adjustmentMovementId: integer("adjustment_movement_id").references(() => fuelMovements.id),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  deletedAt: text("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("fuel_tank_measurements_stock_idx").on(table.serviceFrontId, table.fuelTypeId, table.measuredAt)]);

// ---------------------------------------------------------------------------
// Controle Diário do equipamento. user_id vem sempre da sessão = a conta que EFETIVAMENTE fez o
// lançamento (auditoria). No login de campo (CAMPO) essa conta é o próprio operador; nos demais
// logins (ADMIN/GESTOR/USUÁRIO) o operador é digitado em operator_name e manual_entry = TRUE.
// ---------------------------------------------------------------------------
export const dailyRecords = pgTable("daily_records", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  userId: integer("user_id").notNull().references(() => users.id),
  recordDate: text("record_date").notNull(),
  workedToday: boolean("worked_today").notNull(),
  noWorkReason: text("no_work_reason"),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  location: text("location"),
  // Unidade da leitura no momento do registro ("HOURS" = horímetro, "KM" = odômetro).
  readingUnit: text("reading_unit", { enum:["HOURS","KM"] }).notNull(),
  startReading: doublePrecision("start_reading"),
  endReading: doublePrecision("end_reading"),
  inactiveOrProblem: boolean("inactive_or_problem").notNull().default(false),
  problemReason: text("problem_reason"),
  problemPhotoKey: text("problem_photo_key"),
  hadProduction: boolean("had_production").notNull().default(false),
  productionType: text("production_type", { enum:["BALDEIO","PORTO"] }),
  // Foto única do registro: ficha do baldeio (BALDEIO) ou foto da produção (PORTO).
  productionPhotoKey: text("production_photo_key"),
  notes: text("notes"),
  // Frente oficial do equipamento no momento do lançamento. `serviceFrontId` (acima) é a frente
  // informada pelo operador — difere desta quando ele pediu mudança de frente.
  officialServiceFrontId: integer("official_service_front_id").references(() => serviceFronts.id),
  frontChangeRequestId: integer("front_change_request_id"),
  // Lançamento manual ("Lançado por terceiro"): nome digitado da pessoa a quem o registro se refere.
  operatorName: text("operator_name"),
  manualEntry: boolean("manual_entry").notNull().default(false),
  ...timestamps,
}, (table) => [
  // Um operador não registra o mesmo equipamento duas vezes no mesmo dia (evita envio duplicado).
  // No lançamento manual a mesma conta pode lançar para operadores diferentes: o nome digitado
  // (sem diferenciar maiúsculas) entra na chave.
  uniqueIndex("daily_records_user_equipment_date_operator_unique").on(table.userId, table.equipmentId, table.recordDate, sql`coalesce(lower(${table.operatorName}), '')`),
  index("daily_records_date_idx").on(table.recordDate),
  index("daily_records_equipment_date_idx").on(table.equipmentId, table.recordDate),
  index("daily_records_front_date_idx").on(table.serviceFrontId, table.recordDate),
]);

export const dailyRecordFuelings = pgTable("daily_record_fuelings", {
  id: serial("id").primaryKey(),
  dailyRecordId: integer("daily_record_id").notNull().references(() => dailyRecords.id, { onDelete:"cascade" }),
  fuelingNumber: integer("fueling_number").notNull(),
  liters: doublePrecision("liters").notNull(),
  // Leitura (KM ou horímetro, na unidade do registro) no momento deste abastecimento. NULL só nos
  // abastecimentos lançados antes da troca do campo "Local/Posto" por esta leitura.
  meterReading: doublePrecision("meter_reading"),
  // Campo antigo "Local / posto": só leitura, preservado nos registros anteriores.
  location: text("location"),
  ...timestamps,
}, (table) => [uniqueIndex("daily_record_fuelings_number_unique").on(table.dailyRecordId, table.fuelingNumber)]);

export const dailyRecordTrips = pgTable("daily_record_trips", {
  id: serial("id").primaryKey(),
  dailyRecordId: integer("daily_record_id").notNull().references(() => dailyRecords.id, { onDelete:"cascade" }),
  tripNumber: integer("trip_number").notNull(),
  logsQuantity: integer("logs_quantity").notNull(),
  // Só no PORTO; NULL no BALDEIO.
  meters: doublePrecision("meters"),
  ...timestamps,
}, (table) => [uniqueIndex("daily_record_trips_number_unique").on(table.dailyRecordId, table.tripNumber)]);

// "Memória" do último equipamento usado por cada operador: pré-seleciona o equipamento
// ao abrir o Controle Diário. Uma linha por usuário, atualizada quando ele troca de máquina.
// ---------------------------------------------------------------------------
// Checklist pré-uso: antes de ligar o equipamento o operador marca cada item como OK / Não OK.
// Modelo por tipo de equipamento (equipment.type); equipment_type NULL = modelo padrão para os
// tipos sem modelo próprio. Item "Não OK" exige comentário (e foto, se o item pedir). Item que
// bloqueia (blocking) marcado Não OK deixa o checklist BLOQUEADO: a máquina não deve trabalhar.
// Com open_work_order, qualquer Não OK abre uma O.S. (ou se liga à O.S. aberta do equipamento).
// As respostas guardam o texto e o "bloqueia" do item no momento (o modelo pode mudar depois).
// ---------------------------------------------------------------------------
export const checklistTemplates = pgTable("checklist_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  equipmentType: text("equipment_type"),
  openWorkOrder: boolean("open_work_order").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [uniqueIndex("checklist_templates_type_unique").on(sql`coalesce(${table.equipmentType}, '')`)]);

export const checklistTemplateItems = pgTable("checklist_template_items", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull().references(() => checklistTemplates.id),
  label: text("label").notNull(),
  blocking: boolean("blocking").notNull().default(false),
  photoRequired: boolean("photo_required").notNull().default(true),
  position: integer("position").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [index("checklist_template_items_template_idx").on(table.templateId, table.position)]);

export const checklistSubmissions = pgTable("checklist_submissions", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  userId: integer("user_id").notNull().references(() => users.id),
  operatorName: text("operator_name"),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  templateId: integer("template_id").references(() => checklistTemplates.id),
  checklistDate: text("checklist_date").notNull(),
  meterReading: doublePrecision("meter_reading"),
  status: text("status", { enum:["OK","PENDENCIA","BLOQUEADO"] }).notNull(),
  failedItems: integer("failed_items").notNull().default(0),
  workOrderId: integer("work_order_id").references(() => workOrders.id),
  notes: text("notes"),
  clientRequestId: text("client_request_id"),
  ...timestamps,
}, (table) => [
  index("checklist_submissions_equipment_date_idx").on(table.equipmentId, table.checklistDate),
  index("checklist_submissions_date_idx").on(table.checklistDate, table.status),
  uniqueIndex("checklist_submissions_client_request_unique").on(table.clientRequestId),
]);

export const checklistAnswers = pgTable("checklist_answers", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => checklistSubmissions.id),
  itemId: integer("item_id").references(() => checklistTemplateItems.id),
  label: text("label").notNull(),
  blocking: boolean("blocking").notNull().default(false),
  ok: boolean("ok").notNull(),
  comment: text("comment"),
  photoKey: text("photo_key"),
}, (table) => [index("checklist_answers_submission_idx").on(table.submissionId)]);

export const equipmentCurrentAssignments = pgTable("equipment_current_assignments", {
  userId: integer("user_id").primaryKey().references(() => users.id),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  ...timestamps,
}, (table) => [index("equipment_current_assignments_equipment_idx").on(table.equipmentId)]);

// Tentativas de login do funcionário de campo (nome + código): base do bloqueio contra
// adivinhação do código (ver lib/field-auth.ts).
export const fieldLoginAttempts = pgTable("field_login_attempts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  ip: text("ip").notNull(),
  success: boolean("success").notNull(),
  attemptedAt: text("attempted_at").notNull().default(isoNow),
}, (table) => [
  index("field_login_attempts_user_idx").on(table.userId, table.attemptedAt),
  index("field_login_attempts_ip_idx").on(table.ip, table.attemptedAt),
]);

// Pedido de mudança de frente feito pelo operador no Controle Diário. NÃO altera o cadastro do
// equipamento: só quem aprova (ADMIN/GESTOR com "daily.front_requests") aplica a transferência,
// pelo mesmo fluxo de lib/equipment-transfer.ts (fica no histórico de transferências).
export const serviceFrontChangeRequests = pgTable("service_front_change_requests", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  currentServiceFrontId: integer("current_service_front_id").references(() => serviceFronts.id),
  requestedServiceFrontId: integer("requested_service_front_id").notNull().references(() => serviceFronts.id),
  reason: text("reason"),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestedAt: text("requested_at").notNull(),
  status: text("status", { enum:["PENDING","APPROVED","REJECTED"] }).notNull().default("PENDING"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  reviewNote: text("review_note"),
  ...timestamps,
}, (table) => [
  index("front_change_requests_status_idx").on(table.status, table.requestedAt),
  index("front_change_requests_equipment_idx").on(table.equipmentId, table.status),
]);

// ---------------------------------------------------------------------------
// Funcionários: cadastro único de pessoas (próprios e terceirizados/prestadores fixos), usado como
// fonte dos nomes de responsável/operador no resto do sistema. Mesma lógica de frente dos
// equipamentos: a frente atual só muda pela transferência rastreável (employee_transfers).
// ---------------------------------------------------------------------------
export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  jobTitle: text("job_title").notNull(),
  company: text("company").notNull(),
  admissionDate: text("admission_date").notNull(),
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  // Situação: ATIVO / FOLGA (controlada pelo ciclo de folga, employee_leave_cycles) / AFASTADO /
  // DEMITIDO (só pelo botão Demitir, que grava employee_dismissals). Atestados e afastamentos
  // continuam em employee_absences.
  status: text("status", { enum:["ATIVO","FOLGA","AFASTADO","DEMITIDO"] }).notNull().default("ATIVO"),
  // Matrícula numérica e CPF: únicos quando informados (os importados da relação vieram sem).
  registration: text("registration"),
  cpf: text("cpf"),
  birthDate: text("birth_date"),
  city: text("city"),
  // Salário de carteira (R$). Visível só com a permissão employees.salary.
  salary: doublePrecision("salary"),
  // Ciclo de folga do funcionário: dias trabalhados para ter direito a folga / dias de folga.
  cycleWorkDays: integer("cycle_work_days").notNull().default(90),
  cycleOffDays: integer("cycle_off_days").notNull().default(10),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("employees_front_idx").on(table.serviceFrontId, table.status),
  index("employees_name_idx").on(table.name),
  uniqueIndex("employees_registration_unique").on(table.registration),
  uniqueIndex("employees_cpf_unique").on(table.cpf),
]);

// Empresas dos funcionários (lista do dropdown do cadastro, editável pelo ADMIN).
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (table) => [uniqueIndex("companies_name_unique").on(table.name)]);

// Ciclo de folga: cada linha é um ciclo do funcionário, com as 5 datas lançadas à mão. Toda a conta
// de dias (trabalhados, viagem, folga, atraso) é feita em lib/leave-cycle.ts — nunca aqui nem na tela.
// O ciclo "aberto" é o que ainda não tem frontArrival; ao registrar a chegada na frente, o próximo
// ciclo nasce com workStart = essa data.
export const employeeLeaveCycles = pgTable("employee_leave_cycles", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete:"cascade" }),
  cycleNumber: integer("cycle_number").notNull(),
  serviceFrontId: integer("service_front_id").references(() => serviceFronts.id),
  workStart: text("work_start"),
  frontDeparture: text("front_departure"),
  homeArrival: text("home_arrival"),
  homeDeparture: text("home_departure"),
  frontArrival: text("front_arrival"),
  // Ciclo encerrado sem chegada na frente (demissão): a conta de dias para nesta data.
  endedAt: text("ended_at"),
  // Metas do ciclo no momento em que ele começou (mudar o ciclo do funcionário não reescreve o passado).
  workDaysTarget: integer("work_days_target").notNull(),
  offDaysTarget: integer("off_days_target").notNull(),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  uniqueIndex("employee_leave_cycles_number_unique").on(table.employeeId, table.cycleNumber),
  index("employee_leave_cycles_employee_idx").on(table.employeeId, table.frontArrival),
]);

// Demissões (e readmissões): histórico preservado no perfil. rehireAllowed=false coloca a pessoa na
// lista de "Funcionários Restritos", consultada no cadastro de novos funcionários.
export const employeeDismissals = pgTable("employee_dismissals", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete:"cascade" }),
  dismissedAt: text("dismissed_at").notNull(),
  reason: text("reason").notNull(),
  rehireAllowed: boolean("rehire_allowed").notNull(),
  previousAdmissionDate: text("previous_admission_date"),
  rehiredAt: text("rehired_at"),
  rehiredBy: integer("rehired_by").references(() => users.id),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("employee_dismissals_employee_idx").on(table.employeeId, table.dismissedAt)]);

export const employeeTransfers = pgTable("employee_transfers", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete:"cascade" }),
  previousServiceFrontId: integer("previous_service_front_id").references(() => serviceFronts.id),
  newServiceFrontId: integer("new_service_front_id").notNull().references(() => serviceFronts.id),
  transferDate: text("transfer_date").notNull(),
  transferredBy: integer("transferred_by").references(() => users.id),
  note: text("note"),
  ...timestamps,
}, (table) => [index("employee_transfers_employee_idx").on(table.employeeId, table.transferDate)]);

export const employeeAbsences = pgTable("employee_absences", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete:"cascade" }),
  kind: text("kind", { enum:["FOLGA","FERIAS","ATESTADO","AFASTAMENTO","OUTRO"] }).notNull(),
  startDate: text("start_date").notNull(),
  // NULL = em aberto (sem data de retorno prevista).
  endDate: text("end_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("employee_absences_employee_idx").on(table.employeeId, table.startDate)]);

// ---------------------------------------------------------------------------
// Solicitação de Pedidos (Compras externas). Número exibido PED-000123 (lib/purchases.ts). Cada
// etapa é feita por uma função diferente: solicitante → aprovador → comprador → pagamento →
// despacho → solicitante confirma o recebimento (que gera a entrada no estoque dos itens
// vinculados a produto, via lib/stock.ts).
// ---------------------------------------------------------------------------
export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  requesterId: integer("requester_id").notNull().references(() => users.id),
  // Frente que pede (a do login; escolha obrigatória para quem tem mais de uma) — é onde o estoque entra.
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  requestedAt: text("requested_at").notNull(),
  // Situação GERAL, calculada a partir dos itens (lib/purchases.ts:orderStatusFromItems) e gravada
  // para listar/filtrar; EM_ANDAMENTO = itens em etapas diferentes.
  status: text("status", { enum:["AGUARDANDO_APROVACAO","RECUSADO","EM_COTACAO","ANALISE_PAGAMENTO","PAGO","ENVIADO","RECEBIDO","CANCELADO","EM_ANDAMENTO"] }).notNull().default("AGUARDANDO_APROVACAO"),
  notes: text("notes"),
  // Cabeçalho do pedido (igual à referência "Nova Solicitação de Compra").
  company: text("company"),
  branch: text("branch"),
  title: text("title"),
  // Nome do departamento no momento do pedido (a escolha vem da lista única `departments`).
  department: text("department"),
  departmentId: integer("department_id").references((): AnyPgColumn => departments.id),
  orderDate: text("order_date"),
  // Nome de quem pede (pode ser diferente de quem lançou, requester_id = "criado por").
  requesterName: text("requester_name"),
  urgency: text("urgency", { enum:["BAIXA","NORMAL","ALTA","URGENTE"] }).notNull().default("NORMAL"),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  rejectedBy: integer("rejected_by").references(() => users.id),
  rejectedAt: text("rejected_at"),
  rejectReason: text("reject_reason"),
  paymentRequestedBy: integer("payment_requested_by").references(() => users.id),
  paymentRequestedAt: text("payment_requested_at"),
  buyerNotes: text("buyer_notes"),
  paidBy: integer("paid_by").references(() => users.id),
  paidAt: text("paid_at"),
  paymentNotes: text("payment_notes"),
  dispatchedBy: integer("dispatched_by").references(() => users.id),
  dispatchedAt: text("dispatched_at"),
  dispatchNotes: text("dispatch_notes"),
  receivedBy: integer("received_by").references(() => users.id),
  receivedAt: text("received_at"),
  cancelledBy: integer("cancelled_by").references(() => users.id),
  cancelledAt: text("cancelled_at"),
  cancelReason: text("cancel_reason"),
  ...timestamps,
}, (table) => [
  index("purchase_orders_status_idx").on(table.status, table.requestedAt),
  index("purchase_orders_requester_idx").on(table.requesterId, table.requestedAt),
  index("purchase_orders_front_idx").on(table.serviceFrontId),
]);

export const purchaseOrderItems = pgTable("purchase_order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => purchaseOrders.id, { onDelete:"cascade" }),
  // Vinculado a produto do estoque (recebimento gera entrada) ou NULL = item digitado à mão.
  productId: integer("product_id").references(() => products.id, { onDelete:"set null" }),
  description: text("description").notNull(),
  reference: text("reference"),
  quantity: doublePrecision("quantity").notNull(),
  fiscalUnit: text("fiscal_unit").notNull(),
  // Observações do item (itens digitados à mão).
  notes: text("notes"),
  // Situação do ITEM no fluxo (cada item anda sozinho; o pedido mostra a combinação).
  status: text("status", { enum:["AGUARDANDO_APROVACAO","RECUSADO","EM_COTACAO","ANALISE_PAGAMENTO","PAGO","ENVIADO","RECEBIDO","REMOVIDO","CANCELADO"] }).notNull().default("AGUARDANDO_APROVACAO"),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  rejectedBy: integer("rejected_by").references(() => users.id),
  rejectedAt: text("rejected_at"),
  rejectReason: text("reject_reason"),
  paymentRequestedBy: integer("payment_requested_by").references(() => users.id),
  paymentRequestedAt: text("payment_requested_at"),
  paidBy: integer("paid_by").references(() => users.id),
  paidAt: text("paid_at"),
  dispatchedBy: integer("dispatched_by").references(() => users.id),
  dispatchedAt: text("dispatched_at"),
  // Ajuste do comprador na cotação: a quantidade pedida originalmente fica guardada ao lado da
  // alterada (ou do item removido), com quem alterou e quando.
  originalQuantity: doublePrecision("original_quantity"),
  quantityChangedBy: integer("quantity_changed_by").references(() => users.id),
  quantityChangedAt: text("quantity_changed_at"),
  removedBy: integer("removed_by").references(() => users.id),
  removedAt: text("removed_at"),
  removedReason: text("removed_reason"),
  // Preenchidos pelo comprador na cotação.
  unitPrice: doublePrecision("unit_price"),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  brand: text("brand"),
  // Conferência do recebimento (card "Mudou o fornecedor/marca/valor? Veio a quantidade pedida?").
  receivedAt: text("received_at"),
  receivedBy: integer("received_by").references(() => users.id),
  receivedQuantity: doublePrecision("received_quantity"),
  receivedUnitPrice: doublePrecision("received_unit_price"),
  receivedSupplierId: integer("received_supplier_id").references(() => suppliers.id),
  receivedBrand: text("received_brand"),
  receiptNotes: text("receipt_notes"),
  ...timestamps,
}, (table) => [index("purchase_order_items_order_idx").on(table.orderId), index("purchase_order_items_product_idx").on(table.productId)]);

// Anexos do pedido, em uploads/purchase-quotes: PHOTO = foto de um item (peça quebrada,
// problema...); QUOTE_IMAGE = orçamento por imagem; QUOTE_DOCUMENT = orçamento em documento
// (PDF, Word, Excel...); PAYMENT_PROOF = comprovante de pagamento (imagem ou documento).
export const purchaseOrderAttachments = pgTable("purchase_order_attachments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => purchaseOrders.id, { onDelete:"cascade" }),
  kind: text("kind", { enum:["PHOTO","QUOTE_IMAGE","QUOTE_DOCUMENT","PAYMENT_PROOF"] }).notNull().default("QUOTE_DOCUMENT"),
  // Foto vinculada a um item do pedido (PHOTO); nulo nos orçamentos e comprovantes (do pedido todo).
  itemId: integer("item_id").references((): AnyPgColumn => purchaseOrderItems.id, { onDelete:"set null" }),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("purchase_order_attachments_order_idx").on(table.orderId)]);

// Histórico de cada item do pedido (mudança de situação, ajuste de quantidade, remoção, recebimento).
export const purchaseOrderItemEvents = pgTable("purchase_order_item_events", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => purchaseOrders.id, { onDelete:"cascade" }),
  itemId: integer("item_id").notNull().references(() => purchaseOrderItems.id, { onDelete:"cascade" }),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  details: text("details"),
  userId: integer("user_id").references(() => users.id),
  ...timestamps,
}, (table) => [index("purchase_order_item_events_item_idx").on(table.itemId, table.createdAt)]);

// ---------------------------------------------------------------------------
// Movimentação: saída de produtos do estoque para um funcionário ou um equipamento. Número
// exibido SAI-000123. Cada item vira um movimento em product_stock_movements (lib/stock.ts).
// ---------------------------------------------------------------------------
export const stockExits = pgTable("stock_exits", {
  id: serial("id").primaryKey(),
  // Frente cujo estoque sai.
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  exitDate: text("exit_date").notNull(),
  // Destino principal (para exibição): veículo > funcionário > departamento. A saída pode ter os três.
  // THIRD_PARTY = Terceiro / Prestador (cadastro de terceiros), com quem recebeu (received_by).
  destinationType: text("destination_type", { enum:["EMPLOYEE","EQUIPMENT","DEPARTMENT","THIRD_PARTY"] }).notNull(),
  employeeId: integer("employee_id").references(() => employees.id),
  equipmentId: integer("equipment_id").references(() => equipment.id),
  departmentId: integer("department_id").references(() => departments.id),
  thirdPartyId: integer("third_party_id").references(() => thirdParties.id),
  thirdPartyVehicleId: integer("third_party_vehicle_id").references(() => thirdPartyVehicles.id),
  receivedBy: text("received_by"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id),
  cancelledAt: text("cancelled_at"),
  cancelledBy: integer("cancelled_by").references(() => users.id),
  cancelReason: text("cancel_reason"),
  ...timestamps,
}, (table) => [
  index("stock_exits_date_idx").on(table.exitDate),
  index("stock_exits_equipment_idx").on(table.equipmentId),
  index("stock_exits_employee_idx").on(table.employeeId),
  index("stock_exits_third_party_idx").on(table.thirdPartyId, table.thirdPartyVehicleId),
]);

export const stockExitItems = pgTable("stock_exit_items", {
  id: serial("id").primaryKey(),
  exitId: integer("exit_id").notNull().references(() => stockExits.id, { onDelete:"cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  quantity: doublePrecision("quantity").notNull(),
  unitPrice: doublePrecision("unit_price"),
  ...timestamps,
}, (table) => [index("stock_exit_items_exit_idx").on(table.exitId)]);

// ---------------------------------------------------------------------------
// Ordem de Serviço (número exibido OS-000123). Peças lançadas saem do estoque na hora (lib/stock.ts),
// cada uma com a própria data de lançamento e quem retirou. Trocas de óleo feitas pelo QR Code se
// vinculam pela coluna maintenances.work_order_id.
// ---------------------------------------------------------------------------
export const workOrders = pgTable("work_orders", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipment.id),
  // Frente do equipamento na abertura: é de onde saem as peças.
  serviceFrontId: integer("service_front_id").notNull().references(() => serviceFronts.id),
  openedAt: text("opened_at").notNull(),
  meterReading: doublePrecision("meter_reading"),
  meterUnit: text("meter_unit", { enum:["HOURS","KM"] }).notNull(),
  // O que está sendo feito / diagnóstico do serviço.
  description: text("description").notNull(),
  status: text("status", { enum:["OPEN","CLOSED"] }).notNull().default("OPEN"),
  closedAt: text("closed_at"),
  closedBy: integer("closed_by").references(() => users.id),
  closingNotes: text("closing_notes"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
}, (table) => [
  index("work_orders_equipment_idx").on(table.equipmentId, table.openedAt),
  index("work_orders_status_idx").on(table.status, table.openedAt),
]);

// Mecânicos responsáveis (multi-seleção): nomes da mesma lista do Status da Frota (fleet_mechanics).
export const workOrderMechanics = pgTable("work_order_mechanics", {
  workOrderId: integer("work_order_id").notNull().references(() => workOrders.id, { onDelete:"cascade" }),
  mechanicName: text("mechanic_name").notNull(),
  ...timestamps,
}, (table) => [primaryKey({ columns: [table.workOrderId, table.mechanicName] })]);

export const workOrderItems = pgTable("work_order_items", {
  id: serial("id").primaryKey(),
  workOrderId: integer("work_order_id").notNull().references(() => workOrders.id, { onDelete:"cascade" }),
  productId: integer("product_id").notNull().references(() => products.id),
  quantity: doublePrecision("quantity").notNull(),
  // Data em que ESTA peça foi lançada (a O.S. pode ficar aberta vários dias).
  launchDate: text("launch_date").notNull(),
  // Quem retirou esta peça para aplicação (peça por peça).
  withdrawnBy: text("withdrawn_by").notNull(),
  withdrawnByEmployeeId: integer("withdrawn_by_employee_id").references(() => employees.id),
  // Onde a peça foi aplicada (motor, freio...). Opcional.
  application: text("application"),
  unitPrice: doublePrecision("unit_price"),
  createdBy: integer("created_by").references(() => users.id),
  // Peça retirada da O.S. (lançada por engano): o estoque volta e a linha fica como histórico.
  removedAt: text("removed_at"),
  removedBy: integer("removed_by").references(() => users.id),
  ...timestamps,
}, (table) => [index("work_order_items_order_idx").on(table.workOrderId)]);
