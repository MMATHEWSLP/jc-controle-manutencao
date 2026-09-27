CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"dismissed_at" text NOT NULL,
	"reason" text NOT NULL,
	"rehire_allowed" boolean NOT NULL,
	"previous_admission_date" text,
	"rehired_at" text,
	"rehired_by" integer,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_leave_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"cycle_number" integer NOT NULL,
	"service_front_id" integer,
	"work_start" text,
	"front_departure" text,
	"home_arrival" text,
	"home_departure" text,
	"front_arrival" text,
	"ended_at" text,
	"work_days_target" integer NOT NULL,
	"off_days_target" integer NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"delta" double precision NOT NULL,
	"reason" text NOT NULL,
	"material_request_id" integer,
	"material_request_item_id" integer,
	"reversed_at" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "registration" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "cpf" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "birth_date" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "salary" double precision;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "cycle_work_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "cycle_off_days" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "material_request_items" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "material_requests" ADD COLUMN "origin_service_front_id" integer;--> statement-breakpoint
ALTER TABLE "employee_dismissals" ADD CONSTRAINT "employee_dismissals_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_dismissals" ADD CONSTRAINT "employee_dismissals_rehired_by_users_id_fk" FOREIGN KEY ("rehired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_dismissals" ADD CONSTRAINT "employee_dismissals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_leave_cycles" ADD CONSTRAINT "employee_leave_cycles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_leave_cycles" ADD CONSTRAINT "employee_leave_cycles_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_leave_cycles" ADD CONSTRAINT "employee_leave_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_material_request_id_material_requests_id_fk" FOREIGN KEY ("material_request_id") REFERENCES "public"."material_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_material_request_item_id_material_request_items_id_fk" FOREIGN KEY ("material_request_item_id") REFERENCES "public"."material_request_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_name_unique" ON "companies" USING btree ("name");--> statement-breakpoint
CREATE INDEX "employee_dismissals_employee_idx" ON "employee_dismissals" USING btree ("employee_id","dismissed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_leave_cycles_number_unique" ON "employee_leave_cycles" USING btree ("employee_id","cycle_number");--> statement-breakpoint
CREATE INDEX "employee_leave_cycles_employee_idx" ON "employee_leave_cycles" USING btree ("employee_id","front_arrival");--> statement-breakpoint
CREATE INDEX "product_stock_movements_product_idx" ON "product_stock_movements" USING btree ("product_id","service_front_id");--> statement-breakpoint
CREATE INDEX "product_stock_movements_request_idx" ON "product_stock_movements" USING btree ("material_request_id");--> statement-breakpoint
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_origin_service_front_id_service_fronts_id_fk" FOREIGN KEY ("origin_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_registration_unique" ON "employees" USING btree ("registration");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_cpf_unique" ON "employees" USING btree ("cpf");--> statement-breakpoint
-- Empresas do dropdown: as da relação de colaboradores + qualquer outra já usada em cadastros.
INSERT INTO "companies" ("name") VALUES ('RCA'),('JC'),('RENASCER'),('JFC') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "companies" ("name") SELECT DISTINCT upper(trim("company")) FROM "employees" WHERE trim("company") <> '' ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "employees" SET "company" = upper(trim("company"));--> statement-breakpoint
-- Situação "Desligado" passa a se chamar "Demitido".
UPDATE "employees" SET "status" = 'DEMITIDO' WHERE "status" = 'DESLIGADO';--> statement-breakpoint
-- A importação guardou a cidade nas observações ("Cidade: X · ..."): move para o campo próprio.
UPDATE "employees" SET "city" = trim(replace(substring("notes" from 'Cidade: ([^·]+)'), '(nome da cidade cortado na relação)', ''))
WHERE "city" IS NULL AND "notes" LIKE 'Cidade: %';--> statement-breakpoint
-- Folga em aberto (registrada como ausência) vira o ciclo de folga do funcionário, já na etapa
-- "De folga" (chegada em casa = início registrado). A ausência correspondente é removida.
INSERT INTO "employee_leave_cycles" ("employee_id","cycle_number","service_front_id","home_arrival","work_days_target","off_days_target","notes")
SELECT DISTINCT ON (a."employee_id") a."employee_id", 1, e."service_front_id", a."start_date", e."cycle_work_days", e."cycle_off_days",
  'Convertido da folga registrada como ausência a partir de ' || to_char(a."start_date"::date, 'DD/MM/YYYY') || ' (datas anteriores do ciclo não informadas).'
FROM "employee_absences" a JOIN "employees" e ON e."id" = a."employee_id"
WHERE a."kind" = 'FOLGA' AND a."end_date" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "employee_leave_cycles" c WHERE c."employee_id" = a."employee_id")
ORDER BY a."employee_id", a."start_date" DESC;--> statement-breakpoint
UPDATE "employees" SET "status" = 'FOLGA' WHERE "status" = 'ATIVO'
  AND EXISTS (SELECT 1 FROM "employee_leave_cycles" c WHERE c."employee_id" = "employees"."id" AND c."front_arrival" IS NULL AND c."home_arrival" IS NOT NULL);--> statement-breakpoint
DELETE FROM "employee_absences" a WHERE a."kind" = 'FOLGA' AND a."end_date" IS NULL
  AND EXISTS (SELECT 1 FROM "employee_leave_cycles" c WHERE c."employee_id" = a."employee_id" AND c."home_arrival" = a."start_date");
