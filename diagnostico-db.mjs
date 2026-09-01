import "dotenv/config";
import pg from "pg";

// Uso:
//   node diagnostico-db.mjs                      -> testa a DATABASE_URL do .env
//   node diagnostico-db.mjs "postgresql://..."   -> testa a string passada

const url = process.argv[2] || process.env.DATABASE_URL;

if (!url) {
  console.error("Nenhuma connection string encontrada (nem no .env, nem como argumento).");
  process.exit(1);
}

const mascarada = url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
console.log("Testando conexao com:", mascarada);
console.log("-".repeat(70));

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

try {
  const info = await pool.query(
    "select current_database() as banco, current_user as usuario, current_schema() as schema, version() as versao"
  );
  console.log("CONECTOU COM SUCESSO");
  console.log("  banco:  ", info.rows[0].banco);
  console.log("  usuario:", info.rows[0].usuario);
  console.log("  schema: ", info.rows[0].schema);

  const tabelas = await pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1"
  );
  console.log("-".repeat(70));
  console.log("TABELAS no schema public:", tabelas.rowCount);
  if (tabelas.rowCount > 0) {
    console.log("  " + tabelas.rows.map((r) => r.table_name).join(", "));
  } else {
    console.log("  (NENHUMA TABELA ENCONTRADA - a migracao nao foi aplicada neste banco)");
  }

  console.log("-".repeat(70));
  const bootstrap = await pool.query('select * from "auth_bootstrap"');
  console.log("auth_bootstrap existe. Linhas:", bootstrap.rowCount);
  console.log(bootstrap.rows);

  console.log("-".repeat(70));
  const usuarios = await pool.query('select count(*)::int as total from "users"');
  console.log("Total de usuarios cadastrados:", usuarios.rows[0].total);
} catch (erro) {
  console.log("-".repeat(70));
  console.error("ERRO ENCONTRADO:");
  console.error("  mensagem:", erro.message);
  console.error("  code:    ", erro.code);
  if (erro.detail) console.error("  detail:  ", erro.detail);
  if (erro.hint) console.error("  hint:    ", erro.hint);
  if (erro.cause) console.error("  cause:   ", erro.cause);
} finally {
  await pool.end();
}
