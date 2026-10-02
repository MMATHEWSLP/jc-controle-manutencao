CREATE TABLE "job_functions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"operates_equipment" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "third_party_employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"third_party_id" integer NOT NULL,
	"name" text NOT NULL,
	"job_title" text,
	"cpf" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "third_party_destination" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "third_party_employee_id" integer;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "purpose_note" text;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "third_party_employee_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_code_changed_at" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "employee_id" integer;--> statement-breakpoint
ALTER TABLE "third_party_employees" ADD CONSTRAINT "third_party_employees_third_party_id_third_parties_id_fk" FOREIGN KEY ("third_party_id") REFERENCES "public"."third_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_employees" ADD CONSTRAINT "third_party_employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_functions_name_unique" ON "job_functions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "third_party_employees_party_idx" ON "third_party_employees" USING btree ("third_party_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "third_party_employees_party_name_unique" ON "third_party_employees" USING btree ("third_party_id","name");--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_third_party_employee_id_third_party_employees_id_fk" FOREIGN KEY ("third_party_employee_id") REFERENCES "public"."third_party_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_third_party_employee_id_third_party_employees_id_fk" FOREIGN KEY ("third_party_employee_id") REFERENCES "public"."third_party_employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_employee_unique" ON "users" USING btree ("employee_id");