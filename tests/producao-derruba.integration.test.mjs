// Integração (Postgres de teste já migrado) da PRODUÇÃO — Fase 2, Derruba: lançamento do dia em lote,
// cards (534 árvores em 4 dias = 133,50/dia), gasolina valorada pelo custo médio do estoque sem mexer no
// combustível (8 L × R$ 6,29 = R$ 50,32; 10 L = R$ 62,90; excluir some), material pela saída de estoque
// (baixa 1 e volta no estorno), manutenção sem peça em Outros gastos, análises, multi-frente, importação
// com desfazer e o apontador de campo.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:producao-derruba-banco
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { employees, fuelMovements, fuelTypes, otherExpenses, productFrontStock, productionProjects, products, serviceFronts, stockExits, users } from "../db/schema.ts";
import { ALL_PERMISSIONS, resolvePermissions } from "../lib/auth.ts";
import { changeStage, createProject, ProductionError, productionAccess, productionFronts, saveReason, setFrontPrice, setProductionUse } from "../lib/production.ts";
import { fellingAnalysis, fellingHistory, fellingMultiFront, fellingProjectCards, loadFellingDay, saveFellingDay, setTarget, updateFellingLine, deleteFellingLine, FellingDayError } from "../lib/production-felling.ts";
import { analyzeImport, confirmImport, createMaintenance, createMaterial, deleteExpense, listExpenses, revertImport } from "../lib/production-expenses.ts";
import { cancelStockExit } from "../lib/stock-exits.ts";
import { OtherExpenseError, updateOtherExpense } from "../lib/other-expenses.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const run = Date.now().toString(36).toUpperCase().slice(-4);
let cenarios = 0;
const sessionOf = (row, profile, permissions, extra = {}) => ({ id: row.id, name: row.name, username: "", email: row.email, profile, taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false,
  lastAccessAt: null, createdAt: "", permissions, serviceFrontId: row.serviceFrontId, serviceFrontName: null, allServiceFronts: false, serviceFrontIds: [], canExport: false, jobTitle: null, ...extra });
const PERIOD = { from: "2026-09-01", to: "2026-09-30", projectId: null };

async function cenario() {
  const db = await getDb();
  const s = `${run}${++cenarios}`;
  const [frente, outra] = await db.insert(serviceFronts).values([{ name: `DR${s} MAMURU` }, { name: `DR${s} FLEXAL` }]).returning();
  const [admin, campo] = await db.insert(users).values([
    { email: `der-admin-${s}@t.local`, name: "Admin derruba", role: "ADMIN", serviceFrontId: frente.id },
    { email: `der-campo-${s}@t.local`, name: `APONTADOR ${s}`, role: "CAMPO", serviceFrontId: frente.id, productionRegister: true, fieldDailyAccess: false },
  ]).returning();
  const adminSession = sessionOf(admin, "ADMIN", ALL_PERMISSIONS, { allServiceFronts: true });
  const campoSession = sessionOf(campo, "CAMPO", resolvePermissions("CAMPO", [], { convoy: false, daily: false, production: true }), { serviceFrontIds: [frente.id] });
  const pessoas = await db.insert(employees).values(["ANA", "BRUNO", "CARLA", "DIEGO"].map((nome, index) => ({
    name: `${nome} ${s}`, jobTitle: index === 1 ? "AJUDANTE OPERADOR DE MOTOSSERRA" : "OP. DE MOTOSSERRA - DERRUBA", company: "JC", admissionDate: "2025-01-01", serviceFrontId: frente.id,
  }))).returning();
  const fronts = await productionFronts(db, adminSession);
  const projectId = await createProject(db, adminSession, fronts, { serviceFrontId: frente.id, name: `UPA ${s}` });
  const [gasolina] = await db.select().from(fuelTypes).where(eq(fuelTypes.code, "GASOLINA_COMUM"));
  return { db, s, frente, outra, admin, campo, adminSession, campoSession, pessoas, fronts, projectId, gasolina };
}

const linha = (operator, trees, extra = {}) => ({ operatorEmployeeId: operator.id, trees: String(trees), ipes: "0", ...extra });

test("lançamento do dia: grade, erros por linha, troca do dia inteiro e sugestão do último dia", { skip: !enabled }, async () => {
  const { db, adminSession, pessoas, fronts, projectId } = await cenario();
  const [ana, bruno, carla, diego] = pessoas;
  await assert.rejects(saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-01", lines: [linha(ana, 10, { ipes: "11" }), linha(ana, 5)] }),
    (error) => error instanceof FellingDayError && error.lineErrors.map((item) => item.field).join() === "ipes,operatorEmployeeId");
  await assert.rejects(saveFellingDay(db, adminSession, fronts, { projectId, date: "2999-01-01", lines: [linha(ana, 10)] }), /futura/);
  const result = await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-01", lines: [linha(ana, 30, { helperEmployeeId: bruno.id, ipes: "2", gasolineLiters: "8" }), linha(carla, 25), {}, linha(diego, 20)] });
  assert.deepEqual(result, { saved: 3, removed: 0, trees: 75 });
  // Reabrir o dia e tirar a Diego: a grade é o dia inteiro.
  const day = await loadFellingDay(db, fronts, projectId, "2026-09-01");
  assert.equal(day.saved, true);
  assert.deepEqual(day.lines.map((line) => line.operator.name), [ana.name, carla.name, diego.name]);
  const again = await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-01", lines: day.lines.filter((line) => line.operatorEmployeeId !== diego.id).map((line) => ({ ...line, trees: String(line.trees), ipes: String(line.ipes), gasolineLiters: String(line.gasolineLiters) })) });
  assert.equal(again.removed, 1);
  // Dia novo sugere quem trabalhou no último dia, com os números em branco.
  const next = await loadFellingDay(db, fronts, projectId, "2026-09-02");
  assert.equal(next.saved, false);
  assert.equal(next.suggestedFrom, "2026-09-01");
  assert.deepEqual(next.lines.map((line) => [line.operator.name, line.helper?.name ?? null, line.trees]), [[ana.name, bruno.name, null], [carla.name, null, null]]);
  // Etapa finalizada não aceita lançamento.
  await changeStage(db, adminSession, fronts, projectId, "DERRUBA", "FINALIZAR");
  await assert.rejects(saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-02", lines: [linha(ana, 10)] }), /finalizada/);
});

test("card do projeto: 534 árvores em 4 dias = média 133,50/dia", { skip: !enabled }, async () => {
  const { db, frente, adminSession, pessoas, fronts, projectId } = await cenario();
  const [ana, , carla] = pessoas;
  const dias = [["2026-09-01", 100, 40], ["2026-09-02", 90, 50], ["2026-09-03", 80, 60], ["2026-09-04", 70, 44]];
  for (const [date, a, c] of dias) await saveFellingDay(db, adminSession, fronts, { projectId, date, lines: [linha(ana, a), linha(carla, c)] });
  const card = (await fellingProjectCards(db, [frente.id])).find((item) => item.id === projectId);
  assert.deepEqual([card.trees, card.days, card.operators, card.perDay], [534, 4, 2, 133.5]);
});

test("gasolina: valor pelo custo médio do estoque, sem saída de combustível", { skip: !enabled }, async () => {
  const { db, frente, adminSession, pessoas, fronts, projectId, gasolina } = await cenario();
  const [ana] = pessoas;
  await db.insert(fuelMovements).values({ serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "ENTRADA", movementDate: "2026-08-30", quantity: 1000, unitPrice: 6.29, responsible: "Teste" });
  const antes = (await db.select().from(fuelMovements).where(eq(fuelMovements.serviceFrontId, frente.id))).length;
  await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-05", lines: [linha(ana, 30, { gasolineLiters: "8" })] });
  let [row] = await fellingHistory(db, adminSession, [frente.id], PERIOD);
  assert.equal(row.gasolineValue, 50.32);
  await updateFellingLine(db, adminSession, fronts, row.id, { trees: "30", ipes: "0", gasolineLiters: "10" });
  [row] = await fellingHistory(db, adminSession, [frente.id], PERIOD);
  assert.equal(row.gasolineValue, 62.9);
  const gasolinaNaLista = (await listExpenses(db, [frente.id], PERIOD, "DERRUBA")).filter((item) => item.source === "GASOLINA");
  assert.deepEqual(gasolinaNaLista.map((item) => [item.quantity, item.value]), [[10, 62.9]]);
  assert.equal((await db.select().from(fuelMovements).where(eq(fuelMovements.serviceFrontId, frente.id))).length, antes, "nenhuma saída de combustível criada");
  // Excluir lançamento é do gerenciar (plano, seção 5): quem só lança corrige pelo Editar.
  const soLanca = { ...adminSession, profile: "GESTOR", permissions: ["producao.ver", "producao.custos", "producao.lancar"] };
  await assert.rejects(deleteFellingLine(db, soLanca, fronts, row.id), (error) => error instanceof ProductionError && error.status === 403);
  await deleteFellingLine(db, adminSession, fronts, row.id);
  assert.equal((await listExpenses(db, [frente.id], PERIOD, "DERRUBA")).length, 0);
  // Sem permissão de custos, o histórico não traz R$.
  await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-06", lines: [linha(ana, 30, { gasolineLiters: "8" })] });
  const semCustos = await fellingHistory(db, { ...adminSession, profile: "GESTOR", permissions: ["producao.ver"] }, [frente.id], PERIOD);
  assert.equal(semCustos[0].gasolineValue, null);
});

test("material e manutenção: saída de estoque pelo preço da frente e outros gastos da Produção", { skip: !enabled }, async () => {
  const { db, s, frente, adminSession, pessoas, fronts, projectId } = await cenario();
  const [ana] = pessoas;
  const [lima] = await db.insert(products).values({ tag: `LM${s}`, name: `LIMA CHATA ${s}`, price: 17.91 }).returning();
  await db.insert(productFrontStock).values({ productId: lima.id, serviceFrontId: frente.id, quantity: 10 });
  await setProductionUse(db, adminSession, lima.id, true);
  await setFrontPrice(db, adminSession, fronts, { productId: lima.id, serviceFrontId: frente.id, price: "32,22" });
  await createMaterial(db, adminSession, fronts, { projectId, date: "2026-09-05", employeeId: ana.id, productId: lima.id, quantity: "1" });
  const saldo = async () => Number((await db.select().from(productFrontStock).where(and(eq(productFrontStock.productId, lima.id), eq(productFrontStock.serviceFrontId, frente.id))))[0].quantity);
  assert.equal(await saldo(), 9, "baixa 1 do estoque");
  let lista = await listExpenses(db, [frente.id], PERIOD, "DERRUBA");
  const material = lista.find((item) => item.source === "ESTOQUE");
  assert.deepEqual([material.kind, material.quantity, material.value, material.projectId], ["MATERIAL", 1, 32.22, projectId]);
  await assert.rejects(cancelStockExit(db, adminSession, material.id, "teste"), /Produção/, "Movimentação não estorna saída da Produção");
  await createMaintenance(db, adminSession, fronts, { projectId, date: "2026-09-05", employeeId: ana.id, kind: "MANUTENCAO", value: "85,50", tool: "ms 01" });
  lista = await listExpenses(db, [frente.id], PERIOD, "DERRUBA");
  const reparo = lista.find((item) => item.source === "OUTROS");
  assert.deepEqual([reparo.kind, reparo.value, reparo.tool, reparo.origin], ["MANUTENCAO", 85.5, "MS 01", "MANUAL"]);
  const [gasto] = await db.select().from(otherExpenses).where(eq(otherExpenses.id, reparo.id));
  assert.deepEqual([gasto.category, gasto.productionSector, gasto.employeeId], ["SERVICO", "DERRUBA", ana.id]);
  await assert.rejects(updateOtherExpense(db, adminSession, reparo.id, { serviceFrontId: frente.id, expenseDate: "2026-09-05", category: "OUTROS", amount: 1, description: "xxx" }), (error) => error instanceof OtherExpenseError && error.status === 409);
  await assert.rejects(createMaintenance(db, adminSession, fronts, { projectId, date: "2026-09-05", employeeId: ana.id, kind: "PERDA_TOTAL" }), /valor/);
  await assert.rejects(deleteExpense(db, { ...adminSession, profile: "GESTOR", permissions: ["producao.ver", "producao.custos", "producao.lancar"] }, fronts, "ESTOQUE", material.id),
    (error) => error instanceof ProductionError && error.status === 403, "estornar despesa é do gerenciar");
  await deleteExpense(db, adminSession, fronts, "ESTOQUE", material.id);
  assert.equal(await saldo(), 10, "estorno devolve ao estoque");
  await deleteExpense(db, adminSession, fronts, "OUTROS", reparo.id);
  assert.equal((await listExpenses(db, [frente.id], PERIOD, "DERRUBA")).length, 0);
  // Sem custos não lança despesa.
  await assert.rejects(createMaterial(db, { ...adminSession, profile: "GESTOR", permissions: ["producao.lancar"] }, fronts, { projectId, date: "2026-09-05", employeeId: ana.id, productId: lima.id, quantity: "1" }),
    (error) => error instanceof ProductionError && error.status === 403);
});

test("análises e multi-frente", { skip: !enabled }, async () => {
  const { db, s, frente, outra, adminSession, pessoas, fronts, projectId, gasolina } = await cenario();
  const [ana, , carla] = pessoas;
  const outroProjeto = await createProject(db, adminSession, fronts, { serviceFrontId: outra.id, name: `UPA FLEXAL ${s}` });
  await setTarget(db, adminSession, fronts, { serviceFrontId: frente.id, stage: "DERRUBA", value: "30" });
  await db.insert(fuelMovements).values({ serviceFrontId: frente.id, fuelTypeId: gasolina.id, movementType: "ENTRADA", movementDate: "2026-08-30", quantity: 1000, unitPrice: 6.29, responsible: "Teste" });
  await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-01", lines: [linha(ana, 40, { gasolineLiters: "8" }), linha(carla, 20, { reasonId: null })] });
  await saveFellingDay(db, adminSession, fronts, { projectId, date: "2026-09-02", lines: [linha(ana, 30)] });
  await saveFellingDay(db, adminSession, fronts, { projectId: outroProjeto, date: "2026-09-03", lines: [linha(ana, 50)] });
  await createMaintenance(db, adminSession, fronts, { projectId, date: "2026-09-02", employeeId: ana.id, kind: "PERDA_TOTAL", value: "1000" });
  const analise = await fellingAnalysis(db, [frente.id, outra.id], PERIOD);
  assert.deepEqual([analise.kpis.operators, analise.kpis.trees, analise.kpis.ipes, analise.kpis.cost], [2, 140, 0, 1050.32]);
  assert.equal(analise.kpis.perDay, 35, "140 árvores ÷ 4 dias-operador");
  const anaLinha = analise.byOperator.find((row) => row.operatorId === ana.id);
  assert.deepEqual([anaLinha.days, anaLinha.trees, anaLinha.gasolineLiters, anaLinha.losses, anaLinha.spent, anaLinha.costPerTree], [3, 120, 8, 1, 1050.32, 8.75]);
  assert.deepEqual(analise.daily.filter((row) => row.operatorName === ana.name).map((row) => row.resultLabel).sort(), ["Meta não definida", "Na meta", "Na meta"]);
  const multi = await fellingMultiFront(db, [frente.id, outra.id], PERIOD);
  const anaMulti = multi.rows.find((row) => row.operatorId === ana.id);
  assert.deepEqual([anaMulti.fronts.length, anaMulti.days, anaMulti.trees, anaMulti.daysOnTarget, anaMulti.treesAboveTarget], [2, 3, 120, 2, 10]);
});

test("importação de despesas: prévia, igual ignorada, gravação e desfazer", { skip: !enabled }, async () => {
  const { db, s, frente, adminSession, pessoas, fronts, projectId } = await cenario();
  const [ana] = pessoas;
  const [corrente] = await db.insert(products).values({ tag: `CR${s}`, name: `CORRENTE ${s}`, price: 123, productionUse: true }).returning();
  await db.insert(productFrontStock).values({ productId: corrente.id, serviceFrontId: frente.id, quantity: 5 });
  const [projeto] = await db.select().from(productionProjects).where(eq(productionProjects.id, projectId));
  const rows = [
    { rowNumber: 2, values: { data: "05/09/2026", projeto: projeto.name, funcionario: ana.name.toLowerCase(), tipo: "Material", produto: corrente.tag, quantidade: "2" } },
    { rowNumber: 3, values: { data: "05/09/2026", projeto: projeto.name, funcionario: ana.name, tipo: "Manutenção", valor: "85,00", observacao: "cordão" } },
    { rowNumber: 4, values: { data: "05/09/2026", projeto: projeto.name, tipo: "Custo operacional", valor: "150" } },
    { rowNumber: 5, values: { data: "31/02/2026", projeto: "NÃO EXISTE", tipo: "Viagem" } },
    { rowNumber: 6, values: { data: "05/09/2026", projeto: projeto.name, funcionario: ana.name, tipo: "Manutenção", valor: "85,00" } },
  ];
  await assert.rejects(analyzeImport(db, { ...adminSession, profile: "GESTOR" }, fronts, rows), (error) => error instanceof ProductionError && error.status === 403);
  const preview = await analyzeImport(db, adminSession, fronts, rows);
  assert.deepEqual(preview.map((row) => row.status), ["OK", "OK", "OK", "ERRO", "IGUAL"]);
  assert.equal(preview[3].messages.length, 3);
  const result = await confirmImport(db, adminSession, fronts, "despesas.xlsx", rows, false);
  assert.deepEqual([result.imported, result.ignored, result.errors, result.failed.length], [3, 1, 1, 0]);
  const saldo = async () => Number((await db.select().from(productFrontStock).where(eq(productFrontStock.productId, corrente.id)))[0].quantity);
  assert.equal(await saldo(), 3);
  const lista = await listExpenses(db, [frente.id], PERIOD, "DERRUBA");
  assert.deepEqual(lista.map((item) => item.origin).sort(), ["IMPORTACAO", "IMPORTACAO", "IMPORTACAO"]);
  // Importar de novo: tudo igual ao que já existe.
  const second = await analyzeImport(db, adminSession, fronts, rows.slice(0, 3));
  assert.deepEqual(second.map((row) => row.status), ["IGUAL", "IGUAL", "IGUAL"]);
  await revertImport(db, adminSession, result.batchId);
  assert.equal(await saldo(), 5);
  assert.equal((await listExpenses(db, [frente.id], PERIOD, "DERRUBA")).length, 0);
  await assert.rejects(revertImport(db, adminSession, result.batchId), /já foi desfeito/);
  const exits = await db.select().from(stockExits).where(eq(stockExits.productionImportBatchId, result.batchId));
  assert.ok(exits.every((exit) => exit.cancelledAt), "saídas do lote estornadas");
});

test("apontador de campo lança a derruba e não vê custos", { skip: !enabled }, async () => {
  const { db, campoSession, pessoas, projectId, frente } = await cenario();
  const [ana] = pessoas;
  assert.deepEqual(campoSession.permissions, ["producao.lancar"]);
  assert.deepEqual(productionAccess(campoSession), { view: false, costs: false, launch: true, manage: false, admin: false });
  const fronts = await productionFronts(db, campoSession);
  assert.deepEqual(fronts.map((front) => front.id), [frente.id]);
  const result = await saveFellingDay(db, campoSession, fronts, { projectId, date: "2026-09-05", lines: [linha(ana, 33, { gasolineLiters: "5" })] });
  assert.equal(result.trees, 33);
  const [row] = await fellingHistory(db, campoSession, [frente.id], PERIOD);
  assert.deepEqual([row.trees, row.gasolineLiters, row.gasolineValue], [33, 5, null]);
  await assert.rejects(saveReason(db, campoSession, null, { code: "X.99", description: "teste" }), (error) => error instanceof ProductionError && error.status === 403);
});
