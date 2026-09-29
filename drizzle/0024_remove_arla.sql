-- ARLA 32 não é usado: remove o tipo criado pela 0023 (só se nenhum lançamento o usa).
DELETE FROM "fuel_types" WHERE "code"='ARLA_32' AND NOT EXISTS (SELECT 1 FROM "fuel_movements" WHERE "fuel_movements"."fuel_type_id"="fuel_types"."id");
