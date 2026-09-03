ALTER TABLE "tasks" ADD COLUMN "completed_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completion_note" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "not_done_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "not_done_by" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "not_done_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_at" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_by" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hierarchy_level" text DEFAULT 'USUARIO' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_not_done_by_users_id_fk" FOREIGN KEY ("not_done_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_deleted_idx" ON "tasks" USING btree ("deleted_at");--> statement-breakpoint
-- Regularização de dados: a coluna nova nasce com o padrão 'USUARIO' para todo mundo (mais
-- restritivo/seguro). Aqui só elevamos quem já era ADMIN ou GESTOR pelo perfil (role) existente,
-- para não deixar esses usuários sem visibilidade nenhuma no módulo Tarefas assim que a hierarquia
-- entrar em vigor. Nenhum usuário ou tarefa é apagado ou perde dados nesta migração.
UPDATE "users" SET "hierarchy_level" = 'ADMIN' WHERE "role" = 'ADMIN';--> statement-breakpoint
UPDATE "users" SET "hierarchy_level" = 'GESTOR' WHERE "role" = 'GESTOR';