ALTER TABLE "fuel_movements" ADD COLUMN "balance_adjustment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Ajustes de saldo já gravados (lote ajuste_saldo_*) passam a ser só saldo, sem aparecer como movimentação.
UPDATE "fuel_movements" SET "balance_adjustment"=true WHERE "import_source" LIKE 'ajuste_saldo_%';
