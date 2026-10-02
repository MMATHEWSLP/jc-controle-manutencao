// Teste de integração dos Lançamentos pendentes do Assistente JC num Postgres de teste já migrado.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
// Cria seus próprios dados (frente, produtos, funcionários, equipamento, diesel) e exercita as
// ferramentas da assistente + o "Lançar tudo" com as mesmas funções dos formulários.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:assistente-pendentes
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { assistantPendingItems, employees, equipment, fuelMovements, fuelTypes, meterReadings, productFrontStock, products, serviceFronts, stockExits, users } from "../db/schema.ts";
import { runAssistantTool } from "../lib/assistant-tools.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { lancarPendentes, listarPendentes } from "../lib/assistente/pendentes.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

test("adicionar por texto/voz, editar, remover, bloquear, perguntar e lançar tudo", { skip: !enabled }, async () => {
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE TESTE ${s}` }).returning();
  const [user] = await db.insert(users).values({ email: `pend-${s}@teste.local`, name: "Teste pendentes", role: "GESTOR", serviceFrontId: front.id }).returning();
  const sessao = { id: user.id, name: user.name, username: "", email: user.email, profile: "GESTOR", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: front.id, serviceFrontName: front.name, allServiceFronts: false, serviceFrontIds: [front.id], canExport: true, jobTitle: null };
  const ctx = { db, user: sessao, displayed: [front.id], pergunta: "teste", viaVoz: true };
  const tool = async (name, input) => { const result = await runAssistantTool(ctx, name, input); assert.ok(result.ok, `${name}: ${result.content}`); return JSON.parse(result.content); };

  const [filtro, lima, corrente, pastilha] = await db.insert(products).values([
    { tag: `F${s}`, name: `FILTRO DE COMBUSTÍVEL ZQ${s}`, price: 85 }, { tag: `L${s}`, name: `LIMA REDONDA ZQ${s}`, price: 25 },
    { tag: `C${s}`, name: `CORRENTE 42 DENTES ZQ${s}`, price: 120 }, { tag: `P${s}`, name: `PASTILHA DE FREIO ZQ${s}`, price: 300 },
  ]).returning();
  await db.insert(productFrontStock).values([[filtro, 5], [lima, 3], [corrente, 10], [pastilha, 0]].map(([product, quantity]) => ({ productId: product.id, serviceFrontId: front.id, quantity, active: true })));
  await db.insert(employees).values([`CLAUDILSON ZQ${s}`, `VANDERSON ZQ${s}`, `FABRICIO ZQ${s}`, `JOSEZQ${s} PEREIRA`, `JOSEZQ${s} SANTOS`].map((name) => ({ name, jobTitle: "OPERADOR", company: "JC", admissionDate: "2024-01-01", serviceFrontId: front.id })));
  const [pc, cm] = await db.insert(equipment).values([
    { code: `EQ-PC${s}`, prefix: `PC-${s}`, type: "ESCAVADEIRA", brand: "K", model: "PC200", controlType: "HOURS", currentHours: 8000, currentKm: 0, serviceFrontId: front.id },
    { code: `EQ-CM${s}`, prefix: `CM-${s}`, type: "CAMINHÃO", brand: "M", model: "AXOR", controlType: "KM", currentHours: 0, currentKm: 140500, serviceFrontId: front.id },
  ]).returning();
  let diesel = (await db.select().from(fuelTypes).where(eq(fuelTypes.code, "DIESEL_S10")).limit(1))[0];
  if (!diesel) [diesel] = await db.insert(fuelTypes).values({ code: "DIESEL_S10", name: "Diesel S10" }).returning();
  await db.insert(fuelMovements).values({ serviceFrontId: front.id, fuelTypeId: diesel.id, movementType: "ENTRADA", movementDate: "2026-01-01", quantity: 1000, unitPrice: 6, responsible: "Teste", stockLocation: "FRENTE" });

  // Os 3 exemplos (o 3º são dois itens).
  const a = await tool("lancamento_adicionar", { tipo: "saida_produto", produto: "filtro de combustível", produto_tag: `F${s}`, equipamento: `PC-${s}` });
  assert.equal(a.item.status, "Pronto");
  assert.match(a.confirmacao, /^Adicionado: 1 FILTRO/);
  const b = await tool("lancamento_adicionar", { tipo: "saida_produto", produto: `lima redonda zq${s}`, colaborador: `Claudilson zq${s}` });
  assert.match(b.item.descricao, /para CLAUDILSON/);
  await tool("lancamento_adicionar", { tipo: "saida_produto", produto: `correntes 42 dentes zq${s}`, quantidade: "duas", colaborador: `Vanderson zq${s}` });
  const d = await tool("lancamento_adicionar", { tipo: "saida_combustivel", combustivel: "diesel s10", litros: 300, equipamento: `CM-${s}`, leitura: "cento e quarenta mil e novecentos", motorista: `Fabricio zq${s}` });
  assert.match(d.item.descricao, /300 L de Diesel S10/);
  assert.equal(d.lista.total, 4);

  // Editar quantidade, remover, nada gravado ainda.
  const editado = await tool("lancamento_editar", { item_id: a.item.id, quantidade: "dois" });
  assert.match(editado.item.descricao, /^2 FILTRO/);
  await tool("lancamento_remover", { item_ids: [b.item.id] });
  assert.equal((await db.select().from(stockExits).where(eq(stockExits.serviceFrontId, front.id))).length, 0, "nada é gravado antes do Lançar tudo");

  // Estoque insuficiente bloqueia; nome ambíguo pergunta (e responde com a opção).
  const sem = await tool("lancamento_adicionar", { tipo: "saida_produto", produto_tag: `P${s}`, equipamento: `CM-${s}` });
  assert.equal(sem.item.status, "Bloqueado");
  assert.match(sem.item.bloqueios.join(" "), /Estoque insuficiente/);
  const amb = await tool("lancamento_adicionar", { tipo: "saida_produto", produto_tag: `F${s}`, colaborador: `Josezq${s}` });
  assert.equal(amb.item.status, "Incompleto");
  assert.equal(amb.item.opcoes.colaborador.length, 2);
  const escolhido = await tool("lancamento_editar", { item_id: amb.item.id, escolha_campo: "colaborador", escolha_id: amb.item.opcoes.colaborador[0].id });
  assert.notEqual(escolhido.item.status, "Incompleto");

  // A lista fica no banco (sobrevive a recarregar).
  const lista = await listarPendentes(ctx);
  assert.equal(lista.itens.length, 5);
  assert.ok(lista.itens.every((item) => item.viaVoz));

  const resultado = await lancarPendentes(ctx);
  assert.equal(resultado.lancados.length, 4, JSON.stringify(resultado.falharam));
  assert.equal(resultado.bloqueados.length, 1);
  assert.equal(resultado.lista.itens.length, 1, "o bloqueado fica na lista");
  const saldo = async (product) => Number((await db.select().from(productFrontStock).where(eq(productFrontStock.productId, product.id)))[0].quantity);
  assert.equal(await saldo(filtro), 2); // 5 − 2 − 1
  assert.equal(await saldo(corrente), 8);
  const saidas = await db.select().from(stockExits).where(eq(stockExits.serviceFrontId, front.id));
  assert.equal(saidas.length, 3);
  assert.ok(saidas.every((row) => row.createdVia === "ASSISTENTE" && row.createdBy === user.id));
  const abastecimento = (await db.select().from(fuelMovements).where(eq(fuelMovements.equipmentId, cm.id)))[0];
  assert.equal(abastecimento.createdVia, "ASSISTENTE");
  assert.equal(abastecimento.meterReading, 140900);
  assert.equal(Number((await db.select().from(equipment).where(eq(equipment.id, cm.id)))[0].currentKm), 140900, "leitura do equipamento atualizada");
  assert.equal((await db.select().from(meterReadings).where(eq(meterReadings.equipmentId, cm.id)))[0].source, "ASSISTENTE");

  // Lançar de novo não duplica nada (o bloqueado continua bloqueado).
  const deNovo = await lancarPendentes(ctx);
  assert.equal(deNovo.lancados.length, 0);
  await db.delete(assistantPendingItems).where(eq(assistantPendingItems.userId, user.id));
  assert.ok(pc.id > 0);
});
