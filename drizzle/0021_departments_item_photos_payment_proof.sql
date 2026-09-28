CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "department_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ADD COLUMN "item_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "department_id" integer;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "department_id" integer;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_key_unique" ON "departments" USING btree ("key");--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ADD CONSTRAINT "purchase_order_attachments_item_id_purchase_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Lista inicial de Departamentos + os que já foram digitados nos pedidos de compra (mesma chave de
-- lib/catalog-rules.ts: sem acentos, espaços e pontuação, em maiúsculas).
INSERT INTO "departments" ("name", "key")
SELECT DISTINCT ON (k) n, k FROM (
  SELECT n, upper(regexp_replace(translate(n, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Za-z0-9]', '', 'g')) AS k, o
  FROM (
    SELECT * FROM (VALUES ('MANUTENÇÃO DA FROTA', 0), ('ALIMENTAÇÃO', 0), ('ALOJAMENTO', 0), ('ADMINISTRATIVO', 0)) AS base(n, o)
    UNION ALL
    SELECT upper(regexp_replace(trim("department"), '\s+', ' ', 'g')), 1 FROM "purchase_orders" WHERE "department" IS NOT NULL AND trim("department") <> ''
  ) raw
) d WHERE k <> '' ORDER BY k, o
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "purchase_orders" o SET "department_id" = d."id", "department" = d."name"
FROM "departments" d
WHERE o."department" IS NOT NULL AND o."department_id" IS NULL
  AND d."key" = upper(regexp_replace(translate(trim(o."department"), 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '[^A-Za-z0-9]', '', 'g'));
