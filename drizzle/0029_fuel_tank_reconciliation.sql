CREATE TABLE "fuel_tank_measurements" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"stock_location" text DEFAULT 'FRENTE' NOT NULL,
	"fuel_type_id" integer NOT NULL,
	"tank_id" integer,
	"measured_at" text NOT NULL,
	"method" text DEFAULT 'LITROS' NOT NULL,
	"ruler_cm" double precision,
	"measured_liters" double precision NOT NULL,
	"calculated_liters" double precision NOT NULL,
	"difference_liters" double precision NOT NULL,
	"tolerance_percent" double precision DEFAULT 1 NOT NULL,
	"adjustment_movement_id" integer,
	"notes" text,
	"created_by" integer,
	"deleted_at" text,
	"deleted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_tanks" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"stock_location" text DEFAULT 'FRENTE' NOT NULL,
	"fuel_type_id" integer NOT NULL,
	"name" text NOT NULL,
	"capacity_liters" double precision,
	"calibration" text,
	"tolerance_percent" double precision DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_tank_id_fuel_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."fuel_tanks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_adjustment_movement_id_fuel_movements_id_fk" FOREIGN KEY ("adjustment_movement_id") REFERENCES "public"."fuel_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tank_measurements" ADD CONSTRAINT "fuel_tank_measurements_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tanks" ADD CONSTRAINT "fuel_tanks_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tanks" ADD CONSTRAINT "fuel_tanks_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_tanks" ADD CONSTRAINT "fuel_tanks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_tank_measurements_stock_idx" ON "fuel_tank_measurements" USING btree ("service_front_id","fuel_type_id","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_tanks_stock_unique" ON "fuel_tanks" USING btree ("service_front_id","stock_location","fuel_type_id");