CREATE TABLE "notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"dispatch_id" integer,
	"notification_id" integer,
	"user_id" integer NOT NULL,
	"device_id" integer,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"p256dh" text,
	"auth" text,
	"label" text,
	"last_seen_at" text,
	"last_success_at" text,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" text,
	"disabled_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_dispatches" (
	"id" serial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"service_front_id" integer,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_event_settings" (
	"event" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"push" boolean NOT NULL,
	"include_permission" boolean DEFAULT true NOT NULL,
	"profiles" text DEFAULT '[]' NOT NULL,
	"user_ids" text DEFAULT '[]' NOT NULL,
	"only_front" boolean DEFAULT true NOT NULL,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_mutes" (
	"user_id" integer NOT NULL,
	"event" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "notification_mutes_user_id_event_pk" PRIMARY KEY("user_id","event")
);
--> statement-breakpoint
CREATE TABLE "notification_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"dispatch_id" integer,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"group_key" text,
	"group_count" integer DEFAULT 1 NOT NULL,
	"read_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_dispatch_id_notification_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."notification_dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_id_notification_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."notification_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dispatches" ADD CONSTRAINT "notification_dispatches_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dispatches" ADD CONSTRAINT "notification_dispatches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_event_settings" ADD CONSTRAINT "notification_event_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dispatch_id_notification_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."notification_dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_dispatch_idx" ON "notification_deliveries" USING btree ("dispatch_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries" USING btree ("created_at","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_devices_token_unique" ON "notification_devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "notification_devices_user_idx" ON "notification_devices" USING btree ("user_id","disabled_at");--> statement-breakpoint
CREATE INDEX "notification_dispatches_created_idx" ON "notification_dispatches" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notification_dispatches_event_idx" ON "notification_dispatches" USING btree ("event","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","updated_at");--> statement-breakpoint
CREATE INDEX "notifications_group_idx" ON "notifications" USING btree ("user_id","group_key");--> statement-breakpoint
CREATE INDEX "notifications_dispatch_idx" ON "notifications" USING btree ("dispatch_id");