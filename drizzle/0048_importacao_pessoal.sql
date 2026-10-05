CREATE TABLE "job_function_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"job_function_id" integer NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personnel_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"export_date" text,
	"status" text DEFAULT 'EM_ANDAMENTO' NOT NULL,
	"summary" text,
	"imported_by" integer NOT NULL,
	"finished_at" text,
	"undone_at" text,
	"undone_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personnel_import_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"table_name" text NOT NULL,
	"row_id" integer NOT NULL,
	"action" text NOT NULL,
	"previous" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
DROP INDEX "employees_registration_unique";--> statement-breakpoint
ALTER TABLE "employee_absences" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "employee_dismissals" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "employee_leave_cycles" ADD COLUMN "leave_kind" text DEFAULT 'USUFRUIDA' NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_leave_cycles" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "employee_transfers" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "at_headquarters" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "external_source" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "job_function_aliases" ADD CONSTRAINT "job_function_aliases_job_function_id_job_functions_id_fk" FOREIGN KEY ("job_function_id") REFERENCES "public"."job_functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_import_batches" ADD CONSTRAINT "personnel_import_batches_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_import_batches" ADD CONSTRAINT "personnel_import_batches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_import_changes" ADD CONSTRAINT "personnel_import_changes_batch_id_personnel_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."personnel_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_function_aliases_alias_unique" ON "job_function_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "personnel_import_changes_batch_idx" ON "personnel_import_changes" USING btree ("batch_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_absences_external_unique" ON "employee_absences" USING btree ("employee_id","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_dismissals_external_unique" ON "employee_dismissals" USING btree ("employee_id","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_leave_cycles_external_unique" ON "employee_leave_cycles" USING btree ("employee_id","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_transfers_external_unique" ON "employee_transfers" USING btree ("employee_id","external_key");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_registration_unique" ON "employees" USING btree ("company","registration");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_external_unique" ON "employees" USING btree ("external_source","external_id");