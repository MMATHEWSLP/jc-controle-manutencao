CREATE TABLE "convoy_fuel_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_uuid" text NOT NULL,
	"status" text DEFAULT 'PENDENTE' NOT NULL,
	"registered_by" integer NOT NULL,
	"convoy_equipment_id" integer,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer,
	"fuel_type_id" integer,
	"operator_employee_id" integer,
	"operator_name" text NOT NULL,
	"liters" double precision NOT NULL,
	"reading" double precision,
	"reading_unit" text NOT NULL,
	"device_last_reading" double precision,
	"recorded_at" text NOT NULL,
	"record_date" text NOT NULL,
	"date_justification" text,
	"no_photo" boolean DEFAULT false NOT NULL,
	"no_photo_reason" text,
	"no_photo_note" text,
	"meter_photo_key" text,
	"pump_photo_key" text,
	"photo_taken_at" text,
	"latitude" double precision,
	"longitude" double precision,
	"gps_accuracy" double precision,
	"notes" text,
	"device_warnings" text,
	"received_at" text NOT NULL,
	"ai_reading" double precision,
	"ai_status" text,
	"ai_checked_at" text,
	"corrections" text,
	"correction_note" text,
	"correction_requested_by" integer,
	"correction_requested_at" text,
	"rejection_reason" text,
	"rejected_by" integer,
	"rejected_at" text,
	"approved_by" integer,
	"approved_at" text,
	"fuel_movement_id" integer,
	"reading_update_note" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "convoy_fuel_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pump_photo_required" boolean DEFAULT false NOT NULL,
	"ai_photo_check" boolean DEFAULT false NOT NULL,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "convoy_record_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "convoy_fuel_register" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "convoy_equipment_id" integer;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_convoy_equipment_id_equipment_id_fk" FOREIGN KEY ("convoy_equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_operator_employee_id_employees_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_correction_requested_by_users_id_fk" FOREIGN KEY ("correction_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_fuel_movement_id_fuel_movements_id_fk" FOREIGN KEY ("fuel_movement_id") REFERENCES "public"."fuel_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_settings" ADD CONSTRAINT "convoy_fuel_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "convoy_fuel_records_client_uuid_unique" ON "convoy_fuel_records" USING btree ("client_uuid");--> statement-breakpoint
CREATE INDEX "convoy_fuel_records_status_idx" ON "convoy_fuel_records" USING btree ("status","service_front_id");--> statement-breakpoint
CREATE INDEX "convoy_fuel_records_registered_idx" ON "convoy_fuel_records" USING btree ("registered_by","record_date");--> statement-breakpoint
CREATE INDEX "convoy_fuel_records_equipment_idx" ON "convoy_fuel_records" USING btree ("equipment_id","recorded_at");--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_convoy_record_id_convoy_fuel_records_id_fk" FOREIGN KEY ("convoy_record_id") REFERENCES "public"."convoy_fuel_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_convoy_equipment_id_equipment_id_fk" FOREIGN KEY ("convoy_equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;