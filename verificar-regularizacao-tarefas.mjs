// Script de diagnóstico (somente leitura) para conferir, após a migração de
// hierarquia/tarefas, quantos registros antigos ficaram sem responsável ou
// criador válidos e precisam de regularização administrativa.
// Uso: DATABASE_URL=... node verificar-regularizacao-tarefas.mjs
import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const [totalTasks, missingAssignee, missingCreator, deletedTasks, totalUsers, hierarchyByLevel] = await Promise.all([
    pool.query(`SELECT count(*)::int AS n FROM tasks WHERE deleted_at IS NULL`),
    pool.query(`SELECT count(*)::int AS n FROM tasks WHERE assignee_id IS NULL AND deleted_at IS NULL`),
    pool.query(`SELECT count(*)::int AS n FROM tasks WHERE created_by IS NULL AND deleted_at IS NULL`),
    pool.query(`SELECT count(*)::int AS n FROM tasks WHERE deleted_at IS NOT NULL`),
    pool.query(`SELECT count(*)::int AS n FROM users`),
    pool.query(`SELECT hierarchy_level, count(*)::int AS n FROM users GROUP BY hierarchy_level ORDER BY hierarchy_level`),
  ]);
  console.log("=== Regularização — Tarefas ===");
  console.log(`Tarefas ativas (não excluídas): ${totalTasks.rows[0].n}`);
  console.log(`Tarefas ativas SEM responsável válido (precisam de regularização): ${missingAssignee.rows[0].n}`);
  console.log(`Tarefas ativas SEM criador registrado (precisam de regularização): ${missingCreator.rows[0].n}`);
  console.log(`Tarefas excluídas (soft-delete, fora das listagens): ${deletedTasks.rows[0].n}`);
  console.log("\n=== Regularização — Nível hierárquico dos usuários ===");
  console.log(`Total de usuários: ${totalUsers.rows[0].n}`);
  for (const row of hierarchyByLevel.rows) console.log(`  ${row.hierarchy_level}: ${row.n}`);
  await pool.end();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
