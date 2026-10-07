ALTER TABLE "convoy_fuel_records" ALTER COLUMN "equipment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ALTER COLUMN "reading_unit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "exit_kind" text DEFAULT 'FROTA' NOT NULL;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "third_party_id" integer;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "third_party_destination" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "third_party_vehicle_id" integer;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "third_party_employee_id" integer;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "purpose_note" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "full_tank" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "pending_company" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "pending_vehicle" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD COLUMN "pending_employee" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "revoked_at" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "end_logged_at" text;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_third_party_id_third_parties_id_fk" FOREIGN KEY ("third_party_id") REFERENCES "public"."third_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_third_party_vehicle_id_third_party_vehicles_id_fk" FOREIGN KEY ("third_party_vehicle_id") REFERENCES "public"."third_party_vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "convoy_fuel_records" ADD CONSTRAINT "convoy_fuel_records_third_party_employee_id_third_party_employees_id_fk" FOREIGN KEY ("third_party_employee_id") REFERENCES "public"."third_party_employees"("id") ON DELETE no action ON UPDATE no action;