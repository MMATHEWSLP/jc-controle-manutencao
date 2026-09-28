import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

// ---------------------------------------------------------------------------
// Importação idempotente do histórico de folgas (ciclos) e de afastamentos trazidos do sistema
// anterior, em scripts/import-funcionarios/data/. Mesmo padrão de importar-funcionarios.mjs:
// SIMULAÇÃO por padrão, só grava com --confirmar, e rodar de novo não duplica nada.
// Os funcionários precisam já estar cadastrados (rodar antes importar-funcionarios.mjs); quem não é
// encontrado pelo nome é listado e pulado.
//
// Uso:
//   node importar-historico-funcionarios.mjs                  -> dry-run
//   node importar-historico-funcionarios.mjs --confirmar      -> grava
//   node importar-historico-funcionarios.mjs --folgas=... --afastamentos=... --data=2026-09-28
//
// Folgas (um ciclo por linha, datas das 5 etapas):
// - Funcionário sem ciclo, ou só com o ciclo provisório criado pela importação da relação ("De
//   folga" com só a chegada em casa na data da relação) -> o ciclo 1 recebe as datas reais.
// - Ciclo com chegada na frente -> fecha e abre o próximo começando nessa data (igual à tela), e a
//   situação volta a Ativo (Afastado/Demitido não mudam).
// - Funcionário que já tem ciclo lançado à mão com outras datas -> não mexe, só lista.
// - Saída de casa depois da chegada na frente (erro no sistema anterior) -> usa a chegada na frente
//   nas duas e anota a data original.
// - Ciclo 2 no histórico com datas anteriores ao próprio início (lançamento repetido no sistema
//   anterior) -> ignorado; o ciclo 2 aberto nasce do fechamento do ciclo 1.
//
// Afastamentos (motivo, início, retorno ou previsão de retorno):
// - Término gravado = dia anterior ao retorno (no sistema o retorno é o dia seguinte ao término).
// - Sem retorno = em aberto; a previsão de retorno, se houver, vira o término previsto.
// - Motivo com "atestado" -> Atestado médico; os demais -> Afastamento (o motivo vai nas observações).
// - O afastamento provisório criado pela importação da relação (início na data da relação) recebe a
//   data real; afastamento com o mesmo início já cadastrado é pulado.
// - Afastamento em aberto deixa a situação do funcionário como Afastado.
// ---------------------------------------------------------------------------

const CONFIRMAR = process.argv.includes("--confirmar");
const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const DATA = new URL("./scripts/import-funcionarios/data/", import.meta.url);
const FOLGAS = arg("folgas", new URL("folgas-2026-09-28.tsv", DATA));
const AFASTAMENTOS = arg("afastamentos", new URL("afastamentos-2026-09-28.tsv", DATA));
const DATA_DOC = arg("data", "2026-09-28");
const BR = (day) => (day ? day.split("-").reverse().join("/") : "—");
const ORIGEM = `Importado do sistema anterior (histórico de ${BR(DATA_DOC)})`;
// Marcas deixadas pelos registros provisórios de importar-funcionarios.mjs (e da conversão das folgas
// antigas em ciclo, na migration 0016).
const PLACEHOLDER_CYCLE = ['Situação "De folga" na relação de %', "Convertido da folga registrada como ausência a partir de %"];
const PLACEHOLDER_ABSENCE = "%(data de início real não informada)%";

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
  return lines.map((line) => Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value.trim()])));
}

function previousDay(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function linha() { console.log("-".repeat(78)); }

const STEPS = ["workStart", "frontDeparture", "homeArrival", "homeDeparture", "frontArrival"];

function planCycles(rows, employees, cyclesByEmployee) {
  const plan = { aplicar: [], jaImportado: [], naoEncontrado: [], conflito: [], ignorado: [], corrigido: [] };
  for (const row of rows) {
    const employee = employees.get(nameKey(row.nome));
    if (!employee) { plan.naoEncontrado.push(row); continue; }
    const dates = { workStart: row.inicio, frontDeparture: row.saida_frente, homeArrival: row.chegada_casa, homeDeparture: row.saida_casa, frontArrival: row.chegada_frente };
    if (Number(row.ciclo) !== 1) {
      if (dates.frontDeparture < dates.workStart) { plan.ignorado.push({ row, motivo: `ciclo ${row.ciclo} com saída da frente (${BR(dates.frontDeparture)}) antes do início (${BR(dates.workStart)}) — lançamento repetido no sistema anterior` }); continue; }
      plan.ignorado.push({ row, motivo: `ciclo ${row.ciclo} não suportado pela importação — lançar na ficha` });
      continue;
    }
    const notes = [ORIGEM, row.tipo ? `Situação lá: ${row.tipo}` : null];
    if (dates.frontArrival && dates.homeDeparture > dates.frontArrival) {
      notes.push(`Saída de casa informada ${BR(dates.homeDeparture)}, depois da chegada na frente — ajustada para ${BR(dates.frontArrival)}; conferir`);
      plan.corrigido.push({ row, employee });
      dates.homeDeparture = dates.frontArrival;
    }
    const order = STEPS.map((step) => dates[step]).filter(Boolean);
    if (order.some((day, index) => index > 0 && day < order[index - 1]) || order.some((day) => day > DATA_DOC)) {
      plan.conflito.push({ row, employee, motivo: "datas fora de ordem ou futuras no histórico" });
      continue;
    }
    if (employee.status === "DEMITIDO") { plan.conflito.push({ row, employee, motivo: "funcionário demitido" }); continue; }
    const cycles = cyclesByEmployee.get(employee.id) ?? [];
    const first = cycles.find((cycle) => cycle.cycle_number === 1);
    if (first && STEPS.every((step) => (first[step] ?? null) === (dates[step] || null))) { plan.jaImportado.push({ row, employee }); continue; }
    const placeholder = cycles.length === 1 && first && first.is_placeholder;
    if (cycles.length && !placeholder) {
      plan.conflito.push({ row, employee, motivo: `já tem ${cycles.length} ciclo(s) lançado(s) no sistema (${cycles.map((cycle) => `#${cycle.cycle_number}: ${STEPS.map((step) => BR(cycle[step])).join(" › ")}`).join("; ")})` });
      continue;
    }
    plan.aplicar.push({ row, employee, dates, notes: notes.filter(Boolean).join(" · "), replace: placeholder ? first.id : null });
  }
  return plan;
}

function planAbsences(rows, employees, absencesByEmployee) {
  const plan = { aplicar: [], jaImportado: [], naoEncontrado: [], conflito: [] };
  for (const row of rows) {
    const employee = employees.get(nameKey(row.nome));
    if (!employee) { plan.naoEncontrado.push(row); continue; }
    const kind = /atestado/i.test(row.motivo) ? "ATESTADO" : "AFASTAMENTO";
    const endDate = row.retorno ? previousDay(row.retorno) : row.previsao_retorno ? previousDay(row.previsao_retorno) : null;
    const open = !row.retorno;
    const notes = [row.motivo, row.retorno ? `Retorno em ${BR(row.retorno)}` : row.previsao_retorno ? `Previsão de retorno: ${BR(row.previsao_retorno)}` : null, ORIGEM].filter(Boolean).join(" · ");
    if (endDate && endDate < row.inicio) { plan.conflito.push({ row, employee, motivo: "retorno antes do início" }); continue; }
    const absences = absencesByEmployee.get(employee.id) ?? [];
    if (absences.some((absence) => absence.start_date === row.inicio)) { plan.jaImportado.push({ row, employee }); continue; }
    const placeholder = open ? absences.find((absence) => absence.is_placeholder && absence.end_date === null) : null;
    plan.aplicar.push({ row, employee, kind, endDate, open, notes, replace: placeholder?.id ?? null });
  }
  return plan;
}

async function main() {
  const folgas = parse(FOLGAS);
  const afastamentos = parse(AFASTAMENTOS);
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  try {
    const employees = new Map((await pool.query(`SELECT e.id, e.name, e.status, e.service_front_id, e.cycle_work_days, e.cycle_off_days, sf.name AS front FROM employees e JOIN service_fronts sf ON sf.id = e.service_front_id`)).rows.map((row) => [nameKey(row.name), row]));
    const cycles = (await pool.query(
      `SELECT id, employee_id, cycle_number, work_start AS "workStart", front_departure AS "frontDeparture", home_arrival AS "homeArrival", home_departure AS "homeDeparture", front_arrival AS "frontArrival",
              (work_start IS NULL AND front_departure IS NULL AND home_departure IS NULL AND front_arrival IS NULL AND ended_at IS NULL AND notes LIKE ANY($1::text[])) AS is_placeholder
       FROM employee_leave_cycles ORDER BY employee_id, cycle_number`, [PLACEHOLDER_CYCLE],
    )).rows;
    const absences = (await pool.query(`SELECT id, employee_id, kind, start_date, end_date, (notes LIKE $1) AS is_placeholder FROM employee_absences`, [PLACEHOLDER_ABSENCE])).rows;
    const group = (list) => list.reduce((map, item) => map.set(item.employee_id, [...(map.get(item.employee_id) ?? []), item]), new Map());

    const cyclePlan = planCycles(folgas, employees, group(cycles));
    const absencePlan = planAbsences(afastamentos, employees, group(absences));

    linha();
    console.log(`${CONFIRMAR ? "IMPORTAÇÃO" : "SIMULAÇÃO (nada será gravado)"} — histórico de funcionários de ${BR(DATA_DOC)}`);
    linha();
    console.log(`FOLGAS (${folgas.length} linhas)`);
    console.log(`  Ciclos a gravar ............ ${cyclePlan.aplicar.length} (${cyclePlan.aplicar.filter((item) => item.replace).length} substituem o ciclo provisório da relação)`);
    console.log(`  Já importados (pulados) .... ${cyclePlan.jaImportado.length}`);
    console.log(`  Com ciclo já lançado ....... ${cyclePlan.conflito.length}`);
    console.log(`  Não encontrados ............ ${cyclePlan.naoEncontrado.length}`);
    console.log(`  Ignorados .................. ${cyclePlan.ignorado.length}`);
    for (const item of cyclePlan.aplicar) console.log(`  + ${item.employee.name} (${item.employee.front}): ${STEPS.map((step) => BR(item.dates[step])).join(" › ")}${item.replace ? " [substitui provisório]" : ""}`);
    for (const item of cyclePlan.corrigido) console.log(`  ~ saída de casa ajustada: ${item.employee.name} (${BR(item.row.saida_casa)} > chegada ${BR(item.row.chegada_frente)})`);
    for (const item of cyclePlan.conflito) console.log(`  ! ${item.employee.name}: ${item.motivo} — não alterado`);
    for (const row of cyclePlan.naoEncontrado) console.log(`  ? não cadastrado: #${row.n} ${row.nome} (${row.empresa})`);
    for (const item of cyclePlan.ignorado) console.log(`  - ignorado: #${item.row.n} ${item.row.nome}: ${item.motivo}`);
    linha();
    console.log(`AFASTAMENTOS (${afastamentos.length} linhas)`);
    console.log(`  A gravar ................... ${absencePlan.aplicar.length} (${absencePlan.aplicar.filter((item) => item.open).length} em aberto, ${absencePlan.aplicar.filter((item) => item.replace).length} substituem o provisório da relação)`);
    console.log(`  Já importados (pulados) .... ${absencePlan.jaImportado.length}`);
    console.log(`  Não encontrados ............ ${absencePlan.naoEncontrado.length}`);
    console.log(`  Com problema ............... ${absencePlan.conflito.length}`);
    for (const item of absencePlan.aplicar) console.log(`  + ${item.employee.name} (${item.employee.front}): ${item.kind} ${BR(item.row.inicio)} a ${item.endDate ? BR(item.endDate) : "em aberto"}${item.open ? " — fica Afastado" : ""}${item.replace ? " [substitui provisório]" : ""}`);
    for (const row of absencePlan.naoEncontrado) console.log(`  ? não cadastrado: #${row.n} ${row.nome} (${row.funcao})`);
    for (const item of absencePlan.conflito) console.log(`  ! ${item.employee.name}: ${item.motivo}`);
    linha();

    if (!CONFIRMAR) {
      console.log("Simulação concluída. Rode com --confirmar (modo 'confirmar' no workflow) para gravar.");
      return;
    }

    const client = await pool.connect();
    const now = new Date().toISOString();
    try {
      await client.query("BEGIN");
      for (const item of cyclePlan.aplicar) {
        const { employee, dates } = item;
        const values = [dates.workStart || null, dates.frontDeparture || null, dates.homeArrival || null, dates.homeDeparture || null, dates.frontArrival || null, item.notes];
        if (item.replace) {
          await client.query(
            `UPDATE employee_leave_cycles SET work_start=$2, front_departure=$3, home_arrival=$4, home_departure=$5, front_arrival=$6, notes=$7, updated_at=$8 WHERE id=$1`,
            [item.replace, ...values, now],
          );
        } else {
          await client.query(
            `INSERT INTO employee_leave_cycles (employee_id, cycle_number, service_front_id, work_start, front_departure, home_arrival, home_departure, front_arrival, notes, work_days_target, off_days_target) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [employee.id, employee.service_front_id, ...values, employee.cycle_work_days, employee.cycle_off_days],
          );
        }
        let status = employee.status;
        if (dates.frontArrival) {
          await client.query(
            `INSERT INTO employee_leave_cycles (employee_id, cycle_number, service_front_id, work_start, work_days_target, off_days_target, notes) VALUES ($1, 2, $2, $3, $4, $5, $6)`,
            [employee.id, employee.service_front_id, dates.frontArrival, employee.cycle_work_days, employee.cycle_off_days, `Aberto na chegada à frente do ciclo 1 (${ORIGEM.toLowerCase()})`],
          );
          if (status === "FOLGA") status = "ATIVO";
        } else if (status === "ATIVO" && dates.frontDeparture) {
          status = "FOLGA";
        }
        if (status !== employee.status) await client.query(`UPDATE employees SET status=$2, updated_at=$3 WHERE id=$1`, [employee.id, status, now]);
        await client.query(
          `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, new_value) VALUES (NULL, 'EMPLOYEE', $1, 'CICLO DE FOLGA IMPORTADO', $2)`,
          [String(employee.id), JSON.stringify({ ...dates, status, origem: ORIGEM })],
        );
      }
      for (const item of absencePlan.aplicar) {
        const { employee } = item;
        if (item.replace) {
          await client.query(`UPDATE employee_absences SET kind=$2, start_date=$3, end_date=$4, notes=$5, updated_at=$6 WHERE id=$1`, [item.replace, item.kind, item.row.inicio, item.endDate, item.notes, now]);
        } else {
          await client.query(`INSERT INTO employee_absences (employee_id, kind, start_date, end_date, notes) VALUES ($1,$2,$3,$4,$5)`, [employee.id, item.kind, item.row.inicio, item.endDate, item.notes]);
        }
        if (item.open && employee.status !== "AFASTADO" && employee.status !== "DEMITIDO") {
          await client.query(`UPDATE employees SET status='AFASTADO', updated_at=$2 WHERE id=$1`, [employee.id, now]);
          employee.status = "AFASTADO";
        }
        await client.query(
          `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, new_value) VALUES (NULL, 'EMPLOYEE', $1, 'AFASTAMENTO IMPORTADO', $2)`,
          [String(employee.id), JSON.stringify({ kind: item.kind, startDate: item.row.inicio, endDate: item.endDate, motivo: item.row.motivo, origem: ORIGEM })],
        );
      }
      await client.query("COMMIT");
      console.log(`Importação concluída: ${cyclePlan.aplicar.length} ciclos de folga e ${absencePlan.aplicar.length} afastamentos gravados.`);
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
