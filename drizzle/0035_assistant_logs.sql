CREATE TABLE "assistant_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"question" text DEFAULT '' NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"image_names" text,
	"tools" text,
	"answer" text,
	"status" text DEFAULT 'OK' NOT NULL,
	"error" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_logs" ADD CONSTRAINT "assistant_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_logs_user_created_idx" ON "assistant_logs" USING btree ("user_id","created_at");