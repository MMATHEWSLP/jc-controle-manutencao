CREATE TABLE "employee_absences" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"kind" text NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"previous_service_front_id" integer,
	"new_service_front_id" integer NOT NULL,
	"transfer_date" text NOT NULL,
	"transferred_by" integer,
	"note" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"job_title" text NOT NULL,
	"company" text NOT NULL,
	"admission_date" text NOT NULL,
	"service_front_id" integer NOT NULL,
	"status" text DEFAULT 'ATIVO' NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "third_party_kind" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "provider_company" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "provider_equipment" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "unit_price" double precision;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "responsible_employee_id" integer;--> statement-breakpoint
ALTER TABLE "employee_absences" ADD CONSTRAINT "employee_absences_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_absences" ADD CONSTRAINT "employee_absences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_transfers" ADD CONSTRAINT "employee_transfers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_transfers" ADD CONSTRAINT "employee_transfers_previous_service_front_id_service_fronts_id_fk" FOREIGN KEY ("previous_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_transfers" ADD CONSTRAINT "employee_transfers_new_service_front_id_service_fronts_id_fk" FOREIGN KEY ("new_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_transfers" ADD CONSTRAINT "employee_transfers_transferred_by_users_id_fk" FOREIGN KEY ("transferred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_absences_employee_idx" ON "employee_absences" USING btree ("employee_id","start_date");--> statement-breakpoint
CREATE INDEX "employee_transfers_employee_idx" ON "employee_transfers" USING btree ("employee_id","transfer_date");--> statement-breakpoint
CREATE INDEX "employees_front_idx" ON "employees" USING btree ("service_front_id","status");--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("name");--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_responsible_employee_id_employees_id_fk" FOREIGN KEY ("responsible_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Saídas para terceiros já lançadas são do tipo geral (texto livre).
UPDATE "fuel_movements" SET "third_party_kind" = 'GERAL' WHERE "third_party" = true AND "third_party_kind" IS NULL;
