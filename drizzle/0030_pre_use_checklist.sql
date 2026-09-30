CREATE TABLE "checklist_answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"item_id" integer,
	"label" text NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"ok" boolean NOT NULL,
	"comment" text,
	"photo_key" text
);
--> statement-breakpoint
CREATE TABLE "checklist_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"operator_name" text,
	"service_front_id" integer,
	"template_id" integer,
	"checklist_date" text NOT NULL,
	"meter_reading" double precision,
	"status" text NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"work_order_id" integer,
	"notes" text,
	"client_request_id" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_template_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"label" text NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"photo_required" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"equipment_type" text,
	"open_work_order" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_submission_id_checklist_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."checklist_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_answers" ADD CONSTRAINT "checklist_answers_item_id_checklist_template_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."checklist_template_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_items" ADD CONSTRAINT "checklist_template_items_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checklist_answers_submission_idx" ON "checklist_answers" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "checklist_submissions_equipment_date_idx" ON "checklist_submissions" USING btree ("equipment_id","checklist_date");--> statement-breakpoint
CREATE INDEX "checklist_submissions_date_idx" ON "checklist_submissions" USING btree ("checklist_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_submissions_client_request_unique" ON "checklist_submissions" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "checklist_template_items_template_idx" ON "checklist_template_items" USING btree ("template_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_type_unique" ON "checklist_templates" USING btree (coalesce("equipment_type", ''));--> statement-breakpoint
-- Modelo padrão (vale para todo tipo de equipamento sem modelo próprio). O administrador edita
-- os itens e cria modelos por tipo na tela do Controle Diário → Checklist → Modelos.
INSERT INTO "checklist_templates" ("name", "equipment_type", "open_work_order", "active") VALUES ('Checklist padrão', NULL, true, true);--> statement-breakpoint
INSERT INTO "checklist_template_items" ("template_id", "label", "blocking", "photo_required", "position")
SELECT t."id", i."label", i."blocking", true, i."position" FROM "checklist_templates" t CROSS JOIN (VALUES
  ('Nível do óleo do motor', true, 1),
  ('Nível da água do radiador', true, 2),
  ('Vazamentos (óleo, combustível, hidráulico)', false, 3),
  ('Pneus / esteira (pressão, cortes, folgas)', false, 4),
  ('Freios e freio de estacionamento', true, 5),
  ('Luzes, buzina e alarme de ré', false, 6),
  ('Cinto de segurança', true, 7),
  ('Extintor carregado e no lugar', false, 8),
  ('Vidros, espelhos e limpeza da cabine', false, 9)
) AS i("label", "blocking", "position") WHERE t."equipment_type" IS NULL;
