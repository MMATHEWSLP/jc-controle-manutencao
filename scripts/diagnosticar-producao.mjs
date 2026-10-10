// Diagnóstico (somente leitura) do módulo PRODUÇÃO: confirma no banco real os nomes que o plano
// (docs/producao/PLANO-FASE-0.md) tirou do código — frentes, combustíveis, tipos de equipamento (SK/CM/JL),
// funções e empresas dos funcionários, produtos de consumo, como a gasolina da motosserra é lançada hoje e
// a produção de PORTO do Controle Diário. Só totais e cadastros; nenhum dado pessoal além de função/empresa.
// Uso: DATABASE_URL=... node scripts/diagnosticar-producao.mjs
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
// Mesmos padrões de lib/production-rules.ts (FUNCTION_GROUPS).
const GRUPOS = {
  "Operador de motosserra": "^(OP\\.?|OPERADOR)( DE)? MOTOSSERRA",
  "Ajudante de motosserra": "AJUD.*MOTOSSERRA",
  "Operador de skidder": "SKIDD?ER|ARRASTE",
  Motorista: "^MOT(ORISTA|\\.)",
};

async function main() {
  const client = await pool.connect();
  const q = async (text, values = []) => (await client.query(text, values)).rows;
  const table = (title, rows) => {
    console.log(`\n=== ${title} (${rows.length}) ===`);
    for (const row of rows) console.log(Object.values(row).map((value) => (value === null ? "—" : String(value))).join(" | "));
  };
  try {
    await client.query("BEGIN READ ONLY");
    const migrada = (await q(`SELECT to_regclass('public.production_projects') IS NOT NULL AS ok`))[0].ok;
    console.log(`Migração 0058 (tabelas da Produção) aplicada: ${migrada ? "sim" : "NÃO"}`);
    table("Frentes (id | nome | ativa)", await q(`SELECT id, name, active FROM service_fronts ORDER BY name`));
    table("Combustíveis (id | código | nome | ativo)", await q(`SELECT id, code, name, active FROM fuel_types ORDER BY sort_order, id`));
    table("Tipos de equipamento da frota ativa (tipo | qtd | com placa | exemplos)", await q(`
      SELECT type AS tipo, count(*)::int AS qtd, count(nullif(trim(plate), ''))::int AS com_placa, string_agg(prefix, ', ' ORDER BY sort_key) FILTER (WHERE rn <= 4) AS exemplos
      FROM (SELECT e.*, row_number() OVER (PARTITION BY e.type ORDER BY e.sort_key) AS rn FROM equipment e WHERE e.sold_at IS NULL) x GROUP BY type ORDER BY 2 DESC`));
    table("Empresas dos funcionários (empresa | ativos | total)", await q(`SELECT company AS empresa, count(*) FILTER (WHERE status <> 'DEMITIDO')::int AS ativos, count(*)::int AS total FROM employees GROUP BY company ORDER BY 2 DESC`));
    for (const [nome, padrao] of Object.entries(GRUPOS))
      table(`Funções no grupo "${nome}" (função | ativos)`, await q(`SELECT job_title AS funcao, count(*)::int AS ativos FROM employees WHERE status <> 'DEMITIDO' AND upper(job_title) ~ $1 GROUP BY 1 ORDER BY 2 DESC`, [padrao]));
    table("Funções com MOTOSSERRA/SKIDDER/MOTORISTA fora dos grupos (função | ativos)", await q(`
      SELECT job_title AS funcao, count(*)::int AS ativos FROM employees WHERE status <> 'DEMITIDO' AND upper(job_title) ~ '(MOTOSSERRA|SKID|MOTORISTA|ARRASTE|APONT)'
        AND NOT (upper(job_title) ~ ANY($1)) GROUP BY 1 ORDER BY 2 DESC`, [Object.values(GRUPOS)]));
    table("Produtos parecidos com combustível (tag | nome | ativo) — devem ficar fora da Produção", await q(`
      SELECT tag, name, active FROM products WHERE name ~* '(GASOLINA|DIESEL|OLEO DIESEL|ÓLEO DIESEL)' ORDER BY name LIMIT 30`));
    table("Produtos de consumo da derruba/arraste (tag | nome | preço | ativo)", await q(`
      SELECT tag, name, price, active FROM products WHERE name ~* '(LIMA|CORRENTE|SABRE|2 ?T(EMPOS)?|DOIS TEMPOS|PINHAO|PINHÃO)' ORDER BY name LIMIT 60`));
    table("Gasolina que saiu nos últimos 90 dias, por destino (destino | finalidade | lançamentos | litros)", await q(`
      SELECT CASE WHEN fm.equipment_id IS NOT NULL THEN 'Frota: tipo ' || coalesce(e.type, '?') WHEN fm.third_party THEN coalesce(fm.third_party_kind, 'GERAL') || coalesce(' / ' || fm.third_party_destination, '') ELSE 'Sem destino' END AS destino,
        coalesce(fm.purpose, '—') AS finalidade, count(*)::int AS lancamentos, round(sum(fm.quantity)::numeric, 1) AS litros
      FROM fuel_movements fm JOIN fuel_types ft ON ft.id = fm.fuel_type_id LEFT JOIN equipment e ON e.id = fm.equipment_id
      WHERE fm.deleted_at IS NULL AND NOT fm.balance_adjustment AND fm.movement_type = 'SAIDA' AND ft.code ILIKE 'GASOLINA%' AND fm.movement_date >= to_char(current_date - 90, 'YYYY-MM-DD')
      GROUP BY 1, 2 ORDER BY 4 DESC`));
    table("Controle Diário com produção nos últimos 90 dias (tipo | fichas | viagens | toras | metragem)", await q(`
      SELECT d.production_type AS tipo, count(*)::int AS fichas, coalesce(sum(coalesce(d.total_trips, d.port_trips, d.baldeio_trips)), 0)::int AS viagens, coalesce(sum(d.port_logs), 0)::int AS toras, round(coalesce(sum(d.port_volume_m3), 0)::numeric, 2) AS metragem
      FROM daily_records d WHERE d.had_production AND d.record_date >= to_char(current_date - 90, 'YYYY-MM-DD') GROUP BY 1 ORDER BY 1`));
    table("Terceiros ativos por tipo (tipo | empresas | veículos | funcionários)", await q(`
      SELECT tp.kind AS tipo, count(DISTINCT tp.id)::int AS empresas, count(DISTINCT tv.id)::int AS veiculos, count(DISTINCT te.id)::int AS funcionarios
      FROM third_parties tp LEFT JOIN third_party_vehicles tv ON tv.third_party_id = tp.id AND tv.active LEFT JOIN third_party_employees te ON te.third_party_id = tp.id AND te.active
      WHERE tp.active GROUP BY 1 ORDER BY 1`));
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
