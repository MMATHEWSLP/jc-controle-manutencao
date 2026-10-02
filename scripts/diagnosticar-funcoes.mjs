// Diagnóstico (somente leitura) para o acesso automático dos operadores: lista todas as funções
// dos funcionários com a quantidade em cada uma (total / ativos / por frente), a sugestão de
// "Opera equipamento" e os acessos de campo (perfil CAMPO) que já existem.
// Uso: DATABASE_URL=... node scripts/diagnosticar-funcoes.mjs
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const semAcento = (texto) => String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
// Sugestão: SIM = dirige/opera máquina ou veículo da frota; ANALISAR = depende (operador genérico, motosserra, auxiliar).
export function sugestao(funcao) {
  const f = semAcento(funcao);
  if (/AUXILIAR|AJUDANTE|APRENDIZ|ENCARREGADO|SUPERVISOR|LIDER|COORDENADOR|MECANICO|ELETRICISTA|SOLDADOR|LUBRIFICADOR|BORRACHEIRO/.test(f)) return /OPERADOR|MOTORISTA/.test(f) ? "ANALISAR" : "NÃO";
  if (/MOTOSSERR|MOTO SERR|MOTOPODA|ROCADEIRA/.test(f)) return "ANALISAR";
  if (/MOTORISTA|TRATORISTA|MAQUINISTA|OPERADOR(A)? DE (MAQ|MÁQ|SKIDDER|HARVESTER|FORWARDER|CARREGADEIRA|ESCAVADEIRA|TRATOR|RETRO|MOTONIVELADORA|PA |PÁ |GUINDASTE|MUNCK|FELLER|GARRA|EMPILHADEIRA|CAMINHAO|ROLO|GRUA|EQUIPAMENTO|SLINGER|TRITURADOR|PICADOR)|OP\.? ?(DE )?MAQ|OPERADOR(A)? (SKIDDER|HARVESTER|FORWARDER|FELLER)/.test(f)) return "SIM";
  if (/^OPERADOR/.test(f)) return "ANALISAR";
  return "NÃO";
}

async function main() {
  const funcoes = await pool.query(`
    SELECT upper(trim(regexp_replace(e.job_title, '\\s+', ' ', 'g'))) AS funcao,
      count(*)::int AS total, count(*) FILTER (WHERE e.status <> 'DEMITIDO')::int AS ativos,
      string_agg(DISTINCT CASE WHEN e.status <> 'DEMITIDO' THEN sf.name END, ', ') AS frentes
    FROM employees e LEFT JOIN service_fronts sf ON sf.id = e.service_front_id
    GROUP BY 1 ORDER BY ativos DESC, total DESC, funcao`);
  console.log("=== Funções dos funcionários (total / ativos* / frentes) — *ativo = não demitido ===");
  let sim = 0, analisar = 0;
  for (const row of funcoes.rows) {
    const s = sugestao(row.funcao);
    if (s === "SIM") sim += row.ativos; if (s === "ANALISAR") analisar += row.ativos;
    console.log(`${s.padEnd(8)} | ${String(row.total).padStart(4)} | ${String(row.ativos).padStart(4)} | ${row.funcao} | ${row.frentes ?? "—"}`);
  }
  console.log(`\nFunções: ${funcoes.rows.length}. Ativos em funções SIM: ${sim}. Ativos em funções ANALISAR: ${analisar}.`);
  const status = await pool.query(`SELECT status, count(*)::int AS n FROM employees GROUP BY 1 ORDER BY 1`);
  console.log("Funcionários por situação:", status.rows.map((row) => `${row.status}=${row.n}`).join(", "));
  const semMatricula = await pool.query(`SELECT count(*)::int AS n FROM employees WHERE status <> 'DEMITIDO' AND coalesce(trim(registration), '') = ''`);
  console.log(`Ativos sem matrícula: ${semMatricula.rows[0].n}`);
  const campo = await pool.query(`
    SELECT u.id, u.name, u.job_title, u.status, sf.name AS frente, u.last_access_at,
      (SELECT count(*)::int FROM employees e WHERE upper(trim(e.name)) = upper(trim(u.name)) AND e.status <> 'DEMITIDO') AS funcionarios_mesmo_nome
    FROM users u LEFT JOIN service_fronts sf ON sf.id = u.service_front_id WHERE u.role = 'CAMPO' ORDER BY u.name`);
  console.log(`\n=== Acessos de campo (perfil CAMPO) já existentes: ${campo.rows.length} ===`);
  for (const row of campo.rows) console.log(`${row.status} | ${row.name} | ${row.job_title ?? "—"} | ${row.frente ?? "—"} | último acesso ${row.last_access_at ?? "nunca"} | funcionário ativo com o mesmo nome: ${row.funcionarios_mesmo_nome}`);
  const perfis = await pool.query(`SELECT role, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 1`);
  console.log("\nUsuários por perfil:", perfis.rows.map((row) => `${row.role}=${row.n}`).join(", "));
  await pool.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
