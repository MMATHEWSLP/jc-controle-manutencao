CREATE TABLE "fuel_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"liters" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"details" text,
	"reverted_at" text,
	"reverted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD COLUMN "fuel_import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "fuel_import_batches" ADD CONSTRAINT "fuel_import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_import_batches" ADD CONSTRAINT "fuel_import_batches_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_import_batches_created_idx" ON "fuel_import_batches" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_import_batch_id_fuel_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."fuel_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_fuel_import_batch_id_fuel_import_batches_id_fk" FOREIGN KEY ("fuel_import_batch_id") REFERENCES "public"."fuel_import_batches"("id") ON DELETE no action ON UPDATE no action;