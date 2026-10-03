// Integração (Postgres de teste já migrado) da importação do Controle Diário: prévia sem gravar,
// código com duas escalas (CC-02 em km vira HL-02), CA-01 → CC-01, HL casado pelo prefixo, diesel
// acima de 600 L trocado pela saída de combustível do dia, operador do cadastro x só o nome,
// "Conferir", leitura atual que só sobe se for a mais recente e maior, blocos idempotentes,
// correção um a um, Pendência do problema relatado e desfazer.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:controle-diario-importacao-banco
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ExcelJS from "exceljs";
import { and, eq, sql } from "drizzle-orm";
import { getD1, getDb } from "../db/index.ts";
import { dailyImportBatches, dailyProblemReports, dailyRecords, equipment, fuelMovements, fuelTypes, meterReadings, serviceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { corrigirImportado, desfazerImportacao, finalizarImportacao, importarBloco, iniciarImportacao, lerPlanilhaDiario, montarPrevia, previaDiario } from "../lib/daily-import.ts";
import { totaisDiario } from "../lib/daily-import-rules.ts";
import { loadPendencias, resolverProblemaDiario } from "../lib/pendencias.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const s = Date.now().toString(36).toUpperCase().slice(-5);
const CABECALHO = ["Data", "Equipamento", "Frente", "Operador", "Sem operador", "Local", "Local original", "Leitura inicial", "Leitura final", "KM/Horas trabalhadas", "Local Produção",
  "Viagens Porto", "Volume Porto (m³)", "Toras Porto", "Viagens Baldeio", "Total de viagens", "Diesel (L)", "Problema relatado", "Observações"];

async function planilha(linhas) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Importar");
  sheet.addRow(CABECALHO);
  for (const linha of linhas) sheet.addRow(linha);
  return (await workbook.xlsx.writeBuffer());
}

test("planilha real de setembro: 1.505 linhas e os totais conferidos", { skip: !enabled }, async () => {
  const buffer = readFileSync(new URL("../importacoes/Controle_Diario_Setembro_LIMPO.xlsx", import.meta.url));
  const linhas = await lerPlanilhaDiario(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const totais = totaisDiario(linhas);
  assert.equal(totais.linhas, 1505);
  assert.equal(totais.viagens, 1073);
  assert.equal(totais.volumePorto, 28385.32);
  assert.equal(totais.diesel, 318730);
});

test("prévia → importar em blocos → corrigir → pendência → desfazer", { skip: !enabled }, async () => {
  const db = await getDb();
  // Lote esquecido de uma execução anterior travaria o "uma importação por vez".
  await db.update(dailyImportBatches).set({ status: "DESFEITO" }).where(eq(dailyImportBatches.status, "EM_ANDAMENTO"));
  const [frente] = await db.insert(serviceFronts).values({ name: `ZQ${s} ARAPIUNS` }).returning();
  const [admin] = await db.insert(users).values({ email: `diario-admin-${s}@teste.local`, name: "Admin teste", role: "ADMIN", serviceFrontId: frente.id }).returning();
  const sessao = { id: admin.id, name: admin.name, username: "", email: admin.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: frente.id, serviceFrontName: frente.name, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  const [joao] = await db.insert(users).values({ email: `diario-campo-${s}@teste.local`, name: `ZQ${s} JOAO CAMPO`, role: "CAMPO", serviceFrontId: frente.id }).returning();
  const eq_ = (prefix, controlType, horas, km) => ({ code: `EQ-${prefix}`, prefix, type: "CAMINHÃO", brand: "M", model: "X", controlType, currentHours: horas, currentKm: km, serviceFrontId: frente.id });
  const [cm, hl, cc2, , cc1] = await db.insert(equipment).values([
    eq_(`CM-Z${s}`, "KM", 0, 1000), eq_(`HL-Z${s}-QVN6E34`, "KM", 0, 166800), eq_(`CC-Z${s}2`, "HOURS_KM", 500, 0), eq_(`CA-Z${s}1`, "KM", 0, 193), eq_(`CC-Z${s}1`, "KM", 0, 4279800),
  ]).returning();
  // CC-02 (horas) tem leitura mais nova no histórico: a importação não pode subir a atual dele.
  await db.insert(meterReadings).values({ equipmentId: cc2.id, readingDate: "2026-10-01", hours: 500, source: "MANUAL", createdBy: admin.id });
  let diesel = (await db.select().from(fuelTypes).where(eq(fuelTypes.code, "DIESEL_S10")).limit(1))[0];
  if (!diesel) [diesel] = await db.insert(fuelTypes).values({ code: "DIESEL_S10", name: "Diesel S10" }).returning();
  const [saida] = await db.insert(fuelMovements).values({ serviceFrontId: frente.id, fuelTypeId: diesel.id, movementType: "SAIDA", movementDate: "2026-09-02", quantity: 150, equipmentId: cm.id, responsible: "Teste", stockLocation: "FRENTE" }).returning();

  const F = frente.name, JOAO = `zq${s} joão campo`, PEDRO = `ZQ${s} PEDRO SEM CADASTRO`;
  const linha = (data, codigo, operador, ini, fim, extra = {}) => [data, codigo, F, operador ?? "", operador ? "NÃO" : "SIM", extra.local ?? "CONCESSÃO", extra.local ?? "Concessão", ini, fim, fim - ini,
    extra.producao ?? "", extra.vp ?? 0, extra.vol ?? 0, extra.toras ?? 0, extra.vb ?? 0, extra.total ?? "", extra.diesel ?? 0, extra.problema ?? "", ""];
  const buffer = await planilha([
    linha("01/09/2026", `CM-Z${s}`, JOAO, 1000, 1050, { producao: "Porto", vp: 2, vol: 30.5, toras: 40, diesel: 120 }), // 2
    linha("02/09/2026", `CM-Z${s}`, PEDRO, 1050, 1100, { diesel: 3080, problema: "Pneu furado" }), // 3: diesel > 600
    linha("03/09/2026", `CM-Z${s}`, PEDRO, 1100, 1090), // 4: final < inicial → Conferir
    linha("03/09/2026", `CM-Z${s}`, null, 1100, 1100), // 5: sem operador, parado
    linha("01/09/2026", `HL-Z${s}`, JOAO, 166800, 166900, { vb: 3 }), // 6: casa pelo prefixo
    linha("02/09/2026", `HL-Z${s}`, JOAO, 166900, 167000), // 7
    linha("03/09/2026", `CC-Z${s}2`, "SERGIO", 167000, 167200), // 8: escala km → HL
    linha("04/09/2026", `CC-Z${s}2`, "VALDINEY", 167200, 167450), // 9
    linha("01/09/2026", `CC-Z${s}2`, "FRANCIAN", 500, 508), // 10: escala horas → CC-02
    linha("02/09/2026", `CC-Z${s}2`, "FRANCIAN", 508, 515), // 11
    linha("01/09/2026", `CA-Z${s}1`, "ANTONIO FRANCISCO", 4280000, 4280300), // 12: não bate com o CA → CC-01
  ]);
  const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;

  // Prévia: nada gravado; grupos a decidir com sugestão.
  const antes = (await db.select({ n: sql`count(*)::int` }).from(dailyRecords))[0].n;
  const previa = await previaDiario(sessao, ab, { equipamentos: {}, problemas: [] });
  assert.equal((await db.select({ n: sql`count(*)::int` }).from(dailyRecords))[0].n, antes, "prévia não grava");
  const grupo = (chave) => previa.grupos.find((item) => item.chave === chave);
  assert.equal(grupo(`HL-Z${s}`).situacao, "CASADO_PELO_PREFIXO");
  assert.equal(grupo(`HL-Z${s}`).equipmentId, hl.id);
  assert.equal(grupo(`CC-Z${s}2#A`).equipmentId, cc2.id, "escala de horas fica no CC-02");
  assert.equal(grupo(`CC-Z${s}2#B`).situacao, "DECIDIR");
  assert.equal(grupo(`CC-Z${s}2#B`).sugestaoId, hl.id, "escala de km sugere o HL-02");
  assert.equal(grupo(`CA-Z${s}1`).situacao, "DECIDIR");
  assert.equal(grupo(`CA-Z${s}1`).sugestaoId, cc1.id, "CA-01 sugere o CC-01");
  assert.equal(previa.resumo.decidir, 2);
  await assert.rejects(iniciarImportacao(sessao, ab, "teste.xlsx", { equipamentos: {}, problemas: [] }), /Decida o equipamento/);

  // Decisões do usuário + problema da linha 3 vira pendência.
  const ajustes = { equipamentos: { [`CC-Z${s}2#B`]: hl.id, [`CA-Z${s}1`]: cc1.id }, problemas: [3] };
  const final = await montarPrevia(db, await lerPlanilhaDiario(ab), ajustes);
  assert.equal(final.resumo.decidir, 0);
  assert.equal(final.plano.length, 11);
  const plano = (n) => final.plano.find((item) => item.linha === n);
  assert.equal(plano(2).operadorId, joao.id, "operador casado pelo nome sem acento/caixa");
  assert.equal(plano(3).operadorId, null);
  assert.equal(plano(3).operadorNome, PEDRO, "sem cadastro fica com o nome");
  assert.equal(plano(5).semOperador, true);
  assert.equal(plano(3).diesel, 150, "acima de 600 L usa a saída do Combustível do dia");
  assert.match(plano(3).dieselNota, /acima de 600/);
  assert.equal(plano(2).diesel, 120);
  assert.ok(plano(4).conferir, "final menor que a inicial");
  assert.equal(plano(5).conferir, null, "leitura igual (parado) é normal");
  assert.equal(plano(8).equipmentId, hl.id);
  assert.equal(plano(12).equipmentId, cc1.id);
  assert.ok(final.semCadastro.some((item) => item.nome === PEDRO));
  const leitura = (id) => final.leituras.find((item) => item.equipmentId === id);
  assert.equal(leitura(cm.id).sobe, true);
  assert.equal(leitura(hl.id).importada, 167450);
  assert.equal(leitura(cc2.id).sobe, false, "histórico tem leitura mais nova");

  // Importar: lote, bloco (repetido não duplica), finalizar.
  const inicio = await iniciarImportacao(sessao, ab, "teste.xlsx", ajustes);
  assert.equal(inicio.label, "IMPORTACAO_SETEMBRO_2026");
  await assert.rejects(finalizarImportacao(sessao, inicio.loteId), /Faltam 11/);
  assert.equal((await importarBloco(sessao, inicio.loteId, 0)).inseridos, 11);
  assert.equal((await importarBloco(sessao, inicio.loteId, 0)).inseridos, 0, "repetir o bloco não duplica");
  const resumo = await finalizarImportacao(sessao, inicio.loteId);
  assert.deepEqual(resumo.leiturasAtualizadas.map((item) => item.equipmentId).sort((a, b) => a - b), [cm.id, hl.id, cc1.id].sort((a, b) => a - b));

  const registros = await db.select().from(dailyRecords).where(eq(dailyRecords.importBatchId, inicio.loteId));
  assert.equal(registros.length, 11);
  const reg = (n) => registros.find((item) => item.sourceRow === n);
  assert.equal(reg(2).origin, "IMPORTACAO_SETEMBRO_2026");
  assert.equal(reg(2).fieldOperatorId, joao.id);
  assert.equal(reg(2).portVolumeM3, 30.5);
  assert.equal(reg(4).reviewStatus, "CONFERIR");
  assert.equal(reg(5).noOperator, true);
  assert.equal(reg(3).reportedDieselLiters, 150);
  assert.equal(reg(3).dieselFuelMovementId, saida.id);
  const leituras = await db.select().from(meterReadings).where(eq(meterReadings.dailyImportBatchId, inicio.loteId));
  assert.equal(leituras.length, 10, "todas menos a Conferir");
  assert.ok(leituras.every((item) => item.source === "CONTROLE_DIARIO"));
  const atual = async (id) => (await db.select().from(equipment).where(eq(equipment.id, id)))[0];
  assert.equal((await atual(cm.id)).currentKm, 1100);
  assert.equal((await atual(hl.id)).currentKm, 167450);
  assert.equal((await atual(cc1.id)).currentKm, 4280300);
  assert.equal((await atual(cc2.id)).currentHours, 500, "não sobe: há leitura mais nova");
  assert.equal((await db.select().from(fuelMovements).where(eq(fuelMovements.equipmentId, cm.id))).length, 1, "diesel do diário não cria saída");

  // Pendência do problema relatado e "Resolver".
  const [problema] = await db.select().from(dailyProblemReports).where(eq(dailyProblemReports.importBatchId, inicio.loteId));
  assert.equal(problema.description, "Pneu furado");
  const grupos = await loadPendencias(await getD1(), sessao);
  assert.ok(grupos.find((item) => item.key === "daily-problems").rows.some((row) => Number(row.id) === problema.id));
  assert.equal((await resolverProblemaDiario(await getD1(), sessao, problema.id, "Pneu trocado")).ok, true);
  assert.equal((await resolverProblemaDiario(await getD1(), sessao, problema.id, "")).status, 409);

  // Corrigir um a um: vincula o PEDRO ao cadastro (e os outros com o mesmo nome) e tira o "Conferir".
  const { outros } = await corrigirImportado(sessao, reg(4).id, { operador: { tipo: "CAMPO", id: joao.id }, aplicarMesmoNome: true, inicial: 1100, final: 1120, conferir: false });
  assert.equal(outros, 1, "a linha 3 tinha o mesmo nome");
  const corrigido = (await db.select().from(dailyRecords).where(eq(dailyRecords.id, reg(4).id)))[0];
  assert.equal(corrigido.fieldOperatorId, joao.id);
  assert.equal(corrigido.reviewStatus, "OK");
  assert.equal((await db.select().from(meterReadings).where(eq(meterReadings.dailyRecordId, reg(4).id)))[0].km, 1120);
  assert.equal((await atual(cm.id)).currentKm, 1120, "saiu do Conferir com a leitura mais recente e maior");
  assert.equal((await db.select().from(dailyRecords).where(eq(dailyRecords.id, reg(3).id)))[0].fieldOperatorId, joao.id);

  // Desfazer: apaga registros, leituras e pendências; devolve a leitura que ainda é a da importação.
  const { devolvidas } = await desfazerImportacao(sessao, inicio.loteId);
  assert.equal((await db.select().from(dailyRecords).where(eq(dailyRecords.importBatchId, inicio.loteId))).length, 0);
  assert.equal((await db.select().from(meterReadings).where(eq(meterReadings.dailyImportBatchId, inicio.loteId))).length, 0);
  assert.equal((await db.select().from(dailyProblemReports).where(eq(dailyProblemReports.importBatchId, inicio.loteId))).length, 0);
  assert.equal((await atual(hl.id)).currentKm, 166800);
  assert.equal((await atual(cc1.id)).currentKm, 4279800);
  assert.equal((await atual(cm.id)).currentKm, 1120, "CM mudou depois (correção): não é devolvido");
  assert.ok(!devolvidas.includes(cm.prefix));
  assert.equal((await db.select().from(dailyImportBatches).where(and(eq(dailyImportBatches.id, inicio.loteId), eq(dailyImportBatches.status, "DESFEITO")))).length, 1);
});
