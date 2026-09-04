CREATE TABLE "task_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"read_at" text
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "viewed_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "viewed_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancelled_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancelled_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "task_notifications" ADD CONSTRAINT "task_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notifications" ADD CONSTRAINT "task_notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_notifications_user_idx" ON "task_notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "task_notifications_task_idx" ON "task_notifications" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_viewed_by_users_id_fk" FOREIGN KEY ("viewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;