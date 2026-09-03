CREATE TABLE "material_request_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"quantity_requested" double precision NOT NULL,
	"item_status" text DEFAULT 'PENDING' NOT NULL,
	"quantity_sent" double precision,
	"notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requester_id" integer NOT NULL,
	"service_front_id" integer,
	"requested_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"shipped_by" integer,
	"shipped_at" text,
	"shipment_notes" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_task_id" integer,
	"title" text NOT NULL,
	"description" text,
	"assignee_id" integer,
	"urgency" text DEFAULT 'MEDIUM' NOT NULL,
	"due_date" text NOT NULL,
	"status" text DEFAULT 'TODO' NOT NULL,
	"created_by" integer,
	"completed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_request_id_material_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."material_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_service_front_id_service_fronts_id_fk" FOREIGN KEY ("service_front_id") REFERENCES "public"."service_fronts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_shipped_by_users_id_fk" FOREIGN KEY ("shipped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_request_items_request_idx" ON "material_request_items" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "material_requests_requester_idx" ON "material_requests" USING btree ("requester_id","requested_at");--> statement-breakpoint
CREATE INDEX "material_requests_status_idx" ON "material_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "material_requests_front_idx" ON "material_requests" USING btree ("service_front_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "tasks_due_date_idx" ON "tasks" USING btree ("due_date");