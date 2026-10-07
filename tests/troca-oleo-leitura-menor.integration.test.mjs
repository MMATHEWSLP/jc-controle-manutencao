// Troca de óleo com a leitura ABAIXO da atual (ex.: troca feita antes e lançada depois), num Postgres
// de teste já migrado. Só roda com TEST_DATABASE_URL (nunca DATABASE_URL) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:troca-oleo-banco
// Quem registra troca (não só o administrador) pode lançar, confirmando; a leitura atual do equipamento
// não diminui e a próxima troca é calculada a partir da leitura informada.
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getD1, getDb } from "../db/index.ts";
import { auditLogs, equipment, equipmentMaintenanceTypes, maintenanceIntervalConfigs, maintenancePlans, maintenances, maintenanceTypes, serviceFronts, users, userServiceFronts } from "../db/schema.ts";
import { createSession, SESSION_COOKIE } from "../lib/auth.ts";
import { recalculateMaintenanceCycles } from "../lib/maintenance-recalculation.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

test("troca de óleo com KM abaixo do atual: oficina lança com confirmação, sem baixar a leitura do equipamento", { skip: !enabled }, async () => {
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE OLEO ${s}` }).returning();
  const [type] = await db.insert(maintenanceTypes).values({ name: `TROCA DE OLEO DO MOTOR ${s}`, category: "OIL" }).returning();
  const prefix = `TO${s}-01`;
  const [truck] = await db.insert(equipment).values({ code: `EQ-${prefix}`, prefix, type: "CAMINHÃO", brand: "M", model: "AXOR", controlType: "KM", currentHours: 0, currentKm: 120000, serviceFrontId: front.id }).returning();
  await db.insert(equipmentMaintenanceTypes).values({ equipmentId: truck.id, maintenanceTypeId: type.id, applicable: true });
  await db.insert(maintenanceIntervalConfigs).values({ category: `TO${s}`, maintenanceTypeId: type.id, intervalValue: 10000, unit: "KM" });
  await recalculateMaintenanceCycles(await getD1(), { equipmentId: truck.id, force: true });
  const plan = (await db.select().from(maintenancePlans).where(and(eq(maintenancePlans.equipmentId, truck.id), eq(maintenancePlans.maintenanceTypeId, type.id))))[0];
  assert.ok(plan, "plano criado");
  // Usuário da Oficina (não administrador), com a frente do equipamento.
  const [mechanic] = await db.insert(users).values({ email: `oficina-${s}@teste.local`, username: `oficina-${s}`, name: `MECANICO ${s}`, role: "OFICINA", serviceFrontId: front.id }).returning();
  await db.insert(userServiceFronts).values({ userId: mechanic.id, serviceFrontId: front.id });
  const token = await createSession(mechanic.id, "SHORT");
  const { POST } = await import("../app/api/maintenance/route.ts");
  const send = (extra = {}) => POST(new Request("https://www.jcsistema.online/api/maintenance", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://www.jcsistema.online", cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    body: JSON.stringify({ equipmentId: truck.id, planIds: [plan.id], performedAt: "2026-09-20T10:00", km: 115000, workOrder: "", cost: 0, notes: "Troca feita antes, lançada depois", ...extra }),
  }));

  // Sem confirmar: pede confirmação (não é mais "só o administrador").
  const ask = await send();
  const askBody = await ask.json();
  assert.equal(ask.status, 409);
  assert.equal(askBody.requiresConfirmation, true);
  assert.match(askBody.error, /115\.000 km \(atual 120\.000 km\).*menor que a leitura atual/);
  assert.equal((await db.select().from(maintenances).where(eq(maintenances.equipmentId, truck.id))).length, 0, "nada gravado antes de confirmar");

  // Confirmado: grava a troca com 115.000 km; a leitura do equipamento continua 120.000 km.
  const saved = await send({ authorizeRegression: true });
  assert.equal(saved.status, 201, JSON.stringify(await saved.clone().json()));
  const row = (await db.select().from(maintenances).where(eq(maintenances.equipmentId, truck.id)))[0];
  assert.equal(row.km, 115000);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, truck.id)))[0].currentKm), 120000, "leitura atual não diminui");
  const after = (await db.select().from(maintenancePlans).where(eq(maintenancePlans.id, plan.id)))[0];
  assert.deepEqual([after.lastKm, after.nextKm], [115000, 125000], "próxima troca calculada a partir da leitura informada");
  const log = (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, String(truck.id)), eq(auditLogs.action, "TROCA DE ÓLEO"))))[0];
  assert.equal(JSON.parse(log.newValue).leituraMenorQueAtual, true);
});
