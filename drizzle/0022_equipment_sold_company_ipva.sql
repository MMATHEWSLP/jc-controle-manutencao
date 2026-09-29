ALTER TABLE "equipment" ADD COLUMN "company_id" integer;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "ipva_expires_at" text;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "sold_at" text;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "sold_by" integer;--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "sold_notes" text;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_sold_by_users_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "equipment_sold_idx" ON "equipment" USING btree ("sold_at");