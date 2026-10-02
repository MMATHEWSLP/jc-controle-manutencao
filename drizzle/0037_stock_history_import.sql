CREATE TABLE "stock_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"service_front_id" integer NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"exit_count" integer DEFAULT 0 NOT NULL,
	"adjustment_count" integer DEFAULT 0 NOT NULL,
	"balance_row_count" integer DEFAULT 0 NOT NULL,
	"total_value" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PROCESSING' NOT NULL,
	"details" text,
	"reverted_at" text,
	"reverted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "affects_balance" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "history_kind" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "import_row_number" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "product_name_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "equipment_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "chassis_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "owner_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "equipment_description_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "destination_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "employee_text" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "department_text" text;--> statement-breakpoint
ALTER TABLE "stock_import_batches" ADD CONSTRAINT "stock_import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_import_batches" ADD CONSTRAINT "stock_import_batches_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_import_batches" ADD CONSTRAINT "stock_import_batches_reverted_by_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_import_batches_created_idx" ON "stock_import_batches" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_import_batch_id_stock_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."stock_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_stock_movements_import_batch_idx" ON "product_stock_movements" USING btree ("import_batch_id");