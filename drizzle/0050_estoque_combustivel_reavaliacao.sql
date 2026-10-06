CREATE TABLE "fuel_stock_valuations" (
	"id" serial PRIMARY KEY NOT NULL,
	"fuel_type_id" integer NOT NULL,
	"service_front_id" integer,
	"stock_location" text,
	"effective_date" text NOT NULL,
	"unit_cost" double precision NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_stock_valuations" ADD CONSTRAINT "fuel_stock_valuations_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_stock_valuations" ADD CONSTRAINT "fuel_stock_valuations_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_stock_valuations" ADD CONSTRAINT "fuel_stock_valuations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_stock_valuations_fuel_idx" ON "fuel_stock_valuations" USING btree ("fuel_type_id");