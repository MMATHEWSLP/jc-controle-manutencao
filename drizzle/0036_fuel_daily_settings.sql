CREATE TABLE "fuel_daily_settings" (
	"service_front_id" integer PRIMARY KEY NOT NULL,
	"greeting" text DEFAULT 'Bom dia a todos!' NOT NULL,
	"title" text NOT NULL,
	"balance_label" text NOT NULL,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_daily_settings" ADD CONSTRAINT "fuel_daily_settings_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_daily_settings" ADD CONSTRAINT "fuel_daily_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Arapiuns já vem com o título do grupo do WhatsApp.
INSERT INTO "fuel_daily_settings" ("service_front_id", "greeting", "title", "balance_label")
SELECT "id", 'Bom dia a todos!', 'Controle de Diesel Arapiuns/Fazendinha 2026', 'Saldo Arapiuns' FROM "service_fronts" WHERE "name" ILIKE '%arapiuns%'
ON CONFLICT ("service_front_id") DO NOTHING;
