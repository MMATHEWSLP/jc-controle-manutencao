CREATE TABLE "component_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"component_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"event_date" text NOT NULL,
	"equipment_id" integer,
	"position" text,
	"from_position" text,
	"reading" double precision,
	"unit" text,
	"cost" double precision,
	"tread_depth" double precision,
	"notes" text,
	"user_id" integer,
	"deleted_at" text,
	"deleted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "components" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"brand" text NOT NULL,
	"model" text,
	"size" text,
	"purchase_date" text,
	"purchase_cost" double precision,
	"supplier" text,
	"expected_life" double precision,
	"warranty_months" integer,
	"status" text DEFAULT 'STOCK' NOT NULL,
	"equipment_id" integer,
	"position" text,
	"mounted_at" text,
	"mounted_reading" double precision,
	"mounted_unit" text,
	"usage_km" double precision DEFAULT 0 NOT NULL,
	"usage_hours" double precision DEFAULT 0 NOT NULL,
	"recap_count" integer DEFAULT 0 NOT NULL,
	"events_cost" double precision DEFAULT 0 NOT NULL,
	"last_tread_depth" double precision,
	"notes" text,
	"created_by" integer,
	"deleted_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "component_events" ADD CONSTRAINT "component_events_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_events" ADD CONSTRAINT "component_events_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_events" ADD CONSTRAINT "component_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_events" ADD CONSTRAINT "component_events_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "component_events_component_idx" ON "component_events" USING btree ("component_id","event_date");--> statement-breakpoint
CREATE INDEX "component_events_equipment_idx" ON "component_events" USING btree ("equipment_id","event_date");--> statement-breakpoint
CREATE INDEX "components_equipment_idx" ON "components" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "components_kind_status_idx" ON "components" USING btree ("kind","status");--> statement-breakpoint
-- Número de fogo / série único por tipo (sem diferenciar maiúsculas), ignorando excluídos.
CREATE UNIQUE INDEX "components_kind_code_unique" ON "components" ("kind", upper("code")) WHERE "deleted_at" IS NULL;--> statement-breakpoint
-- Uma posição de um equipamento só pode ter um item montado por vez.
CREATE UNIQUE INDEX "components_mounted_position_unique" ON "components" ("equipment_id", "kind", upper("position")) WHERE "status" = 'MOUNTED' AND "deleted_at" IS NULL;
