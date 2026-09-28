import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Importação idempotente da situação atual do ciclo de folga trazida do sistema anterior (listas
// "Em viagem indo para casa" e "De folga"), em scripts/import-funcionarios/data/. Mesmo padrão dos
// outros importadores: SIMULAÇÃO por padrão, só grava com --confirmar, e rodar de novo não duplica.
//
// Uso:
//   node importar-situacao-folgas.mjs                  -> dry-run
//   node importar-situacao-folgas.mjs --confirmar      -> grava
//   node importar-situacao-folgas.mjs --arquivo=... --data=2026-09-28
//
// Regras (colunas: saida_frente = saiu da frente; chegada_casa = chegou em casa / início da folga):
// - Ciclo provisório criado pela importação da relação (só "chegada em casa" na data da relação)
//   -> recebe as datas reais (a etapa que a lista não informa fica em branco).
// - Ciclo aberto sem saída da frente e sem chegada em casa, com início até a data informada
//   -> ganha as datas informadas (continua sendo o mesmo ciclo).
// - Sem ciclo -> cria o ciclo 1 só com as datas informadas.
// - Ciclo aberto já em outra etapa, ou começado depois da data informada -> não mexe, só lista.
// - Situação passa a "De folga" (Afastado/Demitido não mudam), como faz a tela.
// - Nome cortado na importação da relação ("…") é reconhecido pelo começo do nome e completado.
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const ARQUIVO = arg("arquivo", new URL("./scripts/import-funcionarios/data/situacao-arapiuns-2026-09-28.tsv", import.meta.url));
const DATA_DOC = arg("data", "2026-09-28");
const BR = (day) => (day ? day.split("-").reverse().join("/") : "—");
const ORIGEM = `Importado do sistema anterior (situação de ${BR(DATA_DOC)})`;
const PLACEHOLDER_CYCLE = ['Situação "De folga" na relação de %', "Convertido da folga registrada como ausência a partir de %"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada no ambiente.");
  process.exit(1);
}

function nameKey(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function parse(file) {
  const [header, ...lines] = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  const columns = header.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value?.trim() ?? ""])));
}

function linha() { console.log("-".repeat(78)); }

// Nome exato; se não achar, um único cadastro com nome cortado ("nome cortado na relação") que seja
// o começo do nome da lista.
function findEmployee(row, employees, truncated) {
  const key = nameKey(row.nome);
  if (employees.has(key)) return { employee: employees.get(key), rename: null };
  const candidates = truncated.filter((employee) => key.startsWith(nameKey(employee.name)));
  return candidates.length === 1 ? { employee: candidates[0], rename: row.nome.replace(/\s+/g, " ").trim().toUpperCase() } : null;
}

function plan(rows, employees, truncated, cyclesByEmployee) {
  const result = { aplicar: [], jaImportado: [], naoEncontrado: [], conflito: [], invalidos: [] };
  for (const row of rows) {
    const dates = { frontDeparture: row.saida_frente || null, homeArrival: row.chegada_casa || null };
    const first = dates.frontDeparture ?? dates.homeArrival;
    if (!first || Object.values(dates).some((day) => day && (!DATE.test(day) || day > DATA_DOC)) || (dates.frontDeparture && dates.homeArrival && dates.homeArrival < dates.frontDeparture)) {
      result.invalidos.push(row);
      continue;
    }
    const found = findEmployee(row, employees, truncated);
    if (!found) { result.naoEncontrado.push(row); continue; }
    const { employee, rename } = found;
    if (employee.status === "DEMITIDO") { result.conflito.push({ row, employee, motivo: "funcionário demitido" }); continue; }
    const cycles = cyclesByEmployee.get(employee.id) ?? [];
    const open = cycles.find((cycle) => !cycle.frontArrival && !cycle.endedAt);
    const describe = (cycle) => `#${cycle.cycle_number}: ${["workStart", "frontDeparture", "homeArrival", "homeDeparture"].map((step) => BR(cycle[step])).join(" › ")}`;
    if (open && (open.frontDeparture ?? null) === dates.frontDeparture && (open.homeArrival ?? null) === dates.homeArrival && !open.is_placeholder) {
      result.jaImportado.push({ row, employee });
      continue;
    }
    let action;
    if (open?.is_placeholder) action = { kind: "SUBSTITUIR", cycleId: open.id };
    else if (open && !open.frontDeparture && !open.homeArrival && !open.homeDeparture && (!open.workStart || open.workStart <= first)) action = { kind: "COMPLETAR", cycleId: open.id, workStart: open.workStart };
    else if (open) { result.conflito.push({ row, employee, motivo: `ciclo aberto já lançado no sistema (${describe(open)})` }); continue; }
    else action = { kind: "CRIAR", number: cycles.reduce((max, cycle) => Math.max(max, cycle.cycle_number), 0) + 1 };
    result.aplicar.push({ row, employee, rename, dates, ...action });
  }
  return result;
}

async function main() {
  const rows = parse(ARQUIVO);
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    const all = (await pool.query(`SELECT e.id, e.name, e.status, e.notes, e.service_front_id, e.cycle_work_days, e.cycle_off_days, sf.name AS front FROM employees e JOIN service_fronts sf ON sf.id = e.service_front_id`)).rows;
    const employees = new Map(all.map((row) => [nameKey(row.name), row]));
    const truncated = all.filter((row) => /nome cortado na relação original/i.test(row.notes ?? ""));
    const cycles = (await pool.query(
      `SELECT id, employee_id, cycle_number, work_start AS "workStart", front_departure AS "frontDeparture", home_arrival AS "homeArrival", home_departure AS "homeDeparture", front_arrival AS "frontArrival", ended_at AS "endedAt",
              (work_start IS NULL AND front_departure IS NULL AND home_departure IS NULL AND front_arrival IS NULL AND ended_at IS NULL AND notes LIKE ANY($1::text[])) AS is_placeholder
       FROM employee_leave_cycles ORDER BY employee_id, cycle_number`, [PLACEHOLDER_CYCLE],
    )).rows;
    const byEmployee = cycles.reduce((map, item) => map.set(item.employee_id, [...(map.get(item.employee_id) ?? []), item]), new Map());
    const result = plan(rows, employees, truncated, byEmployee);

    linha();
    console.log(`${CONFIRMAR ? "IMPORTAÇÃO" : "SIMULAÇÃO (nada será gravado)"} — situação dos ciclos de folga em ${BR(DATA_DOC)} — ${rows.length} linhas`);
    linha();
    console.log(`A gravar ................... ${result.aplicar.length} (${result.aplicar.filter((item) => item.kind === "SUBSTITUIR").length} substituem o provisório, ${result.aplicar.filter((item) => item.kind === "COMPLETAR").length} completam o ciclo aberto, ${result.aplicar.filter((item) => item.kind === "CRIAR").length} ciclos novos)`);
    console.log(`Já importados (pulados) .... ${result.jaImportado.length}`);
    console.log(`Com ciclo em outra etapa ... ${result.conflito.length}`);
    console.log(`Não encontrados ............ ${result.naoEncontrado.length}`);
    console.log(`Linhas inválidas ........... ${result.invalidos.length}`);
    for (const item of result.aplicar) console.log(`  + ${item.employee.name} (${item.employee.front}): ${item.row.situacao} — saída da frente ${BR(item.dates.frontDeparture)}, chegada em casa ${BR(item.dates.homeArrival)} [${item.kind.toLowerCase()}]${item.rename ? ` — nome completado para "${item.rename}"` : ""}`);
    for (const item of result.conflito) console.log(`  ! ${item.employee.name}: ${item.motivo} — lista diz ${item.row.situacao}, saída ${BR(item.row.saida_frente)}, chegada ${BR(item.row.chegada_casa)}; não alterado`);
    for (const row of result.naoEncontrado) console.log(`  ? não cadastrado: #${row.n} ${row.nome} (${row.funcao}, ${row.empresa})`);
    for (const row of result.invalidos) console.log(`  ! inválida: #${row.n} ${JSON.stringify(row)}`);
    linha();

    if (!CONFIRMAR) {
      console.log("Simulação concluída. Rode com --confirmar (modo 'confirmar' no workflow) para gravar.");
      return;
    }

    const client = await pool.connect();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      for (const item of result.aplicar) {
        const { employee, dates } = item;
        const notes = `${ORIGEM}: ${item.row.situacao}`;
        if (item.kind === "CRIAR") {
          await client.query(
            `INSERT INTO employee_leave_cycles (employee_id, cycle_number, service_front_id, front_departure, home_arrival, work_days_target, off_days_target, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [employee.id, item.number, employee.service_front_id, dates.frontDeparture, dates.homeArrival, employee.cycle_work_days, employee.cycle_off_days, notes],
          );
        } else {
          // Provisório: as datas da lista substituem tudo; ciclo aberto: mantém o início e as notas.
          await client.query(
            item.kind === "SUBSTITUIR"
              ? `UPDATE employee_leave_cycles SET front_departure=$2, home_arrival=$3, notes=$4, updated_at=$5 WHERE id=$1`
              : `UPDATE employee_leave_cycles SET front_departure=$2, home_arrival=$3, notes=COALESCE(notes || ' · ', '') || $4, updated_at=$5 WHERE id=$1`,
            [item.cycleId, dates.frontDeparture, dates.homeArrival, notes, now],
          );
        }
        const status = employee.status === "AFASTADO" ? "AFASTADO" : "FOLGA";
        if (status !== employee.status || item.rename) {
          await client.query(
            `UPDATE employees SET status=$2, name=COALESCE($3, name), updated_at=$4,
               notes=CASE WHEN $3::text IS NULL THEN notes ELSE replace(notes, 'ATENÇÃO: nome cortado na relação original — conferir e completar.', 'Nome completado pela lista do sistema anterior.') END
             WHERE id=$1`,
            [employee.id, status, item.rename, now],
          );
        }
        await client.query(
          `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, new_value) VALUES (NULL, 'EMPLOYEE', $1, 'SITUAÇÃO DE FOLGA IMPORTADA', $2)`,
          [String(employee.id), JSON.stringify({ ...dates, situacao: item.row.situacao, status, ...(item.rename ? { nomeAnterior: employee.name, nome: item.rename } : {}), origem: ORIGEM })],
        );
      }
      await client.query("COMMIT");
      console.log(`Importação concluída: ${result.aplicar.length} ciclos de folga atualizados.`);
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
