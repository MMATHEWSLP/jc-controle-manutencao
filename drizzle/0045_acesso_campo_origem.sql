ALTER TABLE "users" ADD COLUMN "field_access_origin" text;--> statement-breakpoint
-- Acessos de campo que já existiam foram criados à mão na tela Funcionários de campo (MANUAL);
-- os criados automaticamente pela função (auditoria "ACESSO DE OPERADOR CRIADO") ficam FUNCAO.
UPDATE "users" u SET "field_access_origin" = CASE
  WHEN EXISTS (SELECT 1 FROM "audit_logs" a WHERE a."entity_type" = 'USER' AND a."entity_id" = u."id"::text AND a."action" = 'ACESSO DE OPERADOR CRIADO') THEN 'FUNCAO'
  ELSE 'MANUAL' END
WHERE u."role" = 'CAMPO' AND u."field_access_origin" IS NULL;
