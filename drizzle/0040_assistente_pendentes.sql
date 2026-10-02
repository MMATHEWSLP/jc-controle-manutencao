CREATE TABLE "assistant_pending_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"source_text" text,
	"via_voz" boolean DEFAULT false NOT NULL,
	"request_id" text NOT NULL,
	"launching_at" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_logs" ADD COLUMN "via_voz" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fuel_movements" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "stock_exits" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "assistant_pending_items" ADD CONSTRAINT "assistant_pending_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_pending_items_user_idx" ON "assistant_pending_items" USING btree ("user_id","id");