// Integração (Postgres de teste já migrado) da PRODUÇÃO — Fase 1: permissões (só o ADMIN por padrão;
// apontador de campo só lança), projetos (nome único por frente, frente que a pessoa vê, finalizar/reabrir
// com registro de quem fez), equipes e integrantes, preço por frente e motivos.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:producao-banco
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { auditLogs, employees, productFrontPrices, productionProjects, productionStageEvents, products, serviceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS, effectivePermissions, resolvePermissions } from "../lib/auth.ts";
import {
  addTeamMember, changeStage, createProject, createTeam, listProductionProducts, listProjects, listTeamMembers, listTeams, lookupProductionEmployees, ProductionError,
  productionAccess, productionFronts, removeTeamMember, saveReason, setFrontPrice, setProductionUse, setProjectActive, updateProject, updateTeamMember,
} from "../lib/production.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const run = Date.now().toString(36).toUpperCase().slice(-4);
const sessionOf = (row, profile, permissions, extra = {}) => ({ id: row.id, name: row.name, username: "", email: row.email, profile, taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false,
  lastAccessAt: null, createdAt: "", permissions, serviceFrontId: row.serviceFrontId, serviceFrontName: null, allServiceFronts: false, serviceFrontIds: [], canExport: false, jobTitle: null, ...extra });
const rejects = async (promise, status, pattern) => {
  await assert.rejects(promise, (error) => error instanceof ProductionError && error.status === status && (!pattern || pattern.test(error.message)));
};

let cenarios = 0;
async function cenario() {
  const db = await getDb();
  // Sufixo por cenário: cada teste cria as próprias frentes, pessoas e produtos.
  const s = `${run}${++cenarios}`;
  const [frenteA, frenteB] = await db.insert(serviceFronts).values([{ name: `PR${s} A` }, { name: `PR${s} B` }]).returning();
  const [admin, gestor, campo] = await db.insert(users).values([
    { email: `prod-admin-${s}@t.local`, name: "Admin produção", role: "ADMIN", serviceFrontId: frenteA.id },
    { email: `prod-gestor-${s}@t.local`, name: "Gestor produção", role: "GESTOR", serviceFrontId: frenteA.id },
    { email: `prod-campo-${s}@t.local`, name: "Apontador", role: "CAMPO", serviceFrontId: frenteA.id, productionRegister: true, fieldDailyAccess: false },
  ]).returning();
  const adminSession = sessionOf(admin, "ADMIN", ALL_PERMISSIONS, { allServiceFronts: true });
  // Gestor que só vê a frente A, com as permissões da Produção liberadas por pessoa.
  const gestorSession = sessionOf(gestor, "GESTOR", ["producao.ver", "producao.lancar", "producao.gerenciar"], { serviceFrontIds: [frenteA.id] });
  const pessoas = await db.insert(employees).values([
    { name: `JOAO MOTOSSERRA ${s}`, jobTitle: "OP. DE MOTOSSERRA - DERRUBA", company: "JC", admissionDate: "2025-01-01", serviceFrontId: frenteA.id },
    { name: `ANDERSON AJUDANTE ${s}`, jobTitle: "AJUDANTE OPERADOR DE MOTOSSERRA", company: "RCA", admissionDate: "2025-01-01", serviceFrontId: frenteA.id },
    { name: `PEDRO SKIDDER ${s}`, jobTitle: "OPERADOR DE SKIDDER", company: "JC", admissionDate: "2025-01-01", serviceFrontId: frenteA.id },
    { name: `ZE DESLIGADO ${s}`, jobTitle: "OPERADOR DE MOTOSSERRA", company: "JC", admissionDate: "2024-01-01", serviceFrontId: frenteA.id, status: "DEMITIDO" },
  ]).returning();
  const [lima] = await db.insert(products).values({ tag: `L${s}`, name: `LIMA CHATA ${s}`, price: 12.5 }).returning();
  return { db, s, frenteA, frenteB, admin, campo, adminSession, gestorSession, pessoas, lima };
}

test("permissões: só o ADMIN tem a Produção por padrão; o apontador de campo só lança", { skip: !enabled }, async () => {
  const { campo } = await cenario();
  assert.deepEqual(resolvePermissions("GESTOR", []).filter((key) => key.startsWith("producao.")), [], "GESTOR sem nada por padrão");
  assert.deepEqual(resolvePermissions("GESTOR", [{ permission: "producao.ver", enabled: true }]).filter((key) => key.startsWith("producao.")), ["producao.ver"]);
  assert.ok(resolvePermissions("ADMIN", []).includes("producao.gerenciar"));
  assert.deepEqual(await effectivePermissions(campo.id, "CAMPO"), ["producao.lancar"], "apontador sem Controle Diário");
  assert.deepEqual(resolvePermissions("CAMPO", [], { convoy: false, daily: true, production: false }), ["daily.register"], "campo comum continua igual");
  const access = productionAccess(sessionOf(campo, "CAMPO", ["producao.lancar"]));
  assert.deepEqual(access, { view: false, costs: false, launch: true, manage: false, admin: false }, "campo não vê telas nem custos");
});

test("projetos: nome único por frente, frente visível, editar, inativar e finalizar/reabrir com registro", { skip: !enabled }, async () => {
  const { db, frenteA, frenteB, admin, adminSession, gestorSession } = await cenario();
  const frentesGestor = await productionFronts(db, gestorSession);
  assert.deepEqual(frentesGestor.map((front) => front.id), [frenteA.id]);
  const id = await createProject(db, gestorSession, frentesGestor, { serviceFrontId: frenteA.id, name: "  fazenda   boa vista upa 3 ", camp: "alojamento 1" });
  const [row] = await db.select().from(productionProjects).where(eq(productionProjects.id, id));
  assert.equal(row.name, "FAZENDA BOA VISTA UPA 3");
  assert.equal(row.fellingStatus, "EM_ANDAMENTO");
  assert.equal(row.skiddingStatus, "NAO_INICIADO");
  await rejects(createProject(db, gestorSession, frentesGestor, { serviceFrontId: frenteA.id, name: "Fazenda Boa Vista UPA 3" }), 409, /já existe/i);
  await rejects(createProject(db, gestorSession, frentesGestor, { serviceFrontId: frenteB.id, name: "Outra" }), 403);
  // O mesmo nome em outra frente pode.
  const frentesAdmin = await productionFronts(db, adminSession);
  await createProject(db, adminSession, frentesAdmin, { serviceFrontId: frenteB.id, name: "FAZENDA BOA VISTA UPA 3" });
  await updateProject(db, gestorSession, frentesGestor, id, { name: "Fazenda Boa Vista UPA 3B", camp: "" });
  assert.equal((await db.select().from(productionProjects).where(eq(productionProjects.id, id)))[0].camp, null);

  assert.equal(await changeStage(db, gestorSession, frentesGestor, id, "DERRUBA", "FINALIZAR"), "FINALIZADO");
  await rejects(changeStage(db, gestorSession, frentesGestor, id, "DERRUBA", "FINALIZAR"), 409);
  await rejects(changeStage(db, gestorSession, frentesGestor, id, "ARRASTE", "REABRIR"), 409);
  assert.equal(await changeStage(db, adminSession, frentesAdmin, id, "DERRUBA", "REABRIR"), "EM_ANDAMENTO");
  const eventos = await db.select().from(productionStageEvents).where(eq(productionStageEvents.projectId, id));
  assert.deepEqual(eventos.map((evento) => [evento.stage, evento.action]), [["DERRUBA", "FINALIZOU"], ["DERRUBA", "REABRIU"]]);
  assert.equal(eventos[1].userId, admin.id);

  await setProjectActive(db, gestorSession, frentesGestor, id, false);
  assert.equal((await listProjects(db, [frenteA.id], { active: true })).some((project) => project.id === id), false);
  assert.equal((await listProjects(db, [frenteA.id], { active: false }))[0].id, id);
  const auditoria = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "PRODUCTION_PROJECT"), eq(auditLogs.entityId, String(id))));
  assert.ok(auditoria.length >= 5, "criar, editar, finalizar, reabrir e inativar ficam no log");

  // Sem producao.gerenciar não cadastra.
  const consulta = { ...gestorSession, permissions: ["producao.ver"] };
  await rejects(createProject(db, consulta, frentesGestor, { serviceFrontId: frenteA.id, name: "Sem permissão" }), 403);
});

test("equipes: responsável entra como integrante, datas de entrada/saída e exclusão", { skip: !enabled }, async () => {
  const { db, frenteA, gestorSession, pessoas } = await cenario();
  const fronts = await productionFronts(db, gestorSession);
  const [joao, anderson, pedro, desligado] = pessoas;
  const teamId = await createTeam(db, gestorSession, fronts, { serviceFrontId: frenteA.id, name: "equipe 1", leaderEmployeeId: pedro.id, joinedAt: "2026-09-01" });
  await rejects(createTeam(db, gestorSession, fronts, { serviceFrontId: frenteA.id, name: "Equipe 1" }), 409);
  await addTeamMember(db, gestorSession, fronts, teamId, { employeeId: joao.id, joinedAt: "2026-09-02" });
  await rejects(addTeamMember(db, gestorSession, fronts, teamId, { employeeId: joao.id, joinedAt: "2026-09-03" }), 409, /já está/);
  await rejects(addTeamMember(db, gestorSession, fronts, teamId, { employeeId: desligado.id, joinedAt: "2026-09-03" }), 400, /desligado/);
  await addTeamMember(db, gestorSession, fronts, teamId, { employeeId: anderson.id, joinedAt: "2026-09-02" });
  let [equipe] = (await listTeams(db, [frenteA.id], { active: true })).filter((team) => team.id === teamId);
  assert.equal(equipe.name, "EQUIPE 1");
  assert.equal(equipe.leaderName, pedro.name);
  assert.equal(equipe.activeMembers, 3);
  const membros = await listTeamMembers(db, fronts, teamId);
  const membroJoao = membros.find((member) => member.employeeId === joao.id);
  await rejects(updateTeamMember(db, gestorSession, fronts, teamId, membroJoao.id, { joinedAt: "2026-09-02", leftAt: "2026-09-01" }), 400, /antes da entrada/);
  await updateTeamMember(db, gestorSession, fronts, teamId, membroJoao.id, { joinedAt: "2026-09-02", leftAt: "2026-09-20" });
  // Quem saiu pode entrar de novo (nova linha), e o histórico fica.
  await addTeamMember(db, gestorSession, fronts, teamId, { employeeId: joao.id, joinedAt: "2026-10-01" });
  [equipe] = (await listTeams(db, [frenteA.id], { active: true })).filter((team) => team.id === teamId);
  assert.equal(equipe.activeMembers, 3);
  assert.equal((await listTeamMembers(db, fronts, teamId)).length, 4);
  const membroAnderson = (await listTeamMembers(db, fronts, teamId)).find((member) => member.employeeId === anderson.id);
  await removeTeamMember(db, gestorSession, fronts, teamId, membroAnderson.id);
  assert.equal((await listTeamMembers(db, fronts, teamId)).length, 3);
});

test("preços por frente: só produto marcado, preço vazio volta ao do produto", { skip: !enabled }, async () => {
  const { db, frenteA, adminSession, gestorSession, lima } = await cenario();
  const fronts = await productionFronts(db, adminSession);
  await rejects(setFrontPrice(db, adminSession, fronts, { productId: lima.id, serviceFrontId: frenteA.id, price: "10" }), 400, /Marque o produto/);
  await rejects(setProductionUse(db, gestorSession, lima.id, true), 403, /custos/);
  await setProductionUse(db, adminSession, lima.id, true);
  await setFrontPrice(db, adminSession, fronts, { productId: lima.id, serviceFrontId: frenteA.id, price: "32,22" });
  let [item] = (await listProductionProducts(db, [frenteA.id])).filter((product) => product.id === lima.id);
  assert.deepEqual(item.frontPrices, { [frenteA.id]: 32.22 });
  await rejects(setFrontPrice(db, adminSession, fronts, { productId: lima.id, serviceFrontId: frenteA.id, price: "-1" }), 400);
  await setFrontPrice(db, adminSession, fronts, { productId: lima.id, serviceFrontId: frenteA.id, price: "" });
  assert.equal((await db.select().from(productFrontPrices).where(eq(productFrontPrices.productId, lima.id))).length, 0);
  [item] = (await listProductionProducts(db, [frenteA.id])).filter((product) => product.id === lima.id);
  assert.deepEqual(item.frontPrices, {});
  await setProductionUse(db, adminSession, lima.id, false);
  assert.equal((await listProductionProducts(db, [frenteA.id])).some((product) => product.id === lima.id), false);
});

test("motivos só pelo ADMIN; busca de funcionário por função, sem desligados", { skip: !enabled }, async () => {
  const { db, s, frenteA, adminSession, gestorSession, pessoas } = await cenario();
  await rejects(saveReason(db, gestorSession, null, { code: `X.${s}`, description: "teste" }), 403);
  await saveReason(db, adminSession, null, { code: `x.${s.slice(0, 3)}`, description: "teste de motivo" });
  await rejects(saveReason(db, adminSession, null, { code: `X.${s.slice(0, 3)}`, description: "outro" }), 409);
  const nomes = async (options) => (await lookupProductionEmployees(db, { q: s, frontId: frenteA.id, group: null, all: false, ...options })).map((row) => row.name);
  assert.deepEqual(await nomes({ group: "MOTOSSERRA" }), [pessoas[0].name], "só o operador ativo, sem ajudante nem desligado");
  assert.deepEqual(await nomes({ group: "AJUDANTE_MOTOSSERRA" }), [pessoas[1].name]);
  assert.equal((await nomes({ group: "MOTOSSERRA", all: true })).length, 3, "mostrar todos: todas as funções, ainda sem desligados");
  assert.deepEqual(await nomes({ q: `joão motosserra ${s}`.toLowerCase(), group: null }), [pessoas[0].name], "sem acento e sem maiúsculas");
});
