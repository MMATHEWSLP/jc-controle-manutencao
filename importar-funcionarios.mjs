import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Importação idempotente de funcionários (módulo Funcionários) a partir da relação de colaboradores
// de uma frente, em scripts/import-funcionarios/data/. Mesmo padrão de importar-equipamentos.mjs:
// conecta direto no Postgres via DATABASE_URL, roda em SIMULAÇÃO por padrão e só grava com
// --confirmar. Rodar de novo não duplica: quem já existe (mesmo nome, sem acento/caixa) é pulado.
//
// Uso:
//   node importar-funcionarios.mjs                  -> dry-run (nada é gravado)
//   node importar-funcionarios.mjs --confirmar      -> grava de verdade
//   node importar-funcionarios.mjs --arquivo=... --frente=Arapiuns --data=2026-09-27
//
// Regras da carga:
// - Situação "Trabalhando" -> Ativo.
// - "De folga"  -> Ativo + folga em aberto a partir da data da relação (badge "De folga").
// - "Afastado"  -> Afastado + afastamento em aberto a partir da data da relação.
//   (A relação não traz o início real da folga/afastamento; a data usada é a do documento.)
// - Cidade vai para as observações (o cadastro não tem campo de cidade).
// - Linhas marcadas como duplicata na própria relação "(DUP…" são ignoradas.
// - Nome cortado na relação (terminado em "…") é importado sem o "…" e sinalizado para correção.
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const ARQUIVO = arg("arquivo", new URL("./scripts/import-funcionarios/data/arapiuns-2026-09-27.tsv", import.meta.url));
const FRENTE = arg("frente", "Arapiuns");
const DATA_RELACAO = arg("data", "2026-09-27");
const ORIGEM = `Importado da relação de colaboradores de ${DATA_RELACAO.split("-").reverse().join("/")}`;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no ambiente.");
  process.exit(1);
}

export function nameKey(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function parse(content) {
  const [header, ...lines] = content.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  const columns = header.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value.trim()])));
}

function linha() { console.log("-".repeat(78)); }

async function main() {
  const rows = parse(readFileSync(ARQUIVO, "utf8"));
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    const front = (await pool.query(`SELECT id, name FROM service_fronts WHERE lower(name) = lower($1) AND active = TRUE`, [FRENTE])).rows[0];
    if (!front) throw new Error(`Frente "${FRENTE}" não encontrada (ou inativa).`);
    const existing = new Map((await pool.query(`SELECT e.id, e.name, sf.name AS front FROM employees e JOIN service_fronts sf ON sf.id = e.service_front_id`)).rows.map((row) => [nameKey(row.name), row]));

    const plan = { inserir: [], jaExiste: [], duplicataNaRelacao: [], nomeCortado: [], invalidos: [] };
    const seen = new Set();
    for (const row of rows) {
      const truncated = row.nome.endsWith("…");
      if (/\(DUP/i.test(row.nome)) { plan.duplicataNaRelacao.push(row); continue; }
      const name = row.nome.replace(/…$/, "").replace(/\s+/g, " ").trim().toUpperCase();
      const key = nameKey(name);
      if (!name || !row.funcao || !row.empresa || !/^\d{4}-\d{2}-\d{2}$/.test(row.admissao) || !["Trabalhando", "De folga", "Afastado"].includes(row.situacao)) { plan.invalidos.push(row); continue; }
      if (seen.has(key)) { plan.duplicataNaRelacao.push(row); continue; }
      seen.add(key);
      if (existing.has(key)) { plan.jaExiste.push({ ...row, cadastro: existing.get(key) }); continue; }
      const city = row.cidade.replace(/…$/, "").trim();
      const notes = [city ? `Cidade: ${city}${row.cidade.endsWith("…") ? " (nome da cidade cortado na relação)" : ""}` : null, ORIGEM, truncated ? "ATENÇÃO: nome cortado na relação original — conferir e completar." : null].filter(Boolean).join(" · ");
      const item = { ...row, name, notes, status: row.situacao === "Afastado" ? "AFASTADO" : "ATIVO", absence: row.situacao === "De folga" ? "FOLGA" : row.situacao === "Afastado" ? "AFASTAMENTO" : null };
      plan.inserir.push(item);
      if (truncated) plan.nomeCortado.push(item);
    }

    linha();
    console.log(`${CONFIRMAR ? "IMPORTAÇÃO" : "SIMULAÇÃO (nada será gravado)"} — frente ${front.name} (id ${front.id}) — ${rows.length} linhas na relação`);
    linha();
    console.log(`Novos a cadastrar ........... ${plan.inserir.length}`);
    console.log(`  · trabalhando (ativo) ..... ${plan.inserir.filter((item) => !item.absence).length}`);
    console.log(`  · de folga ................ ${plan.inserir.filter((item) => item.absence === "FOLGA").length}`);
    console.log(`  · afastados ............... ${plan.inserir.filter((item) => item.absence === "AFASTAMENTO").length}`);
    console.log(`Já cadastrados (pulados) .... ${plan.jaExiste.length}`);
    console.log(`Duplicatas na relação ....... ${plan.duplicataNaRelacao.length}`);
    console.log(`Linhas inválidas ............ ${plan.invalidos.length}`);
    for (const row of plan.jaExiste) console.log(`  = já existe: ${row.nome} (cadastro em ${row.cadastro.front})`);
    for (const row of plan.duplicataNaRelacao) console.log(`  ~ duplicata ignorada: #${row.n} ${row.nome}`);
    for (const row of plan.invalidos) console.log(`  ! inválida: #${row.n} ${JSON.stringify(row)}`);
    for (const row of plan.nomeCortado) console.log(`  ✂ nome cortado na relação (importado como "${row.name}"): #${row.n} — completar depois em Funcionários`);
    const byCompany = plan.inserir.reduce((map, item) => map.set(item.empresa, (map.get(item.empresa) ?? 0) + 1), new Map());
    console.log(`Por empresa: ${[...byCompany].map(([company, total]) => `${company} ${total}`).join(" · ")}`);
    linha();

    if (!CONFIRMAR) {
      console.log("Simulação concluída. Rode com --confirmar (modo 'confirmar' no workflow) para gravar.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of plan.inserir) {
        const { rows: [created] } = await client.query(
          `INSERT INTO employees (name, job_title, company, admission_date, service_front_id, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [item.name, item.funcao, item.empresa, item.admissao, front.id, item.status, item.notes],
        );
        await client.query(
          `INSERT INTO employee_transfers (employee_id, previous_service_front_id, new_service_front_id, transfer_date, note) VALUES ($1, NULL, $2, $3, $4)`,
          [created.id, front.id, item.admissao, `Frente inicial (${ORIGEM.toLowerCase()})`],
        );
        if (item.absence) {
          await client.query(
            `INSERT INTO employee_absences (employee_id, kind, start_date, end_date, notes) VALUES ($1,$2,$3,NULL,$4)`,
            [created.id, item.absence, DATA_RELACAO, `Situação "${item.situacao}" na relação de ${DATA_RELACAO.split("-").reverse().join("/")} (data de início real não informada). Informe o retorno na ficha.`],
          );
        }
        await client.query(
          `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, new_value) VALUES (NULL, 'EMPLOYEE', $1, 'FUNCIONÁRIO IMPORTADO', $2)`,
          [String(created.id), JSON.stringify({ name: item.name, jobTitle: item.funcao, company: item.empresa, front: front.name, situacao: item.situacao })],
        );
      }
      await client.query("COMMIT");
      console.log(`Importação concluída: ${plan.inserir.length} funcionários cadastrados em ${front.name}.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Falha na importação:", error.message);
  process.exit(1);
});
