CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"level" text NOT NULL,
	"control_type" text DEFAULT 'HOURS' NOT NULL,
	"current_value" double precision DEFAULT 0 NOT NULL,
	"planned_value" double precision DEFAULT 0 NOT NULL,
	"remaining_value" double precision DEFAULT 0 NOT NULL,
	"overdue_value" double precision DEFAULT 0 NOT NULL,
	"maintenance_status" text DEFAULT 'OK' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"message" text NOT NULL,
	"generated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"viewed_at" text,
	"closed_at" text,
	"closed_by_maintenance_id" integer,
	"fingerprint" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer,
	"maintenance_id" integer,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"previous_value" text,
	"new_value" text,
	"occurred_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_bootstrap" (
	"key" text PRIMARY KEY NOT NULL,
	"completed_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"prefix" text NOT NULL,
	"type" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"year" integer,
	"serial_number" text,
	"chassis" text,
	"identification_type" text DEFAULT 'SERIAL_NUMBER' NOT NULL,
	"plate" text,
	"service_front_id" integer,
	"location" text,
	"current_hours" double precision DEFAULT 0 NOT NULL,
	"current_km" double precision DEFAULT 0 NOT NULL,
	"control_type" text DEFAULT 'HOURS' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"photo_key" text,
	"qr_token" text,
	"oil_change_enabled" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_maintenance_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"maintenance_type_id" integer NOT NULL,
	"applicable" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"previous_service_front_id" integer,
	"new_service_front_id" integer NOT NULL,
	"transferred_at" text NOT NULL,
	"transferred_by" integer NOT NULL,
	"note" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_current_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"status" text DEFAULT 'OPERATING' NOT NULL,
	"since_at" text NOT NULL,
	"active_occurrence_id" text,
	"latest_event_id" text,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_event_mechanics" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"mechanic_name" text NOT NULL,
	"role" text DEFAULT 'MECHANIC' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_mechanics" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer,
	"started_at" text NOT NULL,
	"ended_at" text,
	"returned_to_operation_at" text,
	"reason" text,
	"problem_description" text,
	"location" text,
	"service_performed" text,
	"parts_used" text,
	"notes" text,
	"created_by" integer,
	"closed_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"occurrence_id" text NOT NULL,
	"equipment_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"requested_at" text NOT NULL,
	"description" text NOT NULL,
	"quantity" double precision,
	"unit" text,
	"requester" text,
	"supplier" text,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"attention_hours" double precision DEFAULT 4 NOT NULL,
	"high_hours" double precision DEFAULT 12 NOT NULL,
	"critical_hours" double precision DEFAULT 24 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_status_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurrence_id" text,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer,
	"previous_status" text NOT NULL,
	"new_status" text NOT NULL,
	"occurred_at" text NOT NULL,
	"reason" text,
	"problem_description" text,
	"service_description" text,
	"service_performed" text,
	"location" text,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_maintenance_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer,
	"maintenance_type_id" integer,
	"prefix" text NOT NULL,
	"service" text NOT NULL,
	"reading_raw" text DEFAULT '' NOT NULL,
	"reading_value" double precision,
	"control_type" text NOT NULL,
	"performed_at" text,
	"source" text DEFAULT 'PLANILHA_IMPORTADA' NOT NULL,
	"import_type" text,
	"import_key" text,
	"notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_import_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"equipment_prefix" text NOT NULL,
	"category" text NOT NULL,
	"reading_value" double precision NOT NULL,
	"unit" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"detail" text,
	"imported_history_id" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"source" text NOT NULL,
	"observation" text NOT NULL,
	"status" text NOT NULL,
	"total_analyzed" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"already_existing" integer DEFAULT 0 NOT NULL,
	"newer_existing" integer DEFAULT 0 NOT NULL,
	"zero_values" integer DEFAULT 0 NOT NULL,
	"equipment_not_found" integer DEFAULT 0 NOT NULL,
	"categories_not_found" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_interval_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"maintenance_type_id" integer NOT NULL,
	"interval_value" double precision NOT NULL,
	"unit" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"maintenance_id" integer NOT NULL,
	"description" text NOT NULL,
	"item_type" text NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"unit" text DEFAULT 'UN' NOT NULL,
	"brand" text,
	"reference" text,
	"unit_cost" double precision DEFAULT 0,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"maintenance_type_id" integer NOT NULL,
	"interval_hours" double precision,
	"interval_km" double precision,
	"interval_days" integer,
	"trigger_mode" text DEFAULT 'HOURS' NOT NULL,
	"last_hours" double precision,
	"last_km" double precision,
	"last_date" text,
	"next_hours" double precision,
	"next_km" double precision,
	"next_date" text,
	"expected_quantity" double precision,
	"oil_type" text,
	"viscosity" text,
	"brand" text,
	"filter_reference" text,
	"warning_hours" double precision DEFAULT 100,
	"critical_hours" double precision DEFAULT 50,
	"warning_km" double precision,
	"critical_km" double precision,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_recalculation_state" (
	"key" text PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"recalculated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenances" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer,
	"plan_id" integer,
	"maintenance_type_id" integer NOT NULL,
	"performed_at" text NOT NULL,
	"hours" double precision,
	"km" double precision,
	"mechanic" text,
	"work_order" text NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"reading_date" text NOT NULL,
	"hours" double precision,
	"km" double precision,
	"operator" text,
	"service_front_id" integer,
	"notes" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"authorized_regression" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reading_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"imported_by" integer NOT NULL,
	"total_rows" integer NOT NULL,
	"ready_rows" integer NOT NULL,
	"updated_rows" integer NOT NULL,
	"skipped_rows" integer NOT NULL,
	"error_rows" integer NOT NULL,
	"errors_json" text DEFAULT '[]' NOT NULL,
	"imported_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_fronts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"alerta_horas_verde" double precision DEFAULT 100 NOT NULL,
	"alerta_horas_amarelo_inicio" double precision DEFAULT 51 NOT NULL,
	"alerta_horas_amarelo_fim" double precision DEFAULT 100 NOT NULL,
	"alerta_horas_laranja_inicio" double precision DEFAULT 1 NOT NULL,
	"alerta_horas_laranja_fim" double precision DEFAULT 50 NOT NULL,
	"alerta_km_verde" double precision DEFAULT 2000 NOT NULL,
	"alerta_km_amarelo_inicio" double precision DEFAULT 1001 NOT NULL,
	"alerta_km_amarelo_fim" double precision DEFAULT 2000 NOT NULL,
	"alerta_km_laranja_inicio" double precision DEFAULT 1 NOT NULL,
	"alerta_km_laranja_fim" double precision DEFAULT 1000 NOT NULL,
	"urgency_percent" double precision DEFAULT 20 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"permission" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"last_seen_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"password_hash" text,
	"password_salt" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"theme" text DEFAULT 'LIGHT' NOT NULL,
	"is_primary_admin" boolean DEFAULT false NOT NULL,
	"last_access_at" text,
	"password_updated_at" text,
	"service_front_id" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" integer,
	"plan_id" integer,
	"equipment_id" integer,
	"recipient_id" integer,
	"equipment_prefix" text NOT NULL,
	"category" text NOT NULL,
	"maintenance_name" text NOT NULL,
	"alert_status" text NOT NULL,
	"current_value" double precision,
	"last_value" double precision,
	"next_value" double precision,
	"remaining_value" double precision,
	"unit" text,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"message" text NOT NULL,
	"result" text DEFAULT 'PENDING' NOT NULL,
	"provider_message_id" text,
	"error_reason" text,
	"trigger_type" text NOT NULL,
	"dedupe_key" text,
	"sent_at" text,
	"delivered_at" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"categories" text DEFAULT '["ALL"]' NOT NULL,
	"alert_types" text DEFAULT '["WARNING","NEAR","OVERDUE"]' NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"connection_name" text,
	"sender_phone" text,
	"phone_number_id" text,
	"waba_id" text,
	"access_token_encrypted" text,
	"api_version" text DEFAULT 'v23.0' NOT NULL,
	"connection_status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"last_connection_error" text,
	"last_tested_at" text,
	"automatic_enabled" boolean DEFAULT false NOT NULL,
	"send_mode" text DEFAULT 'MANUAL' NOT NULL,
	"overdue_repeat_days" integer DEFAULT 0 NOT NULL,
	"template_name" text,
	"template_language" text DEFAULT 'pt_BR' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_plan_id_maintenance_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."maintenance_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_closed_by_maintenance_id_maintenances_id_fk" FOREIGN KEY ("closed_by_maintenance_id") REFERENCES "public"."maintenances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_maintenance_id_maintenances_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_maintenance_types" ADD CONSTRAINT "equipment_maintenance_types_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_maintenance_types" ADD CONSTRAINT "equipment_maintenance_types_maintenance_type_id_maintenance_types_id_fk" FOREIGN KEY ("maintenance_type_id") REFERENCES "public"."maintenance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_transfers" ADD CONSTRAINT "equipment_transfers_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_transfers" ADD CONSTRAINT "equipment_transfers_previous_service_front_id_service_fronts_id_fk" FOREIGN KEY ("previous_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_transfers" ADD CONSTRAINT "equipment_transfers_new_service_front_id_service_fronts_id_fk" FOREIGN KEY ("new_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_transfers" ADD CONSTRAINT "equipment_transfers_transferred_by_users_id_fk" FOREIGN KEY ("transferred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_current_status" ADD CONSTRAINT "fleet_current_status_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_current_status" ADD CONSTRAINT "fleet_current_status_active_occurrence_id_fleet_occurrences_id_fk" FOREIGN KEY ("active_occurrence_id") REFERENCES "public"."fleet_occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_current_status" ADD CONSTRAINT "fleet_current_status_latest_event_id_fleet_status_events_id_fk" FOREIGN KEY ("latest_event_id") REFERENCES "public"."fleet_status_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_current_status" ADD CONSTRAINT "fleet_current_status_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_event_mechanics" ADD CONSTRAINT "fleet_event_mechanics_event_id_fleet_status_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."fleet_status_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_occurrences" ADD CONSTRAINT "fleet_occurrences_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_occurrences" ADD CONSTRAINT "fleet_occurrences_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_occurrences" ADD CONSTRAINT "fleet_occurrences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_occurrences" ADD CONSTRAINT "fleet_occurrences_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_orders" ADD CONSTRAINT "fleet_orders_occurrence_id_fleet_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."fleet_occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_orders" ADD CONSTRAINT "fleet_orders_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_orders" ADD CONSTRAINT "fleet_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD CONSTRAINT "fleet_status_events_occurrence_id_fleet_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."fleet_occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD CONSTRAINT "fleet_status_events_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD CONSTRAINT "fleet_status_events_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_status_events" ADD CONSTRAINT "fleet_status_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_maintenance_history" ADD CONSTRAINT "imported_maintenance_history_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_maintenance_history" ADD CONSTRAINT "imported_maintenance_history_maintenance_type_id_maintenance_types_id_fk" FOREIGN KEY ("maintenance_type_id") REFERENCES "public"."maintenance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_import_results" ADD CONSTRAINT "maintenance_import_results_run_id_maintenance_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maintenance_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_import_results" ADD CONSTRAINT "maintenance_import_results_imported_history_id_imported_maintenance_history_id_fk" FOREIGN KEY ("imported_history_id") REFERENCES "public"."imported_maintenance_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_interval_configs" ADD CONSTRAINT "maintenance_interval_configs_maintenance_type_id_maintenance_types_id_fk" FOREIGN KEY ("maintenance_type_id") REFERENCES "public"."maintenance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_items" ADD CONSTRAINT "maintenance_items_maintenance_id_maintenances_id_fk" FOREIGN KEY ("maintenance_id") REFERENCES "public"."maintenances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_maintenance_type_id_maintenance_types_id_fk" FOREIGN KEY ("maintenance_type_id") REFERENCES "public"."maintenance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_plan_id_maintenance_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."maintenance_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_maintenance_type_id_maintenance_types_id_fk" FOREIGN KEY ("maintenance_type_id") REFERENCES "public"."maintenance_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_imports" ADD CONSTRAINT "reading_imports_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_plan_id_maintenance_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."maintenance_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_recipient_id_whatsapp_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."whatsapp_recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_deliveries" ADD CONSTRAINT "whatsapp_deliveries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_recipients" ADD CONSTRAINT "whatsapp_recipients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_fingerprint_unique" ON "alerts" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "alerts_status_level_idx" ON "alerts" USING btree ("status","level");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_code_unique" ON "equipment" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_prefix_unique" ON "equipment" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_serial_unique" ON "equipment" USING btree ("serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_qr_token_unique" ON "equipment" USING btree ("qr_token");--> statement-breakpoint
CREATE INDEX "equipment_front_idx" ON "equipment" USING btree ("service_front_id");--> statement-breakpoint
CREATE INDEX "equipment_oil_front_idx" ON "equipment" USING btree ("oil_change_enabled","service_front_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_maintenance_type_unique" ON "equipment_maintenance_types" USING btree ("equipment_id","maintenance_type_id");--> statement-breakpoint
CREATE INDEX "equipment_maintenance_applicable_idx" ON "equipment_maintenance_types" USING btree ("equipment_id","applicable");--> statement-breakpoint
CREATE INDEX "equipment_transfer_equipment_date_idx" ON "equipment_transfers" USING btree ("equipment_id","transferred_at");--> statement-breakpoint
CREATE INDEX "equipment_transfer_front_date_idx" ON "equipment_transfers" USING btree ("new_service_front_id","transferred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_current_equipment_unique" ON "fleet_current_status" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "fleet_current_status_idx" ON "fleet_current_status" USING btree ("status","since_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_event_mechanic_unique" ON "fleet_event_mechanics" USING btree ("event_id","mechanic_name");--> statement-breakpoint
CREATE INDEX "fleet_event_mechanic_name_idx" ON "fleet_event_mechanics" USING btree ("mechanic_name");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_mechanics_name_unique" ON "fleet_mechanics" USING btree ("name");--> statement-breakpoint
CREATE INDEX "fleet_occurrence_equipment_started_idx" ON "fleet_occurrences" USING btree ("equipment_id","started_at");--> statement-breakpoint
CREATE INDEX "fleet_occurrence_period_idx" ON "fleet_occurrences" USING btree ("started_at","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_order_occurrence_number_unique" ON "fleet_orders" USING btree ("occurrence_id","order_number");--> statement-breakpoint
CREATE INDEX "fleet_order_equipment_status_idx" ON "fleet_orders" USING btree ("equipment_id","status");--> statement-breakpoint
CREATE INDEX "fleet_event_equipment_date_idx" ON "fleet_status_events" USING btree ("equipment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "fleet_event_occurrence_date_idx" ON "fleet_status_events" USING btree ("occurrence_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_history_fingerprint_unique" ON "imported_maintenance_history" USING btree ("prefix","service","reading_raw","performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "imported_history_import_key_unique" ON "imported_maintenance_history" USING btree ("import_key");--> statement-breakpoint
CREATE INDEX "imported_history_equipment_type_idx" ON "imported_maintenance_history" USING btree ("equipment_id","maintenance_type_id");--> statement-breakpoint
CREATE INDEX "imported_history_date_idx" ON "imported_maintenance_history" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX "imported_history_prefix_idx" ON "imported_maintenance_history" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_import_result_row_unique" ON "maintenance_import_results" USING btree ("run_id","row_number");--> statement-breakpoint
CREATE INDEX "maintenance_import_result_status_idx" ON "maintenance_import_results" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_interval_category_type_unique" ON "maintenance_interval_configs" USING btree ("category","maintenance_type_id");--> statement-breakpoint
CREATE INDEX "maintenance_interval_category_active_idx" ON "maintenance_interval_configs" USING btree ("category","active");--> statement-breakpoint
CREATE INDEX "maintenance_items_parent_idx" ON "maintenance_items" USING btree ("maintenance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_equipment_type_unique" ON "maintenance_plans" USING btree ("equipment_id","maintenance_type_id");--> statement-breakpoint
CREATE INDEX "plan_next_hours_idx" ON "maintenance_plans" USING btree ("next_hours");--> statement-breakpoint
CREATE INDEX "plan_next_km_idx" ON "maintenance_plans" USING btree ("next_km");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_types_name_unique" ON "maintenance_types" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenances_work_order_type_unique" ON "maintenances" USING btree ("work_order","maintenance_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenances_equipment_plan_performed_unique" ON "maintenances" USING btree ("equipment_id","plan_id","performed_at");--> statement-breakpoint
CREATE INDEX "maintenance_equipment_date_idx" ON "maintenances" USING btree ("equipment_id","performed_at");--> statement-breakpoint
CREATE INDEX "meter_equipment_date_idx" ON "meter_readings" USING btree ("equipment_id","reading_date");--> statement-breakpoint
CREATE INDEX "reading_imports_user_date_idx" ON "reading_imports" USING btree ("imported_by","imported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_fronts_name_unique" ON "service_fronts" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permission_unique" ON "user_permissions" USING btree ("user_id","permission");--> statement-breakpoint
CREATE INDEX "user_permission_user_idx" ON "user_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_session_token_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_session_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_session_expiry_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "users_status_role_idx" ON "users" USING btree ("status","role");--> statement-breakpoint
CREATE INDEX "users_service_front_idx" ON "users" USING btree ("service_front_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_deliveries_dedupe_unique" ON "whatsapp_deliveries" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "whatsapp_deliveries_plan_recipient_idx" ON "whatsapp_deliveries" USING btree ("plan_id","recipient_id");--> statement-breakpoint
CREATE INDEX "whatsapp_deliveries_result_date_idx" ON "whatsapp_deliveries" USING btree ("result","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_recipients_phone_unique" ON "whatsapp_recipients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "whatsapp_recipients_active_idx" ON "whatsapp_recipients" USING btree ("active");