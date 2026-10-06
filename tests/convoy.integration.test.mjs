// Teste de integração dos abastecimentos do comboio num Postgres de teste já migrado.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:comboio-banco
// Cobre o lado do servidor do roteiro de teste: 3 registros (com foto, sem foto e com leitura menor)
// que sobem sem duplicar, ficam pendentes sem mexer no saldo (com "Saldo previsto"), correção +
// aprovação, rejeição com motivo visto pelo motorista, aprovação do "sem foto", leitura do equipamento,
// pedido de correção respondido pelo motorista, aprovação em lote só sem etiqueta e o relatório.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { auditLogs, convoyFuelRecords, employees, equipment, fuelMovements, fuelTypes, meterReadings, serviceFronts, users } from "../db/schema.ts";
import { effectivePermissions } from "../lib/auth.ts";
import {
  answerConvoyCorrection, approveConvoyBatch, approveConvoyRecord, convoyFieldCatalog, convoyReport, listConvoyRecords, myConvoyRecords, pendingConvoyLiters,
  receiveConvoyRecord, rejectConvoyRecord, requestConvoyCorrection,
} from "../lib/convoy.ts";
import { fuelBalances, fuelHistory, parseFuelFilters } from "../lib/fuel.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

// JPEG mínimo válido (assinatura FF D8 FF) — o servidor confere a assinatura, não o tipo informado.
const jpeg = () => new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])], "medidor.jpg", { type: "image/jpeg" });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("comboio: pendente não mexe no saldo; aprovar baixa e atualiza leitura; rejeitar avisa o motorista", { skip: !enabled }, async () => {
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE COMBOIO ${s}` }).returning();
  const [pc, cm, cc] = await db.insert(equipment).values([
    { code: `EQ-PC${s}`, prefix: `PC-${s}`, type: "ESCAVADEIRA", brand: "K", model: "PC200", controlType: "HOURS", currentHours: 8100, currentKm: 0, serviceFrontId: front.id },
    { code: `EQ-CM${s}`, prefix: `CM-${s}`, type: "CAMINHÃO", brand: "M", model: "AXOR", controlType: "KM", currentHours: 0, currentKm: 140000, serviceFrontId: front.id },
    { code: `EQ-CC${s}`, prefix: `CC-${s}`, type: "CAMINHÃO COMBOIO", brand: "M", model: "ATEGO", controlType: "KM", currentHours: 0, currentKm: 50000, serviceFrontId: front.id },
  ]).returning();
  const [jose, maria] = await db.insert(employees).values([`JOSE COMBOIO ${s}`, `MARIA COMBOIO ${s}`].map((name) => ({ name, jobTitle: "OPERADOR", company: "JC", admissionDate: "2024-01-01", serviceFrontId: front.id }))).returning();
  const [driverRow] = await db.insert(users).values({ email: `comboio-${s}@campo.local`, username: `comboio-${s}`, name: `MOTORISTA COMBOIO ${s}`, role: "CAMPO", serviceFrontId: front.id, convoyFuelRegister: true, convoyEquipmentId: cc.id }).returning();
  const [approverRow] = await db.insert(users).values({ email: `aprova-${s}@teste.local`, username: `aprova-${s}`, name: `APROVADOR ${s}`, role: "GESTOR", serviceFrontId: front.id }).returning();
  const session = (row, profile, permissions) => ({ id: row.id, name: row.name, username: row.username, email: row.email, profile, taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions, serviceFrontId: front.id, serviceFrontName: front.name, allServiceFronts: false, serviceFrontIds: [front.id], canExport: false, jobTitle: null });
  // A permissão do motorista vem do cadastro de campo ("Registra abastecimento (comboio)").
  const driverPermissions = await effectivePermissions(driverRow.id, "CAMPO");
  assert.deepEqual(driverPermissions.sort(), ["daily.register", "fuel.convoy_register"]);
  const approverPermissions = await effectivePermissions(approverRow.id, "GESTOR");
  assert.ok(approverPermissions.includes("fuel.convoy_approve"), "GESTOR aprova por padrão");
  assert.ok(!approverPermissions.includes("fuel.convoy_register"));
  const driver = session(driverRow, "CAMPO", driverPermissions);
  const approver = session(approverRow, "GESTOR", approverPermissions);
  let diesel = (await db.select().from(fuelTypes).where(eq(fuelTypes.code, "DIESEL_S10")).limit(1))[0];
  if (!diesel) [diesel] = await db.insert(fuelTypes).values({ code: "DIESEL_S10", name: "Diesel S10" }).returning();
  await db.insert(fuelMovements).values({ serviceFrontId: front.id, fuelTypeId: diesel.id, movementType: "ENTRADA", movementDate: "2026-01-01", quantity: 10000, unitPrice: 6, responsible: "Teste", stockLocation: "FRENTE" });
  const balance = async () => (await fuelBalances(db, [front.id], today, today)).get(diesel.id)?.byFront.get(front.id)?.byLocation.FRENTE.balance ?? 0;

  // 1. Cadastro para o celular: equipamentos com a última leitura e funcionários.
  const catalog = await convoyFieldCatalog(driver);
  assert.equal(catalog.convoy.prefix, cc.prefix);
  assert.equal(catalog.equipment.find((item) => item.id === pc.id).lastReading, 8100);
  assert.ok(catalog.employees.some((item) => item.id === jose.id));
  await assert.rejects(convoyFieldCatalog(approver), /não registra/);

  // 2–3. Três registros feitos offline sobem (com foto, sem foto, leitura menor), reenvio não duplica.
  const recordedAt = new Date().toISOString();
  const common = { recordedAt, recordDate: today, operatorEmployeeId: jose.id, operatorName: jose.name, latitude: -2.4, longitude: -54.7, gpsAccuracy: 8, photoTakenAt: recordedAt };
  const ids = { photo: crypto.randomUUID(), noPhoto: crypto.randomUUID(), lower: crypto.randomUUID() };
  const a = await receiveConvoyRecord(driver, { ...common, clientUuid: ids.photo, equipmentId: pc.id, liters: "300", reading: "8120", deviceLastReading: 8100 }, { meter: jpeg(), pump: null });
  const b = await receiveConvoyRecord(driver, { ...common, clientUuid: ids.noPhoto, equipmentId: cm.id, liters: "200", reading: "", noPhoto: true, noPhotoReason: "EQUIPAMENTO_FECHADO" }, { meter: null, pump: null });
  const c = await receiveConvoyRecord(driver, { ...common, clientUuid: ids.lower, equipmentId: pc.id, liters: "150", reading: "8090", deviceLastReading: 8100, deviceWarnings: ["LEITURA_MENOR"] }, { meter: jpeg(), pump: null });
  assert.deepEqual([a.duplicate, b.duplicate, c.duplicate], [false, false, false]);
  const again = await receiveConvoyRecord(driver, { ...common, clientUuid: ids.photo, equipmentId: pc.id, liters: "300", reading: "8120" }, { meter: jpeg(), pump: null });
  assert.equal(again.duplicate, true); assert.equal(again.id, a.id);
  await assert.rejects(receiveConvoyRecord(driver, { ...common, clientUuid: crypto.randomUUID(), equipmentId: pc.id, liters: "100", reading: "8130" }, { meter: null, pump: null }), /foto do KM/);
  const mine = await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.registeredBy, driver.id));
  assert.equal(mine.length, 3, "sem duplicar");
  assert.ok(mine.every((row) => row.status === "PENDENTE" && row.serviceFrontId === front.id && row.convoyEquipmentId === cc.id));

  // Pendentes: saldo NÃO muda, leitura e consumo também não; "Saldo previsto" = saldo − 650 L.
  assert.equal(await balance(), 10000);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, pc.id)))[0].currentHours), 8100);
  assert.equal((await db.select().from(fuelMovements).where(eq(fuelMovements.equipmentId, pc.id))).length, 0);
  const pending = await pendingConvoyLiters(db, [front.id]);
  assert.equal(pending.find((row) => row.fuelTypeId === diesel.id).liters, 650);

  // Lista da aprovação com as etiquetas.
  const list = await listConvoyRecords(approver, { status: "ABERTOS", from: null, to: null, frontId: null });
  const flagsOf = (id) => list.find((item) => item.id === id).flags;
  assert.deepEqual(flagsOf(a.id), []);
  assert.deepEqual(flagsOf(b.id), ["SEM_FOTO"]);
  assert.deepEqual(flagsOf(c.id), ["LEITURA_MENOR"]);
  const viewA = list.find((item) => item.id === a.id);
  assert.equal(viewA.lastReading, 8100); assert.equal(viewA.difference, 20); assert.deepEqual(viewA.consumption, { value: 15, unit: "L/h" });
  await assert.rejects(listConvoyRecords(driver, { status: "ABERTOS", from: null, to: null, frontId: null }), /não aprova/);

  // 4. Corrigir e aprovar o com foto (300 → 310 L): baixa o saldo e atualiza a leitura.
  const approved = await approveConvoyRecord(approver, a.id, { liters: 310, stockLocation: "FRENTE" });
  assert.equal(await balance(), 10000 - 310);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, pc.id)))[0].currentHours), 8120, approved.readingUpdateNote);
  const reading = (await db.select().from(meterReadings).where(eq(meterReadings.equipmentId, pc.id)))[0];
  assert.equal(reading.source, "COMBOIO");
  const movement = (await db.select().from(fuelMovements).where(eq(fuelMovements.id, approved.fuelMovementId)))[0];
  assert.equal(movement.createdVia, "COMBOIO"); assert.equal(movement.convoyRecordId, a.id); assert.equal(movement.createdBy, approver.id);
  assert.equal(movement.quantity, 310); assert.equal(movement.meterReading, 8120); assert.equal(movement.responsibleEmployeeId, jose.id);
  const recordA = (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, a.id)))[0];
  assert.equal(recordA.status, "APROVADO");
  const correction = JSON.parse(recordA.corrections)[0];
  assert.deepEqual([correction.campo, correction.de, correction.para, correction.porId], ["litros", 300, 310, approver.id]);
  await assert.rejects(approveConvoyRecord(approver, a.id, {}), /já foi aprovado/);
  // Histórico do Combustível: câmera e quem registrou/aprovou.
  const history = await fuelHistory(db, [front.id], parseFuelFilters(new URLSearchParams({ from: today, to: today })), 50);
  const row = history.rows.find((item) => item.id === approved.fuelMovementId);
  assert.equal(row.convoy.registeredBy, driver.name); assert.equal(row.convoy.approvedBy, approver.name); assert.equal(row.convoy.hasMeterPhoto, true);

  // Rejeitar o da leitura menor (motivo obrigatório) → saldo não muda.
  await assert.rejects(rejectConvoyRecord(approver, c.id, ""), /motivo/);
  await rejectConvoyRecord(approver, c.id, "Leitura menor que a anterior: refaça a foto");
  assert.equal(await balance(), 10000 - 310);

  // Aprovar o sem foto: baixa o saldo; sem leitura, o equipamento não muda.
  const approvedB = await approveConvoyRecord(approver, b.id, { stockLocation: "FRENTE" });
  assert.equal(await balance(), 10000 - 310 - 200);
  assert.match(approvedB.readingUpdateNote, /Sem leitura/);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, cm.id)))[0].currentKm), 140000);

  // 5. O motorista vê o rejeitado com o motivo.
  const forDriver = await myConvoyRecords(driver);
  const rejected = forDriver.find((item) => item.id === c.id);
  assert.equal(rejected.status, "REJEITADO"); assert.match(rejected.rejectionReason, /refaça a foto/);
  assert.equal(forDriver.find((item) => item.id === a.id).status, "APROVADO");

  // Pedir correção → motorista responde (volta para Pendente, com a correção registrada).
  const d = await receiveConvoyRecord(driver, { ...common, clientUuid: crypto.randomUUID(), equipmentId: cm.id, liters: "120", reading: "140300", operatorEmployeeId: maria.id, operatorName: maria.name }, { meter: jpeg(), pump: null });
  await requestConvoyCorrection(approver, d.id, "Litros errados, confira a bomba");
  assert.equal((await myConvoyRecords(driver)).find((item) => item.id === d.id).correctionNote, "Litros errados, confira a bomba");
  const answer = crypto.randomUUID();
  await answerConvoyCorrection(driver, (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, d.id)))[0].clientUuid, { liters: "125", note: "conferi", answerId: answer }, null);
  const recordD = (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, d.id)))[0];
  assert.equal(recordD.status, "PENDENTE"); assert.equal(recordD.liters, 125);
  // Reenvio da mesma resposta (fila do celular) não dá erro.
  assert.equal((await answerConvoyCorrection(driver, recordD.clientUuid, { liters: "125", answerId: answer }, null)).duplicate, true);

  // Aprovar em lote: só os sem etiqueta (o com litragem fora do normal fica de fora).
  const e = await receiveConvoyRecord(driver, { ...common, clientUuid: crypto.randomUUID(), equipmentId: cm.id, liters: "1500", reading: "140400" }, { meter: jpeg(), pump: null });
  const batch = await approveConvoyBatch(approver, [d.id, e.id]);
  assert.deepEqual(batch.approved, [d.id]);
  assert.equal(batch.skipped[0].id, e.id);
  assert.equal(await balance(), 10000 - 310 - 200 - 125);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, cm.id)))[0].currentKm), 140300, "leitura do CM atualizada pela aprovação em lote");

  // Relatório e log.
  const report = await convoyReport(approver, { from: today, to: today, convoyEquipmentId: cc.id, registeredBy: null, equipmentId: null });
  assert.equal(report.totals.records, 5); assert.equal(report.totals.approved, 3); assert.equal(report.totals.rejected, 1); assert.equal(report.totals.pending, 1);
  assert.equal(report.totals.approvedLiters, 635); assert.equal(report.totals.noPhotoByReason["Equipamento fechado"], 1);
  const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityType, "CONVOY_FUEL"))).filter((log) => [a.id, b.id, c.id, d.id, e.id].map(String).includes(log.entityId)).map((log) => log.action);
  for (const action of ["ABASTECIMENTO DO COMBOIO RECEBIDO", "ABASTECIMENTO DO COMBOIO APROVADO", "ABASTECIMENTO DO COMBOIO REJEITADO", "CORREÇÃO PEDIDA AO MOTORISTA", "CORREÇÃO ENVIADA PELO MOTORISTA"]) assert.ok(actions.includes(action), action);

  await rm(path.join(process.cwd(), "uploads", "convoy"), { recursive: true, force: true }).catch(() => undefined);
});
