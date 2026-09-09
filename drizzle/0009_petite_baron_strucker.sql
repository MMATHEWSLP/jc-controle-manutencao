CREATE TABLE "user_service_fronts" (
	"user_id" integer NOT NULL,
	"service_front_id" integer NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "user_service_fronts_user_id_service_front_id_pk" PRIMARY KEY("user_id","service_front_id")
);
--> statement-breakpoint
ALTER TABLE "equipment" ADD COLUMN "sort_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "all_service_fronts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "can_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_service_fronts" ADD CONSTRAINT "user_service_fronts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_fronts" ADD CONSTRAINT "user_service_fronts_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_service_fronts_front_idx" ON "user_service_fronts" USING btree ("service_front_id");--> statement-breakpoint
CREATE INDEX "equipment_sort_key_idx" ON "equipment" USING btree ("sort_key");