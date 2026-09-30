-- Leituras gravadas com fuso ("…Z" ou "-03:00") passam para a hora local de Fortaleza sem fuso,
-- o mesmo formato dos formulários ("AAAA-MM-DDTHH:MM"), para a ordenação por texto ficar cronológica.
UPDATE "meter_readings"
SET "reading_date" = to_char(("reading_date"::timestamptz) AT TIME ZONE 'America/Fortaleza', 'YYYY-MM-DD"T"HH24:MI')
WHERE "reading_date" ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$';
