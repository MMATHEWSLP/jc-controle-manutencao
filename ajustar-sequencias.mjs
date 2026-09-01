import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

// Ajusta os contadores de ID (sequences) depois da importação e confere as
// quantidades de cada tabela contra o arquivo base-antiga.json.
// Uso: node ajustar-sequencias.mjs

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

try {
  // Só tabelas que realmente têm coluna "id" (auth_bootstrap, por exemplo, não tem).
  const { rows: comId } = await pool.query(`
    select table_name
    from information_schema.columns
    where table_schema = 'public' and column_name = 'id'
    order by table_name
  `);

  let ajustadas = 0;
  for (const { table_name: tabela } of comId) {
    const { rows } = await pool.query(`select pg_get_serial_sequence($1,'id') as seq`, [tabela]);
    const seq = rows[0]?.seq;
    if (!seq) continue;
    const { rows: max } = await pool.query(
      `select coalesce(max(id),0)::int as maior from "${tabela}"`
    );
    await pool.query(`select setval($1, $2, true)`, [seq, Math.max(max[0].maior, 1)]);
    ajustadas++;
    console.log(`  ${tabela.padEnd(36)} próximo ID: ${max[0].maior + 1}`);
  }
  console.log(`\n${ajustadas} contadores ajustados.`);

  // --- conferência ---------------------------------------------------------
  console.log("-".repeat(72));
  console.log("CONFERENCIA (arquivo x banco):");
  const base = JSON.parse(fs.readFileSync("base-antiga.json", "utf8"));
  let divergencias = 0;
  let total = 0;
  for (const tabela of Object.keys(base).sort()) {
    const { rows } = await pool.query(`select count(*)::int as total from "${tabela}"`);
    const noBanco = rows[0].total;
    const noArquivo = base[tabela].length;
    total += noBanco;
    if (noBanco !== noArquivo) {
      divergencias++;
      console.log(`  DIVERGENCIA  ${tabela}: arquivo ${noArquivo}, banco ${noBanco}`);
    }
  }
  console.log(
    divergencias === 0
      ? `  Tudo confere. ${total} registros no banco.`
      : `  ${divergencias} tabela(s) com divergência.`
  );

  // --- usuários importados -------------------------------------------------
  console.log("-".repeat(72));
  const { rows: usuarios } = await pool.query(
    `select id, username, name, role, status from "users" order by id`
  );
  console.log("USUARIOS IMPORTADOS:");
  for (const u of usuarios) {
    console.log(`  id=${String(u.id).padStart(3)}  ${String(u.username).padEnd(20)} ${String(u.name).padEnd(28)} ${u.role}  ${u.status}`);
  }
  console.log("-".repeat(72));
} catch (erro) {
  console.error("ERRO:", erro.message);
} finally {
  await pool.end();
}
