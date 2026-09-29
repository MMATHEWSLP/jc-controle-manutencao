ALTER TABLE "fuel_movements" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "origin_confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "vehicle_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "imported_vehicle" text;--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_movements_import_hash_unique" ON "fuel_movements" USING btree ("import_hash");--> statement-breakpoint
CREATE INDEX "fuel_movements_import_source_idx" ON "fuel_movements" USING btree ("import_source");
