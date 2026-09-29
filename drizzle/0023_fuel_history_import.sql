ALTER TABLE "fuel_movements" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "origin_confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "vehicle_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "imported_vehicle" text;--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_movements_import_hash_unique" ON "fuel_movements" USING btree ("import_hash");--> statement-breakpoint
CREATE INDEX "fuel_movements_import_source_idx" ON "fuel_movements" USING btree ("import_source");--> statement-breakpoint
-- ARLA 32 como tipo de combustível (se ainda não foi cadastrado com outro código).
INSERT INTO "fuel_types" ("code","name","unit","sort_order") SELECT 'ARLA_32','ARLA 32','L',3 WHERE NOT EXISTS (SELECT 1 FROM "fuel_types" WHERE upper(replace("name",' ','')) LIKE 'ARLA%' OR "code"='ARLA_32');