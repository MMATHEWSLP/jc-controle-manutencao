import { Pool, types, type PoolClient } from "pg";
import type { ConsultaMontada } from "./consulta";

// ---------------------------------------------------------------------------------------------
// Conexão do Assistente JC com o banco. Usa ASSISTANT_DATABASE_URL (papel assistente_leitura, que
// só tem SELECT nas views do schema "assistente" e transação somente leitura por padrão): mesmo com
// erro de código, o assistente não consegue gravar nem ler tabelas. Enquanto essa variável não
// estiver cadastrada, usa DATABASE_URL — sempre dentro de "BEGIN READ ONLY" e só sobre as views.
// ---------------------------------------------------------------------------------------------
let pool: Pool | null = null;
let poolUrl = "";

// DATE como texto AAAA-MM-DD (sem conversão de fuso), numeric e bigint como número.
const parsers = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === 1082) return (value: string) => value;
    if (oid === 1700 || oid === 20) return (value: string) => Number(value);
    return types.getTypeParser(oid, format);
  }) as typeof types.getTypeParser,
};

export function assistantDbMode() {
  return process.env.ASSISTANT_DATABASE_URL?.trim() ? "DEDICADA" as const : "PRINCIPAL_SOMENTE_LEITURA" as const;
}

function getPool() {
  const url = process.env.ASSISTANT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!url) throw new Error("Banco não configurado (ASSISTANT_DATABASE_URL / DATABASE_URL).");
  if (pool && poolUrl === url) return pool;
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  const local = /@(localhost|127\.0\.0\.1)[:/]|host=\/tmp/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: local ? undefined : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: Number(process.env.ASSISTANT_DATABASE_POOL_MAX) || 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000,
    types: parsers,
  });
  poolUrl = url;
  return pool;
}

async function readOnly<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL search_path = assistente");
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export async function executarConsulta(montada: ConsultaMontada) {
  return readOnly(async (client) => {
    const result = await client.query(montada.sql, montada.params);
    const rows = result.rows as Array<Record<string, unknown>>;
    return { rows: rows.slice(0, montada.limite), limitado: rows.length > montada.limite };
  });
}

// Conferência do catálogo contra o banco (script de teste/CI).
export async function colunasDasViews() {
  return readOnly(async (client) => {
    const result = await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'assistente' ORDER BY table_name, ordinal_position`);
    return result.rows as Array<{ table_name: string; column_name: string; data_type: string }>;
  });
}

export async function fecharPoolAssistente() {
  if (pool) await pool.end().catch(() => undefined);
  pool = null;
}
