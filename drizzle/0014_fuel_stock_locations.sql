-- Idempotente: pode rodar de novo sem erro.
ALTER TABLE "fuel_movements" ADD COLUMN IF NOT EXISTS "stock_location" text DEFAULT 'FRENTE' NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN IF NOT EXISTS "third_party" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN IF NOT EXISTS "third_party_description" text;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN IF NOT EXISTS "destination_location" text;--> statement-breakpoint
-- Lançamentos anteriores eram todos do estoque da Frente (inclusive o destino das transferências).
UPDATE "fuel_movements" SET "destination_location" = 'FRENTE' WHERE "movement_type" = 'TRANSFERENCIA' AND "destination_location" IS NULL;
