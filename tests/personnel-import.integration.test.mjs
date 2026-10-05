// Integração (Postgres de teste já migrado) do "Importar do sistema de pessoal": prévia sem gravar,
// casamento pelo nome com quem já existe, gravação em blocos, desligado inativa o acesso de campo,
// reimportar não muda nada e "Desfazer importação" devolve o banco ao que era. Dados sintéticos.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:importacao-pessoal-banco
import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { auditLogs, employeeDismissals, employeeLeaveCycles, employees, employeeTransfers, jobFunctions, personnelImportBatches, serviceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { applyBlock, finishImport, previewImport, startImport, undoImport } from "../lib/personnel-import.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;

const s = Date.now().toString(36).toUpperCase().slice(-6);
const z = (name) => `ZP${s} ${name}`;
const ARA = `ARAPIUNS ZP${s}`, MAM = `MAMURU ZP${s}`;

// CPF sintético válido (dígitos verificadores calculados).
function cpf(seed) {
  const digits = String(100_000_000 + (seed % 899_999_999)).slice(0, 9).split("").map(Number);
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += digits[index] * (length + 1 - index);
    const rest = (sum * 10) % 11;
    digits.push(rest === 10 ? 0 : rest);
  }
  const d = digits.join("");
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function workbook(sheets) {
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = book.addWorksheet(name);
    const header = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    sheet.addRow(header);
    for (const row of rows) sheet.addRow(header.map((column) => row[column] ?? null));
  }
  const buffer = await book.xlsx.writeBuffer();
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function exportSheets(cpfAlfa) {
  const colab = (id, nome, extra = {}) => ({
    "Frente": ARA, "Lista": "Ativos", "Matrícula": "-", "Colaborador": nome, "Colaborador - detalhe": "OP. DE SKIDDER", "Empresa": "JC", "Cidade": "-", "Nascimento": "-", "Admissão": "10/06/2026",
    "Situação": "Trabalhando", "ID sistema": id, "Matrícula (ficha)": null, "Nome (ficha)": nome, "Função (ficha)": "OP. DE SKIDDER", "Empresa (ficha)": "JC", "Admissão (ficha)": "2026-06-10",
    "Nascimento (ficha)": null, "Cidade (ficha)": null, "CPF": "-", "Salário CTPS": "-", "Fica na sede": "Não", "Desligado em": null, "Motivo": null, "Restrição": null, ...extra,
  });
  const id = (n) => `${s}${n}`;
  return {
    "Colaboradores": [
      colab(id(1), z("ALFA TESTE UM"), { "CPF": cpfAlfa, "Salário CTPS": "2.000,00", "Função (ficha)": "MOT. DE CAMINHAO NIVEL III", "Nascimento (ficha)": "1990-05-01" }),
      colab(id(2), z("BETA TESTE DOIS"), { "Empresa": "Renascer", "Empresa (ficha)": "Renascer" }),
      colab(id(3), z("GAMA TESTE TRES"), { "Lista": "Desligados", "Situação": null, "Desligado em": "25/09/2026", "Motivo": "MOTIVO RESERVADO", "Restrição": "Restrito" }),
      colab(id(4), z("ETA TESTE QUATRO")),
    ],
    "Ciclos de folga (painel)": [
      { "Colaborador": z("ALFA TESTE UM"), "Empresa": "JC", "Início do ciclo": "29/09/2026ciclo 2 · vence 28/12/2026", "Situação": "x" },
      { "Colaborador": z("BETA TESTE DOIS"), "Empresa": "Renascer", "Início do ciclo": "10/06/2026ciclo 1 · vence 08/09/2026", "Situação": "x" },
    ],
    "Histórico de folgas": [
      { "Colaborador": z("ALFA TESTE UM"), "Emp.": "JC", "Ciclo": "1", "Início": "01/07/2026", "Dias trab.": "90", "Saída": "—", "Chegada casa": "—", "Saída casa": "—", "Chegada frente": "—", "Tipo": "VENDIDA" },
    ],
    "De folga": [{ "Colaborador": z("BETA TESTE DOIS"), "Empresa": "Renascer", "Chegou em casa": "02/10/2026", "Término previsto": "12/10/2026", "Dias restantes": "9 d" }],
    "Em viagem": [{ "Colaborador": z("ETA TESTE QUATRO"), "Empresa": "JC", "Saiu da frente": "26/09/2026", "Dias em viagem": "7 d" }],
    "Ausências (por pessoa)": [{ "ID sistema": id(4), "Colaborador": "Selecione um colaborador", "Tipo": "Afastamento", "Período": "31/08/2026 a 08/09/2026", "Motivo / observação": "ATESTADO", "Frente": ARA }],
    "Movimentações": [{ "ID sistema": id(1), "Colaborador": "Selecione um colaborador", "Data": "27/08/2026", "Evento": `Transferido de ${MAM} para ${ARA}`, "Frente": ARA }],
    "Lista de restrição": [{ "Colaborador": z("GAMA TESTE TRES"), "Empresa": "JC", "Desligado em": "25/09/2026", "Motivo": "MOTIVO RESERVADO" }],
  };
}

test("prévia, gravação em blocos, reimportação sem mudança e desfazer", { skip: !enabled }, async () => {
  const db = await getDb();
  const [ara, mam] = await db.insert(serviceFronts).values([{ name: ARA }, { name: MAM }]).returning();
  const [admin] = await db.insert(users).values({ email: `pessoal-admin-${s}@teste.local`, name: "Admin teste", role: "ADMIN", serviceFrontId: ara.id }).returning();
  const session = { id: admin.id, name: admin.name, username: "", email: admin.email, profile: "ADMIN", taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: ara.id, serviceFrontName: ara.name, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null };
  await db.insert(jobFunctions).values({ name: "OP. DE SKIDDER", operatesEquipment: true }).onConflictDoNothing();
  // Já existem: ALFA (Mamuru, sem matrícula/CPF) e GAMA (ativo, com acesso de operador).
  const [alfa, gama] = await db.insert(employees).values([
    { name: z("ALFA TESTE UM"), jobTitle: "MOTORISTA DE CAMINHAO NIVEL III", company: "JC", admissionDate: "2026-06-10", serviceFrontId: mam.id },
    { name: z("GAMA TESTE TRES"), jobTitle: "OP. DE SKIDDER", company: "JC", admissionDate: "2026-06-10", serviceFrontId: ara.id },
  ]).returning();
  await db.insert(employeeTransfers).values([{ employeeId: alfa.id, newServiceFrontId: mam.id, transferDate: "2026-06-10", note: "Frente inicial (cadastro)" }, { employeeId: gama.id, newServiceFrontId: ara.id, transferDate: "2026-06-10", note: "Frente inicial (cadastro)" }]);
  const [gamaUser, etaUser] = await db.insert(users).values([
    { email: `pessoal-g-${s}@campo.local`, username: `pessoal-g-${s}`, name: gama.name, role: "CAMPO", status: "ACTIVE", employeeId: gama.id, fieldAccessOrigin: "FUNCAO", serviceFrontId: ara.id },
    { email: `pessoal-e-${s}@campo.local`, username: `pessoal-e-${s}`, name: z("ETA TESTE QUATRO"), role: "CAMPO", status: "ACTIVE", fieldAccessOrigin: "MANUAL" },
  ]).returning();
  const alfaBefore = (await db.select().from(employees).where(eq(employees.id, alfa.id)))[0];

  const cpfAlfa = cpf(Date.now());
  const file = await workbook(exportSheets(cpfAlfa));
  const preview = await previewImport(session, file, "exportacao.xlsx", {});
  const mine = preview.people;
  const p = (name) => mine.find((item) => item.name === z(name));
  assert.equal(p("ALFA TESTE UM").how, "NOME");
  assert.equal(p("ALFA TESTE UM").action, "ATUALIZAR");
  assert.ok(p("ALFA TESTE UM").changes.some((change) => change.label === "Frente" && change.from === MAM && change.to === ARA), "Frente: MAMURU → ARAPIUNS");
  const cpfChange = p("ALFA TESTE UM").changes.find((change) => change.field === "cpf");
  assert.equal(cpfChange.to, "preenchido", "a prévia nunca mostra o CPF");
  assert.ok(!JSON.stringify(preview).includes(cpfAlfa.replace(/\D/g, "")), "CPF fora da prévia");
  assert.ok(!JSON.stringify(preview).includes("MOTIVO RESERVADO"), "motivo fora da prévia");
  assert.equal(p("BETA TESTE DOIS").action, "CRIAR");
  assert.ok(preview.fieldAccess.deactivate.some((item) => item.name === gama.name));
  assert.ok(preview.fieldAccess.link.some((item) => item.userId === etaUser.id));
  assert.ok(preview.companiesToCreate.includes("RENASCER") || !preview.companiesToCreate.length);
  // A prévia não grava nada.
  assert.equal((await db.select().from(employees).where(like(employees.name, `ZP${s}%`))).length, 2);

  await db.update(personnelImportBatches).set({ status: "DESFEITO" }).where(eq(personnelImportBatches.status, "EM_ANDAMENTO"));
  const started = await startImport(session, file, "exportacao.xlsx", {});
  for (let block = 0; block < started.blocks; block++) {
    const result = await applyBlock(session, started.batchId, block, file, {});
    assert.deepEqual(result.failed, []);
  }
  await finishImport(session, started.batchId);

  const after = await db.select().from(employees).where(like(employees.name, `ZP${s}%`));
  assert.equal(after.length, 4, "2 atualizados + 2 criados");
  const alfaAfter = after.find((row) => row.id === alfa.id);
  assert.equal(alfaAfter.serviceFrontId, ara.id);
  assert.equal(alfaAfter.externalId, `${s}1`);
  assert.equal(alfaAfter.cpf, cpfAlfa.replace(/\D/g, ""));
  assert.equal(alfaAfter.salary, 2000);
  const cycles = await db.select().from(employeeLeaveCycles).where(eq(employeeLeaveCycles.employeeId, alfa.id));
  assert.equal(cycles.find((row) => row.cycleNumber === 1).leaveKind, "VENDIDA");
  assert.equal(cycles.find((row) => row.cycleNumber === 2).workStart, "2026-09-29");
  const gamaAfter = after.find((row) => row.id === gama.id);
  assert.equal(gamaAfter.status, "DEMITIDO");
  const dismissal = (await db.select().from(employeeDismissals).where(eq(employeeDismissals.employeeId, gama.id)))[0];
  assert.equal(dismissal.rehireAllowed, false);
  assert.equal((await db.select().from(users).where(eq(users.id, gamaUser.id)))[0].status, "INACTIVE", "desligado: acesso de campo inativo");
  const eta = after.find((row) => row.name === z("ETA TESTE QUATRO"));
  assert.equal((await db.select().from(users).where(eq(users.id, etaUser.id)))[0].employeeId, eta.id, "vinculado ao acesso de campo existente");
  // Nada de CPF/motivo nos logs de auditoria.
  const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "PERSONNEL_IMPORT"), eq(auditLogs.entityId, String(started.batchId))));
  assert.ok(logs.length >= 1);
  assert.ok(!JSON.stringify(logs).includes(cpfAlfa.replace(/\D/g, "")) && !JSON.stringify(logs).includes("MOTIVO RESERVADO"));

  // Reimportar o mesmo arquivo: ninguém muda (casam pelo ID sistema).
  const again = await previewImport(session, file, "exportacao.xlsx", {});
  for (const item of again.people) {
    assert.equal(item.how, "ID", item.name);
    assert.equal(item.action, "SEM_MUDANCA", `${item.name}: ${JSON.stringify(item.changes)} ${JSON.stringify(item.history)}`);
  }

  // Desfazer: criados somem, ALFA volta como era, acessos voltam.
  const undone = await undoImport(session, started.batchId);
  assert.deepEqual(undone.failed, []);
  const restored = await db.select().from(employees).where(like(employees.name, `ZP${s}%`));
  assert.equal(restored.length, 2);
  const alfaRestored = restored.find((row) => row.id === alfa.id);
  for (const field of ["serviceFrontId", "cpf", "salary", "externalId", "registration", "status", "jobTitle", "company", "birthDate"]) assert.deepEqual(alfaRestored[field], alfaBefore[field], field);
  assert.equal((await db.select().from(employeeLeaveCycles).where(inArray(employeeLeaveCycles.employeeId, [alfa.id, gama.id]))).length, 0);
  assert.equal((await db.select().from(users).where(eq(users.id, gamaUser.id)))[0].status, "ACTIVE");
  assert.equal((await db.select().from(users).where(eq(users.id, etaUser.id)))[0].employeeId, null);
});
