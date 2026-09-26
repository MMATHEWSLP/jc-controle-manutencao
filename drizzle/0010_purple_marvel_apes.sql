CREATE TABLE "daily_record_fuelings" (
	"id" serial PRIMARY KEY NOT NULL,
	"daily_record_id" integer NOT NULL,
	"fueling_number" integer NOT NULL,
	"liters" double precision NOT NULL,
	"location" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_record_trips" (
	"id" serial PRIMARY KEY NOT NULL,
	"daily_record_id" integer NOT NULL,
	"trip_number" integer NOT NULL,
	"logs_quantity" integer NOT NULL,
	"meters" double precision,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"record_date" text NOT NULL,
	"worked_today" boolean NOT NULL,
	"no_work_reason" text,
	"service_front_id" integer,
	"location" text,
	"reading_unit" text NOT NULL,
	"start_reading" double precision,
	"end_reading" double precision,
	"inactive_or_problem" boolean DEFAULT false NOT NULL,
	"problem_reason" text,
	"problem_photo_key" text,
	"had_production" boolean DEFAULT false NOT NULL,
	"production_type" text,
	"production_photo_key" text,
	"notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_current_assignments" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_record_fuelings" ADD CONSTRAINT "daily_record_fuelings_daily_record_id_daily_records_id_fk" FOREIGN KEY ("daily_record_id") REFERENCES "public"."daily_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_record_trips" ADD CONSTRAINT "daily_record_trips_daily_record_id_daily_records_id_fk" FOREIGN KEY ("daily_record_id") REFERENCES "public"."daily_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_current_assignments" ADD CONSTRAINT "equipment_current_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_current_assignments" ADD CONSTRAINT "equipment_current_assignments_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_record_fuelings_number_unique" ON "daily_record_fuelings" USING btree ("daily_record_id","fueling_number");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_record_trips_number_unique" ON "daily_record_trips" USING btree ("daily_record_id","trip_number");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_records_user_equipment_date_unique" ON "daily_records" USING btree ("user_id","equipment_id","record_date");--> statement-breakpoint
CREATE INDEX "daily_records_equipment_date_idx" ON "daily_records" USING btree ("equipment_id","record_date");--> statement-breakpoint
CREATE INDEX "daily_records_front_date_idx" ON "daily_records" USING btree ("service_front_id","record_date");--> statement-breakpoint
CREATE INDEX "equipment_current_assignments_equipment_idx" ON "equipment_current_assignments" USING btree ("equipment_id");