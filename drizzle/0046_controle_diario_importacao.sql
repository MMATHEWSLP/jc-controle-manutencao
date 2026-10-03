CREATE TABLE "daily_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"file_name" text NOT NULL,
	"imported_by" integer NOT NULL,
	"registered_by" integer NOT NULL,
	"status" text DEFAULT 'EM_ANDAMENTO' NOT NULL,
	"total_rows" integer NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"review_rows" integer DEFAULT 0 NOT NULL,
	"plan" text,
	"summary" text,
	"finished_at" text,
	"undone_at" text,
	"undone_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_problem_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"daily_record_id" integer,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer,
	"record_date" text NOT NULL,
	"operator_name" text,
	"description" text NOT NULL,
	"status" text DEFAULT 'ABERTO' NOT NULL,
	"resolved_at" text,
	"resolved_by" integer,
	"resolution_note" text,
	"import_batch_id" integer,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
DROP INDEX "daily_records_user_equipment_date_operator_unique";--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "field_operator_id" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "no_operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "location_original" text;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "port_trips" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "port_volume_m3" double precision;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "port_logs" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "baldeio_trips" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "total_trips" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "reported_diesel_liters" double precision;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "diesel_fuel_movement_id" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "diesel_note" text;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "review_status" text DEFAULT 'OK' NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "review_reason" text;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "origin" text DEFAULT 'APP' NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD COLUMN "daily_record_id" integer;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD COLUMN "daily_import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "daily_import_batches" ADD CONSTRAINT "daily_import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_import_batches" ADD CONSTRAINT "daily_import_batches_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_import_batches" ADD CONSTRAINT "daily_import_batches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_daily_record_id_daily_records_id_fk" FOREIGN KEY ("daily_record_id") REFERENCES "public"."daily_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_import_batch_id_daily_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."daily_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_problem_reports" ADD CONSTRAINT "daily_problem_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_problem_reports_status_idx" ON "daily_problem_reports" USING btree ("status","record_date");--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_field_operator_id_users_id_fk" FOREIGN KEY ("field_operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_diesel_fuel_movement_id_fuel_movements_id_fk" FOREIGN KEY ("diesel_fuel_movement_id") REFERENCES "public"."fuel_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_import_batch_id_daily_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."daily_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_daily_record_id_daily_records_id_fk" FOREIGN KEY ("daily_record_id") REFERENCES "public"."daily_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_daily_import_batch_id_daily_import_batches_id_fk" FOREIGN KEY ("daily_import_batch_id") REFERENCES "public"."daily_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_records_import_batch_idx" ON "daily_records" USING btree ("import_batch_id");--> statement-breakpoint
CREATE INDEX "meter_daily_batch_idx" ON "meter_readings" USING btree ("daily_import_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_records_user_equipment_date_operator_unique" ON "daily_records" USING btree ("user_id","equipment_id","record_date",coalesce(lower("operator_name"), '')) WHERE "daily_records"."import_batch_id" IS NULL;