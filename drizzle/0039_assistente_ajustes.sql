-- Ajustes do Assistente JC (views de 0038):
-- * v_combustivel_movimentacoes: saída importada sem veículo identificado vira tipo_saida 'Veículo a identificar'
--   (como no Histórico do Combustível) e ganha a coluna veiculo_planilha (texto original da planilha), no fim.
-- * v_produtos: 'Zerado' só para produto com saída nos últimos 90 dias na frente (precisa repor); saldo zero sem
--   uso recente vira 'Zerado sem saída recente'.
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
  CASE WHEN b.import_batch_id IS NOT NULL THEN 'Importação de planilha' WHEN b.import_source IS NOT NULL THEN 'Histórico importado' ELSE 'Lançamento' END AS origem_registro,
  nullif(b.imported_vehicle, '') AS veiculo_planilha
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
  CASE WHEN s.quantity < 0 THEN 'Negativo' WHEN s.quantity = 0 AND coalesce(sa.qtd, 0) > 0 THEN 'Zerado' WHEN s.quantity = 0 THEN 'Zerado sem saída recente'
       WHEN coalesce(sa.qtd, 0) > 0 AND s.quantity < sa.qtd / 3.0 THEN 'Baixo' WHEN coalesce(sa.qtd, 0) = 0 THEN 'Sem saída recente' ELSE 'OK' END AS situacao_estoque
FROM public.product_front_stock s
JOIN public.products p ON p.id = s.product_id
JOIN public.service_fronts sf ON sf.id = s.service_front_id
LEFT JOIN public.suppliers su ON su.id = p.supplier_id
LEFT JOIN saidas sa ON sa.product_id = s.product_id AND sa.service_front_id = s.service_front_id
WHERE s.active;
--> statement-breakpoint
-- Views recriadas mantêm os grants, mas por garantia (e se o papel foi criado depois) repete o SELECT.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para conceder SELECT ao papel assistente_leitura.';
END $$;
