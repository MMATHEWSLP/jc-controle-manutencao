CREATE TABLE "third_parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"document" text,
	"contact_name" text,
	"phone" text,
	"service_front_id" integer,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "third_party_vehicles" (
	"id" serial PRIMARY KEY NOT NULL,
	"third_party_id" integer NOT NULL,
	"plate" text NOT NULL,
	"plate_key" text NOT NULL,
	"description" text,
	"vehicle_type" text DEFAULT 'CAMINHAO' NOT NULL,
	"meter_type" text DEFAULT 'KM' NOT NULL,
	"fuel_type_id" integer,
	"tank_capacity_liters" double precision,
	"expected_consumption" double precision,
	"last_reading" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "third_party_id" integer;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "third_party_vehicle_id" integer;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "full_tank" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "consumption_outlier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "reading_exception" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "third_party_id" integer;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "third_party_vehicle_id" integer;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "received_by" text;--> statement-breakpoint
ALTER TABLE "third_parties" ADD CONSTRAINT "third_parties_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_parties" ADD CONSTRAINT "third_parties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_vehicles" ADD CONSTRAINT "third_party_vehicles_third_party_id_third_parties_id_fk" FOREIGN KEY ("third_party_id") REFERENCES "public"."third_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_vehicles" ADD CONSTRAINT "third_party_vehicles_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_vehicles" ADD CONSTRAINT "third_party_vehicles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "third_parties_document_unique" ON "third_parties" USING btree ("document");--> statement-breakpoint
CREATE INDEX "third_parties_name_idx" ON "third_parties" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "third_party_vehicles_plate_unique" ON "third_party_vehicles" USING btree ("third_party_id","plate_key");--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_third_party_id_third_parties_id_fk" FOREIGN KEY ("third_party_id") REFERENCES "public"."third_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_third_party_vehicle_id_third_party_vehicles_id_fk" FOREIGN KEY ("third_party_vehicle_id") REFERENCES "public"."third_party_vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_third_party_id_third_parties_id_fk" FOREIGN KEY ("third_party_id") REFERENCES "public"."third_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_third_party_vehicle_id_third_party_vehicles_id_fk" FOREIGN KEY ("third_party_vehicle_id") REFERENCES "public"."third_party_vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_movements_third_party_vehicle_idx" ON "fuel_movements" USING btree ("third_party_vehicle_id","movement_date");--> statement-breakpoint
CREATE INDEX "fuel_movements_third_party_idx" ON "fuel_movements" USING btree ("third_party_id");--> statement-breakpoint
CREATE INDEX "stock_exits_third_party_idx" ON "stock_exits" USING btree ("third_party_id","third_party_vehicle_id");