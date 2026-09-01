import "dotenv/config";
import fs from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Importa a base do sistema antigo (Cloudflare D1 / SQLite) para o Postgres do
// Supabase. Lê o arquivo base-antiga.json, descobre sozinho os tipos das colunas
// e a ordem correta das tabelas (pelas chaves estrangeiras) e carrega tudo.
//
// Uso:
//   node importar-base.mjs                -> simulação, não grava nada
//   node importar-base.mjs --confirmar    -> APAGA os dados atuais e importa
// ---------------------------------------------------------------------------

const ARQUIVO = "base-antiga.json";
const CONFIRMAR = process.argv.includes("--confirmar");
const LOTE = 200;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no .env");
  process.exit(1);
}
if (!fs.existsSync(ARQUIVO)) {
  console.error(`Arquivo ${ARQUIVO} não encontrado nesta pasta.`);
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

function linha() {
  console.log("-".repeat(72));
}

try {
  // --- 1. tipos das colunas -------------------------------------------------
  const { rows: colunas } = await pool.query(`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
  `);
  const tipos = new Map();
  for (const c of colunas) {
    if (!tipos.has(c.table_name)) tipos.set(c.table_name, new Map());
    tipos.get(c.table_name).set(c.column_name, c.data_type);
  }

  // --- 2. ordem segura pelas chaves estrangeiras ----------------------------
  const { rows: fks } = await pool.query(`
    select tc.table_name as filha, ccu.table_name as pai
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  `);

  const tabelas = [...tipos.keys()].filter((t) => Array.isArray(base[t]));
  const dependencias = new Map(tabelas.map((t) => [t, new Set()]));
  for (const { filha, pai } of fks) {
    if (filha !== pai && dependencias.has(filha) && tipos.has(pai)) {
      dependencias.get(filha).add(pai);
    }
  }

  const ordem = [];
  const pendentes = new Set(tabelas);
  while (pendentes.size) {
    const prontas = [...pendentes].filter((t) =>
      [...dependencias.get(t)].every((pai) => !pendentes.has(pai))
    );
    if (prontas.length === 0) {
      // ciclo entre tabelas: segue na ordem restante
      ordem.push(...pendentes);
      break;
    }
    prontas.sort();
    ordem.push(...prontas);
    for (const t of prontas) pendentes.delete(t);
  }

  // --- 3. resumo ------------------------------------------------------------
  linha();
  console.log(CONFIRMAR ? "IMPORTACAO REAL" : "SIMULACAO (nada será gravado)");
  linha();
  let total = 0;
  for (const t of ordem) {
    total += base[t].length;
    if (base[t].length) console.log(`  ${t.padEnd(36)} ${String(base[t].length).padStart(5)} registros`);
  }
  console.log(`\n  ${ordem.length} tabelas, ${total} registros no arquivo`);

  const ausentes = Object.keys(base).filter((t) => !tipos.has(t));
  if (ausentes.length) console.log("\n  AVISO - tabelas do backup que não existem no banco:", ausentes.join(", "));

  if (!CONFIRMAR) {
    linha();
    console.log("Nada foi alterado. Para importar de verdade, rode:");
    console.log("   node importar-base.mjs --confirmar");
    console.log("ATENCAO: isso APAGA os dados atuais dessas tabelas antes de importar.");
    process.exit(0);
  }

  // --- 4. limpeza -----------------------------------------------------------
  linha();
  const lista = ordem.map((t) => `"${t}"`).join(", ");
  await pool.query(`TRUNCATE ${lista} RESTART IDENTITY CASCADE`);
  console.log("Tabelas esvaziadas.");

  // --- 5. carga -------------------------------------------------------------
  linha();
  let gravados = 0;
  for (const tabela of ordem) {
    const registros = base[tabela];
    if (!registros.length) continue;

    const tiposTabela = tipos.get(tabela);
    const campos = Object.keys(registros[0]).filter((c) => tiposTabela.has(c));
    const ignorados = Object.keys(registros[0]).filter((c) => !tiposTabela.has(c));
    if (ignorados.length) console.log(`  ${tabela}: colunas ignoradas -> ${ignorados.join(", ")}`);

    const converte = (campo, valor) => {
      if (valor === null || valor === undefined) return null;
      if (tiposTabela.get(campo) === "boolean") {
        if (valor === 1 || valor === "1" || valor === true) return true;
        if (valor === 0 || valor === "0" || valor === false) return false;
      }
      if (typeof valor === "object") return JSON.stringify(valor);
      return valor;
    };

    for (let inicio = 0; inicio < registros.length; inicio += LOTE) {
      const fatia = registros.slice(inicio, inicio + LOTE);
      const valores = [];
      const grupos = fatia.map((registro, i) => {
        const marcadores = campos.map((campo, j) => {
          valores.push(converte(campo, registro[campo]));
          return `$${i * campos.length + j + 1}`;
        });
        return `(${marcadores.join(",")})`;
      });
      const sql = `INSERT INTO "${tabela}" (${campos.map((c) => `"${c}"`).join(",")}) VALUES ${grupos.join(",")}`;
      await pool.query(sql, valores);
    }

    gravados += registros.length;
    console.log(`  ${tabela.padEnd(36)} ${String(registros.length).padStart(5)} importados`);
  }

  // --- 6. sequências --------------------------------------------------------
  linha();
  for (const tabela of ordem) {
    const { rows } = await pool.query(
      `select pg_get_serial_sequence($1,'id') as seq`,
      [tabela]
    );
    const seq = rows[0]?.seq;
    if (!seq) continue;
    await pool.query(
      `select setval($1, coalesce((select max(id) from "${tabela}"),1), (select count(*) from "${tabela}") > 0)`,
      [seq]
    );
  }
  console.log("Sequências de ID reajustadas.");

  // --- 7. conferência -------------------------------------------------------
  linha();
  console.log("CONFERENCIA (arquivo x banco):");
  let divergencias = 0;
  for (const tabela of ordem) {
    const { rows } = await pool.query(`select count(*)::int as total from "${tabela}"`);
    const noBanco = rows[0].total;
    const noArquivo = base[tabela].length;
    if (noBanco !== noArquivo) {
      divergencias++;
      console.log(`  DIVERGENCIA ${tabela}: arquivo ${noArquivo}, banco ${noBanco}`);
    }
  }
  console.log(divergencias === 0 ? `  Tudo confere: ${gravados} registros importados.` : `  ${divergencias} tabela(s) com divergência.`);
  linha();
} catch (erro) {
  linha();
  console.error("ERRO:", erro.message);
  if (erro.detail) console.error("detalhe:", erro.detail);
  if (erro.table) console.error("tabela:", erro.table);
  if (erro.column) console.error("coluna:", erro.column);
  console.error("\nNada foi confirmado além do que já apareceu acima.");
} finally {
  await pool.end();
}
