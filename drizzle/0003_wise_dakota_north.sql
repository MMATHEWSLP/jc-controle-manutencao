CREATE TABLE "task_role_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_role_id" integer NOT NULL,
	"target_role_id" integer NOT NULL,
	"can_send" boolean DEFAULT false NOT NULL,
	"can_view_received" boolean DEFAULT false NOT NULL,
	"can_view_sent" boolean DEFAULT false NOT NULL,
	"can_manage" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"updated_by" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"visual_order" integer DEFAULT 0 NOT NULL,
	"is_root" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "creator_role_snapshot_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignee_role_snapshot_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "task_role_id" integer;--> statement-breakpoint
ALTER TABLE "task_role_connections" ADD CONSTRAINT "task_role_connections_source_role_id_task_roles_id_fk" FOREIGN KEY ("source_role_id") REFERENCES "public"."task_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_role_connections" ADD CONSTRAINT "task_role_connections_target_role_id_task_roles_id_fk" FOREIGN KEY ("target_role_id") REFERENCES "public"."task_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_role_connections" ADD CONSTRAINT "task_role_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_role_connections" ADD CONSTRAINT "task_role_connections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_role_connections_pair_unique" ON "task_role_connections" USING btree ("source_role_id","target_role_id");--> statement-breakpoint
CREATE INDEX "task_role_connections_target_idx" ON "task_role_connections" USING btree ("target_role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_roles_name_unique" ON "task_roles" USING btree ("name");--> statement-breakpoint
CREATE INDEX "task_roles_active_idx" ON "task_roles" USING btree ("active","visual_order");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_role_snapshot_id_task_roles_id_fk" FOREIGN KEY ("creator_role_snapshot_id") REFERENCES "public"."task_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_role_snapshot_id_task_roles_id_fk" FOREIGN KEY ("assignee_role_snapshot_id") REFERENCES "public"."task_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_task_role_id_task_roles_id_fk" FOREIGN KEY ("task_role_id") REFERENCES "public"."task_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_task_role_idx" ON "users" USING btree ("task_role_id");--> statement-breakpoint
-- Cargos de Tarefas iniciais: configuração de partida pedida pela especificação (seção 3), na
-- mesma ordem visual. ADMIN nasce como cargo raiz (acesso global). O ADMIN pode renomear,
-- reordenar, desativar (exceto o raiz) ou criar novos cargos depois, pelo Gestor de Cargos de
-- Tarefas — esta migration só garante que ninguém comece sem nenhum cargo configurado.
INSERT INTO "task_roles" ("name","visual_order","is_root","active") VALUES
  ('ADMIN',1,true,true),
  ('GESTOR',2,false,true),
  ('SUB 1',3,false,true),
  ('SUB 2',4,false,true),
  ('SUB 3',5,false,true),
  ('USUÁRIO',6,false,true)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
-- Regularização automática: todo usuário já tinha um hierarchy_level (campo legado, NOT NULL,
-- padrão USUARIO) — aqui só religamos esse valor existente ao cargo correspondente pelo nome,
-- sem inventar cargo novo e sem apagar hierarchy_level. Usuário nenhum fica sem Cargo de Tarefas
-- só por causa desta migration.
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'ADMIN') WHERE "hierarchy_level" = 'ADMIN' AND "task_role_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'GESTOR') WHERE "hierarchy_level" = 'GESTOR' AND "task_role_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'SUB 1') WHERE "hierarchy_level" = 'SUB1' AND "task_role_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'SUB 2') WHERE "hierarchy_level" = 'SUB2' AND "task_role_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'SUB 3') WHERE "hierarchy_level" = 'SUB3' AND "task_role_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "task_role_id" = (SELECT "id" FROM "task_roles" WHERE "name" = 'USUÁRIO') WHERE "hierarchy_level" = 'USUARIO' AND "task_role_id" IS NULL;--> statement-breakpoint
-- Snapshots retroativos: tarefas antigas não tinham Cargo de Tarefas nenhum no momento da
-- criação. Preenchemos com o cargo ATUAL do criador/responsável só para o Histórico exibir algo
-- coerente em vez de vazio — isso não é usado para autorização (que sempre olha o cargo atual).
UPDATE "tasks" SET "creator_role_snapshot_id" = (SELECT "task_role_id" FROM "users" WHERE "users"."id" = "tasks"."created_by") WHERE "creator_role_snapshot_id" IS NULL AND "created_by" IS NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "assignee_role_snapshot_id" = (SELECT "task_role_id" FROM "users" WHERE "users"."id" = "tasks"."assignee_id") WHERE "assignee_role_snapshot_id" IS NULL AND "assignee_id" IS NOT NULL;