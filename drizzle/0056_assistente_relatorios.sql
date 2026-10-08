-- Menu RELATÓRIOS no Assistente JC (parte 3c):
-- * v_outros_gastos: os Outros gastos (serviço/mão de obra e outros) lançados em RELATÓRIOS → Custos.
-- * v_custos_consumo: o custo da troca de óleo passa a contar uma vez por troca (o "Custo total" é
--   gravado em cada item da mesma troca e somava em dobro), como no relatório Custos e Consumo.
CREATE OR REPLACE VIEW assistente.v_outros_gastos AS
SELECT o.id AS gasto_id, assistente.dia(o.expense_date) AS data, o.service_front_id AS frente_id, sf.name AS frente,
  e.id AS equipamento_id, e.prefix AS equipamento, e.type AS tipo_equipamento,
  CASE o.category WHEN 'SERVICO' THEN 'Serviço / mão de obra' ELSE 'Outros' END AS categoria,
  o.amount AS valor, o.description AS descricao, u.name AS lancado_por
FROM public.other_expenses o
JOIN public.service_fronts sf ON sf.id = o.service_front_id
LEFT JOIN public.equipment e ON e.id = o.equipment_id
LEFT JOIN public.users u ON u.id = o.created_by
WHERE o.deleted_at IS NULL;
--> statement-breakpoint
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
  -- O "Custo total" da troca é gravado em cada item da mesma troca: o valor conta uma vez por troca.
  SELECT m.equipment_id AS equipamento_id, coalesce(m.service_front_id, e.service_front_id) AS frente_id, date_trunc('month', assistente.dia(m.performed_at))::date AS mes,
    sum(m.cost) FILTER (WHERE m.primeira) AS valor, count(*) AS trocas
  FROM (SELECT mm.*, row_number() OVER (PARTITION BY mm.equipment_id, mm.performed_at, mm.work_order, mm.created_at, mm.cost ORDER BY mm.id) = 1 AS primeira FROM public.maintenances mm) m
  JOIN public.equipment e ON e.id = m.equipment_id GROUP BY 1, 2, 3
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
LEFT JOIN man ON man.equipamento_id = k.equipamento_id AND man.frente_id IS NOT DISTINCT FROM k.frente_id AND man.mes = k.mes;;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistente_leitura') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistente TO assistente_leitura';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Sem permissão para conceder SELECT ao papel assistente_leitura.';
END $$;
