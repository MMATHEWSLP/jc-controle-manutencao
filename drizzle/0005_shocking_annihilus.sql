ALTER TABLE "material_requests" ADD COLUMN "cancelled_at" text;--> statement-breakpoint
ALTER TABLE "material_requests" ADD COLUMN "cancelled_by" integer;--> statement-breakpoint
ALTER TABLE "material_requests" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "material_requests" ADD COLUMN "reopened_at" text;--> statement-breakpoint
ALTER TABLE "material_requests" ADD COLUMN "reopened_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "status_before_approval_request" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_completion_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_completion_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_approved_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_approved_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_non_execution_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_non_execution_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "non_execution_approved_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "non_execution_approved_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "non_execution_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_completion_by_users_id_fk" FOREIGN KEY ("requested_completion_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completion_approved_by_users_id_fk" FOREIGN KEY ("completion_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_non_execution_by_users_id_fk" FOREIGN KEY ("requested_non_execution_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_non_execution_approved_by_users_id_fk" FOREIGN KEY ("non_execution_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;