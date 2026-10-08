CREATE TABLE "other_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_front_id" integer NOT NULL,
	"equipment_id" integer,
	"expense_date" text NOT NULL,
	"category" text NOT NULL,
	"amount" double precision NOT NULL,
	"description" text NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"deleted_at" text,
	"deleted_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_expenses" ADD CONSTRAINT "other_expenses_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "other_expenses_front_date_idx" ON "other_expenses" USING btree ("service_front_id","expense_date");--> statement-breakpoint
CREATE INDEX "other_expenses_equipment_idx" ON "other_expenses" USING btree ("equipment_id");