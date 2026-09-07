CREATE TABLE "equipment_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"manufacturer" text,
	"category" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"reference" text,
	"price" double precision DEFAULT 0 NOT NULL,
	"supplier_id" integer,
	"brand" text,
	"equipment_model_id" integer,
	"needs_review" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cnpj" text,
	"phone" text,
	"email" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "equipment_model_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_equipment_model_id_equipment_models_id_fk" FOREIGN KEY ("equipment_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_models_name_unique" ON "equipment_models" USING btree ("name");--> statement-breakpoint
CREATE INDEX "equipment_models_active_idx" ON "equipment_models" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tag_unique" ON "products" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "products_equipment_model_idx" ON "products" USING btree ("equipment_model_id");--> statement-breakpoint
CREATE INDEX "products_supplier_idx" ON "products" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "products_needs_review_idx" ON "products" USING btree ("needs_review");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_unique" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "suppliers_active_idx" ON "suppliers" USING btree ("active");--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_equipment_model_id_equipment_models_id_fk" FOREIGN KEY ("equipment_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "equipment_model_idx" ON "equipment" USING btree ("equipment_model_id");