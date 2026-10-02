-- Funcionários de terceiros/prestadores no Assistente JC (migração 0042):
-- * v_combustivel_movimentacoes e v_produtos_movimentacoes ganham, no fim, o destino no terceiro
--   (Veículo / Funcionário), o funcionário do terceiro e (combustível) a finalidade.
-- * v_funcionarios_terceiros: cadastro dos funcionários de cada empresa terceira (sem CPF).
-- * v_terceiros_resumo_mensal: por empresa, mês e frente — combustível e peças em veículos x para funcionários.
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
       WHEN b.vehicle_pending THEN 'Veículo a identificar' WHEN b.third_party AND b.third_party_kind = 'PRESTADOR' THEN 'Prestador de serviço' WHEN b.third_party THEN 'Terceiro' ELSE 'Sem veículo' END AS tipo_saida,
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
  CASE WHEN b.created_via = 'ASSISTENTE' THEN 'Assistente JC' WHEN b.import_batch_id IS NOT NULL THEN 'Importação de planilha' WHEN b.import_source IS NOT NULL THEN 'Histórico importado' ELSE 'Lançamento' END AS origem_registro,
  nullif(b.imported_vehicle, '') AS veiculo_planilha,
  tp.id AS terceiro_id,
  CASE WHEN b.third_party_destination = 'FUNCIONARIO' THEN 'Funcionário' WHEN b.third_party_destination = 'VEICULO' OR b.third_party_vehicle_id IS NOT NULL THEN 'Veículo'
       WHEN b.movement_type = 'SAIDA' AND b.third_party THEN 'Não informado' END AS destino_terceiro,
  te.id AS funcionario_terceiro_id, te.name AS funcionario_terceiro,
  CASE b.purpose WHEN 'MOTOSSERRA' THEN 'Motosserra' WHEN 'GERADOR' THEN 'Gerador' WHEN 'GALAO' THEN 'Galão / reserva' WHEN 'MAQUINA_NAO_CADASTRADA' THEN 'Máquina não cadastrada'
       WHEN 'OUTROS' THEN 'Outros' || coalesce(': ' || nullif(b.purpose_note, ''), '') END AS finalidade
FROM base b
JOIN un ON un.id = b.id
JOIN public.service_fronts sf ON sf.id = b.service_front_id
JOIN public.fuel_types ft ON ft.id = b.fuel_type_id
LEFT JOIN public.service_fronts sd ON sd.id = b.destination_front_id
LEFT JOIN public.equipment e ON e.id = b.equipment_id
LEFT JOIN public.third_party_vehicles v ON v.id = b.third_party_vehicle_id
LEFT JOIN public.third_parties tp ON tp.id = coalesce(b.third_party_id, v.third_party_id)
LEFT JOIN public.employees emp ON emp.id = b.responsible_employee_id
LEFT JOIN public.third_party_employees te ON te.id = b.third_party_employee_id
LEFT JOIN cons ON cons.id = b.id;;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_produtos_movimentacoes AS
SELECT sm.id AS movimento_id, assistente.dia(coalesce(sm.movement_date, sm.created_at)) AS data, sm.service_front_id AS frente_id, sf.name AS frente,
  CASE WHEN sm.history_kind = 'AJUSTE' THEN 'Correção de estoque' WHEN sm.source = 'ADJUSTMENT' THEN 'Ajuste de saldo' WHEN sm.delta > 0 THEN 'Entrada' ELSE 'Saída' END AS tipo,
  CASE WHEN se.created_via = 'ASSISTENTE' THEN 'Movimentação (Assistente JC)' ELSE CASE sm.source WHEN 'MATERIAL_REQUEST' THEN 'Solicitação de Materiais' WHEN 'PURCHASE' THEN 'Pedido de compra' WHEN 'STOCK_EXIT' THEN 'Movimentação'
    WHEN 'WORK_ORDER' THEN 'Ordem de Serviço' WHEN 'ADJUSTMENT' THEN 'Ajuste manual' WHEN 'HISTORY_IMPORT' THEN 'Sistema antigo (importado)' ELSE sm.source END END AS origem,
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
  CASE WHEN sm.source = 'WORK_ORDER' THEN CASE wo.status WHEN 'OPEN' THEN 'Aberta' ELSE 'Fechada' END END AS situacao_os, sm.reason AS motivo,
  se.third_party_id AS terceiro_id, tv.plate AS placa_terceiro,
  CASE WHEN se.third_party_employee_id IS NOT NULL THEN 'Funcionário' WHEN se.third_party_vehicle_id IS NOT NULL THEN 'Veículo' WHEN se.third_party_id IS NOT NULL THEN 'Não informado' END AS destino_terceiro,
  te.id AS funcionario_terceiro_id, te.name AS funcionario_terceiro, se.received_by AS recebido_por
FROM public.product_stock_movements sm
JOIN public.products p ON p.id = sm.product_id
JOIN public.service_fronts sf ON sf.id = sm.service_front_id
LEFT JOIN public.equipment e ON e.id = sm.equipment_id
LEFT JOIN public.employees emp ON emp.id = sm.employee_id
LEFT JOIN public.departments d ON d.id = sm.department_id
LEFT JOIN public.stock_exits se ON se.id = sm.stock_exit_id
LEFT JOIN public.third_parties tp ON tp.id = se.third_party_id
LEFT JOIN public.third_party_vehicles tv ON tv.id = se.third_party_vehicle_id
LEFT JOIN public.third_party_employees te ON te.id = se.third_party_employee_id
LEFT JOIN public.work_order_items wi ON wi.id = sm.work_order_item_id
LEFT JOIN public.work_orders wo ON wo.id = sm.work_order_id
WHERE sm.reversed_at IS NULL;;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_funcionarios_terceiros AS
SELECT f.id AS funcionario_id, t.id AS terceiro_id, t.name AS empresa,
  CASE t.kind WHEN 'PRESTADOR' THEN 'Prestador de serviço' WHEN 'TERCEIRIZADA' THEN 'Terceirizada' ELSE 'Pessoa física' END AS tipo_empresa,
  f.name AS nome, f.job_title AS funcao, f.phone AS telefone, f.active AS ativo, (t.active AND f.active) AS pode_receber
FROM public.third_party_employees f
JOIN public.third_parties t ON t.id = f.third_party_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW assistente.v_terceiros_resumo_mensal AS
WITH comb AS (
  SELECT c.terceiro_id, c.frente_id, date_trunc('month', c.data)::date AS mes,
    sum(c.litros) FILTER (WHERE c.destino_terceiro = 'Veículo') AS litros_em_veiculos,
    sum(c.litros) FILTER (WHERE c.destino_terceiro = 'Funcionário') AS litros_para_funcionarios,
    sum(c.litros) FILTER (WHERE c.destino_terceiro = 'Não informado') AS litros_sem_destino,
    sum(c.litros) FILTER (WHERE c.destino_terceiro = 'Funcionário' AND c.combustivel ILIKE '%diesel%') AS diesel_para_funcionarios,
    sum(c.litros) AS litros_total
  FROM assistente.v_combustivel_movimentacoes c
  WHERE c.tipo = 'Saída' AND c.terceiro_id IS NOT NULL
  GROUP BY 1, 2, 3
), pecas AS (
  SELECT p.terceiro_id, p.frente_id, date_trunc('month', p.data)::date AS mes,
    sum(p.valor_total) FILTER (WHERE p.destino_terceiro = 'Veículo') AS valor_pecas_em_veiculos,
    sum(p.valor_total) FILTER (WHERE p.destino_terceiro = 'Funcionário') AS valor_pecas_para_funcionarios,
    sum(p.valor_total) FILTER (WHERE p.destino_terceiro = 'Não informado') AS valor_pecas_sem_destino,
    sum(p.valor_total) AS valor_pecas_total, sum(p.quantidade) AS quantidade_pecas
  FROM assistente.v_produtos_movimentacoes p
  WHERE p.tipo = 'Saída' AND p.terceiro_id IS NOT NULL
  GROUP BY 1, 2, 3
), chaves AS (
  SELECT terceiro_id, frente_id, mes FROM comb UNION SELECT terceiro_id, frente_id, mes FROM pecas
)
SELECT k.mes, extract(year FROM k.mes)::int AS ano, k.terceiro_id, t.name AS empresa,
  CASE t.kind WHEN 'PRESTADOR' THEN 'Prestador de serviço' WHEN 'TERCEIRIZADA' THEN 'Terceirizada' ELSE 'Pessoa física' END AS tipo_empresa,
  k.frente_id, sf.name AS frente,
  coalesce(c.litros_em_veiculos, 0) AS litros_em_veiculos, coalesce(c.litros_para_funcionarios, 0) AS litros_para_funcionarios,
  coalesce(c.diesel_para_funcionarios, 0) AS diesel_para_funcionarios, coalesce(c.litros_sem_destino, 0) AS litros_sem_destino, coalesce(c.litros_total, 0) AS litros_total,
  coalesce(p.valor_pecas_em_veiculos, 0) AS valor_pecas_em_veiculos, coalesce(p.valor_pecas_para_funcionarios, 0) AS valor_pecas_para_funcionarios,
  coalesce(p.valor_pecas_sem_destino, 0) AS valor_pecas_sem_destino, coalesce(p.valor_pecas_total, 0) AS valor_pecas_total, coalesce(p.quantidade_pecas, 0) AS quantidade_pecas
FROM chaves k
JOIN public.third_parties t ON t.id = k.terceiro_id
JOIN public.service_fronts sf ON sf.id = k.frente_id
LEFT JOIN comb c ON c.terceiro_id = k.terceiro_id AND c.frente_id = k.frente_id AND c.mes = k.mes
LEFT JOIN pecas p ON p.terceiro_id = k.terceiro_id AND p.frente_id = k.frente_id AND p.mes = k.mes;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para conceder SELECT ao papel assistente_leitura.';
END $$;
