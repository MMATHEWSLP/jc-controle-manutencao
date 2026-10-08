// Integração (Postgres de teste já migrado) do menu RELATÓRIOS: os relatórios do Controle Diário
// (produção e Diário x Combustível) rodam no Postgres de verdade e somam as viagens das fichas; os
// relatórios casados (custo x produção) batem com os módulos de origem, por equipamento, por frente e
// geral; e o lançamento de Outros gastos valida, respeita a frente e sai do relatório ao excluir.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:relatorios-banco
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { getD1, getDb } from "../db/index.ts";
import { componentEvents, components, dailyRecords, dailyRecordTrips, equipment, fuelMovements, fuelTypes, maintenances, maintenanceTypes, productStockMovements, products, serviceFronts, thirdParties, thirdPartyEmployees, users, workOrderItems, workOrderMechanics, workOrders } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { costProductionReport, parseCostProductionFilters } from "../lib/cost-production.ts";
import { dieselConferencia, producao } from "../lib/daily-reports.ts";
import { fleetCostReport } from "../lib/fleet-costs.ts";
import { fuelCosts } from "../lib/fuel.ts";
import { createOtherExpense, deleteOtherExpense, OtherExpenseError, updateOtherExpense } from "../lib/other-expenses.ts";
import { fuelByDestination, stockAdjustments, workOrdersReport } from "../lib/more-reports.ts";
import { listStockMovements } from "../lib/stock-history.ts";

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
  // Quem vê só algumas frentes (lista de ids na consulta): o mesmo resultado, sem erro.
  const restrito = { ...sessao, profile: "GESTOR", allServiceFronts: false, serviceFrontIds: [frente.id] };
  assert.equal((await producao(restrito, filtros, "frente"))[0].viagens, 5);
  assert.equal((await dieselConferencia(restrito, filtros)).find((item) => item.equipmentId === trator.id).combustivel, 140);
  assert.deepEqual(await producao({ ...restrito, serviceFrontIds: [frente.id + 100000, frente.id + 100001] }, filtros, "frente"), []);
});

const MES = { from: "2026-08-01", to: "2026-08-31" };
const sessaoDe = (user, frente, extra = {}) => ({ id: user.id, name: user.name, username: "", email: user.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: frente.id, serviceFrontName: frente.name, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null, ...extra });

test("relatórios casados batem com os módulos de origem (por equipamento, por frente e geral)", { skip: !enabled }, async () => {
  const db = await getDb();
  const [frente] = await db.insert(serviceFronts).values({ name: `CS${s} FRENTE` }).returning();
  const [outra] = await db.insert(serviceFronts).values({ name: `CS${s} OUTRA` }).returning();
  const [admin] = await db.insert(users).values({ email: `cs-admin-${s}@teste.local`, name: "Admin casados", role: "ADMIN", serviceFrontId: frente.id }).returning();
  const sessao = sessaoDe(admin, frente);
  const [trator, caminhao] = await db.insert(equipment).values([
    { code: `CT-${s}`, prefix: `CT-${s}`, type: "TRATOR", brand: "M", model: "X", controlType: "HOURS", serviceFrontId: frente.id },
    { code: `CC-${s}`, prefix: `CC-${s}`, type: "CAMINHÃO", brand: "M", model: "Y", controlType: "KM", serviceFrontId: frente.id },
  ]).returning();
  const tipos = await db.select().from(fuelTypes);
  const diesel = tipos.find((tipo) => !tipo.code.startsWith("GASOLINA"));
  const gasolina = tipos.find((tipo) => tipo.code.startsWith("GASOLINA"));
  // Combustível: entradas com preço e saídas (frota e uma sem equipamento); ajuste de saldo e excluída ficam fora.
  await db.insert(fuelMovements).values([
    { serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "ENTRADA", movementDate: "2026-08-01", quantity: 1000, unitPrice: 6 },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "ENTRADA", movementDate: "2026-08-01", quantity: 100, unitPrice: 6.5 },
    { serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-08-05", quantity: 100, equipmentId: trator.id },
    { serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-08-06", quantity: 200, equipmentId: caminhao.id },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "SAIDA", movementDate: "2026-08-07", quantity: 20 },
    { serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-08-08", quantity: 50, equipmentId: trator.id, balanceAdjustment: true },
    { serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-08-08", quantity: 70, equipmentId: trator.id, deletedAt: "2026-08-09T00:00:00Z" },
    { serviceFrontId: outra.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-08-08", quantity: 999, equipmentId: trator.id },
  ]);
  // Peças: uma saída para o trator (valor da saída) e uma para ninguém; estorno, correção e transferência ficam fora.
  const [produto] = await db.insert(products).values({ tag: `CS${s}`, name: "Filtro teste", price: 99 }).returning();
  await db.insert(productStockMovements).values([
    { productId: produto.id, serviceFrontId: frente.id, delta: -2, reason: "Saída", source: "STOCK_EXIT", movementDate: "2026-08-10", unitPrice: 150, equipmentId: trator.id },
    { productId: produto.id, serviceFrontId: frente.id, delta: -1, reason: "Saída", source: "STOCK_EXIT", movementDate: "2026-08-11" },
    { productId: produto.id, serviceFrontId: frente.id, delta: -5, reason: "Estornada", source: "STOCK_EXIT", movementDate: "2026-08-10", unitPrice: 150, equipmentId: trator.id, reversedAt: "2026-08-12T00:00:00Z" },
    { productId: produto.id, serviceFrontId: frente.id, delta: -3, reason: "Correção", source: "HISTORY_IMPORT", movementDate: "2026-08-10", unitPrice: 150, equipmentId: trator.id, historyKind: "AJUSTE", affectsBalance: false },
    { productId: produto.id, serviceFrontId: frente.id, delta: -4, reason: "Envio", source: "MATERIAL_REQUEST", movementDate: "2026-08-10", unitPrice: 150 },
  ]);
  // Troca de óleo com dois itens: o "Custo total" (200) está nas duas linhas e conta uma vez.
  const [tipo] = await db.insert(maintenanceTypes).values({ name: `Óleo ${s}`, category: "MOTOR" }).returning();
  const [tipo2] = await db.insert(maintenanceTypes).values({ name: `Filtro ${s}`, category: "MOTOR" }).returning();
  const criada = "2026-08-12T10:00:00.000Z";
  await db.insert(maintenances).values([tipo, tipo2].map((item) => ({ equipmentId: trator.id, serviceFrontId: frente.id, maintenanceTypeId: item.id, performedAt: "2026-08-12T09:00", workOrder: `OS-${s}`, cost: 200, createdAt: criada, updatedAt: criada })));
  // Pneu: compra (900) na primeira montagem e uma recapagem (300).
  const [pneu] = await db.insert(components).values({ kind: "TIRE", code: `P${s}`, brand: "B", purchaseCost: 900, status: "MOUNTED", equipmentId: caminhao.id }).returning();
  await db.insert(componentEvents).values([
    { componentId: pneu.id, eventType: "MOUNT", eventDate: "2026-08-03", equipmentId: caminhao.id },
    { componentId: pneu.id, eventType: "RECAP", eventDate: "2026-08-20", equipmentId: caminhao.id, cost: 300 },
  ]);
  // Outros gastos: serviço no caminhão e outros sem equipamento (pela função de lançamento).
  await createOtherExpense(db, sessao, { serviceFrontId: frente.id, equipmentId: caminhao.id, expenseDate: "2026-08-15", category: "SERVICO", amount: "500,00", description: "Mão de obra do torneiro" });
  const outrosId = await createOtherExpense(db, sessao, { serviceFrontId: frente.id, equipmentId: null, expenseDate: "2026-08-16", category: "OUTROS", amount: 80, description: "Frete" });
  // Produção: trator 10 h (dois operadores), caminhão 300 km com 3 viagens e 45 m³.
  await db.insert(dailyRecords).values([
    { equipmentId: trator.id, userId: admin.id, recordDate: "2026-08-05", workedToday: true, serviceFrontId: frente.id, readingUnit: "HOURS", startReading: 0, endReading: 4, operatorName: "Ana", location: "Talhão 1" },
    { equipmentId: trator.id, userId: admin.id, recordDate: "2026-08-06", workedToday: true, serviceFrontId: frente.id, readingUnit: "HOURS", startReading: 4, endReading: 10, operatorName: "Bruno", location: "Talhão 2" },
    { equipmentId: caminhao.id, userId: admin.id, recordDate: "2026-08-06", workedToday: true, serviceFrontId: frente.id, readingUnit: "KM", startReading: 100, endReading: 400, operatorName: "Carla", location: "Porto", totalTrips: 3, portTrips: 3, portVolumeM3: 45 },
  ]);

  const filtros = (por) => parseCostProductionFilters(new URLSearchParams({ de: MES.from, ate: MES.to, frente: String(frente.id), por }), "2026-10-08");
  const geral = await costProductionReport(filtros("geral"), "ALL", "2026-10-08");
  // Módulos de origem: custo médio do Combustível, Saídas de produtos e Custos e Consumo.
  const custos = await fuelCosts(db);
  const saidas = await db.select().from(fuelMovements).where(eq(fuelMovements.serviceFrontId, frente.id));
  const valor = (fuel, equipamento) => saidas.filter((row) => row.movementType === "SAIDA" && !row.balanceAdjustment && !row.deletedAt && row.fuelTypeId === fuel.id && (equipamento === undefined || row.equipmentId === equipamento)).reduce((sum, row) => sum + custos.get(row.id).cost, 0);
  const pecasMovimentacao = (await listStockMovements(db, { fronts: [frente.id], from: MES.from, to: MES.to, sources: ["STOCK_EXIT", "WORK_ORDER", "HISTORY_IMPORT"], exitsOnly: true, closedWorkOrdersOnly: true, excludeCorrections: true, limit: 2000 }))
    .reduce((sum, row) => sum + (row.total ?? 0), 0);
  assert.deepEqual(geral.total.costs, { diesel: valor(diesel), gasolina: valor(gasolina), pecas: 300 + 99, manutencao: 700, pneus: 1200, outros: 80 });
  assert.equal(valor(diesel), 1800);
  assert.equal(pecasMovimentacao, 300, "Saídas de produtos soma o valor da saída (a sem valor fica de fora lá)");
  assert.equal(geral.total.total, 1800 + 130 + 399 + 700 + 1200 + 80);
  assert.equal(geral.total.dieselLiters, 300);
  assert.equal(geral.total.hours, 10);
  assert.equal(geral.total.km, 300);
  assert.equal(geral.total.trips, 3);
  assert.equal(geral.total.volume, 45);

  const porEquipamento = await costProductionReport(filtros("equipamento"), "ALL", "2026-10-08");
  const linha = (prefix) => porEquipamento.rows.find((row) => row.key === prefix);
  assert.equal(linha(trator.prefix).total, 600 + 300 + 200);
  assert.equal(linha(trator.prefix).perHour, 110);
  assert.equal(linha(caminhao.prefix).total, 1200 + 900 + 300 + 500);
  assert.equal(linha(caminhao.prefix).perKm, 2900 / 300);
  assert.equal(linha(caminhao.prefix).perM3, 2900 / 45);
  assert.equal(linha("Sem equipamento").total, 130 + 99 + 80);
  assert.equal(porEquipamento.total.total, geral.total.total);
  // Custos e Consumo (por equipamento) dá o mesmo combustível, peças e troca (contada uma vez).
  const fleet = await fleetCostReport(await getD1(), sessao, { from: MES.from, to: MES.to, frontId: frente.id });
  const tratorFleet = fleet.rows.find((row) => row.equipmentId === trator.id);
  assert.deepEqual([tratorFleet.fuelCost, tratorFleet.partsCost, tratorFleet.maintenanceCost, tratorFleet.totalCost], [600, 300, 200, 1100]);

  const porFrente = await costProductionReport(filtros("frente"), "ALL", "2026-10-08");
  assert.deepEqual(porFrente.rows.map((row) => [row.key, row.total]), [[frente.name, geral.total.total]]);
  const porOperador = await costProductionReport(filtros("operador"), "ALL", "2026-10-08");
  const ana = porOperador.rows.find((row) => row.key === "Ana");
  assert.equal(ana.total, Math.round(1100 * 0.4 * 100) / 100, "Ana trabalhou 4 das 10 horas do trator");
  assert.equal(Math.round(porOperador.rows.reduce((sum, row) => sum + row.total, 0) * 100) / 100, geral.total.total);

  // Frente que a pessoa não vê fica fora; excluir o gasto tira do relatório.
  const soOutra = await costProductionReport(filtros("geral"), [outra.id], "2026-10-08");
  assert.equal(soOutra.total.total, 0);
  await deleteOtherExpense(db, sessao, outrosId);
  const depois = await costProductionReport(filtros("geral"), "ALL", "2026-10-08");
  assert.equal(depois.total.costs.outros, 0);
});

test("Outros gastos: validação, frente da pessoa e edição", { skip: !enabled }, async () => {
  const db = await getDb();
  const [frente] = await db.insert(serviceFronts).values({ name: `OG${s} FRENTE` }).returning();
  const [outra] = await db.insert(serviceFronts).values({ name: `OG${s} OUTRA` }).returning();
  const [user] = await db.insert(users).values({ email: `og-${s}@teste.local`, name: "Usuário gastos", role: "OPERADOR", serviceFrontId: frente.id }).returning();
  const sessao = sessaoDe(user, frente, { profile: "OPERADOR", allServiceFronts: false, serviceFrontIds: [frente.id], permissions: ["costs.other_expenses"] });
  const base = { serviceFrontId: frente.id, equipmentId: null, expenseDate: "2026-08-20", category: "SERVICO", amount: "1.234,56", description: "Guincho" };
  await assert.rejects(createOtherExpense(db, sessao, { ...base, amount: "0" }), (error) => error instanceof OtherExpenseError && error.field === "amount");
  await assert.rejects(createOtherExpense(db, sessao, { ...base, description: "x" }), (error) => error instanceof OtherExpenseError && error.field === "description");
  await assert.rejects(createOtherExpense(db, sessao, { ...base, category: "PECAS" }), (error) => error instanceof OtherExpenseError && error.field === "category");
  await assert.rejects(createOtherExpense(db, sessao, { ...base, serviceFrontId: outra.id }), (error) => error instanceof OtherExpenseError && error.status === 403);
  const id = await createOtherExpense(db, sessao, base);
  const lido = async () => (await costProductionReport(parseCostProductionFilters(new URLSearchParams({ de: "2026-08-01", ate: "2026-08-31", frente: String(frente.id), por: "geral" }), "2026-10-08"), [frente.id], "2026-10-08")).total.costs;
  assert.equal((await lido()).manutencao, 1234.56);
  await updateOtherExpense(db, sessao, id, { ...base, category: "OUTROS", amount: 100 });
  assert.deepEqual([(await lido()).manutencao, (await lido()).outros], [0, 100]);
  await assert.rejects(updateOtherExpense(db, sessao, id, { ...base, serviceFrontId: outra.id }), (error) => error instanceof OtherExpenseError && error.status === 403);
});

test("combustível por destino, ajustes de estoque e ordens de serviço (parte 3c)", { skip: !enabled }, async () => {
  const db = await getDb();
  const [frente] = await db.insert(serviceFronts).values({ name: `MR${s} FRENTE` }).returning();
  const [trator] = await db.insert(equipment).values({ code: `MT-${s}`, prefix: `MT-${s}`, type: "TRATOR", brand: "M", model: "X", controlType: "HOURS", serviceFrontId: frente.id }).returning();
  const tipos = await db.select().from(fuelTypes);
  const gasolina = tipos.find((tipo) => tipo.code.startsWith("GASOLINA"));
  const [empresa] = await db.insert(thirdParties).values({ name: `Empresa ${s}`, kind: "TERCEIRIZADA" }).returning();
  const [joao] = await db.insert(thirdPartyEmployees).values({ thirdPartyId: empresa.id, name: "João da motosserra" }).returning();
  await db.insert(fuelMovements).values([
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "ENTRADA", movementDate: "2026-07-01", quantity: 100, unitPrice: 7 },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "SAIDA", movementDate: "2026-07-02", quantity: 10, equipmentId: trator.id },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "SAIDA", movementDate: "2026-07-03", quantity: 5, thirdParty: true, thirdPartyKind: "GERAL", thirdPartyId: empresa.id, thirdPartyDestination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, purpose: "MOTOSSERRA" },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "SAIDA", movementDate: "2026-07-04", quantity: 5, thirdParty: true, thirdPartyKind: "GERAL", thirdPartyId: empresa.id, thirdPartyDestination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, purpose: "MOTOSSERRA" },
    { serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "SAIDA", movementDate: "2026-07-05", quantity: 3, thirdParty: true, thirdPartyKind: "GERAL", thirdPartyDescription: "Doação à comunidade" },
  ]);
  const periodo = { from: "2026-07-01", to: "2026-07-31", frontId: frente.id };
  const destinos = await fuelByDestination({ ...periodo, fuelTypeId: gasolina.id }, "ALL");
  assert.deepEqual(destinos.rows.map((row) => [row.kind, row.destination, row.purpose, row.count, row.liters, row.value]), [
    ["Terceiro/Doações", `${empresa.name} · João da motosserra`, "Motosserra", 2, 10, 70],
    ["Frota JC", trator.prefix, null, 1, 10, 70],
    ["Terceiro/Doações", "Doação à comunidade", null, 1, 3, 21],
  ]);
  assert.deepEqual(destinos.totals, { count: 4, liters: 23, value: 161 });

  const [produto] = await db.insert(products).values({ tag: `MR${s}`, name: "Correia teste", price: 50 }).returning();
  await db.insert(productStockMovements).values([
    { productId: produto.id, serviceFrontId: frente.id, delta: 3, reason: "Contagem do inventário", source: "ADJUSTMENT", movementDate: "2026-07-10" },
    { productId: produto.id, serviceFrontId: frente.id, delta: -2, reason: "Correção", source: "HISTORY_IMPORT", historyKind: "AJUSTE", movementDate: "2026-07-11", unitPrice: 40, affectsBalance: false },
    { productId: produto.id, serviceFrontId: frente.id, delta: -1, reason: "Saída comum (não é ajuste)", source: "STOCK_EXIT", movementDate: "2026-07-12", unitPrice: 50 },
  ]);
  const ajustes = await stockAdjustments({ ...periodo, q: `MR${s}` }, [frente.id]);
  assert.deepEqual(ajustes.totals, { count: 2, increases: 1, decreases: 1, increaseValue: 150, decreaseValue: -80 });

  const [aberta, fechada] = await db.insert(workOrders).values([
    { equipmentId: trator.id, serviceFrontId: frente.id, openedAt: "2026-07-20T08:00:00", meterUnit: "HOURS", description: "Vazamento hidráulico" },
    { equipmentId: trator.id, serviceFrontId: frente.id, openedAt: "2026-07-01T08:00:00", meterUnit: "HOURS", description: "Troca de embreagem", status: "CLOSED", closedAt: "2026-07-05T17:00:00" },
  ]).returning();
  await db.insert(workOrderItems).values([
    { workOrderId: fechada.id, productId: produto.id, quantity: 2, launchDate: "2026-07-02", withdrawnBy: "Mecânico", unitPrice: 50 },
    { workOrderId: fechada.id, productId: produto.id, quantity: 9, launchDate: "2026-07-02", withdrawnBy: "Mecânico", unitPrice: 50, removedAt: "2026-07-03T00:00:00Z" },
  ]);
  await db.insert(workOrderMechanics).values([{ workOrderId: fechada.id, mechanicName: "Carlos" }, { workOrderId: fechada.id, mechanicName: "Ana" }]);
  const os = await workOrdersReport({ ...periodo, status: null, equipmentId: null }, [frente.id], "2026-07-25");
  const linhaFechada = os.rows.find((row) => row.id === fechada.id);
  const linhaAberta = os.rows.find((row) => row.id === aberta.id);
  assert.deepEqual([linhaFechada.days, linhaFechada.items, linhaFechada.partsTotal, linhaFechada.mechanics], [4, 1, 100, "Ana, Carlos"]);
  assert.deepEqual([linhaAberta.status, linhaAberta.days], ["OPEN", 5]);
  assert.deepEqual(os.totals, { count: 2, open: 1, closed: 1, partsTotal: 100, averageDaysClosed: 4 });
  assert.equal((await workOrdersReport({ ...periodo, status: "OPEN", equipmentId: null }, [frente.id], "2026-07-25")).rows.length, 1);
  assert.equal((await workOrdersReport({ ...periodo, status: null, equipmentId: null }, [frente.id + 100000], "2026-07-25")).rows.length, 0);
});
