CREATE TABLE "production_felling" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"felling_date" text NOT NULL,
	"operator_employee_id" integer NOT NULL,
	"helper_employee_id" integer,
	"trees" integer NOT NULL,
	"ipes" integer DEFAULT 0 NOT NULL,
	"gasoline_liters" double precision DEFAULT 0 NOT NULL,
	"reason_id" integer,
	"justification" text,
	"created_by" integer,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "production_felling_counts_check" CHECK ("production_felling"."trees" >= 0 AND "production_felling"."ipes" >= 0 AND "production_felling"."ipes" <= "production_felling"."trees" AND "production_felling"."gasoline_liters" >= 0)
);
--> statement-breakpoint
CREATE TABLE "production_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"created_by" integer,
	"reverted_at" text,
	"reverted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "production_project_id" integer;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "production_sector" text;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "production_kind" text;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "employee_id" integer;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "production_tool" text;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "quantity" double precision;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "unit_value" double precision;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD COLUMN "production_import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "production_project_id" integer;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "production_sector" text;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "production_kind" text;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "production_tool" text;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "production_import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_project_id_production_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."production_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_operator_employee_id_employees_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_helper_employee_id_employees_id_fk" FOREIGN KEY ("helper_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_reason_id_production_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."production_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_felling" ADD CONSTRAINT "production_felling_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_import_batches" ADD CONSTRAINT "production_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_import_batches" ADD CONSTRAINT "production_import_batches_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_felling_day_operator_unique" ON "production_felling" USING btree ("project_id","felling_date","operator_employee_id");--> statement-breakpoint
CREATE INDEX "production_felling_date_idx" ON "production_felling" USING btree ("felling_date");--> statement-breakpoint
CREATE INDEX "production_felling_operator_idx" ON "production_felling" USING btree ("operator_employee_id","felling_date");--> statement-breakpoint
CREATE INDEX "production_import_batches_created_idx" ON "production_import_batches" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_production_project_id_production_projects_id_fk" FOREIGN KEY ("production_project_id") REFERENCES "public"."production_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_production_import_batch_id_production_import_batches_id_fk" FOREIGN KEY ("production_import_batch_id") REFERENCES "public"."production_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_production_project_id_production_projects_id_fk" FOREIGN KEY ("production_project_id") REFERENCES "public"."production_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_production_import_batch_id_production_import_batches_id_fk" FOREIGN KEY ("production_import_batch_id") REFERENCES "public"."production_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "other_expenses_production_idx" ON "other_expenses" USING btree ("production_project_id","production_sector");--> statement-breakpoint
CREATE INDEX "stock_exits_production_idx" ON "stock_exits" USING btree ("production_project_id","production_sector");