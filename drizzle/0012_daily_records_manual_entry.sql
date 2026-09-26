DROP INDEX "daily_records_user_equipment_date_unique";--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "operator_name" text;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "manual_entry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_records_user_equipment_date_operator_unique" ON "daily_records" USING btree ("user_id","equipment_id","record_date",coalesce(lower("operator_name"), ''));--> statement-breakpoint
CREATE INDEX "daily_records_date_idx" ON "daily_records" USING btree ("record_date");