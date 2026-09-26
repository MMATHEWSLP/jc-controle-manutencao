-- Idempotente: o banco de produção pode já ter "operator_name" (migração 0012_useful_junta de outra branch).
DROP INDEX IF EXISTS "daily_records_user_equipment_date_unique";--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN IF NOT EXISTS "operator_name" text;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN IF NOT EXISTS "manual_entry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Registros já lançados com nome digitado pela outra versão contam como lançamento manual.
UPDATE "daily_records" SET "manual_entry" = true WHERE "operator_name" IS NOT NULL AND "manual_entry" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_records_user_equipment_date_operator_unique" ON "daily_records" USING btree ("user_id","equipment_id","record_date",coalesce(lower("operator_name"), ''));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_records_date_idx" ON "daily_records" USING btree ("record_date");
