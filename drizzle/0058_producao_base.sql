CREATE TABLE "product_front_prices" (
	"product_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"price" double precision NOT NULL,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "product_front_prices_product_id_service_front_id_pk" PRIMARY KEY("product_id","service_front_id")
);
--> statement-breakpoint
CREATE TABLE "production_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"name" text NOT NULL,
	"camp" text,
	"active" boolean DEFAULT true NOT NULL,
	"felling_status" text DEFAULT 'EM_ANDAMENTO' NOT NULL,
	"skidding_status" text DEFAULT 'NAO_INICIADO' NOT NULL,
	"measurement_status" text DEFAULT 'NAO_INICIADO' NOT NULL,
	"hauling_status" text DEFAULT 'NAO_INICIADO' NOT NULL,
	"felling_notes" text,
	"skidding_notes" text,
	"measurement_notes" text,
	"hauling_notes" text,
	"created_by" integer,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_reasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_stage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"stage" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"user_id" integer,
	"occurred_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_targets" (
	"service_front_id" integer NOT NULL,
	"stage" text NOT NULL,
	"trees_per_operator_day" integer NOT NULL,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "production_targets_service_front_id_stage_pk" PRIMARY KEY("service_front_id","stage")
);
--> statement-breakpoint
CREATE TABLE "production_team_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"employee_id" integer NOT NULL,
	"joined_at" text NOT NULL,
	"left_at" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"name" text NOT NULL,
	"leader_employee_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "production_use" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "production_register" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_front_prices" ADD CONSTRAINT "product_front_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_front_prices" ADD CONSTRAINT "product_front_prices_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_front_prices" ADD CONSTRAINT "product_front_prices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_projects" ADD CONSTRAINT "production_projects_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_projects" ADD CONSTRAINT "production_projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_projects" ADD CONSTRAINT "production_projects_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_stage_events" ADD CONSTRAINT "production_stage_events_project_id_production_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."production_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_stage_events" ADD CONSTRAINT "production_stage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_targets" ADD CONSTRAINT "production_targets_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_targets" ADD CONSTRAINT "production_targets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_team_members" ADD CONSTRAINT "production_team_members_team_id_production_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."production_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_team_members" ADD CONSTRAINT "production_team_members_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_team_members" ADD CONSTRAINT "production_team_members_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_teams" ADD CONSTRAINT "production_teams_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_teams" ADD CONSTRAINT "production_teams_leader_employee_id_employees_id_fk" FOREIGN KEY ("leader_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_teams" ADD CONSTRAINT "production_teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_teams" ADD CONSTRAINT "production_teams_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_front_prices_front_idx" ON "product_front_prices" USING btree ("service_front_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_projects_front_name_unique" ON "production_projects" USING btree ("service_front_id",lower("name"));--> statement-breakpoint
CREATE INDEX "production_projects_front_idx" ON "production_projects" USING btree ("service_front_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "production_reasons_code_unique" ON "production_reasons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "production_stage_events_project_idx" ON "production_stage_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "production_team_members_active_unique" ON "production_team_members" USING btree ("team_id","employee_id") WHERE "production_team_members"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "production_team_members_employee_idx" ON "production_team_members" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "production_teams_front_name_unique" ON "production_teams" USING btree ("service_front_id",lower("name"));--> statement-breakpoint
CREATE INDEX "production_teams_leader_idx" ON "production_teams" USING btree ("leader_employee_id");--> statement-breakpoint
INSERT INTO "production_reasons" ("code","description") VALUES ('C.01','CHUVA'),('C.02','MANUTENÇÃO DE MOTOSSERRA'),('C.09','MADEIRA GROSSA') ON CONFLICT ("code") DO NOTHING;
