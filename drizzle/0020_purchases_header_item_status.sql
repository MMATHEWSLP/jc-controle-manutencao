CREATE TABLE "product_brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_item_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"details" text,
	"user_id" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ADD COLUMN "kind" text DEFAULT 'QUOTE_DOCUMENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "status" text DEFAULT 'AGUARDANDO_APROVACAO' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "approved_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "approved_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "rejected_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "rejected_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "payment_requested_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "payment_requested_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "paid_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "paid_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "dispatched_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "dispatched_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "original_quantity" double precision;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "quantity_changed_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "quantity_changed_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "removed_by" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "removed_at" text;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "removed_reason" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "order_date" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "requester_name" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "urgency" text DEFAULT 'NORMAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "equipment_id" integer;--> statement-breakpoint
ALTER TABLE "product_brands" ADD CONSTRAINT "product_brands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item_events" ADD CONSTRAINT "purchase_order_item_events_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item_events" ADD CONSTRAINT "purchase_order_item_events_item_id_purchase_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_item_events" ADD CONSTRAINT "purchase_order_item_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_brands_key_unique" ON "product_brands" USING btree ("key");--> statement-breakpoint
CREATE INDEX "purchase_order_item_events_item_idx" ON "purchase_order_item_events" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_payment_requested_by_users_id_fk" FOREIGN KEY ("payment_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_dispatched_by_users_id_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_quantity_changed_by_users_id_fk" FOREIGN KEY ("quantity_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Pedidos já existentes: cada item herda a situação e as datas do pedido; item já recebido fica RECEBIDO.
UPDATE "purchase_order_items" i SET
  "status" = CASE WHEN i."received_at" IS NOT NULL THEN 'RECEBIDO' ELSE o."status" END,
  "approved_by" = o."approved_by", "approved_at" = o."approved_at",
  "rejected_by" = o."rejected_by", "rejected_at" = o."rejected_at", "reject_reason" = o."reject_reason",
  "payment_requested_by" = o."payment_requested_by", "payment_requested_at" = o."payment_requested_at",
  "paid_by" = o."paid_by", "paid_at" = o."paid_at",
  "dispatched_by" = o."dispatched_by", "dispatched_at" = o."dispatched_at"
FROM "purchase_orders" o WHERE o."id" = i."order_id";--> statement-breakpoint
UPDATE "purchase_orders" o SET "order_date" = substr(o."requested_at", 1, 10), "requester_name" = u."name"
FROM "users" u WHERE u."id" = o."requester_id" AND o."order_date" IS NULL;--> statement-breakpoint
-- Anexos já existentes eram orçamentos: imagem ou documento conforme o formato.
UPDATE "purchase_order_attachments" SET "kind" = 'QUOTE_IMAGE' WHERE "content_type" LIKE 'image/%';
--> statement-breakpoint
-- Marcas já usadas nos produtos entram na lista única (a primeira grafia de cada chave vence).
INSERT INTO "product_brands" ("name", "key")
SELECT DISTINCT ON (k) upper(trim("brand")), k FROM (
  SELECT "brand", upper(regexp_replace(translate(trim("brand"), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Za-z0-9]', '', 'g')) AS k, "id"
  FROM "products" WHERE "brand" IS NOT NULL AND trim("brand") <> ''
) b WHERE k <> '' ORDER BY k, "id"
ON CONFLICT ("key") DO NOTHING;
