ALTER TABLE "fuel_movements" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD COLUMN "client_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_movements_client_request_unique" ON "fuel_movements" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_readings_client_request_unique" ON "meter_readings" USING btree ("client_request_id");