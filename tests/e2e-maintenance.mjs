import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const port = 5175;
const origin = `http://127.0.0.1:${port}`;
const password = "LocalE2E-Only-2026";
const automaticSuffix = crypto.randomUUID().slice(0, 8).toUpperCase();
const automaticPrefix = `PC-AUTO-${automaticSuffix}`;
const historyFirstPrefix = `CM-HIST-${automaticSuffix}`;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localD1Directory = join(projectRoot, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const localD1File = readdirSync(localD1Directory).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
if (!localD1File) throw new Error("Banco D1 local não encontrado; inicie a prévia uma vez antes do E2E.");
const localD1 = new DatabaseSync(join(localD1Directory, localD1File));
const hasSchema = localD1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_bootstrap'").get();
if (!hasSchema) {
  for (const migrationFile of readdirSync(join(projectRoot, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    localD1.exec(readFileSync(join(projectRoot, "drizzle", migrationFile), "utf8"));
  }
}
const hasHistoryConsistencyIndex = localD1.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='maintenances_equipment_plan_performed_unique'").get();
if (!hasHistoryConsistencyIndex) localD1.exec(readFileSync(join(projectRoot, "drizzle/0008_history_consistency.sql"), "utf8"));
const hasIntervalConfig = localD1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='maintenance_interval_configs'").get();
if (!hasIntervalConfig) localD1.exec(readFileSync(join(projectRoot, "drizzle/0009_new_rumiko_fujikawa.sql"), "utf8"));
const importedBackfillReady = localD1.prepare("SELECT 1 AS ready FROM maintenance_types WHERE name='TROCA DE ÓLEO DA TRANSMISSÃO' AND description='Troca de óleo da transmissão'").get();
if (!importedBackfillReady) localD1.exec(readFileSync(join(projectRoot, "drizzle/0010_recalculate_imported_history.sql"), "utf8"));
const currentReadingsReady = localD1.prepare("SELECT current_hours AS value FROM equipment WHERE prefix='PC-20'").get();
if (Number(currentReadingsReady?.value) !== 7006.3) localD1.exec(readFileSync(join(projectRoot, "drizzle/0011_update_current_equipment_readings.sql"), "utf8"));
const hasQrToken = localD1.prepare("SELECT 1 AS ready FROM pragma_table_info('equipment') WHERE name='qr_token'").get();
if (!hasQrToken) localD1.exec(readFileSync(join(projectRoot, "drizzle/0012_aromatic_ken_ellis.sql"), "utf8"));
const hasReadingSource = localD1.prepare("SELECT 1 AS ready FROM pragma_table_info('meter_readings') WHERE name='source'").get();
if (!hasReadingSource) localD1.exec(readFileSync(join(projectRoot, "drizzle/0015_cloudy_puma.sql"), "utf8"));
const hasImportedAssociation = localD1.prepare("SELECT 1 AS ready FROM pragma_table_info('imported_maintenance_history') WHERE name='equipment_id'").get();
if (!hasImportedAssociation) localD1.exec(readFileSync(join(projectRoot, "drizzle/0019_cold_skaar.sql"), "utf8"));
const importedCurrentHours = localD1.prepare("SELECT current_hours AS value,control_type AS control FROM equipment WHERE prefix='PC-20'").get();
const importedCurrentKm = localD1.prepare("SELECT current_km AS value,control_type AS control FROM equipment WHERE prefix='CM-20'").get();
const pc20QrToken = localD1.prepare("SELECT qr_token AS token FROM equipment WHERE prefix='PC-20'").get()?.token;
assert.equal(importedCurrentHours?.value, 7006.3, "PC-20 deve receber o horímetro brasileiro normalizado");
assert.equal(importedCurrentHours?.control, "HOURS", "PC deve continuar em horas");
assert.equal(importedCurrentKm?.value, 139711.4, "CM-20 deve receber a quilometragem brasileira normalizada");
assert.equal(importedCurrentKm?.control, "KM", "CM deve continuar em quilômetros");
assert.match(String(pc20QrToken), /^[a-f0-9]{32}$/, "PC-20 deve receber identificador permanente do QR Code");
const automaticEquipment = localD1.prepare(`INSERT INTO equipment
  (code,prefix,type,brand,model,serial_number,current_hours,current_km,control_type,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,7180,0,'HOURS','ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
  .run(`AUTO-${automaticSuffix}`, automaticPrefix, "Pá carregadeira de teste", "Sites QA", "Cálculo pelo Histórico", `AUTO-SER-${automaticSuffix}`);
const automaticEquipmentId = Number(automaticEquipment.lastInsertRowid);
const insertImported = localD1.prepare(`INSERT INTO imported_maintenance_history
  (prefix,service,reading_raw,reading_value,control_type,performed_at,source,created_at,updated_at)
  VALUES (?,?,?,?,? ,?,'TESTE_LOCAL',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
insertImported.run(automaticPrefix, "Troca de óleo do motor", "6500", 6500, "HOURS", "2026-05-01");
insertImported.run(automaticPrefix, "Troca de óleo do motor", "6750", 6750, "HOURS", "2026-06-01");
insertImported.run(automaticPrefix, "Troca de óleo do motor", "7100", 7100, "HOURS", "2026-04-01");
insertImported.run(automaticPrefix, "Troca de óleo do motor", "7000", 7000, "HOURS", "2026-07-01");
insertImported.run(automaticPrefix, "Troca de óleo da transmissão", "6000", 6000, "HOURS", "2026-07-02");
insertImported.run(historyFirstPrefix, "Troca de óleo da caixa de marcha", "94386", 94386, "KM", "2025-05-11");
insertImported.run(historyFirstPrefix, "Troca de óleo do motor", "95123", 95123, "KM", "2025-08-15");
insertImported.run(historyFirstPrefix, "Troca de óleo do motor", "124673", 124673, "KM", "2026-06-20");
insertImported.run(historyFirstPrefix, "Troca de óleo do diferencial dianteiro", "125147", 125147, "KM", "2026-07-11");
insertImported.run(historyFirstPrefix, "Troca de óleo do diferencial traseiro", "125147", 125147, "KM", "2026-07-11");
localD1.close();
const server = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, SITES_E2E_ADMIN_PASSWORD: password },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Servidor local não iniciou.\n${output}`);
}

let cookie = "";
async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
}

try {
  await waitForServer();

  const publicQr = (await request(`/api/qr/${pc20QrToken}`)).body;
  assert.equal(publicQr.equipment.prefix, "PC-20");
  assert.equal(publicQr.equipment.currentHours, 7006.3);
  assert.equal(publicQr.viewer.authenticated, false, "consulta pelo QR deve ser pública");
  assert.ok(publicQr.plans.some((plan) => plan.name === "TROCA DE ÓLEO DO MOTOR"));

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ credential: "mathews", password }),
  });
  cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie.startsWith("maintenance_session="), "login deve criar sessão");
  const authorizedQr = (await request(`/api/qr/${pc20QrToken}`)).body;
  assert.equal(authorizedQr.viewer.canUpdateReading, true);
  assert.equal(authorizedQr.viewer.canRegisterMaintenance, true);

  const historyFirstCreation = await request("/api/equipment", {
    method: "POST",
    body: JSON.stringify({
      prefix: historyFirstPrefix.toLowerCase().replace("-", " - "),
      type: "Caminhão de teste",
      brand: "Sites QA",
      model: "Histórico antes do cadastro",
      year: 2026,
      front: "Frente E2E isolada",
      controlType: "HOURS",
      status: "ACTIVE",
      identificationType: "CHASSIS",
      identificationValue: `CHASSIS-${automaticSuffix}`,
      currentHours: 133665,
      currentKm: 132718,
    }),
  });
  const historyFirstEquipmentId=historyFirstCreation.body.equipment.id;
  assert.equal(historyFirstCreation.body.equipment.control,"KM","CM cadastrado incorretamente em horas deve ser reconciliado para KM");
  assert.equal(historyFirstCreation.body.equipment.km,133665,"a leitura deve ser reclassificada sem conversão matemática");

  const initial = (await request("/api/system")).body;
  assert.ok(initial.maintenanceTypes.length >= 5, "tipos de óleo e filtros devem existir");
  const historyFirstEquipment=initial.equipment.find((item)=>item.id===historyFirstEquipmentId);
  assert.ok(historyFirstEquipment,"equipamento criado depois do Histórico deve existir");
  assert.equal(historyFirstEquipment.control,"KM");
  assert.equal(historyFirstEquipment.km,133665);
  const historyFirstPlans=new Map(historyFirstEquipment.plans.map((plan)=>[plan.name,plan.state]));
  assert.deepEqual(
    ["TROCA DE ÓLEO DA CAIXA DE MARCHA","TROCA DE ÓLEO DO DIFERENCIAL DIANTEIRO","TROCA DE ÓLEO DO DIFERENCIAL TRASEIRO","TROCA DE ÓLEO DO MOTOR"].map((name)=>{
      const state=historyFirstPlans.get(name);return [state?.lastValue,state?.interval,state?.nextValue,state?.remaining,state?.unit];
    }),
    [[94386,40000,134386,721,"KM"],[125147,30000,155147,21482,"KM"],[125147,30000,155147,21482,"KM"],[124673,12000,136673,3008,"KM"]],
    "o Plano deve nascer calculado pelo Histórico anterior ao equipamento",
  );
  assert.ok(initial.history.filter((item)=>item.kind==="IMPORTED"&&item.equipmentId===historyFirstEquipmentId).length>=5,"os registros antigos devem continuar visíveis e associados");
  const associationCheck=new DatabaseSync(join(localD1Directory,localD1File),{readOnly:true});
  const persistedAssociations=associationCheck.prepare("SELECT COUNT(*) AS total FROM imported_maintenance_history WHERE prefix=? AND equipment_id=? AND maintenance_type_id IS NOT NULL").get(historyFirstPrefix,historyFirstEquipmentId);
  associationCheck.close();
  assert.equal(persistedAssociations?.total,5,"a reconciliação deve persistir equipment_id e maintenance_type_id sem duplicar o Histórico");
  const automatic = initial.equipment.find((item) => item.id === automaticEquipmentId);
  assert.ok(automatic, "equipamento de validação automática deve existir");
  const automaticMotor = automatic.plans.find((plan) => plan.name === "TROCA DE ÓLEO DO MOTOR");
  const automaticTransmission = automatic.plans.find((plan) => plan.name === "TROCA DE ÓLEO DA TRANSMISSÃO");
  assert.equal(automaticMotor.state.lastValue, 7000, "deve usar a última troca real por data");
  assert.equal(automaticMotor.state.interval, 250);
  assert.equal(automaticMotor.state.nextValue, 7250);
  assert.equal(automaticMotor.state.remaining, 70);
  assert.equal(automaticTransmission.state.lastValue, 6000, "transmissão deve ter ciclo independente");
  assert.equal(automaticTransmission.state.interval, 2000);
  assert.equal(automaticTransmission.state.nextValue, 8000);
  assert.equal(automaticTransmission.state.remaining, 820);
  const importedMotor = initial.history.find((item) => item.kind === "IMPORTED" && item.equipmentId === automaticEquipmentId && item.newReading === 7000);
  assert.equal(importedMotor.interval, 250);
  assert.equal(importedMotor.nextReading, 7250);

  await request("/api/readings", {
    method: "POST",
    body: JSON.stringify({ equipmentId: automaticEquipmentId, readingDate: new Date().toISOString(), hours: 7200, operator: "Teste automatizado" }),
  });
  const afterAutomaticReading = (await request("/api/system")).body.equipment.find((item) => item.id === automaticEquipmentId);
  const motorAfterReading = afterAutomaticReading.plans.find((plan) => plan.name === "TROCA DE ÓLEO DO MOTOR");
  assert.equal(motorAfterReading.state.nextValue, 7250, "nova leitura não pode deslocar a próxima troca");
  assert.equal(motorAfterReading.state.remaining, 50, "somente o restante deve mudar");

  await request("/api/readings", {
    method: "POST",
    body: JSON.stringify({ equipmentId: automaticEquipmentId, readingDate: new Date(Date.now()+1_000).toISOString(), hours: 7300, operator: "Teste PDF vencidos" }),
  });
  const overduePdfResponse = await fetch(`${origin}/api/overdue-pdf`, { headers: { Cookie: cookie } });
  assert.equal(overduePdfResponse.status, 200, "PDF consolidado dos vencidos deve ser gerado");
  assert.match(overduePdfResponse.headers.get("content-type")??"", /^application\/pdf\b/);
  assert.match(overduePdfResponse.headers.get("content-disposition")??"", /manutencoes-vencidas-\d{4}-\d{2}-\d{2}\.pdf/);
  const overduePdfBytes = new Uint8Array(await overduePdfResponse.arrayBuffer());
  assert.equal(new TextDecoder().decode(overduePdfBytes.slice(0,4)), "%PDF");
  assert.ok(overduePdfBytes.length>1_000, "PDF consolidado deve conter o relatório completo");

  const importRows = [
    { rowNumber: 2, equipment: automaticPrefix.toLowerCase().replaceAll("-", ""), reading: 7350, readingRaw: "7.350", responsible: "EMERSON", readingDate: new Date().toISOString(), notes: "Teste de importação", front: "" },
    { rowNumber: 3, equipment: "CM-99", reading: 75000, readingRaw: "75000", responsible: "FABRICIO", readingDate: null, notes: "", front: "" },
    { rowNumber: 4, equipment: "CM-20", reading: 1, readingRaw: "1", responsible: "RAFAEL", readingDate: null, notes: "", front: "" },
  ];
  const importAnalysis = (await request("/api/reading-imports", { method: "POST", body: JSON.stringify({ action: "ANALYZE", fileName: "leituras-e2e.xlsx", rows: importRows }) })).body;
  assert.equal(importAnalysis.summary.ready, 1, "prefixo sem hífen e minúsculo deve localizar um único equipamento");
  assert.equal(importAnalysis.rows[0].unit, "HOURS", "a unidade deve vir do cadastro real do equipamento");
  assert.equal(importAnalysis.rows[1].code, "EQUIPMENT_NOT_FOUND");
  assert.equal(importAnalysis.rows[2].code, "READING_REGRESSION", "leitura inferior deve ser bloqueada");
  const duplicateAnalysis = (await request("/api/reading-imports", { method: "POST", body: JSON.stringify({ action: "ANALYZE", fileName: "duplicados.csv", rows: [importRows[0], { ...importRows[0], rowNumber: 5, reading: 7360, readingRaw: "7360" }] }) })).body;
  assert.equal(duplicateAnalysis.summary.ready, 0);
  assert.ok(duplicateAnalysis.rows.every((row) => row.code === "DUPLICATE_IN_FILE"));
  const importResult = (await request("/api/reading-imports", { method: "POST", body: JSON.stringify({ action: "CONFIRM", fileName: "leituras-e2e.xlsx", rows: importRows }) })).body;
  assert.equal(importResult.updated, 1);
  assert.equal(importResult.errorRows.length, 2);
  const afterExcelImport = (await request("/api/system")).body;
  assert.equal(afterExcelImport.equipment.find((item) => item.id === automaticEquipmentId).hours, 7350);
  assert.ok(afterExcelImport.history.some((item) => item.equipmentId === automaticEquipmentId && item.kind === "READING" && item.method === "IMPORTAÇÃO EXCEL"), "Histórico deve registrar o método da importação");

  assert.ok(importedMotor.sourceId > 0 && importedMotor.maintenanceTypeId > 0, "Histórico importado deve expor os identificadores seguros para edição");
  await request("/api/history", {
    method: "PUT",
    body: JSON.stringify({
      id: importedMotor.sourceId,
      kind: "IMPORTED",
      prefix: automaticPrefix,
      maintenanceTypeId: importedMotor.maintenanceTypeId,
      performedAt: "2026-07-03T12:00:00.000Z",
      reading: 7010,
      unit: "HOURS",
    }),
  });
  const afterImportedEdit = (await request("/api/system")).body;
  const editedImported = afterImportedEdit.history.find((item) => item.id === importedMotor.id);
  assert.equal(editedImported.newReading, 7010, "edição deve persistir no Histórico importado");
  assert.equal(afterImportedEdit.equipment.find((item) => item.id === automaticEquipmentId).plans.find((plan) => plan.name === "TROCA DE ÓLEO DO MOTOR").state.nextValue, 7260, "edição importada deve recalcular o ciclo");
  await request("/api/history", { method: "DELETE", body: JSON.stringify({ id: importedMotor.sourceId, kind: "IMPORTED" }) });
  const afterImportedDelete = (await request("/api/system")).body;
  assert.equal(afterImportedDelete.history.some((item) => item.id === importedMotor.id), false, "exclusão deve remover o registro importado");
  assert.equal(afterImportedDelete.equipment.find((item) => item.id === automaticEquipmentId).plans.find((plan) => plan.name === "TROCA DE ÓLEO DO MOTOR").state.nextValue, 7000, "exclusão importada deve recalcular pela troca anterior");

  const selectedTypes = initial.maintenanceTypes.slice(0, 2);
  assert.equal(selectedTypes.length, 2);

  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const prefix = `E2E-${suffix}`;
  const equipmentResult = await request("/api/equipment", {
    method: "POST",
    body: JSON.stringify({
      prefix,
      type: "Escavadeira de teste",
      brand: "Sites QA",
      model: "Fluxo Integrado",
      year: 2026,
      front: "Frente E2E isolada",
      controlType: "HOURS_KM",
      status: "ACTIVE",
      identificationType: "SERIAL_NUMBER",
      identificationValue: `SER-${suffix}`,
      currentHours: 100,
      currentKm: 1_000,
      applicableMaintenanceTypes: selectedTypes.map((item) => item.name),
    }),
  });
  const equipmentId = equipmentResult.body.equipment.id;
  assert.ok(equipmentId > 0, "equipamento deve receber ID persistente");

  await request("/api/plans", {
    method: "PUT",
    body: JSON.stringify({
      equipmentId,
      plans: [
        { maintenanceTypeId: selectedTypes[0].id, triggerMode: "HOURS", interval: 500 },
        { maintenanceTypeId: selectedTypes[1].id, triggerMode: "KM", interval: 10_000 },
      ],
    }),
  });

  await request("/api/readings", {
    method: "POST",
    body: JSON.stringify({
      equipmentId,
      readingDate: new Date().toISOString(),
      hours: 150,
      km: 1_500,
      operator: "Teste automatizado",
      notes: "Validação local isolada",
    }),
  });

  const afterReading = (await request("/api/system")).body;
  const persisted = afterReading.equipment.find((item) => item.id === equipmentId);
  assert.equal(persisted.hours, 150);
  assert.equal(persisted.km, 1_500);
  assert.equal(persisted.plans.length, 2);
  assert.ok(afterReading.readings.some((item) => item.equipmentId === equipmentId));

  const selectedPlanIds = persisted.plans.map((plan) => plan.id);
  const performedAt = new Date().toISOString();
  const maintenancePayload = {
    equipmentId,
    planIds: selectedPlanIds,
    performedAt,
    hours: 150,
    km: 1_500,
    notes: "Óleo e filtros validados em conjunto",
    cost: 250,
  };
  const maintenance = await request("/api/maintenance", {
    method: "POST",
    body: JSON.stringify(maintenancePayload),
  });
  assert.equal(maintenance.body.maintenanceCount, 2);
  assert.equal(maintenance.body.duplicate, false);
  assert.equal(maintenance.body.historyIds.length, 2);

  const finalSnapshot = (await request("/api/system")).body;
  const finalEquipment = finalSnapshot.equipment.find((item) => item.id === equipmentId);
  const historyEntries = finalSnapshot.history.filter((item) => item.equipmentId === equipmentId && item.kind === "MAINTENANCE");
  assert.equal(finalEquipment.plans.length, 2);
  assert.ok(finalEquipment.plans.every((plan) => plan.state.level === "OK"));
  assert.equal(historyEntries.length, 2);
  assert.deepEqual(new Set(historyEntries.map((item) => item.interval)), new Set([500, 10_000]));
  assert.deepEqual(new Set(historyEntries.map((item) => item.nextReading)), new Set([650, 11_500]));
  assert.ok(historyEntries.every((item) => item.maintenanceId > 0 && item.recordedAt && item.responsible === "Mathews"));
  assert.equal(finalSnapshot.alerts.filter((item) => item.equipmentId === equipmentId).length, 2);

  const historyEndpoint = (await request("/api/history")).body.history;
  assert.equal(historyEndpoint.filter((item) => item.equipmentId === equipmentId && item.kind === "MAINTENANCE").length, 2);

  const repeated = await request("/api/maintenance", { method: "POST", body: JSON.stringify(maintenancePayload) });
  assert.equal(repeated.body.duplicate, true);
  assert.deepEqual(repeated.body.maintenanceIds, maintenance.body.maintenanceIds);

  const editableMaintenance = historyEntries[0];
  const editedReading = editableMaintenance.newReading + 25;
  await request("/api/history", {
    method: "PUT",
    body: JSON.stringify({
      id: editableMaintenance.sourceId,
      kind: "MAINTENANCE",
      equipmentId,
      maintenanceTypeId: editableMaintenance.maintenanceTypeId,
      performedAt: new Date(Date.now() + 1_000).toISOString(),
      reading: editedReading,
      mechanic: "Editor E2E",
      workOrder: `EDIT-${suffix}-${editableMaintenance.sourceId}`,
      cost: 275,
      notes: "Histórico corrigido pelo teste",
    }),
  });
  const afterMaintenanceEdit = (await request("/api/history")).body.history.find((item) => item.id === editableMaintenance.id);
  assert.equal(afterMaintenanceEdit.newReading, editedReading);
  assert.equal(afterMaintenanceEdit.responsible, "Editor E2E");
  assert.equal(afterMaintenanceEdit.workOrder, `EDIT-${suffix}-${editableMaintenance.sourceId}`);
  assert.equal(afterMaintenanceEdit.nextReading, editedReading + editableMaintenance.interval, "edição deve recalcular a próxima troca");
  await request("/api/history", { method: "DELETE", body: JSON.stringify({ id: editableMaintenance.sourceId, kind: "MAINTENANCE" }) });

  const afterReload = (await request("/api/system")).body;
  assert.equal(afterReload.history.filter((item) => item.equipmentId === equipmentId && item.kind === "MAINTENANCE").length, 1);
  assert.equal(afterReload.alerts.filter((item) => item.equipmentId === equipmentId).length, 1, "exclusão deve remover o ciclo sem Histórico e recalcular alertas");

  process.stdout.write("E2E concluído: Histórico importado e manual editado/excluído, ciclos recalculados, leitura preservada, alertas, recarga e antirrepetição.\n");
} catch (error) {
  process.stderr.write(`${output}\n`);
  throw error;
} finally {
  process.kill(-server.pid, "SIGTERM");
}
