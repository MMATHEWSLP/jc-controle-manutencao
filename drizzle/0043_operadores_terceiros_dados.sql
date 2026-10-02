-- Funções: grafia única (maiúsculas, sem espaços duplicados) e cadastro de Funções com as já usadas.
UPDATE employees SET job_title = upper(trim(regexp_replace(job_title, '\s+', ' ', 'g')))
WHERE job_title IS DISTINCT FROM upper(trim(regexp_replace(job_title, '\s+', ' ', 'g')));
--> statement-breakpoint
INSERT INTO job_functions (name)
SELECT DISTINCT job_title FROM employees WHERE coalesce(job_title, '') <> ''
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
-- "Opera equipamento": as 8 funções confirmadas pelo administrador (02/10/2026). Motosserra fica de fora.
UPDATE job_functions SET operates_equipment = true, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE name IN ('MOTORISTA DE CAMINHAO NIVEL III', 'OP. DE PÁ CARREGADEIRA', 'OP. DE SKIDDER', 'OPERADOR DE TRATOR DE ESTEIRA',
  'MOTORISTA DE APOIO', 'OP. DE MOTONIVELADORA', 'MOTORISTA DE COMBOIO', 'MOTORISTA DE CAMINHÃO NIVEL LLL');
--> statement-breakpoint
-- Acessos de campo já existentes: vincula ao funcionário de mesmo nome (único, não demitido), mantendo o código.
UPDATE users u SET employee_id = e.id
FROM employees e
WHERE u.role = 'CAMPO' AND u.employee_id IS NULL AND e.status <> 'DEMITIDO'
  AND upper(trim(e.name)) = upper(trim(u.name))
  AND (SELECT count(*) FROM employees x WHERE x.status <> 'DEMITIDO' AND upper(trim(x.name)) = upper(trim(u.name))) = 1
  AND NOT EXISTS (SELECT 1 FROM users v WHERE v.employee_id = e.id);
--> statement-breakpoint
-- Saídas de combustível para terceiro já lançadas com veículo: destino Veículo.
UPDATE fuel_movements SET third_party_destination = 'VEICULO' WHERE third_party_vehicle_id IS NOT NULL AND third_party_destination IS NULL;
