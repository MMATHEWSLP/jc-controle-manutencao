CREATE TABLE "purchase_order_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"description" text NOT NULL,
	"reference" text,
	"quantity" double precision NOT NULL,
	"fiscal_unit" text NOT NULL,
	"unit_price" double precision,
	"supplier_id" integer,
	"brand" text,
	"received_at" text,
	"received_by" integer,
	"received_quantity" double precision,
	"received_unit_price" double precision,
	"received_supplier_id" integer,
	"received_brand" text,
	"receipt_notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"requester_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"requested_at" text NOT NULL,
	"status" text DEFAULT 'AGUARDANDO_APROVACAO' NOT NULL,
	"notes" text,
	"approved_by" integer,
	"approved_at" text,
	"rejected_by" integer,
	"rejected_at" text,
	"reject_reason" text,
	"payment_requested_by" integer,
	"payment_requested_at" text,
	"buyer_notes" text,
	"paid_by" integer,
	"paid_at" text,
	"payment_notes" text,
	"dispatched_by" integer,
	"dispatched_at" text,
	"dispatch_notes" text,
	"received_by" integer,
	"received_at" text,
	"cancelled_by" integer,
	"cancelled_at" text,
	"cancel_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_exit_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"exit_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" double precision NOT NULL,
	"unit_price" double precision,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_exits" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"exit_date" text NOT NULL,
	"destination_type" text NOT NULL,
	"employee_id" integer,
	"equipment_id" integer,
	"notes" text,
	"created_by" integer,
	"cancelled_at" text,
	"cancelled_by" integer,
	"cancel_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" double precision NOT NULL,
	"launch_date" text NOT NULL,
	"withdrawn_by" text NOT NULL,
	"withdrawn_by_employee_id" integer,
	"application" text,
	"unit_price" double precision,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_mechanics" (
	"work_order_id" integer NOT NULL,
	"mechanic_name" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "work_order_mechanics_work_order_id_mechanic_name_pk" PRIMARY KEY("work_order_id","mechanic_name")
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"opened_at" text NOT NULL,
	"meter_reading" double precision,
	"meter_unit" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_at" text,
	"closed_by" integer,
	"closing_notes" text,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenances" ADD COLUMN "work_order_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "source" text DEFAULT 'MATERIAL_REQUEST' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "movement_date" text;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "unit_price" double precision;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "equipment_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "employee_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "purchase_order_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "purchase_order_item_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "stock_exit_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "stock_exit_item_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "work_order_id" integer;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD COLUMN "work_order_item_id" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ADD CONSTRAINT "purchase_order_attachments_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_attachments" ADD CONSTRAINT "purchase_order_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_id_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_received_supplier_id_suppliers_id_fk" FOREIGN KEY ("received_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_payment_requested_by_users_id_fk" FOREIGN KEY ("payment_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_dispatched_by_users_id_fk" FOREIGN KEY ("dispatched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exit_items" ADD CONSTRAINT "stock_exit_items_exit_id_stock_exits_id_fk" FOREIGN KEY ("exit_id") REFERENCES "public"."stock_exits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exit_items" ADD CONSTRAINT "stock_exit_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD CONSTRAINT "stock_exits_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_withdrawn_by_employee_id_employees_id_fk" FOREIGN KEY ("withdrawn_by_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_mechanics" ADD CONSTRAINT "work_order_mechanics_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_order_attachments_order_idx" ON "purchase_order_attachments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_order_idx" ON "purchase_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_items_product_idx" ON "purchase_order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "purchase_orders_requester_idx" ON "purchase_orders" USING btree ("requester_id","requested_at");--> statement-breakpoint
CREATE INDEX "purchase_orders_front_idx" ON "purchase_orders" USING btree ("service_front_id");--> statement-breakpoint
CREATE INDEX "stock_exit_items_exit_idx" ON "stock_exit_items" USING btree ("exit_id");--> statement-breakpoint
CREATE INDEX "stock_exits_date_idx" ON "stock_exits" USING btree ("exit_date");--> statement-breakpoint
CREATE INDEX "stock_exits_equipment_idx" ON "stock_exits" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "stock_exits_employee_idx" ON "stock_exits" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "work_order_items_order_idx" ON "work_order_items" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "work_orders_equipment_idx" ON "work_orders" USING btree ("equipment_id","opened_at");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status","opened_at");--> statement-breakpoint
ALTER TABLE "maintenances" ADD CONSTRAINT "maintenances_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_stock_exit_id_stock_exits_id_fk" FOREIGN KEY ("stock_exit_id") REFERENCES "public"."stock_exits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_stock_exit_item_id_stock_exit_items_id_fk" FOREIGN KEY ("stock_exit_item_id") REFERENCES "public"."stock_exit_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_work_order_item_id_work_order_items_id_fk" FOREIGN KEY ("work_order_item_id") REFERENCES "public"."work_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_stock_movements_source_idx" ON "product_stock_movements" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "product_stock_movements_equipment_idx" ON "product_stock_movements" USING btree ("equipment_id");--> statement-breakpoint
CREATE INDEX "product_stock_movements_employee_idx" ON "product_stock_movements" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "product_stock_movements_work_order_idx" ON "product_stock_movements" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "product_stock_movements_exit_idx" ON "product_stock_movements" USING btree ("stock_exit_id");--> statement-breakpoint
CREATE INDEX "product_stock_movements_purchase_idx" ON "product_stock_movements" USING btree ("purchase_order_id");