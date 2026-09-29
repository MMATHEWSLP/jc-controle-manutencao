import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Auditoria de dados SOMENTE LEITURA: roda dentro de uma transação READ ONLY (o Postgres recusa
// qualquer INSERT/UPDATE/DELETE) e termina com ROLLBACK. Lista contagens e exemplos de problemas de
// dados (órfãos, duplicados, leituras que diminuem, saídas com veículo genérico, índices faltando...).
// Uso: node auditoria-banco.mjs
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não encontrada no ambiente."); process.exit(1); }
const linha = () => console.log("-".repeat(100));
const EXEMPLOS = 12;

const checks = [
  ["Contagem de linhas por tabela (estimada)", `SELECT relname AS tabela, n_live_tup AS linhas, seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY n_live_tup DESC`, 80],
  ["Tabelas grandes lidas mais por varredura completa do que por índice", `SELECT relname AS tabela, n_live_tup AS linhas, seq_scan, seq_tup_read, idx_scan FROM pg_stat_user_tables
    WHERE n_live_tup > 1000 AND seq_scan > coalesce(idx_scan,0) ORDER BY seq_tup_read DESC`],
  ["Colunas com chave estrangeira sem índice", `SELECT c.conrelid::regclass AS tabela, a.attname AS coluna
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND array_length(c.conkey,1)=1 AND c.connamespace='public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indkey[0]=c.conkey[1])
    ORDER BY 1,2`, 200],
  ["Chaves estrangeiras não validadas (NOT VALID)", `SELECT conrelid::regclass AS tabela, conname FROM pg_constraint WHERE contype='f' AND NOT convalidated`],
  ["Migrações aplicadas (últimas)", `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5`],
  ["Resto de teste automatizado (frentes 'TESTE A/B ...')", `SELECT id,name,created_at FROM service_fronts WHERE name ~ '^TESTE [AB] '`],

  // Equipamentos
  ["Equipamentos ativos sem frente", `SELECT id,prefix,type,status FROM equipment WHERE service_front_id IS NULL AND sold_at IS NULL ORDER BY prefix`],
  ["Equipamentos com prefixo duplicado", `SELECT upper(trim(prefix)) AS prefixo, count(*), string_agg(id::text, ',') FROM equipment GROUP BY 1 HAVING count(*)>1`],
  ["Equipamentos com código duplicado", `SELECT upper(trim(code)) AS codigo, count(*), string_agg(prefix, ',') FROM equipment GROUP BY 1 HAVING count(*)>1`],
  ["Placas duplicadas", `SELECT upper(regexp_replace(plate,'[^A-Za-z0-9]','','g')) AS placa, count(*), string_agg(prefix, ',') FROM equipment WHERE coalesce(plate,'')<>'' GROUP BY 1 HAVING count(*)>1`],
  ["Equipamentos sem marca/modelo/tipo preenchidos", `SELECT id,prefix,type,brand,model FROM equipment WHERE trim(coalesce(brand,''))='' OR trim(coalesce(model,''))='' OR trim(coalesce(type,''))=''`],
  ["Equipamentos sem sort_key (ordem alfabética)", `SELECT id,prefix FROM equipment WHERE coalesce(sort_key,'')=''`],
  ["Equipamentos sem QR token", `SELECT count(*) FROM equipment WHERE coalesce(qr_token,'')='' AND sold_at IS NULL`],
  ["Equipamentos com leitura atual zerada (controle por horas/km)", `SELECT id,prefix,control_type,current_hours,current_km FROM equipment WHERE sold_at IS NULL
    AND ((control_type IN ('HOURS','HOURS_KM') AND current_hours=0) OR (control_type='KM' AND current_km=0)) ORDER BY prefix`],
  ["Validade de IPVA vencida (equipamentos com placa)", `SELECT prefix,plate,ipva_expires_at FROM equipment WHERE ipva_expires_at IS NOT NULL AND ipva_expires_at < to_char(now(),'YYYY-MM-DD') AND sold_at IS NULL`],

  // Leituras
  ["Leituras de horímetro que diminuem (sem regressão autorizada)", `SELECT * FROM (SELECT e.prefix, m.id, m.reading_date, m.hours, lag(m.hours) OVER w AS anterior, m.source, m.authorized_regression
      FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WHERE m.hours IS NOT NULL WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
    WHERE hours < anterior AND NOT authorized_regression ORDER BY prefix, reading_date`],
  ["Leituras de KM que diminuem (sem regressão autorizada)", `SELECT * FROM (SELECT e.prefix, m.id, m.reading_date, m.km, lag(m.km) OVER w AS anterior, m.source, m.authorized_regression
      FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WHERE m.km IS NOT NULL WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
    WHERE km < anterior AND NOT authorized_regression ORDER BY prefix, reading_date`],
  ["Saltos absurdos de horímetro (> 24 h por dia desde a leitura anterior, ou > 2.000 h)", `SELECT * FROM (SELECT e.prefix, m.id, m.reading_date, m.hours, lag(m.hours) OVER w AS anterior, lag(m.reading_date) OVER w AS data_anterior
      FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WHERE m.hours IS NOT NULL WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
    WHERE hours - anterior > greatest(2000, 24 * greatest(1, (left(reading_date,10)::date - left(data_anterior,10)::date))) ORDER BY prefix`],
  ["Saltos absurdos de KM (> 1.500 km por dia desde a leitura anterior)", `SELECT * FROM (SELECT e.prefix, m.id, m.reading_date, m.km, lag(m.km) OVER w AS anterior, lag(m.reading_date) OVER w AS data_anterior
      FROM meter_readings m JOIN equipment e ON e.id=m.equipment_id WHERE m.km IS NOT NULL WINDOW w AS (PARTITION BY m.equipment_id ORDER BY m.reading_date, m.id)) x
    WHERE km - anterior > 1500 * greatest(1, (left(reading_date,10)::date - left(data_anterior,10)::date)) ORDER BY prefix`],
  ["Leituras com data inválida ou no futuro", `SELECT id,equipment_id,reading_date FROM meter_readings WHERE reading_date !~ '^\\d{4}-\\d{2}-\\d{2}' OR left(reading_date,10) > to_char(now() + interval '1 day','YYYY-MM-DD')`],
  ["Leitura atual do equipamento diferente da maior leitura registrada", `SELECT e.prefix, e.control_type, e.current_hours, max(m.hours) AS maior_hora, e.current_km, max(m.km) AS maior_km
    FROM equipment e JOIN meter_readings m ON m.equipment_id=e.id WHERE e.sold_at IS NULL GROUP BY e.id
    HAVING (max(m.hours) IS NOT NULL AND e.control_type IN ('HOURS','HOURS_KM') AND abs(e.current_hours - max(m.hours)) > 0.5)
        OR (max(m.km) IS NOT NULL AND e.control_type IN ('KM','HOURS_KM') AND abs(e.current_km - max(m.km)) > 0.5) ORDER BY e.prefix`],

  // Combustível
  ["Saídas com veículo pendente / genérico (teste, A IDENTIFICAR)", `SELECT count(*) AS saidas, round(sum(quantity)::numeric,2) AS litros,
      count(*) FILTER (WHERE trim(coalesce(responsible,''))='') AS sem_responsavel FROM fuel_movements
    WHERE deleted_at IS NULL AND movement_type='SAIDA' AND (vehicle_pending OR upper(coalesce(imported_vehicle,'')) LIKE '%TESTE%')`],
  ["Lançamentos de combustível com observação 'N/A' ou vazia de sentido", `SELECT movement_type, count(*) FROM fuel_movements WHERE deleted_at IS NULL AND upper(trim(coalesce(notes,''))) IN ('N/A','NA','-','.','0') GROUP BY 1`],
  ["Lançamentos com quantidade <= 0 ou data inválida/futura", `SELECT id,movement_type,movement_date,quantity FROM fuel_movements WHERE deleted_at IS NULL AND NOT balance_adjustment
    AND (quantity <= 0 OR movement_date !~ '^\\d{4}-\\d{2}-\\d{2}$' OR movement_date > to_char(now() + interval '1 day','YYYY-MM-DD'))`],
  ["Saldo de combustível por frente/local (negativo = problema)", `WITH legs AS (
      SELECT service_front_id AS frente, coalesce(stock_location,'FRENTE') AS local, fuel_type_id, CASE WHEN movement_type='ENTRADA' THEN quantity ELSE -quantity END AS delta FROM fuel_movements WHERE deleted_at IS NULL
      UNION ALL SELECT coalesce(destination_front_id,service_front_id), coalesce(destination_location,'FRENTE'), fuel_type_id, quantity FROM fuel_movements WHERE deleted_at IS NULL AND movement_type='TRANSFERENCIA')
    SELECT sf.name AS frente, l.local, ft.name AS combustivel, round(sum(l.delta)::numeric,2) AS saldo FROM legs l JOIN service_fronts sf ON sf.id=l.frente JOIN fuel_types ft ON ft.id=l.fuel_type_id GROUP BY 1,2,3 ORDER BY 4`],
  ["Saídas sem veículo reconhecido (texto importado sem equipamento)", `SELECT coalesce(imported_vehicle,'(vazio)') AS veiculo_importado, count(*), round(sum(quantity)::numeric,1) AS litros FROM fuel_movements
    WHERE deleted_at IS NULL AND movement_type='SAIDA' AND NOT balance_adjustment AND equipment_id IS NULL AND NOT third_party AND NOT vehicle_pending GROUP BY 1 ORDER BY 2 DESC`, 30],
  ["Saídas acima do padrão do equipamento (> 3x a mediana das saídas dele)", `WITH m AS (SELECT equipment_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY quantity) AS mediana, count(*) AS n FROM fuel_movements WHERE deleted_at IS NULL AND movement_type='SAIDA' AND equipment_id IS NOT NULL GROUP BY equipment_id)
    SELECT e.prefix, fm.id, fm.movement_date, fm.quantity, round(m.mediana::numeric,1) AS mediana FROM fuel_movements fm JOIN m ON m.equipment_id=fm.equipment_id JOIN equipment e ON e.id=fm.equipment_id
    WHERE fm.deleted_at IS NULL AND fm.movement_type='SAIDA' AND m.n >= 5 AND fm.quantity > 3*m.mediana ORDER BY fm.quantity/m.mediana DESC`],
  ["Saídas de terceiro acima da capacidade do tanque", `SELECT v.plate, fm.id, fm.movement_date, fm.quantity, v.tank_capacity_liters FROM fuel_movements fm JOIN third_party_vehicles v ON v.id=fm.third_party_vehicle_id
    WHERE fm.deleted_at IS NULL AND v.tank_capacity_liters IS NOT NULL AND fm.quantity > v.tank_capacity_liters`],
  ["Veículos de terceiros sem capacidade de tanque / sem consumo esperado", `SELECT p.name, v.plate, v.tank_capacity_liters, v.expected_consumption FROM third_party_vehicles v JOIN third_parties p ON p.id=v.third_party_id
    WHERE v.active AND (v.tank_capacity_liters IS NULL OR v.expected_consumption IS NULL)`],
  ["Saídas de terceiro sem KM/horímetro", `SELECT p.name, count(*) FROM fuel_movements fm JOIN third_parties p ON p.id=fm.third_party_id WHERE fm.deleted_at IS NULL AND fm.meter_reading IS NULL GROUP BY 1`],
  ["Lançamentos importados com origem não confirmada", `SELECT import_source, count(*) FROM fuel_movements WHERE deleted_at IS NULL AND NOT origin_confirmed GROUP BY 1`],

  // Manutenção
  ["Planos ativos sem próxima troca calculada", `SELECT e.prefix, mt.name FROM maintenance_plans p JOIN equipment e ON e.id=p.equipment_id JOIN maintenance_types mt ON mt.id=p.maintenance_type_id
    WHERE p.active AND e.sold_at IS NULL AND p.next_hours IS NULL AND p.next_km IS NULL AND p.next_date IS NULL ORDER BY e.prefix`],
  ["Planos com última troca em data genérica", `SELECT count(*) FROM maintenance_plans WHERE active AND last_is_generic_date`],
  ["Planos duplicados (mesmo equipamento e tipo)", `SELECT equipment_id, maintenance_type_id, count(*) FROM maintenance_plans GROUP BY 1,2 HAVING count(*)>1`],
  ["Equipamentos com troca de óleo ligada e sem nenhum plano ativo", `SELECT e.prefix FROM equipment e WHERE e.oil_change_enabled AND e.sold_at IS NULL AND NOT EXISTS (SELECT 1 FROM maintenance_plans p WHERE p.equipment_id=e.id AND p.active) ORDER BY e.prefix`],

  // Produtos / estoque
  ["Estoque negativo por frente", `SELECT p.name, sf.name AS frente, s.quantity FROM product_front_stock s JOIN products p ON p.id=s.product_id JOIN service_fronts sf ON sf.id=s.service_front_id WHERE s.quantity < 0`],
  ["Produtos com nome duplicado", `SELECT upper(trim(name)) AS nome, count(*) FROM products GROUP BY 1 HAVING count(*)>1`],
  ["Saldo da tabela de estoque diferente da soma das movimentações (não estornadas)", `WITH mv AS (SELECT product_id, service_front_id, sum(delta) AS soma FROM product_stock_movements WHERE reversed_at IS NULL GROUP BY 1,2)
    SELECT p.name, sf.name AS frente, s.quantity AS saldo, round(coalesce(mv.soma,0)::numeric,3) AS soma_mov FROM product_front_stock s JOIN products p ON p.id=s.product_id JOIN service_fronts sf ON sf.id=s.service_front_id
    LEFT JOIN mv ON mv.product_id=s.product_id AND mv.service_front_id=s.service_front_id WHERE abs(s.quantity - coalesce(mv.soma,0)) > 0.001 ORDER BY 1`],

  // Pessoas / acesso
  ["Funcionários com CPF duplicado", `SELECT regexp_replace(cpf,'\\D','','g') AS cpf, count(*), string_agg(name, ' | ') FROM employees WHERE coalesce(cpf,'')<>'' GROUP BY 1 HAVING count(*)>1`],
  ["Funcionários com nome duplicado (ativos)", `SELECT upper(trim(name)) AS nome, count(*) FROM employees WHERE status<>'DEMITIDO' GROUP BY 1 HAVING count(*)>1`],
  ["Usuários ativos sem frente e sem acesso a todas", `SELECT u.username, u.role FROM users u WHERE u.status='ACTIVE' AND u.service_front_id IS NULL AND NOT u.all_service_fronts
    AND NOT EXISTS (SELECT 1 FROM user_service_fronts x WHERE x.user_id=u.id) AND u.role<>'ADMIN'`],
  ["Usuários por perfil", `SELECT role, hierarchy_level, status, count(*) FROM users GROUP BY 1,2,3 ORDER BY 1,2,3`],
  ["Usuários ativos sem acesso há mais de 60 dias", `SELECT username, role, last_access_at FROM users WHERE status='ACTIVE' AND (last_access_at IS NULL OR last_access_at < to_char(now() - interval '60 days','YYYY-MM-DD'))`],
  ["Sessões vencidas ainda guardadas", `SELECT count(*) FILTER (WHERE expires_at < to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')) AS vencidas, count(*) AS total, min(expires_at), max(expires_at) FROM user_sessions`],
  ["Erros de login (últimos 7 dias)", `SELECT success, count(*) FROM field_login_attempts WHERE attempted_at > to_char(now() - interval '7 days','YYYY-MM-DD') GROUP BY 1`],

  // Tarefas / controle diário
  ["Tarefas por status", `SELECT status, count(*) FILTER (WHERE deleted_at IS NULL) AS ativas, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS excluidas FROM tasks GROUP BY 1`],
  ["Tarefas abertas vencidas há mais de 7 dias", `SELECT count(*) FROM tasks WHERE deleted_at IS NULL AND status IN ('TODO','IN_PROGRESS') AND due_date < to_char(now() - interval '7 days','YYYY-MM-DD')`],
  ["Controle diário: leitura final menor que a inicial", `SELECT dr.id, e.prefix, dr.record_date, dr.start_reading, dr.end_reading FROM daily_records dr JOIN equipment e ON e.id=dr.equipment_id WHERE dr.end_reading < dr.start_reading`],
  ["Controle diário: mais de um registro no mesmo dia para o mesmo equipamento", `SELECT equipment_id, record_date, count(*) FROM daily_records GROUP BY 1,2 HAVING count(*)>1`],
  ["Controle diário: jornada acima de 24 h/1.500 km", `SELECT dr.id, e.prefix, dr.record_date, dr.reading_unit, dr.end_reading - dr.start_reading AS diferenca FROM daily_records dr JOIN equipment e ON e.id=dr.equipment_id
    WHERE (dr.reading_unit='HOURS' AND dr.end_reading - dr.start_reading > 24) OR (dr.reading_unit='KM' AND dr.end_reading - dr.start_reading > 1500)`],

  // Datas em texto com formato fora do padrão
  ["Datas em texto fora do padrão AAAA-MM-DD (várias tabelas)", `SELECT 'tasks.due_date' AS campo, count(*) FROM tasks WHERE due_date !~ '^\\d{4}-\\d{2}-\\d{2}'
    UNION ALL SELECT 'employees.admission_date', count(*) FROM employees WHERE admission_date !~ '^\\d{4}-\\d{2}-\\d{2}'
    UNION ALL SELECT 'daily_records.record_date', count(*) FROM daily_records WHERE record_date !~ '^\\d{4}-\\d{2}-\\d{2}'
    UNION ALL SELECT 'maintenance_plans.next_date', count(*) FROM maintenance_plans WHERE next_date IS NOT NULL AND next_date !~ '^\\d{4}-\\d{2}-\\d{2}'
    UNION ALL SELECT 'equipment.ipva_expires_at', count(*) FROM equipment WHERE ipva_expires_at IS NOT NULL AND ipva_expires_at !~ '^\\d{4}-\\d{2}-\\d{2}'`],

  // WhatsApp / alertas
  ["Envios de WhatsApp por resultado", `SELECT result, trigger_type, count(*), max(sent_at) AS ultimo FROM whatsapp_deliveries GROUP BY 1,2 ORDER BY 1,2`],
  ["Alertas por tipo/status", `SELECT level, status, count(*) FROM alerts GROUP BY 1,2 ORDER BY 1,2`],
];

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = '30s'");
  linha();
  console.log("AUDITORIA DE DADOS — SOMENTE LEITURA (transação READ ONLY, termina em ROLLBACK)");
  for (const [title, query, limit = EXEMPLOS] of checks) {
    linha();
    await client.query("SAVEPOINT s");
    try {
      const { rows } = await client.query(query);
      console.log(`${title}: ${rows.length} linha(s)`);
      for (const row of rows.slice(0, limit)) console.log(`  ${Object.entries(row).map(([key, value]) => `${key}=${value === null ? "∅" : String(value).slice(0, 60)}`).join(" · ")}`);
      if (rows.length > limit) console.log(`  … e mais ${rows.length - limit}`);
      await client.query("RELEASE SAVEPOINT s");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT s");
      console.log(`${title}: NÃO RODOU (${error instanceof Error ? error.message : error})`);
    }
  }
  linha();
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
  await pool.end();
}
