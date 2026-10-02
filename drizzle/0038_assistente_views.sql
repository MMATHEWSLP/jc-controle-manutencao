-- ---------------------------------------------------------------------------------------------
-- Assistente JC: camada de consulta SOMENTE LEITURA.
--  * Schema próprio "assistente" (fora do "public", que o PostgREST do Supabase expõe).
--  * Uma view por assunto, com nomes e colunas em português e os joins já resolvidos.
--  * Nenhuma view traz senha, hash, token, chave, QR token, sessão ou configuração do WhatsApp.
--  * Papel "assistente_leitura": só USAGE no schema e SELECT nas views (nada nas tabelas), com
--    transação somente leitura por padrão. A senha NÃO fica aqui: o ADMIN define no Supabase
--    (ALTER ROLE assistente_leitura WITH LOGIN PASSWORD '...') e cadastra ASSISTANT_DATABASE_URL.
--  * Toda coluna de frente se chama frente_id; o servidor (lib/assistente/consulta.ts) aplica o
--    filtro das frentes do usuário em toda consulta. O catálogo das colunas fica em
--    lib/assistente/catalogo.ts (manter os dois em sintonia; tests/assistente-catalogo confere).
--  * Datas saem como DATE (dia local). Ao mudar/remover uma coluna usada aqui, recrie a view.
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS assistente;
--> statement-breakpoint
-- Texto de data do sistema → DATE. "AAAA-MM-DD" (com ou sem hora local) vira o próprio dia;
-- carimbo ISO em UTC ("...Z" ou com fuso) vira o dia no horário de Fortaleza.
CREATE OR REPLACE FUNCTION assistente.dia(valor text) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN valor ~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$' THEN (valor::timestamptz AT TIME ZONE 'America/Fortaleza')::date
    WHEN valor ~ '^\d{4}-\d{2}-\d{2}' THEN left(valor, 10)::date
  END
$$;
--> statement-breakpoint
-- Chave de comparação dos filtros de texto: minúsculas, sem acento e com espaços simples.
CREATE OR REPLACE FUNCTION assistente.chave(valor text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(trim(translate(lower(valor), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')), '\s+', ' ', 'g')
$$;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_frentes AS
SELECT sf.id AS frente_id, sf.name AS frente, sf.location AS local, sf.active AS ativa
FROM public.service_fronts sf;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_equipamentos AS
SELECT e.id AS equipamento_id, e.prefix AS codigo, e.plate AS placa, coalesce(e.chassis, e.serial_number) AS chassi_serie,
  e.type AS tipo, e.brand AS marca, e.model AS modelo, em.name AS modelo_aplicacao, e.year AS ano,
  e.service_front_id AS frente_id, sf.name AS frente, e.location AS local,
  CASE e.status WHEN 'ACTIVE' THEN 'Ativo' WHEN 'STOPPED' THEN 'Parado' WHEN 'MAINTENANCE' THEN 'Em manutenção' WHEN 'INACTIVE' THEN 'Inativo' ELSE e.status END AS situacao_cadastro,
  CASE coalesce(fcs.status, 'OPERATING') WHEN 'OPERATING' THEN 'Operando' WHEN 'STOPPED' THEN 'Parado' WHEN 'MAINTENANCE' THEN 'Em manutenção'
    WHEN 'WAITING_PART' THEN 'Aguardando peça' WHEN 'WAITING_ORDER' THEN 'Aguardando pedido' WHEN 'WAITING_MECHANIC' THEN 'Aguardando mecânico'
    WHEN 'WAITING_EXTERNAL_SERVICE' THEN 'Aguardando serviço externo' WHEN 'READY' THEN 'Liberado / pronto' WHEN 'INACTIVE' THEN 'Inativo' ELSE fcs.status END AS status_frota,
  co.name AS proprietario,
  CASE e.control_type WHEN 'KM' THEN 'KM' WHEN 'HOURS' THEN 'Horímetro' ELSE 'Horímetro e KM' END AS controle,
  e.current_hours AS horimetro_atual, e.current_km AS km_atual, lr.ultima_leitura AS data_ultima_leitura,
  e.oil_change_enabled AS participa_troca_oleo, (e.sold_at IS NOT NULL) AS vendido, assistente.dia(e.sold_at) AS data_venda,
  assistente.dia(e.ipva_expires_at) AS vencimento_ipva
FROM public.equipment e
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
LEFT JOIN public.equipment_models em ON em.id = e.equipment_model_id
LEFT JOIN public.companies co ON co.id = e.company_id
LEFT JOIN public.fleet_current_status fcs ON fcs.equipment_id = e.id
LEFT JOIN LATERAL (SELECT max(assistente.dia(m.reading_date)) AS ultima_leitura FROM public.meter_readings m WHERE m.equipment_id = e.id) lr ON true;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_leituras AS
SELECT m.id AS leitura_id, assistente.dia(m.reading_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(m.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente, m.hours AS horimetro, m.km AS km, m.operator AS operador,
  CASE m.source WHEN 'MANUAL' THEN 'Manual' WHEN 'EXCEL_IMPORT' THEN 'Planilha' WHEN 'QR_CODE' THEN 'QR Code' WHEN 'MAINTENANCE' THEN 'Troca de óleo' ELSE m.source END AS origem,
  m.authorized_regression AS regressao_autorizada, m.notes AS observacao
FROM public.meter_readings m
JOIN public.equipment e ON e.id = m.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(m.service_front_id, e.service_front_id);
--> statement-breakpoint
-- Situação de cada plano ativo, com a MESMA regra de lib/maintenance-engine.ts:calculatePlanState.
CREATE OR REPLACE VIEW assistente.v_trocas_oleo AS
WITH cfg AS (
  SELECT coalesce((SELECT alerta_horas_amarelo_fim FROM public.system_settings WHERE id = 1), 100) AS aviso_horas,
         coalesce((SELECT alerta_km_amarelo_fim FROM public.system_settings WHERE id = 1), 2000) AS aviso_km,
         coalesce((SELECT urgency_percent FROM public.system_settings WHERE id = 1), 20) AS urgencia
), p AS (
  SELECT p.*, e.prefix, e.type AS equipment_type, e.service_front_id, e.current_hours, e.current_km, mt.name AS servico,
    CASE WHEN p.trigger_mode IN ('KM', 'KM_OR_TIME') THEN 'KM' WHEN p.trigger_mode IN ('HOURS', 'HOURS_OR_TIME') THEN 'HOURS'
         WHEN p.interval_km IS NOT NULL THEN 'KM' ELSE 'HOURS' END AS unidade
  FROM public.maintenance_plans p
  JOIN public.equipment e ON e.id = p.equipment_id
  JOIN public.maintenance_types mt ON mt.id = p.maintenance_type_id
  WHERE p.active AND e.sold_at IS NULL AND e.oil_change_enabled
), v AS (
  SELECT p.*,
    CASE WHEN p.unidade = 'KM' THEN p.current_km ELSE p.current_hours END AS atual,
    CASE WHEN p.unidade = 'KM' THEN p.interval_km ELSE p.interval_hours END AS intervalo,
    CASE WHEN p.unidade = 'KM' THEN p.last_km ELSE p.last_hours END AS ultima,
    coalesce(CASE WHEN p.unidade = 'KM' THEN p.next_km ELSE p.next_hours END,
      (CASE WHEN p.unidade = 'KM' THEN p.last_km ELSE p.last_hours END) + (CASE WHEN p.unidade = 'KM' THEN p.interval_km ELSE p.interval_hours END)) AS proxima
  FROM p
)
SELECT v.id AS plano_id, v.equipment_id AS equipamento_id, v.prefix AS equipamento, v.equipment_type AS tipo_equipamento,
  v.service_front_id AS frente_id, sf.name AS frente, v.servico,
  CASE v.unidade WHEN 'KM' THEN 'km' ELSE 'h' END AS unidade,
  v.atual AS leitura_atual, v.ultima AS ultima_troca_leitura, assistente.dia(v.last_date) AS ultima_troca_data, v.intervalo,
  v.proxima AS proxima_troca_leitura,
  CASE WHEN v.intervalo > 0 AND v.proxima IS NOT NULL THEN v.proxima - v.atual END AS faltam,
  CASE WHEN v.intervalo > 0 AND v.proxima IS NOT NULL THEN greatest(0, v.atual - v.proxima) END AS vencida_ha,
  CASE
    WHEN NOT (coalesce(v.intervalo, 0) > 0) THEN 'Sem plano'
    WHEN v.proxima IS NULL THEN 'Sem histórico'
    WHEN v.proxima - v.atual < 0 AND v.atual - v.proxima > v.intervalo * greatest(0, cfg.urgencia) / 100 THEN 'Vencida (urgente)'
    WHEN v.proxima - v.atual < 0 THEN 'Vencida'
    WHEN v.proxima - v.atual <= CASE WHEN v.unidade = 'KM' THEN cfg.aviso_km ELSE cfg.aviso_horas END THEN 'Próxima'
    ELSE 'Normal'
  END AS situacao,
  CASE WHEN v.intervalo > 0 AND v.proxima IS NOT NULL THEN greatest(0, least(100, round(((v.proxima - v.atual) / v.intervalo * 100)::numeric))) END AS saude_percentual
FROM v CROSS JOIN cfg
LEFT JOIN public.service_fronts sf ON sf.id = v.service_front_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_planos_manutencao AS
SELECT p.id AS plano_id, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento, e.service_front_id AS frente_id, sf.name AS frente,
  mt.name AS servico, mt.category AS categoria,
  CASE p.trigger_mode WHEN 'HOURS' THEN 'Horímetro' WHEN 'KM' THEN 'KM' WHEN 'TIME' THEN 'Tempo' WHEN 'HOURS_OR_TIME' THEN 'Horímetro ou tempo' WHEN 'KM_OR_TIME' THEN 'KM ou tempo' ELSE p.trigger_mode END AS gatilho,
  p.interval_hours AS intervalo_horas, p.interval_km AS intervalo_km, p.interval_days AS intervalo_dias,
  p.last_hours AS ultima_horas, p.last_km AS ultima_km, assistente.dia(p.last_date) AS ultima_data,
  p.next_hours AS proxima_horas, p.next_km AS proxima_km, assistente.dia(p.next_date) AS proxima_data,
  p.oil_type AS tipo_oleo, p.viscosity AS viscosidade, p.brand AS marca_oleo, p.filter_reference AS referencia_filtro,
  p.expected_quantity AS quantidade_prevista, p.notes AS observacao, p.active AS ativo
FROM public.maintenance_plans p
JOIN public.equipment e ON e.id = p.equipment_id
JOIN public.maintenance_types mt ON mt.id = p.maintenance_type_id
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE e.sold_at IS NULL;
--> statement-breakpoint
-- Trocas/manutenções já feitas: as registradas no sistema e o histórico importado de planilhas.
CREATE OR REPLACE VIEW assistente.v_trocas_realizadas AS
SELECT 'S' || m.id AS registro, assistente.dia(m.performed_at) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(m.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente, mt.name AS servico,
  m.hours AS leitura_horimetro, m.km AS leitura_km, m.mechanic AS mecanico, m.work_order AS ordem_servico,
  CASE WHEN m.work_order_id IS NOT NULL THEN 'OS-' || lpad(m.work_order_id::text, 6, '0') END AS os_sistema,
  m.cost AS custo, m.notes AS observacao, 'Sistema' AS origem, false AS data_generica
FROM public.maintenances m
JOIN public.equipment e ON e.id = m.equipment_id
JOIN public.maintenance_types mt ON mt.id = m.maintenance_type_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(m.service_front_id, e.service_front_id)
UNION ALL
SELECT 'H' || h.id, assistente.dia(h.performed_at), e.id, coalesce(e.prefix, h.prefix), e.type, e.service_front_id, sf.name, coalesce(mt.name, h.service),
  CASE WHEN h.control_type = 'HOURS' THEN h.reading_value END, CASE WHEN h.control_type = 'KM' THEN h.reading_value END,
  NULL, NULL, NULL, 0, h.notes, 'Planilha importada (histórico)', h.is_generic_date
FROM public.imported_maintenance_history h
LEFT JOIN public.equipment e ON e.id = h.equipment_id
LEFT JOIN public.maintenance_types mt ON mt.id = h.maintenance_type_id
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_alertas AS
SELECT a.id AS alerta_id, assistente.dia(a.generated_at) AS gerado_em, e.id AS equipamento_id, e.prefix AS equipamento, e.service_front_id AS frente_id, sf.name AS frente,
  mt.name AS servico,
  CASE a.level WHEN 'NEAR' THEN 'Urgente' WHEN 'OVERDUE' THEN 'Vencida' WHEN 'WARNING' THEN 'Atenção' WHEN 'CRITICAL' THEN 'Crítico' ELSE 'Normal' END AS nivel,
  CASE a.status WHEN 'OPEN' THEN 'Aberto' WHEN 'ACKNOWLEDGED' THEN 'Visto' ELSE 'Fechado' END AS situacao,
  CASE a.control_type WHEN 'KM' THEN 'km' ELSE 'h' END AS unidade,
  a.current_value AS leitura_atual, a.planned_value AS leitura_prevista, a.remaining_value AS faltam, a.overdue_value AS vencida_ha, a.message AS mensagem
FROM public.alerts a
JOIN public.equipment e ON e.id = a.equipment_id
JOIN public.maintenance_plans p ON p.id = a.plan_id
JOIN public.maintenance_types mt ON mt.id = p.maintenance_type_id
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE a.status <> 'CLOSED' AND e.sold_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_ordens_servico AS
SELECT w.id AS os_id, 'OS-' || lpad(w.id::text, 6, '0') AS numero, assistente.dia(w.opened_at) AS aberta_em, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  w.service_front_id AS frente_id, sf.name AS frente, CASE w.status WHEN 'OPEN' THEN 'Aberta' ELSE 'Fechada' END AS situacao,
  assistente.dia(w.closed_at) AS fechada_em, w.description AS descricao, w.meter_reading AS leitura, CASE w.meter_unit WHEN 'KM' THEN 'km' ELSE 'h' END AS unidade,
  (SELECT string_agg(wm.mechanic_name, ', ' ORDER BY wm.mechanic_name) FROM public.work_order_mechanics wm WHERE wm.work_order_id = w.id) AS mecanicos,
  coalesce(pc.itens, 0) AS pecas_itens, coalesce(pc.valor, 0) AS pecas_valor,
  (SELECT count(*) FROM public.maintenances m WHERE m.work_order_id = w.id) AS trocas_vinculadas,
  CASE WHEN w.status = 'OPEN' THEN (current_date - assistente.dia(w.opened_at)) END AS dias_aberta,
  w.closing_notes AS observacao_fechamento
FROM public.work_orders w
JOIN public.equipment e ON e.id = w.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = w.service_front_id
LEFT JOIN LATERAL (
  SELECT count(*) AS itens, sum(i.quantity * coalesce(i.unit_price, pr.price, 0)) AS valor
  FROM public.work_order_items i JOIN public.products pr ON pr.id = i.product_id
  WHERE i.work_order_id = w.id AND i.removed_at IS NULL
) pc ON true;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_pneus_baterias AS
SELECT c.id AS item_id, CASE c.kind WHEN 'TIRE' THEN 'Pneu' ELSE 'Bateria' END AS tipo, c.code AS numero, c.brand AS marca, c.model AS modelo, c.size AS medida,
  CASE c.status WHEN 'STOCK' THEN 'Em estoque' WHEN 'MOUNTED' THEN 'Montado' ELSE 'Descartado' END AS situacao,
  e.id AS equipamento_id, e.prefix AS equipamento, e.service_front_id AS frente_id, sf.name AS frente, c.position AS posicao, assistente.dia(c.mounted_at) AS montado_em,
  c.usage_km AS uso_km, c.usage_hours AS uso_horas, c.expected_life AS vida_esperada, c.recap_count AS recapagens, c.last_tread_depth AS ultimo_sulco_mm,
  assistente.dia(c.purchase_date) AS data_compra, c.purchase_cost AS custo_compra, c.events_cost AS custo_eventos, c.supplier AS fornecedor, c.warranty_months AS garantia_meses
FROM public.components c
LEFT JOIN public.equipment e ON e.id = c.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE c.deleted_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_status_frota AS
SELECT e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento, e.service_front_id AS frente_id, sf.name AS frente,
  CASE coalesce(fcs.status, 'OPERATING') WHEN 'OPERATING' THEN 'Operando' WHEN 'STOPPED' THEN 'Parado' WHEN 'MAINTENANCE' THEN 'Em manutenção'
    WHEN 'WAITING_PART' THEN 'Aguardando peça' WHEN 'WAITING_ORDER' THEN 'Aguardando pedido' WHEN 'WAITING_MECHANIC' THEN 'Aguardando mecânico'
    WHEN 'WAITING_EXTERNAL_SERVICE' THEN 'Aguardando serviço externo' WHEN 'READY' THEN 'Liberado / pronto' WHEN 'INACTIVE' THEN 'Inativo' ELSE fcs.status END AS status,
  (coalesce(fcs.status, 'OPERATING') NOT IN ('OPERATING', 'READY', 'INACTIVE')) AS parado,
  assistente.dia(fcs.since_at) AS desde,
  CASE WHEN fcs.since_at ~ '^\d{4}-\d{2}-\d{2}T' THEN round((extract(epoch FROM (now() - fcs.since_at::timestamptz)) / 3600)::numeric, 1) END AS horas_no_status,
  o.reason AS motivo, o.problem_description AS problema, o.location AS local_ocorrencia
FROM public.equipment e
LEFT JOIN public.fleet_current_status fcs ON fcs.equipment_id = e.id
LEFT JOIN public.fleet_occurrences o ON o.id = fcs.active_occurrence_id
LEFT JOIN public.service_fronts sf ON sf.id = e.service_front_id
WHERE e.sold_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_paradas_frota AS
SELECT o.id AS ocorrencia_id, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento, coalesce(o.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente,
  assistente.dia(o.started_at) AS inicio, assistente.dia(coalesce(o.returned_to_operation_at, o.ended_at)) AS fim,
  (coalesce(o.returned_to_operation_at, o.ended_at) IS NULL) AS em_aberto,
  CASE WHEN o.started_at ~ '^\d{4}-\d{2}-\d{2}T' THEN round((extract(epoch FROM (coalesce(nullif(coalesce(o.returned_to_operation_at, o.ended_at), '')::timestamptz, now()) - o.started_at::timestamptz)) / 3600)::numeric, 1) END AS horas_parado,
  o.reason AS motivo, o.problem_description AS problema, o.service_performed AS servico_realizado, o.parts_used AS pecas_usadas, o.location AS local, o.notes AS observacao
FROM public.fleet_occurrences o
JOIN public.equipment e ON e.id = o.equipment_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(o.service_front_id, e.service_front_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_transferencias_equipamentos AS
SELECT t.id AS transferencia_id, assistente.dia(t.transferred_at) AS data, e.id AS equipamento_id, e.prefix AS equipamento,
  t.previous_service_front_id AS frente_origem_id, so.name AS frente_origem, t.new_service_front_id AS frente_id, sd.name AS frente,
  u.name AS transferido_por, t.note AS observacao
FROM public.equipment_transfers t
JOIN public.equipment e ON e.id = t.equipment_id
LEFT JOIN public.service_fronts so ON so.id = t.previous_service_front_id
LEFT JOIN public.service_fronts sd ON sd.id = t.new_service_front_id
LEFT JOIN public.users u ON u.id = t.transferred_by;
--> statement-breakpoint
-- Lançamentos de combustível (sem os excluídos e sem os ajustes de saldo, que só corrigem o saldo).
-- Consumo calculado como lib/third-party-rules.ts:computeConsumption: só entre tanques cheios, com os
-- litros dos parciais acumulados; o 1º abastecimento com leitura e a exceção de leitura viram base.
CREATE OR REPLACE VIEW assistente.v_combustivel_movimentacoes AS
WITH base AS (
  SELECT fm.*,
    CASE WHEN fm.equipment_id IS NOT NULL THEN 'E' || fm.equipment_id WHEN fm.third_party_vehicle_id IS NOT NULL THEN 'V' || fm.third_party_vehicle_id END AS vkey
  FROM public.fuel_movements fm
  WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment
), seq AS (
  SELECT b.id, b.vkey, b.quantity, b.meter_reading, b.full_tank, b.reading_exception, b.movement_date,
    count(b.meter_reading) OVER (PARTITION BY b.vkey ORDER BY b.movement_date, b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS leituras_antes
  FROM base b WHERE b.movement_type = 'SAIDA' AND b.vkey IS NOT NULL
), anc AS (
  SELECT s.*, (s.meter_reading IS NOT NULL AND (s.full_tank OR s.reading_exception OR s.leituras_antes = 0)) AS base_nova FROM seq s
), grp AS (
  SELECT a.*,
    count(*) FILTER (WHERE a.base_nova) OVER (PARTITION BY a.vkey ORDER BY a.movement_date, a.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS grupo,
    count(*) FILTER (WHERE a.base_nova) OVER (PARTITION BY a.vkey ORDER BY a.movement_date, a.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS numero_base
  FROM anc a
), acc AS (
  SELECT g.*, sum(g.quantity) OVER (PARTITION BY g.vkey, g.grupo ORDER BY g.movement_date, g.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS litros_acumulados FROM grp g
), cons AS (
  SELECT c.id, c.litros_acumulados, c.meter_reading - pb.meter_reading AS rodado
  FROM acc c JOIN acc pb ON pb.vkey = c.vkey AND pb.base_nova AND pb.numero_base = c.grupo
  WHERE c.base_nova AND c.full_tank AND NOT c.reading_exception AND c.leituras_antes > 0
), un AS (
  SELECT b.id,
    CASE WHEN b.equipment_id IS NOT NULL THEN coalesce(b.meter_unit, CASE WHEN e.control_type = 'KM' THEN 'KM' ELSE 'HOURS' END)
         WHEN v.id IS NOT NULL THEN CASE v.meter_type WHEN 'KM' THEN 'KM' ELSE 'HOURS' END
         ELSE b.meter_unit END AS unidade
  FROM base b LEFT JOIN public.equipment e ON e.id = b.equipment_id LEFT JOIN public.third_party_vehicles v ON v.id = b.third_party_vehicle_id
)
SELECT b.id AS lancamento_id, assistente.dia(b.movement_date) AS data, b.service_front_id AS frente_id, sf.name AS frente,
  CASE b.stock_location WHEN 'PORTO' THEN 'Porto' ELSE 'Frente' END AS estoque, ft.name AS combustivel,
  CASE b.movement_type WHEN 'ENTRADA' THEN 'Entrada' WHEN 'SAIDA' THEN 'Saída' ELSE 'Transferência' END AS tipo,
  CASE WHEN b.movement_type <> 'SAIDA' THEN NULL WHEN b.equipment_id IS NOT NULL THEN 'Frota JC'
       WHEN b.third_party AND b.third_party_kind = 'PRESTADOR' THEN 'Prestador de serviço' WHEN b.third_party THEN 'Terceiro' ELSE 'Sem veículo' END AS tipo_saida,
  b.destination_front_id AS frente_destino_id, sd.name AS frente_destino,
  CASE WHEN b.movement_type = 'TRANSFERENCIA' THEN CASE coalesce(b.destination_location, 'FRENTE') WHEN 'PORTO' THEN 'Porto' ELSE 'Frente' END END AS estoque_destino,
  e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  v.id AS veiculo_terceiro_id, v.plate AS placa_terceiro, coalesce(tp.name, nullif(b.provider_company, ''), nullif(b.third_party_description, '')) AS empresa,
  coalesce(e.plate, v.plate) AS placa, nullif(b.provider_equipment, '') AS equipamento_prestador,
  b.quantity AS litros, b.unit_price AS valor_litro, CASE WHEN b.movement_type = 'ENTRADA' AND b.unit_price IS NOT NULL THEN b.unit_price * b.quantity END AS valor_entrada,
  b.meter_reading AS leitura, CASE un.unidade WHEN 'KM' THEN 'km' WHEN 'HOURS' THEN 'h' END AS unidade_leitura,
  cons.rodado AS rodado, cons.litros_acumulados AS litros_do_consumo,
  CASE WHEN cons.rodado > 0 AND cons.litros_acumulados > 0 THEN CASE WHEN un.unidade = 'KM' THEN cons.rodado / cons.litros_acumulados ELSE cons.litros_acumulados / cons.rodado END END AS consumo,
  CASE WHEN cons.rodado > 0 AND cons.litros_acumulados > 0 THEN CASE WHEN un.unidade = 'KM' THEN 'km/L' ELSE 'L/h' END END AS unidade_consumo,
  b.full_tank AS tanque_cheio, b.consumption_outlier AS consumo_fora_da_media, b.vehicle_pending AS veiculo_pendente,
  coalesce(emp.name, b.responsible) AS responsavel, b.notes AS observacao,
  CASE WHEN b.import_batch_id IS NOT NULL THEN 'Importação de planilha' WHEN b.import_source IS NOT NULL THEN 'Histórico importado' ELSE 'Lançamento' END AS origem_registro
FROM base b
JOIN un ON un.id = b.id
JOIN public.service_fronts sf ON sf.id = b.service_front_id
JOIN public.fuel_types ft ON ft.id = b.fuel_type_id
LEFT JOIN public.service_fronts sd ON sd.id = b.destination_front_id
LEFT JOIN public.equipment e ON e.id = b.equipment_id
LEFT JOIN public.third_party_vehicles v ON v.id = b.third_party_vehicle_id
LEFT JOIN public.third_parties tp ON tp.id = coalesce(b.third_party_id, v.third_party_id)
LEFT JOIN public.employees emp ON emp.id = b.responsible_employee_id
LEFT JOIN cons ON cons.id = b.id;
--> statement-breakpoint
-- Saldo atual (desde sempre) por frente, estoque (Frente/Porto) e combustível — mesma conta de
-- lib/fuel-rules.ts:computeFuelBalances (ajustes de saldo contam; transferência sai da origem e
-- entra no destino). Inclui o tanque cadastrado e a última medição física.
CREATE OR REPLACE VIEW assistente.v_combustivel_saldos AS
WITH pernas AS (
  SELECT fm.service_front_id AS frente_id, fm.stock_location AS estoque, fm.fuel_type_id,
    CASE WHEN fm.movement_type = 'ENTRADA' THEN fm.quantity ELSE -fm.quantity END AS litros, fm.movement_date
  FROM public.fuel_movements fm WHERE fm.deleted_at IS NULL
  UNION ALL
  SELECT coalesce(fm.destination_front_id, fm.service_front_id), coalesce(fm.destination_location, 'FRENTE'), fm.fuel_type_id, fm.quantity, fm.movement_date
  FROM public.fuel_movements fm WHERE fm.deleted_at IS NULL AND fm.movement_type = 'TRANSFERENCIA'
), saldo AS (
  SELECT frente_id, estoque, fuel_type_id, round(sum(litros)::numeric, 3) AS saldo, max(assistente.dia(movement_date)) AS ultimo
  FROM pernas GROUP BY frente_id, estoque, fuel_type_id
)
SELECT s.frente_id, sf.name AS frente, CASE s.estoque WHEN 'PORTO' THEN 'Porto' ELSE 'Frente' END AS estoque, ft.name AS combustivel,
  s.saldo AS saldo_litros, s.ultimo AS data_ultimo_lancamento, t.capacity_liters AS capacidade_tanque_litros,
  med.measured_at AS data_ultima_medicao, med.measured_liters AS litros_ultima_medicao, med.difference_liters AS diferenca_ultima_medicao
FROM saldo s
JOIN public.service_fronts sf ON sf.id = s.frente_id
JOIN public.fuel_types ft ON ft.id = s.fuel_type_id
LEFT JOIN public.fuel_tanks t ON t.service_front_id = s.frente_id AND t.stock_location = s.estoque AND t.fuel_type_id = s.fuel_type_id AND t.active
LEFT JOIN LATERAL (
  SELECT assistente.dia(m.measured_at) AS measured_at, m.measured_liters, m.difference_liters FROM public.fuel_tank_measurements m
  WHERE m.service_front_id = s.frente_id AND m.stock_location = s.estoque AND m.fuel_type_id = s.fuel_type_id AND m.deleted_at IS NULL
  ORDER BY m.measured_at DESC, m.id DESC LIMIT 1
) med ON true;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_combustivel_medicoes AS
SELECT m.id AS medicao_id, assistente.dia(m.measured_at) AS data, m.service_front_id AS frente_id, sf.name AS frente,
  CASE m.stock_location WHEN 'PORTO' THEN 'Porto' ELSE 'Frente' END AS estoque, ft.name AS combustivel,
  CASE m.method WHEN 'REGUA' THEN 'Régua' ELSE 'Litros' END AS metodo, m.ruler_cm AS regua_cm, m.measured_liters AS litros_medidos,
  m.calculated_liters AS litros_sistema, m.difference_liters AS diferenca_litros, m.tolerance_percent AS tolerancia_percentual,
  (abs(m.difference_liters) <= abs(m.calculated_liters) * m.tolerance_percent / 100) AS dentro_da_tolerancia,
  (m.adjustment_movement_id IS NOT NULL) AS gerou_ajuste, m.notes AS observacao
FROM public.fuel_tank_measurements m
JOIN public.service_fronts sf ON sf.id = m.service_front_id
JOIN public.fuel_types ft ON ft.id = m.fuel_type_id
WHERE m.deleted_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_terceiros AS
SELECT t.id AS terceiro_id, t.name AS empresa,
  CASE t.kind WHEN 'PRESTADOR' THEN 'Prestador de serviço' WHEN 'TERCEIRIZADA' THEN 'Terceirizada' ELSE 'Pessoa física' END AS tipo,
  CASE WHEN t.kind <> 'PESSOA_FISICA' THEN t.document END AS cnpj, t.contact_name AS contato, t.phone AS telefone, t.service_front_id AS frente_principal_id, sf.name AS frente_principal,
  t.active AS ativo, (SELECT count(*) FROM public.third_party_vehicles v WHERE v.third_party_id = t.id AND v.active) AS veiculos_ativos, t.notes AS observacao
FROM public.third_parties t
LEFT JOIN public.service_fronts sf ON sf.id = t.service_front_id;
--> statement-breakpoint
-- Um registro por veículo de terceiro e frente onde ele abasteceu (sem abastecimento: frente vazia).
-- Consumo médio = total rodado ÷ litros (km/L) ou litros ÷ horas (L/h), só com os abastecimentos que
-- têm consumo calculado — igual à tela de Terceiros.
CREATE OR REPLACE VIEW assistente.v_veiculos_terceiros AS
WITH ab AS (
  SELECT c.veiculo_terceiro_id, c.frente_id, c.frente, count(*) AS abastecimentos, sum(c.litros) AS litros,
    sum(c.rodado) FILTER (WHERE c.consumo IS NOT NULL) AS rodado, sum(c.litros_do_consumo) FILTER (WHERE c.consumo IS NOT NULL) AS litros_consumo,
    max(c.data) AS ultimo_abastecimento, max(c.leitura) AS maior_leitura
  FROM assistente.v_combustivel_movimentacoes c WHERE c.tipo = 'Saída' AND c.veiculo_terceiro_id IS NOT NULL
  GROUP BY c.veiculo_terceiro_id, c.frente_id, c.frente
)
SELECT v.id AS veiculo_id, t.id AS terceiro_id, t.name AS empresa,
  CASE t.kind WHEN 'PRESTADOR' THEN 'Prestador de serviço' WHEN 'TERCEIRIZADA' THEN 'Terceirizada' ELSE 'Pessoa física' END AS tipo_empresa,
  v.plate AS placa, v.description AS descricao,
  CASE v.vehicle_type WHEN 'CAMINHAO' THEN 'Caminhão' WHEN 'MAQUINA' THEN 'Máquina' WHEN 'VEICULO_LEVE' THEN 'Veículo leve' ELSE 'Outro' END AS tipo_veiculo,
  CASE v.meter_type WHEN 'KM' THEN 'km' ELSE 'h' END AS medidor, ft.name AS combustivel, v.tank_capacity_liters AS capacidade_tanque_litros,
  v.expected_consumption AS consumo_esperado, v.last_reading AS ultima_leitura_cadastro, v.active AS ativo,
  ab.frente_id, ab.frente, coalesce(ab.abastecimentos, 0) AS abastecimentos, coalesce(ab.litros, 0) AS litros_abastecidos,
  ab.rodado AS rodado_com_consumo, ab.litros_consumo AS litros_com_consumo,
  CASE WHEN ab.rodado > 0 AND ab.litros_consumo > 0 THEN CASE v.meter_type WHEN 'KM' THEN ab.rodado / ab.litros_consumo ELSE ab.litros_consumo / ab.rodado END END AS consumo_medio,
  CASE v.meter_type WHEN 'KM' THEN 'km/L' ELSE 'L/h' END AS unidade_consumo, ab.ultimo_abastecimento
FROM public.third_party_vehicles v
JOIN public.third_parties t ON t.id = v.third_party_id
LEFT JOIN public.fuel_types ft ON ft.id = v.fuel_type_id
LEFT JOIN ab ON ab.veiculo_terceiro_id = v.id;
--> statement-breakpoint
-- Custos e consumo por equipamento da frota, mês e frente: combustível (litros e consumo), peças
-- (saídas de estoque para o equipamento, sem Correção de Estoque) e trocas/manutenções.
CREATE OR REPLACE VIEW assistente.v_custos_consumo AS
WITH comb AS (
  SELECT c.equipamento_id, c.frente_id, date_trunc('month', c.data)::date AS mes, sum(c.litros) AS litros,
    sum(c.rodado) FILTER (WHERE c.consumo IS NOT NULL) AS rodado, sum(c.litros_do_consumo) FILTER (WHERE c.consumo IS NOT NULL) AS litros_consumo
  FROM assistente.v_combustivel_movimentacoes c WHERE c.tipo = 'Saída' AND c.equipamento_id IS NOT NULL
  GROUP BY 1, 2, 3
), pecas AS (
  SELECT sm.equipment_id AS equipamento_id, sm.service_front_id AS frente_id, date_trunc('month', assistente.dia(coalesce(sm.movement_date, sm.created_at)))::date AS mes,
    sum(-sm.delta * coalesce(sm.unit_price, p.price, 0)) AS valor
  FROM public.product_stock_movements sm JOIN public.products p ON p.id = sm.product_id
  WHERE sm.delta < 0 AND sm.reversed_at IS NULL AND sm.equipment_id IS NOT NULL AND sm.history_kind IS DISTINCT FROM 'AJUSTE'
  GROUP BY 1, 2, 3
), man AS (
  SELECT m.equipment_id AS equipamento_id, coalesce(m.service_front_id, e.service_front_id) AS frente_id, date_trunc('month', assistente.dia(m.performed_at))::date AS mes,
    sum(m.cost) AS valor, count(*) AS trocas
  FROM public.maintenances m JOIN public.equipment e ON e.id = m.equipment_id GROUP BY 1, 2, 3
), chaves AS (
  SELECT equipamento_id, frente_id, mes FROM comb UNION SELECT equipamento_id, frente_id, mes FROM pecas UNION SELECT equipamento_id, frente_id, mes FROM man
)
SELECT k.mes, extract(year FROM k.mes)::int AS ano, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento, k.frente_id, sf.name AS frente,
  coalesce(comb.litros, 0) AS litros_combustivel,
  CASE WHEN comb.rodado > 0 AND comb.litros_consumo > 0 THEN CASE WHEN e.control_type = 'KM' THEN comb.rodado / comb.litros_consumo ELSE comb.litros_consumo / comb.rodado END END AS consumo_medio,
  CASE WHEN e.control_type = 'KM' THEN 'km/L' ELSE 'L/h' END AS unidade_consumo,
  coalesce(pecas.valor, 0) AS valor_pecas, coalesce(man.valor, 0) AS valor_manutencoes, coalesce(man.trocas, 0) AS trocas,
  coalesce(pecas.valor, 0) + coalesce(man.valor, 0) AS valor_pecas_e_manutencoes
FROM chaves k
JOIN public.equipment e ON e.id = k.equipamento_id
LEFT JOIN public.service_fronts sf ON sf.id = k.frente_id
LEFT JOIN comb ON comb.equipamento_id = k.equipamento_id AND comb.frente_id IS NOT DISTINCT FROM k.frente_id AND comb.mes = k.mes
LEFT JOIN pecas ON pecas.equipamento_id = k.equipamento_id AND pecas.frente_id IS NOT DISTINCT FROM k.frente_id AND pecas.mes = k.mes
LEFT JOIN man ON man.equipamento_id = k.equipamento_id AND man.frente_id IS NOT DISTINCT FROM k.frente_id AND man.mes = k.mes;
--> statement-breakpoint
-- Produtos com o saldo de cada frente onde estão ativos. Saída média mensal = saídas dos últimos
-- 90 dias ÷ 3 (sem Correção de Estoque e sem ajuste manual); cobertura = saldo ÷ saída média.
CREATE OR REPLACE VIEW assistente.v_produtos AS
WITH saidas AS (
  SELECT sm.product_id, sm.service_front_id, sum(-sm.delta) AS qtd
  FROM public.product_stock_movements sm
  WHERE sm.delta < 0 AND sm.reversed_at IS NULL AND sm.history_kind IS DISTINCT FROM 'AJUSTE' AND sm.source <> 'ADJUSTMENT'
    AND assistente.dia(coalesce(sm.movement_date, sm.created_at)) >= current_date - 90
  GROUP BY 1, 2
)
SELECT p.id AS produto_id, p.tag, p.name AS nome, p.reference AS referencia, p.brand AS marca, su.name AS fornecedor,
  (SELECT string_agg(m.name, ', ' ORDER BY m.name) FROM public.product_equipment_models pem JOIN public.equipment_models m ON m.id = pem.equipment_model_id WHERE pem.product_id = p.id) AS aplicacao,
  p.price AS preco, p.needs_review AS cadastro_para_revisar, p.active AS produto_ativo,
  s.service_front_id AS frente_id, sf.name AS frente, s.quantity AS saldo, s.quantity * p.price AS valor_em_estoque,
  coalesce(sa.qtd, 0) AS saida_90_dias, round((coalesce(sa.qtd, 0) / 3.0)::numeric, 2) AS saida_media_mensal,
  CASE WHEN coalesce(sa.qtd, 0) > 0 THEN round((s.quantity / (sa.qtd / 3.0))::numeric, 1) END AS cobertura_meses,
  CASE WHEN s.quantity < 0 THEN 'Negativo' WHEN s.quantity = 0 THEN 'Zerado'
       WHEN coalesce(sa.qtd, 0) > 0 AND s.quantity < sa.qtd / 3.0 THEN 'Baixo' WHEN coalesce(sa.qtd, 0) = 0 THEN 'Sem saída recente' ELSE 'OK' END AS situacao_estoque
FROM public.product_front_stock s
JOIN public.products p ON p.id = s.product_id
JOIN public.service_fronts sf ON sf.id = s.service_front_id
LEFT JOIN public.suppliers su ON su.id = p.supplier_id
LEFT JOIN saidas sa ON sa.product_id = s.product_id AND sa.service_front_id = s.service_front_id
WHERE s.active;
--> statement-breakpoint
-- Toda entrada/saída de produto (sem as estornadas). tipo: Entrada, Saída, Correção de estoque
-- (AJUSTE do sistema antigo) ou Ajuste de saldo (ajuste manual na ficha). origem diz de onde veio,
-- inclusive "Sistema antigo (importado)"; baixou_estoque = FALSE nas linhas só de histórico.
CREATE OR REPLACE VIEW assistente.v_produtos_movimentacoes AS
SELECT sm.id AS movimento_id, assistente.dia(coalesce(sm.movement_date, sm.created_at)) AS data, sm.service_front_id AS frente_id, sf.name AS frente,
  CASE WHEN sm.history_kind = 'AJUSTE' THEN 'Correção de estoque' WHEN sm.source = 'ADJUSTMENT' THEN 'Ajuste de saldo' WHEN sm.delta > 0 THEN 'Entrada' ELSE 'Saída' END AS tipo,
  CASE sm.source WHEN 'MATERIAL_REQUEST' THEN 'Solicitação de Materiais' WHEN 'PURCHASE' THEN 'Pedido de compra' WHEN 'STOCK_EXIT' THEN 'Movimentação'
    WHEN 'WORK_ORDER' THEN 'Ordem de Serviço' WHEN 'ADJUSTMENT' THEN 'Ajuste manual' WHEN 'HISTORY_IMPORT' THEN 'Sistema antigo (importado)' ELSE sm.source END AS origem,
  CASE sm.source WHEN 'MATERIAL_REQUEST' THEN 'SOL-' || lpad(sm.material_request_id::text, 6, '0') WHEN 'PURCHASE' THEN 'PED-' || lpad(sm.purchase_order_id::text, 6, '0')
    WHEN 'STOCK_EXIT' THEN 'SAI-' || lpad(sm.stock_exit_id::text, 6, '0') WHEN 'WORK_ORDER' THEN 'OS-' || lpad(sm.work_order_id::text, 6, '0')
    WHEN 'HISTORY_IMPORT' THEN 'IMP-' || sm.import_batch_id END AS documento,
  p.id AS produto_id, p.tag, p.name AS produto, abs(sm.delta) AS quantidade, (sm.delta > 0) AS e_entrada,
  coalesce(sm.unit_price, p.price) AS valor_unitario, abs(sm.delta) * coalesce(sm.unit_price, p.price, 0) AS valor_total,
  e.id AS equipamento_id, coalesce(e.prefix, sm.equipment_text) AS equipamento,
  tp.name AS terceiro, coalesce(emp.name, sm.employee_text, wi.withdrawn_by, se.received_by) AS colaborador,
  coalesce(d.name, CASE WHEN sm.history_kind = 'AJUSTE' THEN NULL ELSE sm.department_text END) AS departamento,
  CASE WHEN sm.history_kind = 'AJUSTE' THEN NULL ELSE sm.department_text END AS departamento_planilha,
  sm.destination_text AS local_destino, sm.owner_text AS proprietario_equipamento, wi.application AS aplicacao_peca,
  (sm.origin = 'IMPORTACAO_SISTEMA_ANTIGO') AS importado_sistema_antigo, sm.affects_balance AS baixou_estoque,
  CASE WHEN sm.source = 'WORK_ORDER' THEN CASE wo.status WHEN 'OPEN' THEN 'Aberta' ELSE 'Fechada' END END AS situacao_os, sm.reason AS motivo
FROM public.product_stock_movements sm
JOIN public.products p ON p.id = sm.product_id
JOIN public.service_fronts sf ON sf.id = sm.service_front_id
LEFT JOIN public.equipment e ON e.id = sm.equipment_id
LEFT JOIN public.employees emp ON emp.id = sm.employee_id
LEFT JOIN public.departments d ON d.id = sm.department_id
LEFT JOIN public.stock_exits se ON se.id = sm.stock_exit_id
LEFT JOIN public.third_parties tp ON tp.id = se.third_party_id
LEFT JOIN public.work_order_items wi ON wi.id = sm.work_order_item_id
LEFT JOIN public.work_orders wo ON wo.id = sm.work_order_id
WHERE sm.reversed_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_solicitacoes_materiais AS
SELECT r.id AS solicitacao_id, 'SOL-' || lpad(r.id::text, 6, '0') AS numero, assistente.dia(r.requested_at) AS data, r.service_front_id AS frente_id, sf.name AS frente,
  u.name AS solicitante,
  CASE r.status WHEN 'PENDING' THEN 'Pendente' WHEN 'IN_SEPARATION' THEN 'Em separação' WHEN 'SENT' THEN 'Enviada' WHEN 'PARTIALLY_SENT' THEN 'Enviada parcialmente'
    WHEN 'NOT_FULFILLED' THEN 'Não atendida' ELSE 'Cancelada' END AS situacao,
  i.description AS item, i.reference AS referencia, p.tag AS tag_produto, i.quantity_requested AS quantidade_pedida, i.quantity_sent AS quantidade_enviada, i.fiscal_unit AS unidade,
  CASE i.item_status WHEN 'PENDING' THEN 'Pendente' WHEN 'SENT' THEN 'Enviado' ELSE 'Indisponível' END AS situacao_item,
  assistente.dia(r.shipped_at) AS enviada_em, so.name AS frente_origem_envio
FROM public.material_requests r
JOIN public.material_request_items i ON i.request_id = r.id
LEFT JOIN public.products p ON p.id = i.product_id
LEFT JOIN public.users u ON u.id = r.requester_id
LEFT JOIN public.service_fronts sf ON sf.id = r.service_front_id
LEFT JOIN public.service_fronts so ON so.id = r.origin_service_front_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_pedidos_compra AS
SELECT o.id AS pedido_id, 'PED-' || lpad(o.id::text, 6, '0') AS numero, assistente.dia(coalesce(o.order_date, o.requested_at)) AS data, o.service_front_id AS frente_id, sf.name AS frente,
  coalesce(o.requester_name, u.name) AS solicitante, coalesce(d.name, o.department) AS departamento, o.title AS titulo,
  CASE o.urgency WHEN 'BAIXA' THEN 'Baixa' WHEN 'ALTA' THEN 'Alta' WHEN 'URGENTE' THEN 'Urgente' ELSE 'Normal' END AS urgencia,
  CASE o.status WHEN 'AGUARDANDO_APROVACAO' THEN 'Aguardando aprovação' WHEN 'RECUSADO' THEN 'Recusado' WHEN 'EM_COTACAO' THEN 'Aprovado / Em cotação'
    WHEN 'ANALISE_PAGAMENTO' THEN 'Análise de pagamento' WHEN 'PAGO' THEN 'Pago' WHEN 'ENVIADO' THEN 'Enviado' WHEN 'RECEBIDO' THEN 'Recebido'
    WHEN 'CANCELADO' THEN 'Cancelado' ELSE 'Em andamento' END AS situacao_pedido,
  i.description AS item, p.tag AS tag_produto, coalesce(i.received_quantity, i.quantity) AS quantidade, i.fiscal_unit AS unidade,
  CASE i.status WHEN 'AGUARDANDO_APROVACAO' THEN 'Aguardando aprovação' WHEN 'RECUSADO' THEN 'Recusado' WHEN 'EM_COTACAO' THEN 'Aprovado / Em cotação'
    WHEN 'ANALISE_PAGAMENTO' THEN 'Análise de pagamento' WHEN 'PAGO' THEN 'Pago' WHEN 'ENVIADO' THEN 'Enviado' WHEN 'RECEBIDO' THEN 'Recebido'
    WHEN 'REMOVIDO' THEN 'Removido na cotação' ELSE 'Cancelado' END AS situacao_item,
  coalesce(i.received_unit_price, i.unit_price) AS valor_unitario, coalesce(i.received_quantity, i.quantity) * coalesce(i.received_unit_price, i.unit_price) AS valor_total,
  coalesce(rs.name, s.name) AS fornecedor, coalesce(i.received_brand, i.brand) AS marca, e.prefix AS equipamento,
  assistente.dia(coalesce(i.paid_at, o.paid_at)) AS pago_em, assistente.dia(coalesce(i.received_at, o.received_at)) AS recebido_em
FROM public.purchase_orders o
JOIN public.purchase_order_items i ON i.order_id = o.id
LEFT JOIN public.products p ON p.id = i.product_id
LEFT JOIN public.users u ON u.id = o.requester_id
LEFT JOIN public.departments d ON d.id = o.department_id
LEFT JOIN public.suppliers s ON s.id = i.supplier_id
LEFT JOIN public.suppliers rs ON rs.id = i.received_supplier_id
LEFT JOIN public.equipment e ON e.id = o.equipment_id
JOIN public.service_fronts sf ON sf.id = o.service_front_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_fornecedores AS
SELECT s.id AS fornecedor_id, s.name AS fornecedor, s.cnpj, s.phone AS telefone, s.email, s.active AS ativo FROM public.suppliers s;
--> statement-breakpoint
-- Funcionários (sem CPF, data de nascimento e salário).
CREATE OR REPLACE VIEW assistente.v_funcionarios AS
SELECT f.id AS funcionario_id, f.name AS nome, f.job_title AS funcao, f.company AS empresa, assistente.dia(f.admission_date) AS admissao, f.service_front_id AS frente_id, sf.name AS frente,
  CASE f.status WHEN 'ATIVO' THEN 'Ativo' WHEN 'FOLGA' THEN 'De folga' WHEN 'AFASTADO' THEN 'Afastado' ELSE 'Demitido' END AS situacao,
  f.registration AS matricula, f.city AS cidade, f.cycle_work_days AS ciclo_dias_trabalho, f.cycle_off_days AS ciclo_dias_folga
FROM public.employees f
JOIN public.service_fronts sf ON sf.id = f.service_front_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_ausencias_funcionarios AS
SELECT a.id AS ausencia_id, f.id AS funcionario_id, f.name AS funcionario, f.service_front_id AS frente_id, sf.name AS frente,
  CASE a.kind WHEN 'FOLGA' THEN 'Folga' WHEN 'FERIAS' THEN 'Férias' WHEN 'ATESTADO' THEN 'Atestado médico' WHEN 'AFASTAMENTO' THEN 'Afastamento' ELSE 'Outro' END AS tipo,
  assistente.dia(a.start_date) AS inicio, assistente.dia(a.end_date) AS fim, (a.end_date IS NULL) AS em_aberto, a.notes AS observacao
FROM public.employee_absences a
JOIN public.employees f ON f.id = a.employee_id
JOIN public.service_fronts sf ON sf.id = f.service_front_id;
--> statement-breakpoint
-- Tarefas (sem as excluídas). O servidor mostra a quem não é ADMIN só as tarefas em que a pessoa é
-- responsável ou criadora (responsavel_id / criado_por_id).
CREATE OR REPLACE VIEW assistente.v_tarefas AS
SELECT t.id AS tarefa_id, t.title AS titulo, t.description AS descricao, t.assignee_id AS responsavel_id, ua.name AS responsavel, t.created_by AS criado_por_id, uc.name AS criado_por,
  CASE t.urgency WHEN 'LOW' THEN 'Baixa' WHEN 'HIGH' THEN 'Alta' WHEN 'URGENT' THEN 'Urgente' ELSE 'Média' END AS urgencia,
  assistente.dia(t.due_date) AS prazo,
  CASE t.status WHEN 'TODO' THEN CASE WHEN t.viewed_at IS NOT NULL THEN 'Visualizada' ELSE 'Pendente' END WHEN 'IN_PROGRESS' THEN 'Em andamento'
    WHEN 'AWAITING_COMPLETION_APPROVAL' THEN 'Aguardando aprovação da conclusão' WHEN 'AWAITING_NOT_DONE_AUTHORIZATION' THEN 'Aguardando autorização para não realizar'
    WHEN 'DONE' THEN 'Concluída' WHEN 'NOT_DONE' THEN 'Não realizada' ELSE 'Cancelada' END AS situacao,
  (t.status IN ('TODO', 'IN_PROGRESS', 'AWAITING_COMPLETION_APPROVAL', 'AWAITING_NOT_DONE_AUTHORIZATION')) AS aberta,
  (t.status IN ('TODO', 'IN_PROGRESS', 'AWAITING_COMPLETION_APPROVAL', 'AWAITING_NOT_DONE_AUTHORIZATION') AND assistente.dia(t.due_date) < current_date) AS atrasada,
  assistente.dia(t.created_at) AS criada_em, assistente.dia(t.completed_at) AS concluida_em, t.parent_task_id AS tarefa_principal_id
FROM public.tasks t
LEFT JOIN public.users ua ON ua.id = t.assignee_id
LEFT JOIN public.users uc ON uc.id = t.created_by
WHERE t.deleted_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_controle_diario AS
SELECT d.id AS registro_id, assistente.dia(d.record_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  coalesce(d.service_front_id, d.official_service_front_id) AS frente_id, sf.name AS frente, coalesce(nullif(d.operator_name, ''), u.name) AS operador,
  d.worked_today AS trabalhou, d.no_work_reason AS motivo_sem_trabalho, CASE d.reading_unit WHEN 'KM' THEN 'km' ELSE 'h' END AS unidade,
  d.start_reading AS leitura_inicial, d.end_reading AS leitura_final, CASE WHEN d.end_reading >= d.start_reading THEN d.end_reading - d.start_reading END AS trabalhado,
  (SELECT coalesce(sum(f.liters), 0) FROM public.daily_record_fuelings f WHERE f.daily_record_id = d.id) AS litros_abastecidos,
  (SELECT count(*) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id) AS viagens,
  (SELECT coalesce(sum(t.logs_quantity), 0) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id) AS toras,
  (SELECT sum(t.meters) FROM public.daily_record_trips t WHERE t.daily_record_id = d.id) AS metros,
  CASE d.production_type WHEN 'BALDEIO' THEN 'Baldeio' WHEN 'PORTO' THEN 'Porto' END AS producao, d.had_production AS teve_producao,
  d.inactive_or_problem AS teve_problema, d.problem_reason AS problema, d.manual_entry AS lancado_por_terceiro, d.location AS local, d.notes AS observacao
FROM public.daily_records d
JOIN public.equipment e ON e.id = d.equipment_id
LEFT JOIN public.users u ON u.id = d.user_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(d.service_front_id, d.official_service_front_id);
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_checklists AS
SELECT c.id AS checklist_id, assistente.dia(c.checklist_date) AS data, e.id AS equipamento_id, e.prefix AS equipamento, coalesce(c.service_front_id, e.service_front_id) AS frente_id, sf.name AS frente,
  coalesce(nullif(c.operator_name, ''), u.name) AS operador, CASE c.status WHEN 'OK' THEN 'OK' WHEN 'PENDENCIA' THEN 'Pendência' ELSE 'Bloqueado' END AS situacao,
  c.failed_items AS itens_nao_ok,
  (SELECT string_agg(a.label, '; ' ORDER BY a.id) FROM public.checklist_answers a WHERE a.submission_id = c.id AND NOT a.ok) AS itens_com_problema,
  CASE WHEN c.work_order_id IS NOT NULL THEN 'OS-' || lpad(c.work_order_id::text, 6, '0') END AS ordem_servico, c.meter_reading AS leitura, c.notes AS observacao
FROM public.checklist_submissions c
JOIN public.equipment e ON e.id = c.equipment_id
LEFT JOIN public.users u ON u.id = c.user_id
LEFT JOIN public.service_fronts sf ON sf.id = coalesce(c.service_front_id, e.service_front_id);
--> statement-breakpoint
-- Pendências de dados (mesmos grupos da tela Pendências, menos usuários parados).
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
WHERE v.active AND t.active AND (v.tank_capacity_liters IS NULL OR v.expected_consumption IS NULL);
--> statement-breakpoint
-- Usuários do sistema (só ADMIN consulta): sem senha, hash, código de acesso e sessões.
CREATE OR REPLACE VIEW assistente.v_usuarios AS
SELECT u.id AS usuario_id, u.name AS nome, u.username AS usuario, u.email,
  CASE u.role WHEN 'ADMIN' THEN 'Administrador' WHEN 'GESTOR' THEN 'Gestor' WHEN 'CAMPO' THEN 'Campo' ELSE 'Usuário (' || u.role || ')' END AS perfil,
  CASE u.status WHEN 'ACTIVE' THEN 'Ativo' ELSE 'Inativo' END AS situacao, sf.name AS frente_principal, u.all_service_fronts AS todas_as_frentes,
  (SELECT string_agg(f.name, ', ' ORDER BY f.name) FROM public.user_service_fronts usf JOIN public.service_fronts f ON f.id = usf.service_front_id WHERE usf.user_id = u.id) AS frentes,
  tr.name AS cargo_tarefas, u.job_title AS funcao, assistente.dia(u.last_access_at) AS ultimo_acesso
FROM public.users u
LEFT JOIN public.service_fronts sf ON sf.id = u.service_front_id
LEFT JOIN public.task_roles tr ON tr.id = u.task_role_id;
--> statement-breakpoint
-- Ninguém além do papel do assistente lê o schema (nem o PUBLIC, nem os papéis da API do Supabase).
REVOKE ALL ON SCHEMA assistente FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA assistente FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE papel text;
BEGIN
  FOREACH papel IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = papel) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA assistente FROM %I', papel);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA assistente FROM %I', papel);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Papel somente leitura do assistente. Sem senha aqui: sem LOGIN até o ADMIN definir a senha.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    CREATE ROLE assistente_leitura NOLOGIN;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA assistente TO assistente_leitura';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  EXECUTE 'GRANT EXECUTE ON FUNCTION assistente.dia(text) TO assistente_leitura';
  EXECUTE 'GRANT EXECUTE ON FUNCTION assistente.chave(text) TO assistente_leitura';
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM assistente_leitura';
  EXECUTE 'ALTER ROLE assistente_leitura SET default_transaction_read_only = on';
  EXECUTE 'ALTER ROLE assistente_leitura SET statement_timeout = ''20s''';
  EXECUTE 'ALTER ROLE assistente_leitura SET search_path = assistente';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para criar/configurar o papel assistente_leitura: crie-o no SQL Editor do Supabase (docs/assistente-banco.md).';
END $$;
