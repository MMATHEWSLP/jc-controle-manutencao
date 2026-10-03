-- Controle Diário importado no Assistente JC (migração 0046):
-- * v_controle_diario: operador do cadastro de campo / "Sem operador"; viagens e toras usam os totais
--   da planilha quando existem; "trabalhado" fica vazio nos registros "Conferir"; no fim, origem,
--   conferir, produção do porto/baldeio e diesel informado (que NÃO é saída de combustível).
-- * v_leituras: origem "Controle Diário" e o registro diário de onde a leitura veio.
-- * v_controle_diario_problemas: problemas relatados (abertos e resolvidos).
-- * v_diario_x_combustivel: diesel informado no diário x saídas de combustível, por equipamento e dia.
-- * v_pendencias: inclui os problemas relatados ainda abertos.
CREATE OR REPLACE VIEW assistente.v_controle_diario AS
SELECT d.id AS registro_id, assistente.dia(d.record_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(d.service_front_id, d.official_service_front_id) AS frente_id, sf.name AS frente,
  CASE WHEN d.no_operator THEN 'Sem operador' ELSE coalesce(fo.name, nullif(d.operator_name, ''), u.name) END AS operador,
  d.worked_today AS trabalhou, d.no_work_reason AS motivo_sem_trabalho, CASE d.reading_unit WHEN 'KM' THEN 'km' ELSE 'h' END AS unidade,
  d.start_reading AS leitura_inicial, d.end_reading AS leitura_final,
  CASE WHEN d.review_status <> 'CONFERIR' AND d.end_reading >= d.start_reading THEN d.end_reading - d.start_reading END AS trabalhado,
  (SELECT coalesce(sum(f.liters), 0) FROM public.daily_record_fuelings f WHERE f.daily_record_id = d.id) AS litros_abastecidos,
  coalesce(d.total_trips::bigint, (SELECT count(*) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id)) AS viagens,
  coalesce(d.port_logs::bigint, (SELECT coalesce(sum(t.logs_quantity), 0) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id)) AS toras,
  (SELECT sum(t.meters) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id) AS metros,
  CASE d.production_type WHEN 'BALDEIO' THEN 'Baldeio' WHEN 'PORTO' THEN 'Porto' END AS producao, d.had_production AS teve_producao,
  d.inactive_or_problem AS teve_problema, d.problem_reason AS problema, d.manual_entry AS lancado_por_terceiro, d.location AS local, d.notes AS observacao,
  CASE WHEN d.import_batch_id IS NOT NULL THEN 'Importação de planilha' ELSE 'Aplicativo' END AS origem_registro,
  CASE WHEN d.import_batch_id IS NOT NULL THEN d.origin END AS lote_importacao,
  d.review_status = 'CONFERIR' AS conferir, d.review_reason AS motivo_conferir,
  d.field_operator_id IS NOT NULL AS operador_cadastrado, d.no_operator AS sem_operador, d.location_original AS local_original,
  d.port_trips AS viagens_porto, d.port_volume_m3 AS volume_porto_m3, d.port_logs AS toras_porto, d.baldeio_trips AS viagens_baldeio,
  d.reported_diesel_liters AS diesel_informado, d.diesel_note AS observacao_diesel
FROM public.daily_records d
JOIN public.equipment e ON e.id = d.equipment_id
LEFT JOIN public.users u ON u.id = d.user_id
LEFT JOIN public.users fo ON fo.id = d.field_operator_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(d.service_front_id, d.official_service_front_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_leituras AS
SELECT m.id AS leitura_id, assistente.dia(m.reading_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(m.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente, m.hours AS horimetro, m.km AS km, m.operator AS operador,
  CASE m.source WHEN 'MANUAL' THEN 'Manual' WHEN 'EXCEL_IMPORT' THEN 'Planilha' WHEN 'QR_CODE' THEN 'QR Code' WHEN 'MAINTENANCE' THEN 'Troca de óleo' WHEN 'ASSISTENTE' THEN 'Assistente JC'
    WHEN 'CONTROLE_DIARIO' THEN 'Controle Diário' ELSE m.source END AS origem,
  m.authorized_regression AS regressao_autorizada, m.notes AS observacao, m.daily_record_id AS registro_diario_id
FROM public.meter_readings m
JOIN public.equipment e ON e.id = m.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(m.service_front_id, e.service_front_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_controle_diario_problemas AS
SELECT r.id AS problema_id, assistente.dia(r.record_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(r.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente, r.operator_name AS operador, r.description AS problema,
  CASE r.status WHEN 'RESOLVIDO' THEN 'Resolvido' ELSE 'Aberto' END AS situacao, assistente.dia(r.resolved_at) AS resolvido_em, ur.name AS resolvido_por,
  r.resolution_note AS resolucao, CASE WHEN r.import_batch_id IS NOT NULL THEN 'Importação de planilha' ELSE 'Aplicativo' END AS origem, r.daily_record_id AS registro_id
FROM public.daily_problem_reports r
JOIN public.equipment e ON e.id = r.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(r.service_front_id, e.service_front_id)
LEFT JOIN public.users ur ON ur.id = r.resolved_by;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_diario_x_combustivel AS
WITH diario AS (
  SELECT d.equipment_id, left(d.record_date, 10) AS dia, max(coalesce(d.service_front_id, d.official_service_front_id)) AS frente_id,
    sum(coalesce(d.reported_diesel_liters, 0) + coalesce((SELECT sum(f.liters) FROM public.daily_record_fuelings f WHERE f.daily_record_id = d.id), 0)) AS litros,
    count(*) AS registros, bool_or(d.diesel_note IS NOT NULL) AS nota
  FROM public.daily_records d GROUP BY 1, 2
), comb AS (
  SELECT fm.equipment_id, left(fm.movement_date, 10) AS dia, max(fm.service_front_id) AS frente_id, sum(fm.quantity) AS litros, count(*) AS saidas
  FROM public.fuel_movements fm
  WHERE fm.deleted_at IS NULL AND fm.movement_type = 'SAIDA' AND NOT fm.balance_adjustment AND fm.equipment_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT assistente.dia(coalesce(di.dia, co.dia)) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(di.frente_id, co.frente_id, e.service_front_id) AS frente_id, sf.name AS frente,
  coalesce(di.litros, 0) AS diesel_diario, coalesce(co.litros, 0) AS diesel_combustivel, coalesce(di.litros, 0) - coalesce(co.litros, 0) AS diferenca,
  coalesce(di.registros, 0) AS registros_diario, coalesce(co.saidas, 0) AS saidas_combustivel, coalesce(di.nota, false) AS acima_de_600_nao_lancado
FROM diario di
FULL JOIN comb co ON co.equipment_id = di.equipment_id AND co.dia = di.dia
JOIN public.equipment e ON e.id = coalesce(di.equipment_id, co.equipment_id)
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(di.frente_id, co.frente_id, e.service_front_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_pendencias AS
SELECT 'Saída de combustível sem veículo' AS tipo, 'Alta' AS gravidade, fm.service_front_id AS frente_id, sf.name AS frente,
  assistente.dia(fm.movement_date) AS data, coalesce(nullif(fm.imported_vehicle, ''), '(sem veículo)') AS referencia,
  round(fm.quantity::numeric, 2) || ' L · responsável ' || coalesce(fm.responsible, '—') AS detalhe, 'Combustível → Histórico (editar o lançamento e escolher o veículo)' AS onde_corrigir
FROM public.fuel_movements fm JOIN public.service_fronts sf ON sf.id = fm.service_front_id
WHERE fm.deleted_at IS NULL AND fm.movement_type = 'SAIDA' AND NOT fm.balance_adjustment AND fm.equipment_id IS NULL AND fm.third_party_vehicle_id IS NULL AND (fm.vehicle_pending OR NOT fm.third_party)
UNION ALL
SELECT 'Equipamento com horímetro/KM zerado', 'Média', e.service_front_id, sf.name, NULL, e.prefix, e.type, 'Troca de Óleo → Horímetros / KM'
FROM public.equipment e LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE e.sold_at IS NULL AND e.status <> 'INACTIVE' AND ((e.control_type IN ('HOURS', 'HOURS_KM') AND e.current_hours = 0) OR (e.control_type = 'KM' AND e.current_km = 0))
UNION ALL
SELECT 'Troca de óleo ligada sem plano', 'Média', e.service_front_id, sf.name, NULL, e.prefix, e.type, 'Equipamentos → Cadastro ou Troca de Óleo → planos'
FROM public.equipment e LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE e.oil_change_enabled AND e.sold_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.maintenance_plans p WHERE p.equipment_id = e.id AND p.active)
UNION ALL
SELECT 'Equipamento sem frente', 'Média', NULL, NULL, NULL, e.prefix, e.type, 'Equipamentos → Cadastro'
FROM public.equipment e WHERE e.service_front_id IS NULL AND e.sold_at IS NULL
UNION ALL
SELECT 'Estoque negativo', 'Alta', s.service_front_id, sf.name, NULL, p.tag || ' ' || p.name, 'saldo ' || s.quantity, 'Produtos → ficha do produto (ajustar saldo)'
FROM public.product_front_stock s JOIN public.products p ON p.id = s.product_id JOIN public.service_fronts sf ON sf.id = s.service_front_id WHERE s.quantity < 0
UNION ALL
SELECT 'Veículo de terceiro sem capacidade/consumo esperado', 'Baixa', NULL, NULL, NULL, t.name || ' · ' || v.plate,
  concat_ws(', ', CASE WHEN v.tank_capacity_liters IS NULL THEN 'falta capacidade do tanque' END, CASE WHEN v.expected_consumption IS NULL THEN 'falta consumo esperado' END), 'Produtos → Terceiros'
FROM public.third_party_vehicles v JOIN public.third_parties t ON t.id = v.third_party_id
WHERE v.active AND t.active AND (v.tank_capacity_liters IS NULL OR v.expected_consumption IS NULL)
UNION ALL
SELECT 'Problema relatado no Controle Diário', 'Alta', coalesce(r.service_front_id, e.service_front_id), sf.name, assistente.dia(r.record_date), e.prefix,
  r.description || coalesce(' · operador ' || r.operator_name, ''), 'Pendências → Problemas relatados no Controle Diário (Resolver)'
FROM public.daily_problem_reports r JOIN public.equipment e ON e.id = r.equipment_id LEFT JOIN public.service_fronts sf ON sf.id = coalesce(r.service_front_id, e.service_front_id)
WHERE r.status = 'ABERTO';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para conceder SELECT ao papel assistente_leitura.';
END $$;
