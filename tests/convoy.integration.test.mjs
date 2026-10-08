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
  answerConvoyCorrection, approveConvoyBatch, approveConvoyRecord, convoyDriverActivity, convoyFieldCatalog, convoyFilterOptions, convoyReport, listConvoyRecords, myConvoyRecords,
  parseConvoyListFilters, pendingConvoyLiters, receiveConvoyRecord, rejectConvoyRecord, requestConvoyCorrection,
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

  // Combustível → Aprovação → Histórico: só os tratados (aprovados e rejeitados), do mais novo para o
  // mais antigo, com os filtros de motorista, comboio e equipamento; quem aprovou/rejeitou e as correções.
  const treated = await listConvoyRecords(approver, { status: "TRATADOS", from: today, to: today, frontId: null, driverId: driverRow.id, convoyId: cc.id, newestFirst: true });
  assert.deepEqual(treated.map((item) => item.id).sort((x, y) => x - y), [a.id, b.id, c.id, d.id].sort((x, y) => x - y));
  assert.ok(treated.every((item, index) => index === 0 || treated[index - 1].recordedAt > item.recordedAt || treated[index - 1].recordedAt === item.recordedAt && treated[index - 1].id > item.id), "mais novo primeiro");
  assert.equal(treated.find((item) => item.id === a.id).approvedBy, approver.name);
  assert.equal(treated.find((item) => item.id === a.id).corrections[0].campo, "litros");
  assert.equal(treated.find((item) => item.id === c.id).rejectedBy, approver.name);
  const onlyCm = await listConvoyRecords(approver, { status: "TRATADOS", from: null, to: null, frontId: front.id, equipmentId: cm.id });
  assert.ok(onlyCm.length >= 2 && onlyCm.every((item) => item.equipmentId === cm.id));
  assert.equal((await listConvoyRecords(approver, { status: "TRATADOS", from: today, to: today, frontId: null, driverId: approverRow.id })).length, 0, "filtro por motorista");
  const filterOptions = await convoyFilterOptions(approver);
  assert.ok(filterOptions.drivers.some((item) => item.id === driverRow.id && item.label === driver.name));
  assert.ok(filterOptions.convoys.some((item) => item.id === cc.id));
  assert.ok(filterOptions.equipment.some((item) => item.id === pc.id) && filterOptions.equipment.some((item) => item.id === cm.id));
  await assert.rejects(convoyFilterOptions(driver), /não aprova/);
  const parsed = parseConvoyListFilters(new URLSearchParams({ status: "TRATADOS", driver: String(driverRow.id), convoy: "abc", order: "desc", from: "2026-10-01", to: "ontem" }));
  assert.deepEqual([parsed.status, parsed.driverId, parsed.convoyId, parsed.newestFirst, parsed.from, parsed.to], ["TRATADOS", driverRow.id, null, true, "2026-10-01", null]);
  assert.equal(parseConvoyListFilters(new URLSearchParams({ status: "QUALQUER" })).status, "ABERTOS");
  // Motorista comboio: último lançamento e quantos ainda aguardam (o "e", que ficou fora do lote).
  const activity = (await convoyDriverActivity(db, [driverRow.id])).get(driverRow.id);
  assert.equal(activity.pending, 1);
  assert.ok(activity.lastRecordAt >= recordD.recordedAt);

  await rm(path.join(process.cwd(), "uploads", "convoy"), { recursive: true, force: true }).catch(() => undefined);
});

test("setor Abastecimentos: motorista do comboio entra só em Abastecimentos (Controle Diário só se marcar)", { skip: !enabled }, async () => {
  const { ALL_PERMISSIONS } = await import("../lib/auth.ts");
  const { createConvoyDriver, listConvoyDrivers, removeConvoyDriver, updateConvoyDriver } = await import("../lib/convoy-drivers.ts");
  const { listFieldOperators } = await import("../lib/field-operators.ts");
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE MOTORISTAS ${s}` }).returning();
  const [cc] = await db.insert(equipment).values({ code: `EQ-CCM${s}`, prefix: `CCM-${s}`, type: "CAMINHÃO COMBOIO", brand: "M", model: "ATEGO", controlType: "KM", currentHours: 0, currentKm: 1000, serviceFrontId: front.id }).returning();
  const [employee] = await db.insert(employees).values({ name: `PEDRO MOTORISTA ${s}`, jobTitle: "MOTORISTA", company: "JC", admissionDate: "2024-01-01", serviceFrontId: front.id }).returning();
  const [adminRow] = await db.insert(users).values({ email: `adm-${s}@teste.local`, username: `adm-${s}`, name: `ADMIN ${s}`, role: "ADMIN" }).returning();
  const admin = { id: adminRow.id, name: adminRow.name, username: adminRow.username, email: adminRow.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: [...ALL_PERMISSIONS], serviceFrontId: null, serviceFrontName: null, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };

  // Da lista de funcionários: cria o acesso de campo com PIN (devolvido uma vez) e já marca como motorista.
  const created = await createConvoyDriver(admin, { mode: "employee", employeeId: employee.id, convoyEquipmentId: cc.id, dailyAccess: false });
  assert.match(created.access.code, /^\d{4}$/);
  assert.deepEqual(await effectivePermissions(created.userId, "CAMPO"), ["fuel.convoy_register"], "não faz o Controle Diário");
  const listed = (await listConvoyDrivers(admin)).drivers.find((row) => row.id === created.userId);
  assert.equal(listed.convoyPrefix, cc.prefix); assert.equal(listed.dailyAccess, false);
  // Não aparece em Controle Diário → Funcionários de campo (rota filtra os motoristas só do comboio).
  const operator = (await listFieldOperators(admin)).find((row) => row.id === created.userId);
  assert.ok(operator.convoyFuelRegister && !operator.fieldDailyAccess);

  // Marcar "também faz o Controle Diário" devolve daily.register; remover do comboio volta ao acesso comum.
  await updateConvoyDriver(admin, created.userId, { convoyEquipmentId: cc.id, dailyAccess: true, active: true });
  assert.deepEqual((await effectivePermissions(created.userId, "CAMPO")).sort(), ["daily.register", "fuel.convoy_register"]);
  await assert.rejects(updateConvoyDriver(admin, created.userId, { convoyEquipmentId: 999999999, dailyAccess: true }), /Comboio não encontrado/);
  await removeConvoyDriver(admin, created.userId);
  assert.deepEqual(await effectivePermissions(created.userId, "CAMPO"), ["daily.register"]);

  // Quem já tem acesso de campo: vira motorista sem trocar o PIN e continua no Controle Diário por padrão.
  const again = await createConvoyDriver(admin, { mode: "access", userId: created.userId, convoyEquipmentId: null });
  assert.equal(again.access, null);
  assert.deepEqual((await effectivePermissions(created.userId, "CAMPO")).sort(), ["daily.register", "fuel.convoy_register"]);
  await assert.rejects(createConvoyDriver(admin, { mode: "access", userId: created.userId }), /já é motorista/);

  // Fora do cadastro (manual, sem cadastro de funcionário) com PIN escolhido; PIN óbvio é recusado.
  await assert.rejects(createConvoyDriver(admin, { mode: "manual", name: `ZECA FORA ${s}`, jobTitle: "MOTORISTA", serviceFrontIds: [front.id], criarFuncionario: false, confirmarParecidos: true, code: "1234" }), /fácil de adivinhar/);
  const manual = await createConvoyDriver(admin, { mode: "manual", name: `ZECA FORA ${s}`, jobTitle: "MOTORISTA", serviceFrontIds: [front.id], criarFuncionario: false, confirmarParecidos: true, code: "4826", convoyEquipmentId: cc.id });
  assert.equal(manual.access.code, "4826");
  assert.deepEqual(await effectivePermissions(manual.userId, "CAMPO"), ["fuel.convoy_register"]);
  const logs = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, String(manual.userId)))).map((row) => row.action);
  assert.ok(logs.includes("MOTORISTA DO COMBOIO CADASTRADO"));
});

// Roteiro do comboio com terceiros (registrados "offline" e enviados depois): 1 abastecimento para o
// veículo de um prestador, 1 para o funcionário do prestador e 1 com a empresa "Não cadastrada".
// Aprovar grava com a MESMA createFuelMovement do computador: baixa o saldo, atualiza a leitura e a
// média de consumo do veículo do terceiro (só destino veículo) e entra nos relatórios.
test("comboio: saída para terceiros e prestadores — veículo, funcionário e cadastro pendente", { skip: !enabled }, async () => {
  const { thirdParties, thirdPartyEmployees, thirdPartyVehicles } = await import("../db/schema.ts");
  const { createThirdParty, createVehicle, thirdPartyConsumptionReport } = await import("../lib/third-parties.ts");
  const { createFuelMovement } = await import("../lib/fuel-create.ts");
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE TERCEIROS ${s}` }).returning();
  const [cc] = await db.insert(equipment).values({ code: `EQ-CT${s}`, prefix: `CT-${s}`, type: "CAMINHÃO COMBOIO", brand: "M", model: "ATEGO", controlType: "KM", currentHours: 0, currentKm: 70000, serviceFrontId: front.id }).returning();
  const [driverRow] = await db.insert(users).values({ email: `ct-${s}@campo.local`, username: `ct-${s}`, name: `MOTORISTA CT ${s}`, role: "CAMPO", serviceFrontId: front.id, convoyFuelRegister: true, convoyEquipmentId: cc.id }).returning();
  const [approverRow] = await db.insert(users).values({ email: `apt-${s}@teste.local`, username: `apt-${s}`, name: `APROVADOR T ${s}`, role: "GESTOR", serviceFrontId: front.id }).returning();
  const session = (row, profile, permissions) => ({ id: row.id, name: row.name, username: row.username, email: row.email, profile, taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions, serviceFrontId: front.id, serviceFrontName: front.name, allServiceFronts: false, serviceFrontIds: [front.id], canExport: false, jobTitle: null });
  const driver = session(driverRow, "CAMPO", await effectivePermissions(driverRow.id, "CAMPO"));
  const approver = session(approverRow, "GESTOR", await effectivePermissions(approverRow.id, "GESTOR"));
  assert.ok(approver.permissions.includes("third_parties.manage") && approver.permissions.includes("fuel.convoy_approve"));
  let diesel = (await db.select().from(fuelTypes).where(eq(fuelTypes.code, "DIESEL_S10")).limit(1))[0];
  if (!diesel) [diesel] = await db.insert(fuelTypes).values({ code: "DIESEL_S10", name: "Diesel S10" }).returning();
  await db.insert(fuelMovements).values({ serviceFrontId: front.id, fuelTypeId: diesel.id, movementType: "ENTRADA", movementDate: "2026-01-01", quantity: 5000, unitPrice: 6, responsible: "Teste", stockLocation: "FRENTE" });
  const balance = async () => (await fuelBalances(db, [front.id], today, today)).get(diesel.id)?.byFront.get(front.id)?.byLocation.FRENTE.balance ?? 0;

  // Prestador com veículo (tanque 400 L, base de consumo: 10.000 km em 02/01) e funcionário.
  const [prestador] = await db.insert(thirdParties).values({ name: `PRESTADORA TESTE ${s}`, kind: "PRESTADOR", serviceFrontId: front.id }).returning();
  const plate = `PRT${s.slice(-4)}`;
  const [caminhao] = await db.insert(thirdPartyVehicles).values({ thirdPartyId: prestador.id, plate, plateKey: plate, meterType: "KM", tankCapacityLiters: 400 }).returning();
  const [joao] = await db.insert(thirdPartyEmployees).values({ thirdPartyId: prestador.id, name: `JOAO MOTOSSERRISTA ${s}`, jobTitle: "MOTOSSERRISTA" }).returning();
  await createFuelMovement(db, approver, { movementType: "SAIDA", thirdParty: true, thirdPartyKind: "PRESTADOR", fuelTypeId: diesel.id, movementDate: "2026-01-02", quantity: 100, stockLocation: "FRENTE", serviceFrontId: front.id, thirdPartyId: prestador.id, thirdPartyDestination: "VEICULO", thirdPartyVehicleId: caminhao.id, thirdPartyReading: "10000", fullTank: true, responsible: "Base" }, { displayedFronts: "ALL" });
  assert.equal(await balance(), 4900);

  // Celular: o cadastro baixado traz a empresa, o veículo (última leitura) e o funcionário.
  const catalog = await convoyFieldCatalog(driver);
  const party = catalog.thirdParties.find((item) => item.id === prestador.id);
  assert.equal(party.kind, "PRESTADOR");
  assert.deepEqual([party.vehicles[0].plate, party.vehicles[0].lastReading, party.vehicles[0].unit, party.vehicles[0].tankCapacityLiters], [plate, 10000, "KM", 400]);
  assert.equal(party.employees[0].name, joao.name);

  const recordedAt = new Date().toISOString();
  const common = { recordedAt, recordDate: today, latitude: -2.4, longitude: -54.7, gpsAccuracy: 8, photoTakenAt: recordedAt };
  const vehicleToPrestador = { ...common, clientUuid: crypto.randomUUID(), exitKind: "PRESTADOR", operatorName: "MOTORISTA DO PRESTADOR", liters: "100", reading: "10300", deviceLastReading: 10000,
    thirdPartyId: prestador.id, companyLabel: prestador.name, destination: "VEICULO", thirdPartyVehicleId: caminhao.id, vehicleLabel: plate, fullTank: true };
  // Estes dois no formato que o celular envia (campos do terceiro dentro de "thirdParty").
  const workerOfPrestador = { ...common, clientUuid: crypto.randomUUID(), exitKind: "PRESTADOR", operatorName: joao.name, liters: "20",
    thirdParty: { thirdPartyId: prestador.id, companyLabel: prestador.name, destination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, employeeLabel: joao.name, purpose: "MOTOSSERRA" } };
  const notRegistered = { ...common, clientUuid: crypto.randomUUID(), exitKind: "TERCEIROS", operatorName: "SEU ZE DA SERRARIA", liters: "60", reading: "5000",
    thirdParty: { thirdPartyId: null, pendingCompany: `SERRARIA NOVA ${s}`, destination: "VEICULO", thirdPartyVehicleId: null, pendingVehicle: `ABC${s.slice(-4)}`, fullTank: true } };
  // Mesmas regras do computador: veículo obrigatório (não é pessoa física), finalidade no destino funcionário.
  await assert.rejects(receiveConvoyRecord(driver, { ...vehicleToPrestador, clientUuid: crypto.randomUUID(), thirdPartyVehicleId: null }, { meter: jpeg(), pump: null }), /veículo\/máquina/);
  await assert.rejects(receiveConvoyRecord(driver, { ...workerOfPrestador, clientUuid: crypto.randomUUID(), thirdParty: { ...workerOfPrestador.thirdParty, purpose: null } }, { meter: null, pump: null }), /finalidade/);
  await assert.rejects(receiveConvoyRecord(driver, { ...vehicleToPrestador, clientUuid: crypto.randomUUID() }, { meter: null, pump: null }), /foto do KM/);
  const r1 = await receiveConvoyRecord(driver, vehicleToPrestador, { meter: jpeg(), pump: null });
  const r2 = await receiveConvoyRecord(driver, workerOfPrestador, { meter: null, pump: null });
  const r3 = await receiveConvoyRecord(driver, notRegistered, { meter: jpeg(), pump: null });
  assert.equal((await receiveConvoyRecord(driver, vehicleToPrestador, { meter: jpeg(), pump: null })).duplicate, true, "reenvio da fila não duplica");
  const stored = await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.registeredBy, driver.id));
  assert.equal(stored.length, 3);
  assert.ok(stored.every((row) => row.serviceFrontId === front.id && row.equipmentId === null), "frente do comboio, sem equipamento da frota");
  const stored3 = stored.find((row) => row.id === r3.id);
  assert.deepEqual([stored3.exitKind, stored3.thirdPartyId, stored3.pendingCompany, stored3.pendingVehicle], ["TERCEIROS", null, `SERRARIA NOVA ${s}`, `ABC${s.slice(-4)}`]);

  // Pendentes: nada muda no saldo nem na leitura do veículo; entram no "Saldo previsto".
  assert.equal(await balance(), 4900);
  assert.equal((await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, caminhao.id)))[0].lastReading, 10000);
  assert.equal((await pendingConvoyLiters(db, [front.id])).find((row) => row.fuelTypeId === diesel.id).liters, 180);

  // Aprovação: tipo, empresa, destino e etiquetas.
  const list = await listConvoyRecords(approver, { status: "ABERTOS", from: null, to: null, frontId: null });
  const view = (id) => list.find((item) => item.id === id);
  assert.deepEqual([view(r1.id).exitKind, view(r1.id).company, view(r1.id).destination, view(r1.id).vehiclePlate, view(r1.id).lastReading, view(r1.id).difference], ["PRESTADOR", prestador.name, "VEICULO", plate, 10000, 300]);
  assert.deepEqual(view(r1.id).flags, []);
  assert.deepEqual([view(r2.id).destination, view(r2.id).workerName, view(r2.id).purposeLabel, view(r2.id).flags], ["FUNCIONARIO", joao.name, "Motosserra", []]);
  assert.deepEqual(view(r3.id).flags, ["CADASTRO_PENDENTE"]);
  assert.match(view(r3.id).equipment, /SERRARIA NOVA .* \(não cadastrada\)/);
  const mine = await myConvoyRecords(driver);
  assert.equal(mine.find((item) => item.id === r2.id).equipment, `${prestador.name} · ${joao.name}`);

  // 1) Veículo do prestador: baixa o saldo, atualiza a leitura e calcula o consumo (300 km / 100 L).
  const a1 = await approveConvoyRecord(approver, r1.id, { stockLocation: "FRENTE" });
  assert.equal(await balance(), 4800);
  assert.equal((await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, caminhao.id)))[0].lastReading, 10300);
  const m1 = (await db.select().from(fuelMovements).where(eq(fuelMovements.id, a1.fuelMovementId)))[0];
  assert.deepEqual([m1.thirdParty, m1.thirdPartyKind, m1.thirdPartyId, m1.thirdPartyVehicleId, m1.meterReading, m1.createdVia, m1.convoyRecordId, m1.responsible], [true, "PRESTADOR", prestador.id, caminhao.id, 10300, "COMBOIO", r1.id, "MOTORISTA DO PRESTADOR"]);
  assert.match(a1.message, /consumo 3 km\/L/);

  // 2) Funcionário do prestador: baixa o saldo, sem leitura e fora do consumo.
  const a2 = await approveConvoyRecord(approver, r2.id, {});
  assert.equal(await balance(), 4780);
  const m2 = (await db.select().from(fuelMovements).where(eq(fuelMovements.id, a2.fuelMovementId)))[0];
  assert.deepEqual([m2.thirdPartyDestination, m2.thirdPartyEmployeeId, m2.purpose, m2.meterReading, m2.thirdPartyVehicleId], ["FUNCIONARIO", joao.id, "MOTOSSERRA", null, null]);
  assert.equal((await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, caminhao.id)))[0].lastReading, 10300, "funcionário não mexe na leitura do veículo");

  // 3) "Não cadastrada": não aprova sem cadastrar/vincular (e não fica travado em "Em aprovação").
  await assert.rejects(approveConvoyRecord(approver, r3.id, {}), /CADASTRO PENDENTE/);
  assert.equal((await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, r3.id)))[0].status, "PENDENTE");
  const companyId = await createThirdParty(db, approver, { name: `SERRARIA NOVA ${s}`, kind: "TERCEIRIZADA", document: null, contactName: null, phone: null, serviceFrontId: front.id, notes: null });
  await assert.rejects(approveConvoyRecord(approver, r3.id, { thirdPartyId: companyId }), /veículo/);
  const vehicleId = await createVehicle(db, approver, companyId, { plate: `ABC${s.slice(-4)}`, plateKey: `ABC${s.slice(-4)}`, description: "Toyota", vehicleType: "CAMINHAO", meterType: "KM", fuelTypeId: null, tankCapacityLiters: 50, expectedConsumption: null, lastReading: null });
  // Passa da capacidade do tanque: igual ao computador, pede confirmação.
  const tank = await approveConvoyRecord(approver, r3.id, { thirdPartyId: companyId, thirdPartyVehicleId: vehicleId }).then(() => null, (error) => error);
  assert.equal(tank.data.confirm, "TANK");
  assert.equal((await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, r3.id)))[0].status, "PENDENTE");
  const a3 = await approveConvoyRecord(approver, r3.id, { thirdPartyId: companyId, thirdPartyVehicleId: vehicleId, confirmTank: true });
  assert.equal(await balance(), 4720);
  assert.equal((await db.select().from(thirdPartyVehicles).where(eq(thirdPartyVehicles.id, vehicleId)))[0].lastReading, 5000);
  const rec3 = (await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, r3.id)))[0];
  assert.deepEqual([rec3.status, rec3.thirdPartyId, rec3.thirdPartyVehicleId, rec3.fuelMovementId], ["APROVADO", companyId, vehicleId, a3.fuelMovementId]);
  assert.ok(JSON.parse(rec3.corrections).some((change) => change.campo === "empresa"));

  // Leitura menor que a última: só com a exceção + justificativa (quem gerencia Terceiros).
  const lower = await receiveConvoyRecord(driver, { ...vehicleToPrestador, clientUuid: crypto.randomUUID(), liters: "50", reading: "10200", deviceWarnings: ["LEITURA_MENOR"] }, { meter: jpeg(), pump: null });
  assert.deepEqual((await listConvoyRecords(approver, { status: "ABERTOS", from: null, to: null, frontId: null })).find((item) => item.id === lower.id).flags, ["LEITURA_MENOR"]);
  const refused = await approveConvoyRecord(approver, lower.id, {}).then(() => null, (error) => error);
  assert.equal(refused.data.exception, true);
  await assert.rejects(approveConvoyRecord(approver, lower.id, { readingException: true }), /justificativa/);
  await approveConvoyRecord(approver, lower.id, { readingException: true, note: "Painel trocado na oficina", confirmOutlier: true });
  assert.equal(await balance(), 4670);
  assert.equal((await approveConvoyBatch(approver, [])).approved.length, 0);

  // Terceiro/Doações manual (sem cadastro): só destino/descrição; sem leitura e sem CADASTRO PENDENTE.
  const donation = await receiveConvoyRecord(driver, { ...common, clientUuid: crypto.randomUUID(), exitKind: "TERCEIROS", operatorName: "SECRETARIO DE OBRAS", liters: "40",
    thirdParty: { manual: true, description: `DOACAO PREFEITURA ${s}` } }, { meter: null, pump: null });
  const donationView = (await listConvoyRecords(approver, { status: "ABERTOS", from: null, to: null, frontId: null })).find((item) => item.id === donation.id);
  assert.deepEqual([donationView.exitLabel, donationView.manual, donationView.description, donationView.flags, donationView.equipment], ["Terceiro/Doações", true, `DOACAO PREFEITURA ${s}`, [], `DOACAO PREFEITURA ${s}`]);
  const approvedDonation = await approveConvoyRecord(approver, donation.id, { description: `DOACAO PREFEITURA DE TESTE ${s}` });
  assert.equal(await balance(), 4630);
  const md = (await db.select().from(fuelMovements).where(eq(fuelMovements.id, approvedDonation.fuelMovementId)))[0];
  assert.deepEqual([md.thirdParty, md.thirdPartyKind, md.thirdPartyId, md.thirdPartyVehicleId, md.thirdPartyDescription, md.responsible, md.meterReading, md.createdVia],
    [true, "GERAL", null, null, `DOACAO PREFEITURA DE TESTE ${s}`, "SECRETARIO DE OBRAS", null, "COMBOIO"]);
  assert.ok(JSON.parse((await db.select().from(convoyFuelRecords).where(eq(convoyFuelRecords.id, donation.id)))[0].corrections).some((change) => change.campo === "destino/descrição"));

  // Computador: Terceiro/Doações manual (texto livre) e Prestadores continua exigindo o cadastro.
  const pcBase = { movementType: "SAIDA", thirdParty: true, fuelTypeId: diesel.id, movementDate: today, quantity: 10, stockLocation: "FRENTE", serviceFrontId: front.id, responsible: "Fulano" };
  const pcManual = await createFuelMovement(db, approver, { ...pcBase, thirdPartyKind: "GERAL", thirdPartyDescription: "Doação para a comunidade" }, { displayedFronts: "ALL" });
  assert.equal(await balance(), 4620);
  assert.deepEqual([(await db.select().from(fuelMovements).where(eq(fuelMovements.id, pcManual.id)))[0].thirdPartyId, pcManual.message.includes("Doação para a comunidade")], [null, true]);
  await assert.rejects(createFuelMovement(db, approver, { ...pcBase, thirdPartyKind: "GERAL" }, { displayedFronts: "ALL" }), /Destino\/Descrição/);
  await assert.rejects(createFuelMovement(db, approver, { ...pcBase, thirdPartyKind: "PRESTADOR", providerCompany: "Livre", providerEquipment: "Livre" }, { displayedFronts: "ALL" }), /cadastro de terceiros/);
  const pcRegistered = await createFuelMovement(db, approver, { ...pcBase, thirdPartyKind: "GERAL", thirdPartyId: companyId, thirdPartyDestination: "VEICULO", thirdPartyVehicleId: vehicleId, thirdPartyReading: "5100", fullTank: true, confirmOutlier: true }, { displayedFronts: "ALL" });
  assert.equal((await db.select().from(fuelMovements).where(eq(fuelMovements.id, pcRegistered.id)))[0].thirdPartyVehicleId, vehicleId, "Terceiro/Doações do cadastro continua igual");

  // Relatórios: comboio (por tipo e por empresa) e Consumo de Terceiros.
  const report = await convoyReport(approver, { from: today, to: today, convoyEquipmentId: null, registeredBy: driver.id, equipmentId: null });
  assert.equal(report.totals.approvedLiters, 270);
  assert.equal(report.byKind.find((row) => row.key === "PRESTADOR").approvedLiters, 170);
  assert.equal(report.byKind.find((row) => row.key === "TERCEIROS").label, "Terceiro/Doações");
  assert.equal(report.byKind.find((row) => row.key === "TERCEIROS").approvedLiters, 100);
  assert.equal(report.byCompany.find((row) => row.label === `DOACAO PREFEITURA DE TESTE ${s} (manual)`).approvedLiters, 40);
  assert.equal(report.byCompany.find((row) => row.label === prestador.name).approvedLiters, 170);
  const consumption = await thirdPartyConsumptionReport(db, [front.id], { from: today, to: today, thirdPartyId: prestador.id, vehicleId: null });
  const truck = consumption.vehicles.find((row) => row.id === caminhao.id);
  assert.equal(truck.fuelings, 2); assert.equal(truck.liters, 150); assert.equal(truck.average, 3);
  const history = await fuelHistory(db, [front.id], parseFuelFilters(new URLSearchParams({ from: today, to: today, movementType: "PRESTADORES" })), 50);
  assert.ok(history.rows.some((row) => row.id === a2.fuelMovementId && row.convoy?.registeredBy === driver.name));
  const donations = await fuelHistory(db, [front.id], parseFuelFilters(new URLSearchParams({ from: today, to: today, movementType: "TERCEIROS" })), 50);
  assert.ok(donations.rows.some((row) => row.id === approvedDonation.fuelMovementId && row.movementLabel === "Terceiro/Doações"));

  await rm(path.join(process.cwd(), "uploads", "convoy"), { recursive: true, force: true }).catch(() => undefined);
});
