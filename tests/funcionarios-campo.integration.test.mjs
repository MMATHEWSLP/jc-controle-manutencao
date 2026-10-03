// Integração (Postgres de teste já migrado) da tela Funcionários de campo: adicionar da lista em lote,
// cadastro manual (com e sem cadastro de Funcionários), demissão inativa o acesso, login com o código
// e importação da planilha (prévia, parecidos, "Conferir", mantém quem já existe sem trocar o código).
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:funcionarios-campo-banco
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { companies, employees, serviceFronts, userServiceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { verifyFieldOperator } from "../lib/field-auth.ts";
import { confirmFieldImport, createFieldOperator, createFromEmployees, createManual, fieldAccessCandidates, linkFieldOperator, listFieldOperators, previewFieldImport } from "../lib/field-operators.ts";
import { sincronizarComAviso } from "../lib/operadores.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const base = Date.now().toString(36).toUpperCase().slice(-6);
const ip = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const pedido = () => new Request("http://localhost/api/auth/field/verify", { headers: { "x-forwarded-for": ip } });

async function preparar(s) {
  const db = await getDb();
  const z = (texto) => `ZQ${s} ${texto}`;
  const [arapiuns, mamuru] = await db.insert(serviceFronts).values([{ name: `ARAPIUNS ${s}` }, { name: `MAMURU ${s}` }]).returning();
  await db.insert(companies).values({ name: `JC TESTE ${s}` }).onConflictDoNothing();
  const [admin] = await db.insert(users).values({ email: `campo-admin-${s}@teste.local`, name: "Admin teste", role: "ADMIN", serviceFrontId: arapiuns.id }).returning();
  const sessao = { id: admin.id, name: admin.name, username: "", email: admin.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: arapiuns.id, serviceFrontName: arapiuns.name, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  const funcionario = (nome, funcao, frente, extra = {}) => ({ name: z(nome), jobTitle: funcao, company: `JC TESTE ${s}`, admissionDate: "2025-01-10", serviceFrontId: frente.id, ...extra });
  return { db, arapiuns, mamuru, sessao, funcionario, z, s };
}

test("da lista (3 de uma vez), manual com e sem cadastro, demissão inativa, login com o código", { skip: !enabled }, async () => {
  const { db, arapiuns, mamuru, sessao, funcionario, z, s } = await preparar(`${base}A`);
  const lista = await db.insert(employees).values([
    funcionario("ANTONIO OPERADOR", "OP. DE PÁ CARREGADEIRA", arapiuns), funcionario("BRUNO MOTORISTA", "MOTORISTA DE APOIO", mamuru, { status: "FOLGA" }),
    funcionario("CARLOS AJUDANTE", "AJUDANTE GERAL", arapiuns, { registration: `9${Date.now() % 1_000_000}` }), funcionario("DAVI DEMITIDO", "OP. DE SKIDDER", arapiuns, { status: "DEMITIDO" }),
  ]).returning();
  const [antonio, bruno, carlos, davi] = lista;

  // Candidatos: só não demitidos e sem acesso.
  const { candidatos } = await fieldAccessCandidates(sessao);
  const ids = new Set(candidatos.map((row) => row.id));
  assert.ok(ids.has(antonio.id) && ids.has(bruno.id) && ids.has(carlos.id));
  assert.ok(!ids.has(davi.id), "demitido não aparece");

  // 3 de uma vez: Antonio com código digitado e frente extra; os outros com código gerado.
  await assert.rejects(createFromEmployees(sessao, [{ employeeId: antonio.id, extraFrontIds: [], code: "1234" }]), /fácil de adivinhar/);
  const criados = await createFromEmployees(sessao, [
    { employeeId: antonio.id, extraFrontIds: [mamuru.id], code: "7391" }, { employeeId: bruno.id, extraFrontIds: [], code: null }, { employeeId: carlos.id, extraFrontIds: [], code: null },
  ]);
  assert.equal(criados.length, 3);
  assert.equal(criados[0].code, "7391");
  assert.equal(new Set(criados.map((row) => row.code)).size, 3, "códigos sem repetir no lote");
  assert.ok(criados.every((row) => /^\d{4}$/.test(row.code)));
  assert.deepEqual(criados[0].fronts, [arapiuns.name, mamuru.name]);
  const [uAntonio] = await db.select().from(users).where(eq(users.id, criados[0].userId));
  assert.equal(uAntonio.employeeId, antonio.id);
  assert.equal(uAntonio.fieldAccessOrigin, "MANUAL");
  assert.ok(!uAntonio.accessCodeHash.includes("7391"), "código só com hash");
  assert.equal((await fieldAccessCandidates(sessao)).candidatos.some((row) => row.id === antonio.id), false, "sai da lista depois de ter acesso");

  // Entrar com um dos novos códigos (certo e errado).
  assert.equal((await verifyFieldOperator(pedido(), uAntonio.id, "7391")).id, uAntonio.id);
  await assert.rejects(verifyFieldOperator(pedido(), uAntonio.id, "7392"), (error) => error.status === 401);

  // Mudança no cadastro principal reflete (nome e função); função que não opera NÃO derruba o acesso manual.
  await db.update(employees).set({ name: z("CARLOS AJUDANTE SILVA"), jobTitle: "SERVICOS GERAIS" }).where(eq(employees.id, carlos.id));
  await sincronizarComAviso(db, carlos.id, sessao);
  const [uCarlos] = await db.select().from(users).where(eq(users.id, criados[2].userId));
  assert.equal(uCarlos.name, z("CARLOS AJUDANTE SILVA"));
  assert.equal(uCarlos.jobTitle, "SERVICOS GERAIS");
  assert.equal(uCarlos.status, "ACTIVE");
  // Frente extra continua depois da sincronização.
  await sincronizarComAviso(db, antonio.id, sessao);
  assert.equal((await db.select().from(userServiceFronts).where(eq(userServiceFronts.userId, uAntonio.id))).length, 2);

  // Demitir no menu FUNCIONÁRIOS deixa o acesso de campo Inativo (sem excluir).
  await db.update(employees).set({ status: "DEMITIDO" }).where(eq(employees.id, bruno.id));
  const aviso = await sincronizarComAviso(db, bruno.id, sessao);
  assert.match(aviso.avisoAcesso, /desativado/);
  const brunoTela = (await listFieldOperators(sessao)).find((row) => row.id === criados[1].userId);
  assert.equal(brunoTela.active, false);

  // Manual: nome parecido avisa antes de salvar.
  await assert.rejects(createManual(sessao, { name: z("ANTONIO OPERADOR"), jobTitle: "OPERADOR", frontIds: [arapiuns.id], code: null, criarFuncionario: true, company: `JC TESTE ${s}`, admissionDate: "", confirmarParecidos: false }),
    (error) => error.status === 409 && error.extra.parecidos.funcionarios.some((row) => row.id === antonio.id));
  // Manual criando também no cadastro de Funcionários (vinculado).
  const [comCadastro] = (await Promise.all([createManual(sessao, { name: z("EDUARDO TEMPORARIO"), jobTitle: "OPERADOR DE GERADOR", frontIds: [mamuru.id], code: null, criarFuncionario: true, company: `JC TESTE ${s}`, admissionDate: "2026-10-01", confirmarParecidos: true })]));
  assert.ok(comCadastro.employeeId, "criou no cadastro de Funcionários");
  const [empEduardo] = await db.select().from(employees).where(eq(employees.id, comCadastro.employeeId));
  assert.equal(empEduardo.serviceFrontId, mamuru.id);
  assert.equal((await db.select().from(users).where(eq(users.employeeId, empEduardo.id))).length, 1, "um acesso só (sem duplicar pelo automático)");
  // Manual sem cadastro de Funcionários: fica solto (etiqueta "Sem cadastro de funcionário") e depois "Vincular".
  const solto = await createManual(sessao, { name: z("FABIO PRESTADOR"), jobTitle: "MOTORISTA TERCEIRO", frontIds: [arapiuns.id], code: "5820", criarFuncionario: false, company: "", admissionDate: "", confirmarParecidos: true });
  assert.equal(solto.employeeId, null);
  assert.equal((await listFieldOperators(sessao)).find((row) => row.id === solto.userId).employeeId, null);
  const [fabio] = await db.insert(employees).values(funcionario("FABIO PRESTADOR", "MOTORISTA DE APOIO", arapiuns)).returning();
  await linkFieldOperator(sessao, solto.userId, fabio.id);
  const vinculado = (await listFieldOperators(sessao)).find((row) => row.id === solto.userId);
  assert.equal(vinculado.employeeId, fabio.id);
  assert.equal((await verifyFieldOperator(pedido(), solto.userId, "5820")).id, solto.userId, "código mantido ao vincular");
});

async function planilha(linhas) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Funcionários de campo");
  sheet.addRow(["Nome", "Função sugerida", "Frente principal", "Outras frentes", "Equipamentos (setembro)", "Lançamentos em setembro", "PIN", "Conferir"]);
  for (const linha of linhas) sheet.addRow(linha);
  return (await workbook.xlsx.writeBuffer());
}

test("importar planilha: prévia, parecidos, Conferir, mantém quem já existe sem trocar o código", { skip: !enabled }, async () => {
  const { db, arapiuns, mamuru, sessao, funcionario, z, s } = await preparar(`${base}B`);
  // Já na tela (como o HENRIQUE): acesso antigo só em Arapiuns, código 4826.
  const henriqueId = await createFieldOperator(sessao, { name: z("HENRIQUE MEIRE CARMINATI"), jobTitle: "Motorista de caminhão nivel lll", code: "4826", serviceFrontIds: [arapiuns.id], active: true });
  const [jose, joaoPedro] = await db.insert(employees).values([
    funcionario("JOSÉ SALVADOR CARDOSO MELO", "MOTORISTA DE CAMINHAO NIVEL III", arapiuns), funcionario("JOAO PEDRO DA SILVA SANTOS", "OP. DE SKIDDER", mamuru),
  ]).returning();
  const buffer = await planilha([
    [z("HENRIQUE MEIRE CARMINATI"), "Motorista", `ARAPIUNS ${s}`, `MAMURU ${s}`, "CM-01", 12, 1111, ""],   // mantém, completa Mamuru
    [z("JOSE SALVADOR CARDOSO MELO"), "Motorista", `Arapiuns ${s}`, "", "CM-02", 30, 3907, ""],           // = JOSÉ (sem acento) → vincula
    [z("JOAO PEDRO SANTOS"), "Operador", `MAMURU ${s}`, "", "SK-01", 8, 6284, ""],                          // sobrenome faltando → parecido
    [z("KLEBER NOVO OPERADOR"), "OPERADOR DE ESTEIRA", `ARAPIUNS ${s}`, `MAMURU ${s}`, "TE-01", 20, 5173, ""], // novo sem cadastro
    [z("LUIZ CONFERIR NOME"), "OPERADOR", `ARAPIUNS ${s}`, "", "", 2, 9046, "nome incompleto?"],           // conferir
    [z("MARIO PIN RUIM"), "OPERADOR", `ARAPIUNS ${s}`, "", "", 1, "12", ""],                               // erro
  ]);
  const vazio = { nomes: {}, aprovados: [], decisoes: [] };
  const previa = await previewFieldImport(sessao, buffer, vazio);
  assert.deepEqual({ criar: previa.resumo.criar, manter: previa.resumo.manter, parecidos: previa.resumo.parecidos, conferir: previa.resumo.conferir, erros: previa.resumo.erros }, { criar: 2, manter: 1, parecidos: 1, conferir: 1, erros: 1 });
  assert.ok(!JSON.stringify(previa).includes("3907"), "a prévia não devolve os PINs");
  const linhaJose = previa.linhas.find((row) => row.linha === 3);
  assert.equal(linhaJose.vinculo.id, jose.id);
  assert.match(linhaJose.vinculo.semelhanca, /acento/);
  const parecido = previa.linhas.find((row) => row.grupo === "PARECIDO");
  assert.ok(parecido.opcoes.some((opcao) => opcao.id === joaoPedro.id && opcao.semelhanca === "Sobrenome faltando"));
  assert.deepEqual(previa.linhas.find((row) => row.linha === 2).manterAcesso.frentesNovas, [mamuru.name]);
  await assert.rejects(previewFieldImport({ ...sessao, profile: "GESTOR" }, buffer, vazio), /Só ADMIN/);

  // Confirmar exige decidir os parecidos.
  await assert.rejects(confirmFieldImport(sessao, buffer, vazio), /Decida os nomes parecidos/);
  const ajustes = { nomes: { 6: z("LUIZ CONFERIR NOME SOUZA") }, aprovados: [6], decisoes: [{ linha: 4, acao: "VINCULAR", id: joaoPedro.id }] };
  const resultado = await confirmFieldImport(sessao, buffer, ajustes);
  assert.equal(resultado.criados.length, 4);
  assert.equal(resultado.mantidos.length, 1);
  assert.deepEqual(resultado.mantidos[0].frentesAdicionadas, [mamuru.name]);
  assert.equal(resultado.ignorados.length, 1);
  assert.ok(!JSON.stringify(resultado).match(/3907|6284|5173|9046/), "resultado sem códigos");

  const tela = await listFieldOperators(sessao);
  const porNome = (nome) => tela.find((row) => row.name === nome);
  const uJose = porNome(jose.name);
  assert.equal(uJose.employeeId, jose.id, "nome e vínculo do cadastro principal");
  assert.equal(uJose.jobTitle, "MOTORISTA DE CAMINHAO NIVEL III", "função do cadastro principal, não a sugerida");
  assert.equal(porNome(joaoPedro.name).employeeId, joaoPedro.id);
  const kleber = porNome(z("KLEBER NOVO OPERADOR"));
  assert.equal(kleber.jobTitle, "OPERADOR DE ESTEIRA", "função sugerida para quem não tem cadastro");
  assert.equal(kleber.employeeId, null);
  assert.equal(kleber.serviceFrontIds.length, 2);
  assert.ok(porNome(z("LUIZ CONFERIR NOME SOUZA")), "Conferir aprovado entra com o nome corrigido");
  assert.ok(tela.filter((row) => row.name.includes(`ZQ${s}`)).every((row) => row.active), "todos ativos");
  const henrique = porNome(z("HENRIQUE MEIRE CARMINATI"));
  assert.deepEqual([...henrique.serviceFrontIds].sort(), [arapiuns.id, mamuru.id].sort());

  // Entrar: 2 operadores importados (certo e errado) e o Henrique com o código DELE.
  assert.equal((await verifyFieldOperator(pedido(), uJose.id, "3907")).id, uJose.id);
  await assert.rejects(verifyFieldOperator(pedido(), kleber.id, "5174"), (error) => error.status === 401);
  assert.equal((await verifyFieldOperator(pedido(), kleber.id, "5173")).id, kleber.id);
  assert.equal((await verifyFieldOperator(pedido(), henriqueId, "4826")).id, henriqueId);
  await assert.rejects(verifyFieldOperator(pedido(), henriqueId, "1111"), (error) => error.status === 401, "PIN da planilha NÃO trocou o código do Henrique");

  // Importar de novo não duplica: tudo vira "mantido".
  const segunda = await previewFieldImport(sessao, buffer, ajustes);
  assert.equal(segunda.resumo.criar, 0);
  assert.equal((await db.select().from(users).where(inArray(users.name, [jose.name]))).length, 1);
});
