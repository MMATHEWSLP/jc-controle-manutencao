// Integração (Postgres de teste já migrado) do acesso dos operadores e dos funcionários de terceiros.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:operadores-terceiros-banco
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { employees, fieldLoginAttempts, fuelMovements, fuelTypes, jobFunctions, productFrontStock, products, serviceFronts, stockExits, thirdParties, thirdPartyEmployees, thirdPartyVehicles, users } from "../db/schema.ts";
import { runAssistantTool } from "../lib/assistant-tools.ts";
import { lancarPendentes } from "../lib/assistente/pendentes.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { verifyFieldOperator } from "../lib/field-auth.ts";
import { createFuelMovement } from "../lib/fuel-create.ts";
import { redefinirPin, sincronizarComAviso } from "../lib/operadores.ts";
import { createStockExit } from "../lib/stock-exits.ts";
import { listStockMovements } from "../lib/stock-history.ts";
import { thirdPartySummary, vehicleFuelings } from "../lib/third-parties.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;
delete process.env.OPERATOR_DEFAULT_PIN;

const s = Date.now().toString(36).toUpperCase();
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const pedido = () => new Request("http://localhost/api/auth/field/verify", { headers: { "x-forwarded-for": ip } });
async function preparar(nome) {
  const db = await getDb();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE ${nome} ${s}` }).returning();
  const [gestor] = await db.insert(users).values({ email: `${nome.toLowerCase()}-gestor-${s}@teste.local`, name: "Gestor teste", role: "GESTOR", serviceFrontId: front.id }).returning();
  const sessao = { id: gestor.id, name: gestor.name, username: "", email: gestor.email, profile: "GESTOR", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: front.id, serviceFrontName: front.name, allServiceFronts: false, serviceFrontIds: [front.id], canExport: true, jobTitle: null };
  return { db, front, sessao };
}

test("operador: admissão cria o acesso, PIN certo entra, PIN errado bloqueia, demissão desativa", { skip: !enabled }, async () => {
  const { db, front, sessao } = await preparar("OP");
  const funcao = `OP. DE SKIDDER TESTE ${s}`;
  await db.insert(jobFunctions).values({ name: funcao, operatesEquipment: true });

  // Admissão (mesmo serviço da rota POST /api/employees): cria o acesso e devolve o PIN uma vez, com o PDF.
  const [func] = await db.insert(employees).values({ name: `OPERADOR TESTE ${s}`, jobTitle: funcao, company: "JC", admissionDate: "2026-01-01", serviceFrontId: front.id, birthDate: "1990-05-01" }).returning();
  const admissao = await sincronizarComAviso(db, func.id, sessao, { jobTitle: funcao });
  assert.ok(admissao.acessoOperador, JSON.stringify(admissao));
  const { pin, userId } = admissao.acessoOperador;
  assert.match(pin, /^\d{4}$/);
  assert.notEqual(pin, "1990");
  assert.ok(admissao.acessoOperador.pdfBase64.length > 100, "PDF do acesso");
  const [usuario] = await db.select().from(users).where(eq(users.id, userId));
  assert.equal(usuario.role, "CAMPO");
  assert.equal(usuario.employeeId, func.id);
  assert.equal(usuario.status, "ACTIVE");
  assert.ok(usuario.accessCodeHash && !usuario.accessCodeHash.includes(pin), "PIN só com hash");

  // Função que não opera não ganha acesso.
  const [outro] = await db.insert(employees).values({ name: `AJUDANTE TESTE ${s}`, jobTitle: `AJUDANTE ${s}`, company: "JC", admissionDate: "2026-01-01", serviceFrontId: front.id }).returning();
  assert.equal((await sincronizarComAviso(db, outro.id, sessao, { jobTitle: `AJUDANTE ${s}` })).acessoOperador, undefined);

  // PIN certo entra; errado registra a tentativa; 5 erradas bloqueiam (até o PIN certo).
  assert.equal((await verifyFieldOperator(pedido(), userId, pin)).id, userId);
  const errado = pin === "5555" ? "5556" : "5555";
  for (let tentativa = 1; tentativa <= 4; tentativa++) await assert.rejects(verifyFieldOperator(pedido(), userId, errado), (error) => error.status === 401 && /PIN incorretos/.test(error.message));
  await assert.rejects(verifyFieldOperator(pedido(), userId, errado), (error) => error.status === 429 && /bloqueado por 15 minutos/.test(error.message));
  await assert.rejects(verifyFieldOperator(pedido(), userId, pin), (error) => error.status === 429, "bloqueado mesmo com o PIN certo");
  const tentativas = await db.select().from(fieldLoginAttempts).where(eq(fieldLoginAttempts.userId, userId));
  assert.equal(tentativas.filter((row) => !row.success).length, 5);

  // Redefinir PIN (ADMIN/GESTOR) desbloqueia e o PIN antigo deixa de valer.
  const novo = await redefinirPin(db, sessao, userId);
  assert.notEqual(novo.pin, undefined);
  assert.equal((await verifyFieldOperator(pedido(), userId, novo.pin)).id, userId);
  if (novo.pin !== pin) await assert.rejects(verifyFieldOperator(pedido(), userId, pin), (error) => error.status === 401);

  // Demissão (mesmo serviço da rota de demitir): desativa, sem excluir.
  await db.update(employees).set({ status: "DEMITIDO" }).where(eq(employees.id, func.id));
  const demissao = await sincronizarComAviso(db, func.id, sessao);
  assert.match(demissao.avisoAcesso, /desativado/);
  const [depois] = await db.select().from(users).where(eq(users.id, userId));
  assert.equal(depois.status, "INACTIVE", "desativado, não excluído");
  await assert.rejects(verifyFieldOperator(pedido(), userId, novo.pin), (error) => error.status === 401 || error.status === 429);

  // Readmissão: reativa com PIN novo.
  await db.update(employees).set({ status: "ATIVO" }).where(eq(employees.id, func.id));
  const volta = await sincronizarComAviso(db, func.id, sessao);
  assert.equal(volta.acessoOperador?.userId, userId);
});

test("terceiro: diesel e peça para funcionário do prestador (sem leitura, fora da média)", { skip: !enabled }, async () => {
  const { db, front, sessao } = await preparar("TERC");
  const [empresa] = await db.insert(thirdParties).values({ name: `GREGOLETO TESTE ${s}`, kind: "PRESTADOR", serviceFrontId: front.id }).returning();
  const [caminhao] = await db.insert(thirdPartyVehicles).values({ thirdPartyId: empresa.id, plate: `TST${s.slice(-4)}`, plateKey: `TST${s.slice(-4)}`, meterType: "KM" }).returning();
  const [joao] = await db.insert(thirdPartyEmployees).values({ thirdPartyId: empresa.id, name: `JOAO MOTOSSERRISTA ${s}`, jobTitle: "MOTOSSERRISTA" }).returning();
  let diesel = (await db.select().from(fuelTypes).where(eq(fuelTypes.code, "DIESEL_S10")).limit(1))[0];
  if (!diesel) [diesel] = await db.insert(fuelTypes).values({ code: "DIESEL_S10", name: "Diesel S10" }).returning();
  await db.insert(fuelMovements).values({ serviceFrontId: front.id, fuelTypeId: diesel.id, movementType: "ENTRADA", movementDate: "2026-09-01", quantity: 2000, unitPrice: 6, responsible: "Teste", stockLocation: "FRENTE" });
  const opcoes = { displayedFronts: [front.id] };
  const base = { serviceFrontId: front.id, fuelTypeId: diesel.id, movementType: "SAIDA", stockLocation: "FRENTE", thirdParty: true, thirdPartyKind: "PRESTADOR", thirdPartyId: empresa.id };

  // Dois abastecimentos do caminhão (com leitura) e, no meio, diesel para o funcionário (motosserra).
  await createFuelMovement(db, sessao, { ...base, movementDate: "2026-09-02", quantity: 100, thirdPartyDestination: "VEICULO", thirdPartyVehicleId: caminhao.id, thirdPartyReading: "10000", fullTank: true, responsible: "Motorista" }, opcoes);
  const funcionario = await createFuelMovement(db, sessao, { ...base, movementDate: "2026-09-03", quantity: 20, thirdPartyDestination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, purpose: "MOTOSSERRA", thirdPartyReading: "99999", responsible: joao.name }, opcoes);
  await createFuelMovement(db, sessao, { ...base, movementDate: "2026-09-04", quantity: 100, thirdPartyDestination: "VEICULO", thirdPartyVehicleId: caminhao.id, thirdPartyReading: "10300", fullTank: true, responsible: "Motorista", confirmOutlier: true }, opcoes);
  const [linha] = await db.select().from(fuelMovements).where(eq(fuelMovements.id, funcionario.id));
  assert.equal(linha.thirdPartyDestination, "FUNCIONARIO");
  assert.equal(linha.thirdPartyEmployeeId, joao.id);
  assert.equal(linha.thirdPartyVehicleId, null);
  assert.equal(linha.meterReading, null, "sem leitura");
  assert.equal(linha.purpose, "MOTOSSERRA");
  // A média do caminhão ignora o diesel do funcionário: 300 km ÷ 100 L = 3 km/L.
  const historico = (await vehicleFuelings(db, [caminhao.id])).get(caminhao.id) ?? [];
  assert.equal(historico.length, 2);
  assert.ok(historico.every((row) => row.id !== funcionario.id));
  // Finalidade é obrigatória para funcionário; Outros pede a descrição.
  await assert.rejects(createFuelMovement(db, sessao, { ...base, movementDate: "2026-09-05", quantity: 5, thirdPartyDestination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, responsible: "x" }, opcoes), /finalidade/);
  await assert.rejects(createFuelMovement(db, sessao, { ...base, movementDate: "2026-09-05", quantity: 5, thirdPartyDestination: "FUNCIONARIO", thirdPartyEmployeeId: joao.id, purpose: "OUTROS", responsible: "x" }, opcoes), /Outros/);

  // Peça para o funcionário do prestador.
  const [corrente] = await db.insert(products).values({ tag: `CR${s}`, name: `CORRENTE MOTOSSERRA ${s}`, price: 150 }).returning();
  await db.insert(productFrontStock).values({ productId: corrente.id, serviceFrontId: front.id, quantity: 5, active: true });
  const saida = await createStockExit(db, sessao, {
    serviceFrontId: front.id, exitDate: "2026-09-03", destinationType: "THIRD_PARTY", employeeId: null, equipmentId: null, departmentId: null,
    thirdPartyId: empresa.id, thirdPartyVehicleId: null, thirdPartyEmployeeId: joao.id, receivedBy: joao.name, notes: null,
    items: [{ productId: corrente.id, quantity: 2 }], allowNegative: false,
  });
  const [gravada] = await db.select().from(stockExits).where(eq(stockExits.id, saida.id));
  assert.equal(gravada.thirdPartyEmployeeId, joao.id);
  assert.equal(gravada.thirdPartyVehicleId, null);
  assert.equal(Number((await db.select().from(productFrontStock).where(and(eq(productFrontStock.productId, corrente.id), eq(productFrontStock.serviceFrontId, front.id))))[0].quantity), 3);
  const filtrado = await listStockMovements(db, { fronts: [front.id], thirdPartyEmployeeId: joao.id });
  assert.equal(filtrado.length, 1);
  assert.equal(filtrado[0].thirdParty.employee, joao.name);
  assert.equal(filtrado[0].thirdParty.destination, "Funcionário");

  // Resumo por empresa separa veículo x funcionário.
  const { companies } = await thirdPartySummary(db, [front.id], { from: "2026-09-01", to: "2026-09-30", thirdPartyId: empresa.id });
  const resumo = companies.find((row) => row.thirdPartyId === empresa.id);
  assert.equal(resumo.fuelVehicleLiters, 200);
  assert.equal(resumo.fuelEmployeeLiters, 20);
  assert.equal(resumo.fuelEmployeeValue, 120);
  assert.equal(resumo.partsEmployeeValue, 300);
  assert.equal(resumo.partsVehicleValue, 0);
  assert.equal(resumo.totalValue, 1200 + 120 + 300);

  // Assistente JC: "15 litros de diesel para o João da Gregoleto, gerador" → lista → Lançar tudo.
  const ctx = { db, user: sessao, displayed: [front.id], pergunta: "teste", viaVoz: false };
  const tool = async (name, input) => { const result = await runAssistantTool(ctx, name, input); assert.ok(result.ok, `${name}: ${result.content}`); return JSON.parse(result.content); };
  const item = await tool("lancamento_adicionar", { tipo: "saida_combustivel", combustivel: "diesel s10", litros: "quinze", terceiro: `gregoleto teste ${s}`, funcionario_terceiro: `joao motosserrista ${s}`, finalidade: "gerador", data: "05/09/2026" });
  assert.equal(item.item.status, "Pronto", JSON.stringify(item.item));
  assert.match(item.item.descricao, /para GREGOLETO.*funcionário JOAO.*Gerador/);
  const produtoItem = await tool("lancamento_adicionar", { tipo: "saida_produto", produto_tag: `CR${s}`, terceiro: `gregoleto teste ${s}`, funcionario_terceiro: `joao motosserrista ${s}`, data: "05/09/2026" });
  assert.equal(produtoItem.item.status, "Pronto", JSON.stringify(produtoItem.item));
  const lancado = await lancarPendentes(ctx);
  assert.equal(lancado.lancados.length, 2, JSON.stringify(lancado));
  const viaAssistente = (await db.select().from(fuelMovements).where(and(eq(fuelMovements.thirdPartyEmployeeId, joao.id), eq(fuelMovements.createdVia, "ASSISTENTE"))))[0];
  assert.equal(viaAssistente.purpose, "GERADOR");
  assert.equal(viaAssistente.meterReading, null);
  assert.equal(viaAssistente.responsible, joao.name);
  assert.equal((await db.select().from(stockExits).where(and(eq(stockExits.thirdPartyEmployeeId, joao.id), eq(stockExits.createdVia, "ASSISTENTE")))).length, 1);
});
