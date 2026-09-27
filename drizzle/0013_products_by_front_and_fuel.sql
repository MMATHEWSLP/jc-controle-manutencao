CREATE TABLE "fuel_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"fuel_type_id" integer NOT NULL,
	"movement_type" text NOT NULL,
	"movement_date" text NOT NULL,
	"quantity" double precision NOT NULL,
	"origin" text,
	"equipment_id" integer,
	"meter_reading" double precision,
	"meter_unit" text,
	"destination_front_id" integer,
	"responsible" text,
	"notes" text,
	"created_by" integer,
	"deleted_at" text,
	"deleted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fuel_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'L' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_equipment_models" (
	"product_id" integer NOT NULL,
	"equipment_model_id" integer NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "product_equipment_models_product_id_equipment_model_id_pk" PRIMARY KEY("product_id","equipment_model_id")
);
--> statement-breakpoint
CREATE TABLE "product_front_stock" (
	"product_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"activated_at" text,
	"activated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "product_front_stock_product_id_service_front_id_pk" PRIMARY KEY("product_id","service_front_id")
);
--> statement-breakpoint
CREATE TABLE "product_photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"storage_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"uploaded_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_references" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"reference" text NOT NULL,
	"normalized" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_fuel_type_id_fuel_types_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_destination_front_id_service_fronts_id_fk" FOREIGN KEY ("destination_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD CONSTRAINT "fuel_movements_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_equipment_models" ADD CONSTRAINT "product_equipment_models_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_equipment_models" ADD CONSTRAINT "product_equipment_models_equipment_model_id_equipment_models_id_fk" FOREIGN KEY ("equipment_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_front_stock" ADD CONSTRAINT "product_front_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_front_stock" ADD CONSTRAINT "product_front_stock_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_front_stock" ADD CONSTRAINT "product_front_stock_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_references" ADD CONSTRAINT "product_references_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_movements_front_date_idx" ON "fuel_movements" USING btree ("service_front_id","movement_date");--> statement-breakpoint
CREATE INDEX "fuel_movements_destination_idx" ON "fuel_movements" USING btree ("destination_front_id");--> statement-breakpoint
CREATE INDEX "fuel_movements_equipment_idx" ON "fuel_movements" USING btree ("equipment_id","movement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_types_code_unique" ON "fuel_types" USING btree ("code");--> statement-breakpoint
CREATE INDEX "product_equipment_models_model_idx" ON "product_equipment_models" USING btree ("equipment_model_id");--> statement-breakpoint
CREATE INDEX "product_front_stock_front_idx" ON "product_front_stock" USING btree ("service_front_id","active");--> statement-breakpoint
CREATE INDEX "product_photos_product_idx" ON "product_photos" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_references_product_normalized_unique" ON "product_references" USING btree ("product_id","normalized");--> statement-breakpoint
CREATE INDEX "product_references_normalized_idx" ON "product_references" USING btree ("normalized");--> statement-breakpoint
-- Tipos de combustível iniciais. Para incluir outro (ex.: ARLA 32) basta um INSERT nesta tabela.
INSERT INTO "fuel_types" ("code","name","unit","sort_order") VALUES ('DIESEL_S10','Diesel S10','L',1),('GASOLINA_COMUM','Gasolina Comum','L',2) ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- Referência única de hoje vira a primeira da lista (mesma normalização de lib/product-rules.ts).
INSERT INTO "product_references" ("product_id","reference","normalized","position")
SELECT "id",upper(trim("reference")),upper(regexp_replace("reference",'[[:space:]./-]','','g')),0 FROM "products"
WHERE "reference" IS NOT NULL AND regexp_replace("reference",'[[:space:]./-]','','g')<>''
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Aplicação única de hoje vira o primeiro item do multi-select.
INSERT INTO "product_equipment_models" ("product_id","equipment_model_id")
SELECT "id","equipment_model_id" FROM "products" WHERE "equipment_model_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Para não mudar o que cada frente enxerga hoje (o catálogo era único e visível para todos), os
-- produtos já cadastrados ficam ativos em todas as frentes ativas, com quantidade zerada. Produtos
-- novos daqui em diante nascem ativos só na frente de quem cadastrou (ver app/api/products).
INSERT INTO "product_front_stock" ("product_id","service_front_id","quantity","active","activated_at")
SELECT p."id",sf."id",0,true,to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "products" p CROSS JOIN "service_fronts" sf WHERE p."active"=true AND sf."active"=true
ON CONFLICT DO NOTHING;
