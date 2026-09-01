import "dotenv/config";
import pg from "pg";

// ---------------------------------------------------------------------------
// Diagnostico de um erro real ao salvar Atualizacao Operacional / Status da
// Frota. NAO grava nada: toda a tentativa roda dentro de uma transacao que
// termina sempre em ROLLBACK, so pra revelar a mensagem de erro verdadeira
// do Postgres (constraint, FK, trigger etc.), igual diagnostico-db.mjs faz
// para a conexao.
//
// Uso: node diagnosticar-fleet-status.mjs PREFIXO
// ---------------------------------------------------------------------------

const prefixoAlvo = process.argv[2];
if (!prefixoAlvo) {
  console.error("Uso: node diagnosticar-fleet-status.mjs PREFIXO");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não encontrada.");
  process.exit(1);
}

function linha() {
  console.log("-".repeat(78));
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });

async function equipmentByPrefix(client, prefix) {
  const { rows } = await client.query(
    `SELECT e.id,e.prefix,e.code,e.type,e.status,e.service_front_id,sf.name AS front_name,e.oil_change_enabled,e.control_type,e.current_hours,e.current_km
     FROM equipment e LEFT JOIN service_fronts sf ON sf.id=e.service_front_id WHERE e.prefix=$1`,
    [prefix],
  );
  return rows[0] ?? null;
}

async function fleetCurrentStatus(client, equipmentId) {
  const { rows } = await client.query(`SELECT * FROM fleet_current_status WHERE equipment_id=$1`, [equipmentId]);
  return rows[0] ?? null;
}

async function algumUsuarioId(client) {
  const { rows } = await client.query(`SELECT id FROM users ORDER BY id LIMIT 1`);
  if (!rows[0]) throw new Error("Nenhum usuário cadastrado para usar no diagnóstico.");
  return Number(rows[0].id);
}

async function tentarAtualizacao(client, equipmentId, frontId, userId, label) {
  linha();
  console.log(`TENTATIVA (dry-run, sera desfeita): ${label} (equipment_id=${equipmentId})`);
  await client.query("SAVEPOINT tentativa");
  try {
    const eventId = "00000000-0000-4000-8000-000000000000";
    const occurrenceId = `OC-DIAGNOSTICO-${Date.now()}`;
    const now = new Date().toISOString();
    const reason = "";
    const problemDescription = "";
    const location = "";
    const servicePerformed = "";
    const partsUsed = "";
    const notes = "DIAGNOSTICO - NAO E DADO REAL";
    const serviceDescription = "AGUARDANDO PEÇA PARA CONTINUAR SERVIÇO (DIAGNOSTICO)";
    await client.query(
      `INSERT INTO fleet_occurrences (id,equipment_id,service_front_id,started_at,reason,problem_description,location,notes,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$9)`,
      [occurrenceId, equipmentId, frontId, now, reason || null, problemDescription || null, location || null, notes || null, now],
    );
    // Réplica EXATA da query real de app/api/fleet-status/route.ts (a mesma
    // que roda logo em seguida sobre a ocorrência recem-criada).
    const endedAt = null; // status não é READY nem OPERATING
    const returnedAt = null;
    await client.query(
      `UPDATE fleet_occurrences SET
        reason=CASE WHEN $1<>'' THEN $2 ELSE reason END,
        problem_description=CASE WHEN $3<>'' THEN $4 ELSE problem_description END,
        location=CASE WHEN $5<>'' THEN $6 ELSE location END,
        service_performed=CASE WHEN $7<>'' THEN $8 ELSE service_performed END,
        parts_used=CASE WHEN $9<>'' THEN $10 ELSE parts_used END,
        notes=CASE WHEN $11<>'' THEN $12 ELSE notes END,
        ended_at=COALESCE(ended_at,$13),returned_to_operation_at=COALESCE(returned_to_operation_at,$14),
        closed_by=CASE WHEN $15::text IS NOT NULL THEN $16 ELSE closed_by END,updated_at=$17 WHERE id=$18`,
      [reason, reason, problemDescription, problemDescription, location, location, servicePerformed, servicePerformed,
        partsUsed, partsUsed, notes, notes, endedAt, returnedAt, endedAt, userId, now, occurrenceId],
    );
    await client.query(
      `INSERT INTO fleet_status_events (id,occurrence_id,equipment_id,service_front_id,previous_status,new_status,occurred_at,reason,problem_description,service_description,service_performed,location,notes,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$14)`,
      [eventId, occurrenceId, equipmentId, frontId, "OPERATING", "WAITING_PART", now, reason || null, problemDescription || null, serviceDescription || null, servicePerformed || null, location || null, notes || null, now],
    );
    await client.query(
      `INSERT INTO fleet_current_status (equipment_id,status,since_at,active_occurrence_id,latest_event_id,updated_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$6) ON CONFLICT(equipment_id) DO UPDATE SET status=excluded.status,since_at=excluded.since_at,
       active_occurrence_id=excluded.active_occurrence_id,latest_event_id=excluded.latest_event_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      [equipmentId, "WAITING_PART", now, occurrenceId, eventId, now],
    );
    const mechanicName = "DIAGNOSTICO TESTE";
    await client.query(
      `INSERT INTO fleet_mechanics (id,name,active,created_at,updated_at) VALUES ($1,$2,TRUE,$3,$3) ON CONFLICT(name) DO UPDATE SET active=TRUE,updated_at=excluded.updated_at`,
      ["00000000-0000-4000-8000-000000000001", mechanicName, now],
    );
    await client.query(
      `INSERT INTO fleet_event_mechanics (id,event_id,mechanic_name,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)`,
      ["00000000-0000-4000-8000-000000000002", eventId, mechanicName, "RESPONSIBLE", now],
    );
    console.log("  RESULTADO: sucesso (nenhum erro do Postgres).");
  } catch (error) {
    console.log("  RESULTADO: ERRO REAL DO POSTGRES:");
    console.log(`    message: ${error.message}`);
    if (error.code) console.log(`    code:    ${error.code}`);
    if (error.detail) console.log(`    detail:  ${error.detail}`);
    if (error.table) console.log(`    table:   ${error.table}`);
    if (error.column) console.log(`    column:  ${error.column}`);
    if (error.constraint) console.log(`    constraint: ${error.constraint}`);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT tentativa");
  }
}

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const alvo = await equipmentByPrefix(client, prefixoAlvo);
    if (!alvo) {
      console.log(`Equipamento com prefixo "${prefixoAlvo}" não encontrado.`);
    } else {
      linha();
      console.log(`EQUIPAMENTO ALVO: ${prefixoAlvo}`);
      console.log(alvo);
      const statusAlvo = await fleetCurrentStatus(client, alvo.id);
      console.log("fleet_current_status existente:", statusAlvo ?? "(nenhum registro ainda)");
    }

    const { rows: antigosComStatus } = await client.query(
      `SELECT e.id,e.prefix,e.code,e.type,e.status,e.service_front_id,e.oil_change_enabled,e.control_type,cs.status AS fleet_status
       FROM equipment e INNER JOIN fleet_current_status cs ON cs.equipment_id=e.id ORDER BY e.id LIMIT 1`,
    );
    const antigo = antigosComStatus[0] ?? null;
    linha();
    console.log("EQUIPAMENTO ANTIGO DE COMPARAÇÃO (já tem fleet_current_status):");
    console.log(antigo ?? "(nenhum equipamento com fleet_current_status no banco)");

    const userId = await algumUsuarioId(client);
    if (alvo) await tentarAtualizacao(client, alvo.id, alvo.service_front_id, userId, `${prefixoAlvo} (importado)`);
    if (antigo) await tentarAtualizacao(client, antigo.id, antigo.service_front_id, userId, `${antigo.prefix} (antigo, já funcionava)`);

    await client.query("ROLLBACK");
    linha();
    console.log("Nada foi gravado (ROLLBACK no final, como esperado para um diagnóstico).");
    linha();
  } finally {
    client.release();
  }
} catch (error) {
  console.error("ERRO GERAL:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
