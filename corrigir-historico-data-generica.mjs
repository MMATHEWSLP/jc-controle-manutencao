// Correção idempotente e auditável dos históricos de troca de óleo IMPORTADOS
// que ficaram sem data de execução (nula, vazia ou inválida). Aplica a data
// genérica autorizada (2026-07-05, ou seja, 05/07/2026 — dia 5, mês 7) e
// marca o registro como is_generic_date=TRUE / date_source='IMPORT_DEFAULT',
// para que a interface nunca a apresente como uma data original confirmada.
//
// Nunca toca em:
//  - históricos manuais (tabela "maintenances", performed_at é NOT NULL lá);
//  - históricos importados que já têm data válida;
//  - históricos sem NENHUMA leitura (não é possível confirmar que representam
//    uma troca realmente executada — ficam intactos, listados para revisão);
//  - equipamento, categoria/tipo de troca, leituras, usuário, observações e
//    created_at/updated_at (updated_at só muda porque a linha foi de fato
//    atualizada, o que já é o padrão do projeto para toda escrita).
//
// Idempotente: rodar de novo não altera nada, porque a segunda execução não
// encontra mais candidatos (a condição de seleção exige is_generic_date=FALSE
// e data ausente/inválida; depois da correção a data passa a ser válida).
//
// Uso:
//   node corrigir-historico-data-generica.mjs                -> dry-run (nada é gravado)
//   node corrigir-historico-data-generica.mjs --confirmar     -> aplica a correção real
import "dotenv/config";
import { Pool } from "pg";
import { GENERIC_DATE, GENERIC_DATE_SOURCE, genericDateAuditPayload, isEligibleForGenericDate, isValidDateText } from "./scripts/generic-date-correction/logic.mjs";

const CONFIRMAR = process.argv.includes("--confirmar");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function linha() {
  console.log("-".repeat(78));
}

async function main() {
  console.log(`=== Correção de data genérica — Histórico de Troca de Óleo (${CONFIRMAR ? "CONFIRMAR" : "DRY-RUN"}) ===`);
  linha();

  const { rows: candidates } = await pool.query(`
    SELECT id, prefix, service, reading_raw, reading_value, control_type, performed_at, is_generic_date, date_source, equipment_id, maintenance_type_id
    FROM imported_maintenance_history
    WHERE is_generic_date IS NOT TRUE
    ORDER BY id
  `);

  const asPure = (row) => ({ performedAt: row.performed_at, readingValue: row.reading_value });
  const withoutValidDate = candidates.filter((row) => !isValidDateText(row.performed_at));
  const eligible = withoutValidDate.filter((row) => isEligibleForGenericDate(asPure(row)));
  const ambiguous = withoutValidDate.filter((row) => !isEligibleForGenericDate(asPure(row)));

  console.log(`Total de históricos importados analisados: ${candidates.length}`);
  console.log(`Sem data válida: ${withoutValidDate.length}`);
  console.log(`  - elegíveis para a data genérica ${GENERIC_DATE} (têm leitura registrada): ${eligible.length}`);
  console.log(`  - ambíguos, mantidos intactos para revisão manual (sem leitura, não dá para confirmar que é uma troca executada): ${ambiguous.length}`);
  linha();

  if (ambiguous.length > 0) {
    console.log("Registros ambíguos (revisão manual, NENHUMA alteração será feita neles):");
    for (const row of ambiguous.slice(0, 30)) {
      console.log(`  #${row.id} prefix=${row.prefix} service="${row.service}" reading_raw="${row.reading_raw}" performed_at=${row.performed_at ?? "NULL"}`);
    }
    if (ambiguous.length > 30) console.log(`  ... e mais ${ambiguous.length - 30} registro(s).`);
    linha();
  }

  if (eligible.length === 0) {
    console.log("Nenhum registro elegível para correção. Nada a fazer.");
    await pool.end();
    return;
  }

  console.log(`Equipamentos afetados: ${new Set(eligible.map((row) => row.prefix)).size}`);
  console.log("Amostra dos registros que serão corrigidos (até 20):");
  for (const row of eligible.slice(0, 20)) {
    console.log(`  #${row.id} prefix=${row.prefix} service="${row.service}" leitura=${row.reading_value}${row.control_type === "KM" ? "km" : "h"} performed_at_atual=${row.performed_at ?? "NULL"}`);
  }
  if (eligible.length > 20) console.log(`  ... e mais ${eligible.length - 20} registro(s).`);
  linha();

  if (!CONFIRMAR) {
    console.log(`DRY-RUN: nenhuma alteração foi gravada. Rode com --confirmar para aplicar a correção em ${eligible.length} registro(s).`);
    await pool.end();
    return;
  }

  let corrected = 0;
  let skippedConflict = 0;
  const conflicts = [];
  for (const row of eligible) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const audit = genericDateAuditPayload({ performedAt: row.performed_at, isGenericDate: row.is_generic_date, dateSource: row.date_source });
      const updated = await client.query(
        `UPDATE imported_maintenance_history
         SET performed_at=$1, is_generic_date=TRUE, date_source=$3, updated_at=NOW()
         WHERE id=$2 AND is_generic_date IS NOT TRUE
         RETURNING id`,
        [GENERIC_DATE, row.id, GENERIC_DATE_SOURCE],
      );
      if (updated.rowCount === 0) { await client.query("ROLLBACK"); continue; }
      await client.query(
        `INSERT INTO audit_logs (user_id, entity_type, entity_id, action, previous_value, new_value, occurred_at)
         VALUES (NULL, 'IMPORTED_MAINTENANCE_HISTORY', $1, 'DATA GENÉRICA APLICADA (correção de histórico importado sem data original)', $2, $3, NOW())`,
        [String(row.id), JSON.stringify(audit.previousValue), JSON.stringify(audit.newValue)],
      );
      await client.query("COMMIT");
      corrected++;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        skippedConflict++;
        conflicts.push({ id: row.id, prefix: row.prefix, service: row.service, reading: row.reading_value });
      } else {
        throw error;
      }
    } finally {
      client.release();
    }
  }

  linha();
  console.log(`Registros corrigidos com sucesso: ${corrected}`);
  console.log(`Registros ignorados por conflito de unicidade (prefixo+serviço+leitura+data já usados por outro registro — mantidos intactos para revisão): ${skippedConflict}`);
  for (const conflict of conflicts) console.log(`  #${conflict.id} prefix=${conflict.prefix} service="${conflict.service}" leitura=${conflict.reading}`);

  const { rows: [after] } = await pool.query(`
    SELECT count(*) FILTER (WHERE performed_at = $1 AND is_generic_date) AS com_data_generica,
           count(*) FILTER (WHERE performed_at IS NULL OR performed_at !~ '^\\d{4}-\\d{2}-\\d{2}') AS ainda_sem_data_valida
    FROM imported_maintenance_history
  `, [GENERIC_DATE]);
  linha();
  console.log(`Validação final: ${after.com_data_generica} registro(s) agora com performed_at=${GENERIC_DATE} e is_generic_date=TRUE.`);
  console.log(`Registros que ainda não têm data válida (ambíguos, propositalmente não tocados): ${after.ainda_sem_data_valida}`);
  await pool.end();
}

main().catch(async (error) => { console.error(error); process.exitCode = 1; await pool.end(); });
