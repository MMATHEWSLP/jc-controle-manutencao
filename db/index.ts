import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// Compatibilidade: este projeto foi originalmente escrito para o Cloudflare D1
// (SQLite). Em vez de reescrever as dezenas de rotas que já sabem "conversar"
// com o D1 (chamando .prepare(sql).bind(...).all()/.first()/.run()), mantemos
// exatamente essa mesma "casca" aqui, só que por baixo dos panos ela agora
// conversa com o Postgres do Supabase. Nenhuma rota precisa saber disso.
// ---------------------------------------------------------------------------

export interface D1ResultLike<T> { results:T[]; }
export interface D1PreparedStatementLike {
  bind(...values:unknown[]):D1PreparedStatementLike;
  all<T=Record<string,unknown>>():Promise<D1ResultLike<T>>;
  first<T=Record<string,unknown>>():Promise<T|null>;
  run():Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(query:string):D1PreparedStatementLike;
  batch(statements:D1PreparedStatementLike[]):Promise<unknown[]>;
}

let pool:Pool|null=null;

function getPool():Pool {
  if (pool) return pool;
  const connectionString=process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL não está configurada. Cadastre a connection string do Supabase (Settings > Database > Connection string) nas variáveis de ambiente do servidor."
    );
  }
  pool=new Pool({
    connectionString,
    // O Supabase exige TLS; a maioria dos provedores usa certificado válido,
    // mas alguns modos de conexão (pooler) usam certificado que o Node não
    // reconhece automaticamente — por isso relaxamos a verificação aqui.
    ssl:{ rejectUnauthorized:false },
  });
  return pool;
}

// Converte marcadores de posição no estilo SQLite/D1 ("?") para o estilo do
// Postgres ("$1", "$2", ...), sem mexer em "?" que apareçam dentro de textos
// entre aspas simples.
export function toPgQuery(query:string):string {
  let result="";
  let paramIndex=0;
  let insideString=false;
  for (let index=0;index<query.length;index++) {
    const char=query[index];
    if (char==="'") {
      insideString=!insideString;
      result+=char;
      continue;
    }
    if (char==="?"&&!insideString) {
      paramIndex+=1;
      result+=`$${paramIndex}`;
      continue;
    }
    result+=char;
  }
  return result;
}

// No SQLite/D1 não existe tipo booleano: verdadeiro/falso são gravados como 1 e 0,
// e por isso as consultas do projeto comparam essas colunas com números. No Postgres
// elas são BOOLEAN de verdade, e a comparação com número é recusada com o erro
// "operator does not exist: boolean = integer". Em vez de reescrever dezenas de
// consultas espalhadas pelas rotas, a tradução acontece aqui, num ponto só.
const BOOLEAN_COLUMNS = [
  "active",
  "enabled",
  "applicable",
  "oil_change_enabled",
  "automatic_enabled",
  "authorized_regression",
  "is_primary_admin",
];

// Casa também quando a coluna vem com prefixo de tabela (e.oil_change_enabled=1).
// A borda \b impede que "active" case dentro de nomes como "is_active".
const BOOLEAN_COMPARISON = new RegExp(
  `\\b(${BOOLEAN_COLUMNS.join("|")})\\s*(=|<>|!=)\\s*([01])(?![0-9])`,
  "gi"
);

function normalizeBooleans(query:string):string {
  return query.replace(BOOLEAN_COMPARISON,(_todo,coluna:string,operador:string,valor:string)=>
    `${coluna}${operador}${valor==="1"?"TRUE":"FALSE"}`
  );
}

// O mesmo problema aparece de outra forma nos INSERT: ali o 0/1 não está colado
// num "=", e sim numa posição da lista de valores, como em
//   INSERT INTO maintenance_plans (...,active,...) VALUES (?,?,...,1,?,?)
// Para tratar isso, casamos a lista de colunas com a lista de valores e trocamos
// apenas as posições que correspondem a colunas booleanas.
const INSERT_COM_VALORES=/(INSERT\s+INTO\s+"?\w+"?\s*\(\s*)([^)]*?)(\s*\)\s*VALUES\s*\(\s*)([^)]*?)(\s*\))/gi;

function normalizeInsertBooleans(query:string):string {
  return query.replace(INSERT_COM_VALORES,(todo:string,antes:string,listaColunas:string,meio:string,listaValores:string,fim:string)=>{
    // Só mexemos em listas simples (marcadores e números). Se houver texto entre
    // aspas ou chamadas de função, separar por vírgula seria arriscado.
    if(/['"()]/.test(listaValores))return todo;
    const colunas=listaColunas.split(",").map((c)=>c.trim().replace(/"/g,"").toLowerCase());
    const valores=listaValores.split(",").map((v)=>v.trim());
    if(colunas.length!==valores.length)return todo;
    const ajustados=valores.map((valor,posicao)=>{
      if(!BOOLEAN_COLUMNS.includes(colunas[posicao]))return valor;
      if(valor==="1")return "TRUE";
      if(valor==="0")return "FALSE";
      return valor;
    });
    return `${antes}${listaColunas}${meio}${ajustados.join(",")}${fim}`;
  });
}

// Pequenos ajustes de sintaxe que existem no SQLite/D1 e não existem no
// Postgres. Cada rota que usa uma dessas construções já foi corrigida no
// código-fonte; esta função fica apenas como rede de segurança.
// Exportada só para ser testada isoladamente (tests/db-sql-translation.test.mjs)
// sem precisar de conexão real com o Postgres.
export function normalizeSqliteisms(query:string):string {
  const semGroupConcat=query.replace(/\bGROUP_CONCAT\s*\(\s*DISTINCT\s+/gi,"STRING_AGG(DISTINCT ");
  // instr(texto,busca) do SQLite equivale a strpos(texto,busca) no Postgres: mesma
  // ordem de argumentos, mesmo retorno (posição a partir de 1, zero se não achar).
  const semInstr=semGroupConcat.replace(/\binstr\s*\(/gi,"strpos(");
  // "coluna IS ?" é válido no SQLite (compara com NULL-safety, aceitando um
  // parâmetro qualquer do lado direito) mas não existe no Postgres — lá "IS"
  // só aceita NULL/TRUE/FALSE/UNKNOWN literais. O equivalente correto e
  // NULL-safe é "IS NOT DISTINCT FROM ?".
  const semIsParametrizado=semInstr.replace(/\bIS\s+\?/gi,"IS NOT DISTINCT FROM ?");
  return normalizeInsertBooleans(normalizeBooleans(semIsParametrizado));
}

class PgPreparedStatement implements D1PreparedStatementLike {
  private readonly text:string;
  private values:unknown[]=[];
  constructor(private readonly pool:Pool, query:string) {
    this.text=toPgQuery(normalizeSqliteisms(query));
  }
  bind(...values:unknown[]):D1PreparedStatementLike {
    this.values=values;
    return this;
  }
  async all<T=Record<string,unknown>>():Promise<D1ResultLike<T>> {
    const result=await this.pool.query(this.text,this.values);
    return { results: result.rows as T[] };
  }
  async first<T=Record<string,unknown>>():Promise<T|null> {
    const result=await this.pool.query(this.text,this.values);
    return (result.rows[0] as T)??null;
  }
  async run():Promise<unknown> {
    return this.pool.query(this.text,this.values);
  }
  // Usado internamente pelo batch() para reaproveitar texto/valores já resolvidos.
  _snapshot() { return { text:this.text, values:this.values }; }
}

class PgD1Adapter implements D1DatabaseLike {
  constructor(private readonly pool:Pool) {}
  prepare(query:string):D1PreparedStatementLike {
    return new PgPreparedStatement(this.pool,query);
  }
  async batch(statements:D1PreparedStatementLike[]):Promise<unknown[]> {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results:unknown[]=[];
      for (const statement of statements) {
        const { text, values }=(statement as PgPreparedStatement)._snapshot();
        results.push(await client.query(text,values));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function getD1():Promise<D1DatabaseLike> {
  return new PgD1Adapter(getPool());
}

export async function getDb() {
  return drizzle(getPool(), { schema });
}
