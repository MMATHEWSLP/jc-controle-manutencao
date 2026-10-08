// Integração (Postgres de teste já migrado) do menu RELATÓRIOS: os relatórios do Controle Diário
// (produção e Diário x Combustível) rodam no Postgres de verdade e somam as viagens das fichas.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:relatorios-banco
import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../db/index.ts";
import { dailyRecords, dailyRecordTrips, equipment, fuelMovements, fuelTypes, serviceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { dieselConferencia, producao } from "../lib/daily-reports.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const s = Date.now().toString(36).toUpperCase().slice(-5);
const DIA = "2026-09-15";

async function cenario() {
  const db = await getDb();
  const [frente] = await db.insert(serviceFronts).values({ name: `RL${s} FRENTE` }).returning();
  const [admin] = await db.insert(users).values({ email: `rel-admin-${s}@teste.local`, name: "Admin relatórios", role: "ADMIN", serviceFrontId: frente.id }).returning();
  const sessao = { id: admin.id, name: admin.name, username: "", email: admin.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: frente.id, serviceFrontName: frente.name, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  const [trator, caminhao] = await db.insert(equipment).values([
    { code: `TR-${s}`, prefix: `TR-${s}`, type: "TRATOR", brand: "M", model: "X", controlType: "HOURS", serviceFrontId: frente.id },
    { code: `CM-${s}`, prefix: `CM-${s}`, type: "CAMINHÃO", brand: "M", model: "Y", controlType: "KM", serviceFrontId: frente.id },
  ]).returning();
  // Ficha do app (sem os totais digitados): as viagens vêm de daily_record_trips.
  const [baldeio] = await db.insert(dailyRecords).values({ equipmentId: trator.id, userId: admin.id, recordDate: DIA, workedToday: true, serviceFrontId: frente.id, readingUnit: "HOURS", startReading: 100, endReading: 109, hadProduction: true, productionType: "BALDEIO", operatorName: "Op Baldeio", reportedDieselLiters: 150 }).returning();
  await db.insert(dailyRecordTrips).values([1, 2, 3].map((tripNumber) => ({ dailyRecordId: baldeio.id, tripNumber, logsQuantity: 10 })));
  const [porto] = await db.insert(dailyRecords).values({ equipmentId: caminhao.id, userId: admin.id, recordDate: DIA, workedToday: true, serviceFrontId: frente.id, readingUnit: "KM", startReading: 5000, endReading: 5320, hadProduction: true, productionType: "PORTO", operatorName: "Op Porto" }).returning();
  await db.insert(dailyRecordTrips).values([{ dailyRecordId: porto.id, tripNumber: 1, logsQuantity: 40, meters: 30.5 }, { dailyRecordId: porto.id, tripNumber: 2, logsQuantity: 35, meters: 28 }]);
  const [diesel] = await db.select().from(fuelTypes).limit(1);
  await db.insert(fuelMovements).values({ serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: DIA, quantity: 140, equipmentId: trator.id });
  return { sessao, frente, trator, caminhao };
}

test("produção do Controle Diário soma horas, km e as viagens das fichas", { skip: !enabled }, async () => {
  const { sessao, frente, trator, caminhao } = await cenario();
  const filtros = { from: DIA, to: DIA, frontId: frente.id, equipmentId: null, operator: "", location: "", origin: "" };
  const [linha] = await producao(sessao, filtros, "frente");
  assert.equal(linha.chave, frente.name);
  assert.equal(linha.registros, 2);
  assert.equal(linha.horas, 9);
  assert.equal(linha.km, 320);
  assert.equal(linha.viagensBaldeio, 3);
  assert.equal(linha.viagensPorto, 2);
  assert.equal(linha.viagens, 5);
  assert.equal(linha.volumePorto, 58.5);
  assert.equal(linha.torasPorto, 75);
  assert.equal(linha.dieselInformado, 150);
  const porEquipamento = await producao(sessao, filtros, "equipamento");
  assert.deepEqual(porEquipamento.map((item) => [item.chave, item.viagens]).sort(), [[caminhao.prefix, 2], [trator.prefix, 3]].sort());
  const conferencia = await dieselConferencia(sessao, filtros);
  const tr = conferencia.find((item) => item.equipmentId === trator.id);
  assert.deepEqual([tr.diario, tr.combustivel, tr.diferenca], [150, 140, 10]);
});
