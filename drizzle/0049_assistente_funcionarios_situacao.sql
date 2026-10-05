-- Funcionários no Assistente JC (LGPD, importação do sistema de pessoal — migração 0048):
-- * v_funcionarios: a situação passa a ser a calculada pelo sistema a partir das datas
--   (Trabalhando, De folga, Em viagem, Afastado, Sede, Desligado), igual à tela. Sem CPF, salário,
--   nascimento, motivo de demissão, afastamento ou restrição.
-- * v_ausencias_funcionarios: sem observação (podia ter motivo de saúde) e com o tipo genérico
--   (atestado médico aparece como "Afastamento").
CREATE OR REPLACE VIEW assistente.v_funcionarios AS
SELECT f.id AS funcionario_id, f.name AS nome, f.job_title AS funcao, f.company AS empresa, assistente.dia(f.admission_date) AS admissao, f.service_front_id AS frente_id, sf.name AS frente,
  CASE
    WHEN f.status = 'DEMITIDO' THEN 'Desligado'
    WHEN f.status = 'AFASTADO' OR EXISTS (
      SELECT 1 FROM public.employee_absences a
      WHERE a.employee_id = f.id AND a.kind IN ('ATESTADO', 'AFASTAMENTO', 'OUTRO')
        AND a.start_date <= to_char(now() AT TIME ZONE 'America/Fortaleza', 'YYYY-MM-DD')
        AND (a.end_date IS NULL OR a.end_date >= to_char(now() AT TIME ZONE 'America/Fortaleza', 'YYYY-MM-DD'))
    ) THEN 'Afastado'
    WHEN f.at_headquarters THEN 'Sede'
    WHEN c.home_arrival IS NOT NULL AND c.home_departure IS NULL THEN 'De folga'
    WHEN c.front_departure IS NOT NULL OR c.home_departure IS NOT NULL THEN 'Em viagem'
    ELSE 'Trabalhando'
  END AS situacao,
  f.registration AS matricula, f.city AS cidade, f.cycle_work_days AS ciclo_dias_trabalho, f.cycle_off_days AS ciclo_dias_folga
FROM public.employees f
JOIN public.service_fronts sf ON sf.id = f.service_front_id
LEFT JOIN LATERAL (
  SELECT l.front_departure, l.home_arrival, l.home_departure
  FROM public.employee_leave_cycles l
  WHERE l.employee_id = f.id AND l.front_arrival IS NULL AND l.ended_at IS NULL
  ORDER BY l.cycle_number DESC LIMIT 1
) c ON true;
--> statement-breakpoint
DROP VIEW IF EXISTS assistente.v_ausencias_funcionarios;
--> statement-breakpoint
CREATE VIEW assistente.v_ausencias_funcionarios AS
SELECT a.id AS ausencia_id, f.id AS funcionario_id, f.name AS funcionario, f.service_front_id AS frente_id, sf.name AS frente,
  CASE a.kind WHEN 'FOLGA' THEN 'Folga' WHEN 'FERIAS' THEN 'Férias' ELSE 'Afastamento' END AS tipo,
  assistente.dia(a.start_date) AS inicio, assistente.dia(a.end_date) AS fim, (a.end_date IS NULL) AS em_aberto
FROM public.employee_absences a
JOIN public.employees f ON f.id = a.employee_id
JOIN public.service_fronts sf ON sf.id = f.service_front_id;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para conceder SELECT ao papel assistente_leitura.';
END $$;
