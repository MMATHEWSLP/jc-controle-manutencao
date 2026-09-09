// Script de diagnóstico (somente leitura) para investigar o relato de que o
// módulo Produtos "sumiu" (lista vazia ou tabela ausente) depois do deploy
// do PR de frentes multi-usuário.
//
// Não altera nenhum dado.
//
// Uso: DATABASE_URL=... node diagnosticar-produtos.mjs
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function tableExists(client, name) {
  const result = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
    [name],
  );
  return result.rowCount > 0;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log("== Diagnóstico do módulo Produtos ==");
    for (const table of ["products", "equipment_models", "suppliers", "equipment"]) {
      const exists = await tableExists(client, table);
      if (!exists) {
        console.log(`Tabela "${table}": NÃO EXISTE`);
        continue;
      }
      const count = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      console.log(`Tabela "${table}": existe, ${count.rows[0].n} linha(s)`);
    }

    const sample = await client.query(
      "SELECT id, code, name, category, brand, active FROM products ORDER BY id LIMIT 5",
    );
    console.log("\nAmostra de até 5 produtos:");
    for (const row of sample.rows) {
      console.log(JSON.stringify(row));
    }

    const activeCount = await client.query("SELECT COUNT(*)::int AS n FROM products WHERE active = true");
    const inactiveCount = await client.query("SELECT COUNT(*)::int AS n FROM products WHERE active = false");
    console.log(`\nProdutos ativos: ${activeCount.rows[0].n} | inativos: ${inactiveCount.rows[0].n}`);

    const equipModelLinked = await client.query(
      "SELECT COUNT(*)::int AS n FROM equipment WHERE equipment_model_id IS NOT NULL",
    );
    console.log(`Equipamentos vinculados a um modelo: ${equipModelLinked.rows[0].n}`);

    console.log("\n== Fim do diagnóstico ==");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Falha no diagnóstico:", error);
  process.exitCode = 1;
});
