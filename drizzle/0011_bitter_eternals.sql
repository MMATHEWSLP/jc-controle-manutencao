CREATE TABLE "field_login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"attempted_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_front_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"equipment_id" integer NOT NULL,
	"current_service_front_id" integer,
	"requested_service_front_id" integer NOT NULL,
	"reason" text,
	"requested_by" integer NOT NULL,
	"requested_at" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" text,
	"review_note" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "official_service_front_id" integer;--> statement-breakpoint
ALTER TABLE "daily_records" ADD COLUMN "front_change_request_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_code_hash" text;--> statement-breakpoint
ALTER TABLE "field_login_attempts" ADD CONSTRAINT "field_login_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_front_change_requests" ADD CONSTRAINT "service_front_change_requests_equipment_id_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_front_change_requests" ADD CONSTRAINT "service_front_change_requests_current_service_front_id_service_fronts_id_fk" FOREIGN KEY ("current_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_front_change_requests" ADD CONSTRAINT "service_front_change_requests_requested_service_front_id_service_fronts_id_fk" FOREIGN KEY ("requested_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_front_change_requests" ADD CONSTRAINT "service_front_change_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_front_change_requests" ADD CONSTRAINT "service_front_change_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_login_attempts_user_idx" ON "field_login_attempts" USING btree ("user_id","attempted_at");--> statement-breakpoint
CREATE INDEX "field_login_attempts_ip_idx" ON "field_login_attempts" USING btree ("ip","attempted_at");--> statement-breakpoint
CREATE INDEX "front_change_requests_status_idx" ON "service_front_change_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "front_change_requests_equipment_idx" ON "service_front_change_requests" USING btree ("equipment_id","status");--> statement-breakpoint
ALTER TABLE "daily_records" ADD CONSTRAINT "daily_records_official_service_front_id_service_fronts_id_fk" FOREIGN KEY ("official_service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;