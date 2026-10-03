import { randomInt, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, employees, jobFunctions, serviceFronts, userServiceFronts, userSessions, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { validateEmployee } from "./employee-rules";
import { assertUniqueDocuments, employeeToday, insertEmployee, parseEmployeeBody, requireCompany, restrictedMatches } from "./employees";
import { ACCESS_CODE_PATTERN, hashAccessCode } from "./field-auth";
import { codigosDoLote, lerPin, mapearCabecalho, nameKey, semelhanca, separarFrentes, SEMELHANCA_ROTULO, type Semelhanca } from "./field-operators-rules";
import { pinObvio } from "./operadores-regras";

// Cadastro dos funcionários de campo (perfil CAMPO). Quem cadastra (daily.field_operators)
// só vê e cria funcionários nas frentes que enxerga. O código nunca é devolvido pela API — a não
// ser na resposta do próprio cadastro, para ser entregue uma única vez.
//  - O acesso pode ficar vinculado ao cadastro principal (users.employee_id): nome, função e demissão
//    passam a vir de lá (lib/operadores.ts → sincronizarAcessoOperador).
//  - Quem é adicionado nesta tela (da lista, manual ou importação) tem origem MANUAL.
export class FieldOperatorError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type FieldOperatorInput = { name: string; jobTitle: string; code: string | null; serviceFrontIds: number[]; active: boolean };

const clean = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");
const ids = (value: unknown) => (Array.isArray(value) ? [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : []);

export function parseFieldOperatorInput(body: Record<string, unknown>, creating: boolean): FieldOperatorInput {
  const name = clean(body.name).toUpperCase();
  const jobTitle = clean(body.jobTitle);
  const code = clean(body.code);
  const serviceFrontIds = ids(body.serviceFrontIds);
  if (name.length < 5 || !name.includes(" ")) throw new FieldOperatorError("Informe o nome completo do funcionário.");
  if (!jobTitle) throw new FieldOperatorError("Informe a função do funcionário.");
  if ((creating || code) && !ACCESS_CODE_PATTERN.test(code)) throw new FieldOperatorError("O código deve ter de 4 a 8 números.");
  if (!serviceFrontIds.length) throw new FieldOperatorError("Selecione pelo menos uma frente de serviço.");
  return { name, jobTitle, code: code || null, serviceFrontIds, active: body.active !== false };
}

function assertFronts(actor: SessionUser, frontIds: number[]) {
  const fronts = frentesVisiveis(actor);
  if (fronts !== "ALL" && frontIds.some((id) => !fronts.includes(id))) throw new FieldOperatorError("Você só pode usar frentes que enxerga.", 403);
}
const seesFront = (actor: SessionUser, frontId: number | null) => { const fronts = frentesVisiveis(actor); return fronts === "ALL" || (frontId !== null && fronts.includes(frontId)); };

export async function listFieldOperators(actor: SessionUser) {
  const db = await getDb();
  const rows = await db.select({
    id: users.id, name: users.name, jobTitle: users.jobTitle, status: users.status, serviceFrontId: users.serviceFrontId, lastAccessAt: users.lastAccessAt,
    employeeId: users.employeeId, origin: users.fieldAccessOrigin, registration: employees.registration, employeeStatus: employees.status, employeeName: employees.name,
  }).from(users).leftJoin(employees, eq(employees.id, users.employeeId)).where(eq(users.role, "CAMPO")).orderBy(asc(users.name));
  const links = rows.length ? await db.select().from(userServiceFronts).where(inArray(userServiceFronts.userId, rows.map((row) => row.id))) : [];
  const fronts = frentesVisiveis(actor);
  return rows.map((row) => {
    const frontIds = [...new Set([row.serviceFrontId, ...links.filter((link) => link.userId === row.id).map((link) => link.serviceFrontId)].filter((id): id is number => id !== null))];
    return {
      id: row.id, name: row.name, jobTitle: row.jobTitle, active: row.status === "ACTIVE", serviceFrontIds: frontIds, lastAccessAt: row.lastAccessAt,
      employeeId: row.employeeId, registration: row.registration, employeeStatus: row.employeeStatus, origin: row.origin ?? "FUNCAO",
    };
  }).filter((row) => fronts === "ALL" || row.serviceFrontIds.some((id) => fronts.includes(id)));
}

async function validateFrontsExist(db: Db | Tx, frontIds: number[]) {
  const rows = await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(inArray(serviceFronts.id, frontIds), eq(serviceFronts.active, true)));
  if (rows.length !== frontIds.length) throw new FieldOperatorError("Uma das frentes não existe ou está inativa.");
}

// Grava um acesso de campo (mesma tabela e mesmo hash do "＋ Novo funcionário" de sempre).
type NovoAcesso = { name: string; jobTitle: string; frontIds: number[]; code: string; employeeId: number | null; active: boolean; origin: "MANUAL" | null; via: string };
async function inserirAcesso(tx: Tx, actor: SessionUser, input: NovoAcesso) {
  const now = new Date().toISOString();
  // E-mail/usuário técnicos (as colunas são obrigatórias/únicas); não servem para login por senha.
  const tag = randomUUID();
  const [row] = await tx.insert(users).values({
    name: input.name, jobTitle: input.jobTitle, email: `campo-${tag}@campo.local`, username: `campo-${tag}`, role: "CAMPO",
    status: input.active ? "ACTIVE" : "INACTIVE", serviceFrontId: input.frontIds[0], accessCodeHash: await hashAccessCode(input.code), accessCodeChangedAt: now,
    employeeId: input.employeeId, fieldAccessOrigin: input.origin, createdAt: now, updatedAt: now,
  }).returning({ id: users.id });
  await tx.insert(userServiceFronts).values(input.frontIds.map((serviceFrontId) => ({ userId: row.id, serviceFrontId, createdAt: now, updatedAt: now })));
  // Auditoria sem o código.
  await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(row.id), action: "FUNCIONÁRIO DE CAMPO CRIADO",
    newValue: JSON.stringify({ name: input.name, jobTitle: input.jobTitle, serviceFrontIds: input.frontIds, active: input.active, employeeId: input.employeeId, via: input.via }), occurredAt: now });
  return row.id;
}

export async function createFieldOperator(actor: SessionUser, input: FieldOperatorInput) {
  assertFronts(actor, input.serviceFrontIds);
  const db = await getDb();
  await validateFrontsExist(db, input.serviceFrontIds);
  return db.transaction((tx) => inserirAcesso(tx, actor, { name: input.name, jobTitle: input.jobTitle, frontIds: input.serviceFrontIds, code: input.code!, employeeId: null, active: input.active, origin: "MANUAL", via: "manual" }));
}

export async function updateFieldOperator(actor: SessionUser, id: number, input: FieldOperatorInput) {
  const current = (await listFieldOperators(actor)).find((row) => row.id === id);
  if (!current) throw new FieldOperatorError("Funcionário não encontrado.", 404);
  assertFronts(actor, input.serviceFrontIds);
  const db = await getDb();
  await validateFrontsExist(db, input.serviceFrontIds);
  // Vinculado ao cadastro principal: nome e função vêm de lá (a tela mostra como somente leitura).
  const vinculado = current.employeeId ? (await db.select({ name: employees.name, jobTitle: employees.jobTitle, status: employees.status }).from(employees).where(eq(employees.id, current.employeeId)).limit(1))[0] : null;
  if (vinculado && input.active && vinculado.status === "DEMITIDO") throw new FieldOperatorError(`${vinculado.name} está demitido no cadastro de Funcionários: o acesso fica inativo.`);
  const name = vinculado?.name ?? input.name;
  const jobTitle = vinculado?.jobTitle ?? input.jobTitle;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({
      name, jobTitle, status: input.active ? "ACTIVE" : "INACTIVE", serviceFrontId: input.serviceFrontIds[0], updatedAt: now,
      ...(input.code ? { accessCodeHash: await hashAccessCode(input.code), accessCodeChangedAt: now } : {}),
    }).where(and(eq(users.id, id), eq(users.role, "CAMPO")));
    // Inativar ou trocar o código derruba na hora quem estiver logado com o acesso antigo.
    if (!input.active || input.code) await tx.delete(userSessions).where(eq(userSessions.userId, id));
    await tx.delete(userServiceFronts).where(eq(userServiceFronts.userId, id));
    await tx.insert(userServiceFronts).values(input.serviceFrontIds.map((serviceFrontId) => ({ userId: id, serviceFrontId, createdAt: now, updatedAt: now })));
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(id), action: "FUNCIONÁRIO DE CAMPO ALTERADO",
      previousValue: JSON.stringify(current), occurredAt: now,
      newValue: JSON.stringify({ name, jobTitle, serviceFrontIds: input.serviceFrontIds, active: input.active, codeChanged: Boolean(input.code) }) });
  });
  return { name };
}

// ---------------------------------------------------------------------------
// "Da lista de funcionários": candidatos e criação em lote
// ---------------------------------------------------------------------------
// Funcionários não demitidos (ativos, de folga ou afastados) das frentes que a pessoa enxerga, que
// ainda não têm acesso de campo. Quem tem nome igual a um acesso antigo sem vínculo vem marcado
// (use "Vincular" no card, para não duplicar).
export async function fieldAccessCandidates(actor: SessionUser) {
  const db = await getDb();
  const [lista, acessos, operam] = await Promise.all([
    db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, registration: employees.registration, status: employees.status, serviceFrontId: employees.serviceFrontId, front: serviceFronts.name })
      .from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)).where(ne(employees.status, "DEMITIDO")).orderBy(asc(employees.name)),
    db.select({ id: users.id, name: users.name, employeeId: users.employeeId }).from(users).where(eq(users.role, "CAMPO")),
    db.select({ name: jobFunctions.name }).from(jobFunctions).where(and(eq(jobFunctions.operatesEquipment, true), eq(jobFunctions.active, true))),
  ]);
  const comAcesso = new Set(acessos.map((row) => row.employeeId).filter((id) => id !== null));
  const naoVinculados = new Map(acessos.filter((row) => !row.employeeId).map((row) => [nameKey(row.name), row]));
  const funcoesQueOperam = new Set(operam.map((row) => row.name));
  const candidatos = lista.filter((row) => !comAcesso.has(row.id) && seesFront(actor, row.serviceFrontId)).map((row) => {
    const mesmoNome = naoVinculados.get(nameKey(row.name));
    return {
      id: row.id, name: row.name, jobTitle: row.jobTitle, registration: row.registration, status: row.status, serviceFrontId: row.serviceFrontId, front: row.front,
      operates: funcoesQueOperam.has(row.jobTitle), acessoSemVinculo: mesmoNome ? { id: mesmoNome.id, name: mesmoNome.name } : null,
    };
  });
  return { candidatos, funcoes: [...new Set(candidatos.map((row) => row.jobTitle))].sort() };
}

export type ItemDaLista = { employeeId: number; extraFrontIds: number[]; code: string | null };
export type AcessoCriado = { userId: number; employeeId: number | null; name: string; jobTitle: string; registration: string | null; fronts: string[]; code: string };

async function nomesDasFrentes(db: Db | Tx, frontIds: number[]) {
  const rows = frontIds.length ? await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(inArray(serviceFronts.id, frontIds)) : [];
  return frontIds.map((id) => rows.find((row) => row.id === id)?.name ?? `Frente ${id}`);
}

export async function createFromEmployees(actor: SessionUser, itens: ItemDaLista[]): Promise<AcessoCriado[]> {
  if (!itens.length) throw new FieldOperatorError("Selecione pelo menos um funcionário.");
  if (itens.length > 300) throw new FieldOperatorError("Selecione no máximo 300 funcionários por vez.");
  if (new Set(itens.map((item) => item.employeeId)).size !== itens.length) throw new FieldOperatorError("O mesmo funcionário foi selecionado duas vezes.");
  const db = await getDb();
  const lista = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, registration: employees.registration, status: employees.status, serviceFrontId: employees.serviceFrontId, birthDate: employees.birthDate })
    .from(employees).where(inArray(employees.id, itens.map((item) => item.employeeId)));
  const jaTem = await db.select({ employeeId: users.employeeId, name: users.name }).from(users).where(inArray(users.employeeId, itens.map((item) => item.employeeId)));
  const problemas: string[] = [];
  const pedidos = itens.map((item) => {
    const funcionario = lista.find((row) => row.id === item.employeeId);
    if (!funcionario) { problemas.push(`Funcionário ${item.employeeId} não encontrado.`); return null; }
    if (funcionario.status === "DEMITIDO") problemas.push(`${funcionario.name} está demitido.`);
    if (!seesFront(actor, funcionario.serviceFrontId)) problemas.push(`${funcionario.name} é de uma frente que você não enxerga.`);
    if (jaTem.some((row) => row.employeeId === funcionario.id)) problemas.push(`${funcionario.name} já tem acesso de campo.`);
    const frontIds = [...new Set([funcionario.serviceFrontId, ...item.extraFrontIds])];
    return { funcionario, frontIds, code: item.code };
  });
  const { codigos, erros } = codigosDoLote(pedidos.map((pedido) => ({ codigo: pedido?.code, anoNascimento: pedido?.funcionario.birthDate?.slice(0, 4) })), (limite) => randomInt(limite));
  erros.forEach((erro, index) => { if (erro && pedidos[index]) problemas.push(`${pedidos[index]!.funcionario.name}: ${erro}`); });
  if (problemas.length) throw new FieldOperatorError(problemas.join(" "));
  const todasFrentes = [...new Set(pedidos.flatMap((pedido) => pedido!.frontIds))];
  assertFronts(actor, todasFrentes.filter((id) => !pedidos.some((pedido) => pedido!.funcionario.serviceFrontId === id)));
  await validateFrontsExist(db, todasFrentes);
  return db.transaction(async (tx) => {
    const criados: AcessoCriado[] = [];
    for (const [index, pedido] of pedidos.entries()) {
      const { funcionario, frontIds } = pedido!;
      const userId = await inserirAcesso(tx, actor, { name: funcionario.name, jobTitle: funcionario.jobTitle, frontIds, code: codigos[index], employeeId: funcionario.id, active: true, origin: "MANUAL", via: "lista de funcionários" });
      criados.push({ userId, employeeId: funcionario.id, name: funcionario.name, jobTitle: funcionario.jobTitle, registration: funcionario.registration, fronts: await nomesDasFrentes(tx, frontIds), code: codigos[index] });
    }
    return criados;
  });
}

// ---------------------------------------------------------------------------
// Cadastro manual: nomes parecidos, criação (com ou sem cadastro principal) e "Vincular"
// ---------------------------------------------------------------------------
export async function similarNames(actor: SessionUser, name: string, ignoreUserId?: number) {
  const db = await getDb();
  const [lista, acessos, vinculados] = await Promise.all([
    db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, status: employees.status, registration: employees.registration, serviceFrontId: employees.serviceFrontId, front: serviceFronts.name })
      .from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)),
    db.select({ id: users.id, name: users.name, jobTitle: users.jobTitle, status: users.status, employeeId: users.employeeId }).from(users).where(eq(users.role, "CAMPO")),
    db.select({ employeeId: users.employeeId, userId: users.id }).from(users).where(isNotNull(users.employeeId)),
  ]);
  const ordem: Record<string, number> = { IGUAL: 0, SOBRENOME_FALTANDO: 1, GRAFIA: 2, PRIMEIRO_E_ULTIMO: 3 };
  const comSemelhanca = <T extends { name: string }>(rows: T[]) => rows.map((row) => ({ ...row, semelhanca: semelhanca(name, row.name) }))
    .filter((row): row is T & { semelhanca: Exclude<Semelhanca, null> } => row.semelhanca !== null).sort((a, b) => ordem[a.semelhanca] - ordem[b.semelhanca]).slice(0, 8);
  return {
    funcionarios: comSemelhanca(lista.filter((row) => seesFront(actor, row.serviceFrontId))).map((row) => ({ ...row, semelhancaRotulo: SEMELHANCA_ROTULO[row.semelhanca], acessoId: vinculados.find((link) => link.employeeId === row.id)?.userId ?? null })),
    acessos: comSemelhanca(acessos.filter((row) => row.id !== ignoreUserId)).map((row) => ({ id: row.id, name: row.name, jobTitle: row.jobTitle, active: row.status === "ACTIVE", vinculado: Boolean(row.employeeId), semelhanca: row.semelhanca, semelhancaRotulo: SEMELHANCA_ROTULO[row.semelhanca] })),
  };
}

export type ManualInput = {
  name: string; jobTitle: string; frontIds: number[]; code: string | null;
  criarFuncionario: boolean; company: string; admissionDate: string; confirmarParecidos: boolean;
};
export function parseManualInput(body: Record<string, unknown>): ManualInput {
  const name = clean(body.name).toUpperCase();
  const jobTitle = clean(body.jobTitle).toUpperCase();
  if (name.length < 5 || !name.includes(" ")) throw new FieldOperatorError("Informe o nome completo (nome e sobrenome).");
  if (!jobTitle) throw new FieldOperatorError("Informe a função.");
  const frontIds = ids(body.serviceFrontIds);
  if (!frontIds.length) throw new FieldOperatorError("Selecione pelo menos uma frente de serviço.");
  return { name, jobTitle, frontIds, code: clean(body.code) || null, criarFuncionario: body.criarFuncionario !== false, company: clean(body.company).toUpperCase(), admissionDate: clean(body.admissionDate), confirmarParecidos: body.confirmarParecidos === true };
}

export async function createManual(actor: SessionUser, input: ManualInput): Promise<AcessoCriado> {
  assertFronts(actor, input.frontIds);
  const db = await getDb();
  await validateFrontsExist(db, input.frontIds);
  // Antes de salvar: alguém com nome parecido no cadastro principal ou nos acessos de campo?
  if (!input.confirmarParecidos) {
    const parecidos = await similarNames(actor, input.name);
    if (parecidos.funcionarios.length || parecidos.acessos.length) throw new FieldOperatorError("Já existe alguém com nome parecido.", 409, { parecidos });
  }
  const { codigos, erros } = codigosDoLote([{ codigo: input.code }], (limite) => randomInt(limite));
  if (erros[0]) throw new FieldOperatorError(erros[0]);
  let employeeId: number | null = null;
  if (input.criarFuncionario) {
    if (!actor.permissions.includes("employees.manage")) throw new FieldOperatorError("Para criar também no cadastro de Funcionários é preciso a permissão de cadastrar funcionários. Desmarque a opção ou peça a quem tem.", 403);
    const employee = parseEmployeeBody({ name: input.name, jobTitle: input.jobTitle, company: input.company, admissionDate: input.admissionDate || employeeToday(), serviceFrontId: input.frontIds[0], status: "ATIVO" });
    const problema = validateEmployee(employee, { requireFront: true, today: employeeToday() });
    if (problema) throw new FieldOperatorError(problema);
    await requireCompany(db, employee.company);
    await assertUniqueDocuments(db, employee);
    if ((await restrictedMatches(db, employee)).length) throw new FieldOperatorError("Este nome confere com um funcionário restrito (não pode ser recontratado). Cadastre pelo menu FUNCIONÁRIOS.", 409);
    employeeId = await insertEmployee(db, actor, employee, { via: "Funcionários de campo (Controle Diário)" });
  }
  const userId = await db.transaction((tx) => inserirAcesso(tx, actor, { name: input.name, jobTitle: input.jobTitle, frontIds: input.frontIds, code: codigos[0], employeeId, active: true, origin: "MANUAL", via: employeeId ? "manual + cadastro de funcionários" : "manual (sem cadastro de funcionário)" }));
  return { userId, employeeId, name: input.name, jobTitle: input.jobTitle, registration: null, fronts: await nomesDasFrentes(db, input.frontIds), code: codigos[0] };
}

// "Vincular": liga um acesso sem vínculo ao funcionário do cadastro principal (nome e função passam
// a vir de lá; o código continua o mesmo).
export async function linkFieldOperator(actor: SessionUser, userId: number, employeeId: number) {
  const atual = (await listFieldOperators(actor)).find((row) => row.id === userId);
  if (!atual) throw new FieldOperatorError("Funcionário de campo não encontrado.", 404);
  if (atual.employeeId) throw new FieldOperatorError("Este acesso já está vinculado ao cadastro de Funcionários.");
  const db = await getDb();
  const funcionario = (await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1))[0];
  if (!funcionario || !seesFront(actor, funcionario.serviceFrontId)) throw new FieldOperatorError("Funcionário não encontrado.", 404);
  if (funcionario.status === "DEMITIDO") throw new FieldOperatorError(`${funcionario.name} está demitido no cadastro de Funcionários.`);
  const outro = (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.employeeId, employeeId)).limit(1))[0];
  if (outro) throw new FieldOperatorError(`${funcionario.name} já tem outro acesso de campo (${outro.name}).`, 409);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ employeeId, name: funcionario.name, jobTitle: funcionario.jobTitle, fieldAccessOrigin: "MANUAL", updatedAt: now }).where(eq(users.id, userId));
    // A frente do cadastro entra junto com as que o acesso já tinha.
    await tx.insert(userServiceFronts).values({ userId, serviceFrontId: funcionario.serviceFrontId, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(userId), action: "FUNCIONÁRIO DE CAMPO VINCULADO",
      previousValue: JSON.stringify({ name: atual.name, jobTitle: atual.jobTitle }), newValue: JSON.stringify({ employeeId, name: funcionario.name, jobTitle: funcionario.jobTitle }), occurredAt: now });
  });
  return { name: funcionario.name };
}

// ---------------------------------------------------------------------------
// Importação da planilha "Funcionários de campo" (só ADMIN): prévia sem gravar e confirmação.
// O PIN da planilha é o código (mesmo hash da tela); nunca volta na resposta nem vai para log.
// ---------------------------------------------------------------------------
type LinhaPlanilha = { linha: number; nome: string; funcao: string; frentePrincipal: string; outrasFrentes: string[]; equipamentos: string; lancamentos: string; pin: string; conferir: string };

function textoCelula(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "object") {
    if ("result" in valor) return textoCelula(valor.result as ExcelJS.CellValue);
    if ("richText" in valor) return valor.richText.map((parte) => parte.text).join("");
    if ("text" in valor) return String(valor.text);
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    return "";
  }
  return String(valor).trim();
}

export async function lerPlanilhaCampo(buffer: ArrayBuffer): Promise<LinhaPlanilha[]> {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new FieldOperatorError("Não foi possível ler o arquivo. Envie a planilha .xlsx."); }
  const sheet = workbook.worksheets.find((item) => nameKey(item.name) === "FUNCIONARIOS DE CAMPO") ?? workbook.worksheets[0];
  if (!sheet) throw new FieldOperatorError("A planilha está vazia.");
  let cabecalho: ReturnType<typeof mapearCabecalho> | null = null;
  let linhaCabecalho = 0;
  for (let numero = 1; numero <= Math.min(10, sheet.rowCount); numero++) {
    const valores = (sheet.getRow(numero).values as ExcelJS.CellValue[]).slice(1).map(textoCelula);
    const mapa = mapearCabecalho(valores);
    if (mapa.indices.nome !== undefined) { cabecalho = mapa; linhaCabecalho = numero; break; }
  }
  if (!cabecalho) throw new FieldOperatorError("Não achei o cabeçalho (coluna \"Nome\") nas primeiras linhas da aba \"Funcionários de campo\".");
  if (cabecalho.faltando.length) throw new FieldOperatorError(`Faltam colunas na planilha: ${cabecalho.faltando.join(", ")}.`);
  const { indices } = cabecalho;
  const linhas: LinhaPlanilha[] = [];
  for (let numero = linhaCabecalho + 1; numero <= sheet.rowCount; numero++) {
    const valores = (sheet.getRow(numero).values as ExcelJS.CellValue[]).slice(1);
    const pega = (coluna: keyof typeof indices) => (indices[coluna] === undefined ? "" : textoCelula(valores[indices[coluna]!]));
    const nome = pega("nome").replace(/\s+/g, " ").trim();
    if (!nome) continue;
    linhas.push({
      linha: numero, nome, funcao: pega("funcao"), frentePrincipal: pega("frentePrincipal"), outrasFrentes: separarFrentes(pega("outrasFrentes")),
      equipamentos: pega("equipamentos"), lancamentos: pega("lancamentos"), pin: indices.pin === undefined ? "" : lerPin(valores[indices.pin] && typeof valores[indices.pin] === "object" ? textoCelula(valores[indices.pin]) : valores[indices.pin]), conferir: pega("conferir"),
    });
  }
  if (!linhas.length) throw new FieldOperatorError("Nenhuma pessoa encontrada na planilha.");
  return linhas;
}

export type DecisaoImportacao = { linha: number; acao: "VINCULAR" | "MANTER" | "NOVO" | "IGNORAR"; id?: number };
export type AjustesImportacao = { nomes: Record<string, string>; aprovados: number[]; decisoes: DecisaoImportacao[] };

type Opcao = { tipo: "FUNCIONARIO" | "ACESSO"; id: number; nome: string; detalhe: string; semelhanca: string };
export type LinhaPrevia = {
  linha: number; nome: string; nomeOriginal: string; funcao: string; frentes: string[]; equipamentos: string; lancamentos: string; conferir: string;
  grupo: "CRIAR" | "MANTER" | "PARECIDO" | "ERRO"; paraConferir: boolean; aprovado: boolean;
  vinculo: { id: number; nome: string; funcao: string; semelhanca: string } | null; manterAcesso: { id: number; nome: string; frentesNovas: string[] } | null;
  opcoes: Opcao[]; decisao: DecisaoImportacao | null; erro: string | null;
};

async function montarPrevia(db: Db, linhas: LinhaPlanilha[], ajustes: AjustesImportacao) {
  const [frentes, lista, acessos, links] = await Promise.all([
    db.select({ id: serviceFronts.id, name: serviceFronts.name, active: serviceFronts.active }).from(serviceFronts),
    db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, status: employees.status, front: serviceFronts.name }).from(employees).innerJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)),
    db.select({ id: users.id, name: users.name, jobTitle: users.jobTitle, employeeId: users.employeeId, serviceFrontId: users.serviceFrontId, status: users.status }).from(users).where(eq(users.role, "CAMPO")),
    db.select().from(userServiceFronts),
  ]);
  // Nome exato primeiro; sem acento/maiúsculas só se for uma frente só (senão é ambíguo).
  const frentePorNome = (nome: string) => {
    const exata = frentes.find((front) => front.name.trim() === nome.trim());
    if (exata) return exata;
    const parecidas = frentes.filter((front) => nameKey(front.name) === nameKey(nome));
    return parecidas.length === 1 ? parecidas[0] : undefined;
  };
  const ativos = lista.filter((row) => row.status !== "DEMITIDO");
  const vistos = new Map<string, number>();
  const usadosFuncionario = new Map<number, number>();
  const previa: LinhaPrevia[] = linhas.map((original) => {
    const nome = (ajustes.nomes[String(original.linha)] ?? original.nome).replace(/\s+/g, " ").trim().toUpperCase();
    const paraConferir = Boolean(original.conferir.trim());
    const base: LinhaPrevia = {
      linha: original.linha, nome, nomeOriginal: original.nome, funcao: original.funcao, frentes: [original.frentePrincipal, ...original.outrasFrentes].filter(Boolean),
      equipamentos: original.equipamentos, lancamentos: original.lancamentos, conferir: original.conferir, grupo: "CRIAR", paraConferir, aprovado: !paraConferir || ajustes.aprovados.includes(original.linha),
      vinculo: null, manterAcesso: null, opcoes: [], decisao: ajustes.decisoes.find((item) => item.linha === original.linha) ?? null, erro: null,
    };
    const erro = (texto: string): LinhaPrevia => ({ ...base, grupo: "ERRO", erro: texto });
    if (nome.split(" ").length < 2) return erro("Nome incompleto (precisa nome e sobrenome).");
    const repetida = vistos.get(nameKey(nome));
    if (repetida) return erro(`Nome repetido na planilha (linha ${repetida}).`);
    vistos.set(nameKey(nome), original.linha);
    if (!/^\d{4}$/.test(original.pin)) return erro("PIN inválido: precisa ter 4 números.");
    const frentesLinha = base.frentes.map((texto) => ({ texto, frente: frentePorNome(texto) }));
    const semFrente = frentesLinha.filter((item) => !item.frente || !item.frente.active).map((item) => item.texto);
    if (!original.frentePrincipal) return erro("Sem frente principal.");
    if (semFrente.length) return erro(`Frente não encontrada ou inativa: ${semFrente.join(", ")}.`);
    const frenteIds = [...new Set(frentesLinha.map((item) => item.frente!.id))];
    base.frentes = frenteIds.map((id) => frentes.find((front) => front.id === id)!.name);

    // Já está na tela? (acesso com o mesmo nome, ou vinculado ao funcionário de mesmo nome)
    const iguais = ativos.filter((row) => nameKey(row.name) === nameKey(nome));
    const acessoIgual = acessos.find((row) => nameKey(row.name) === nameKey(nome)) ?? acessos.find((row) => row.employeeId && iguais.some((func) => func.id === row.employeeId));
    const manter = (acesso: typeof acessos[number]): LinhaPrevia => {
      const atuais = new Set([acesso.serviceFrontId, ...links.filter((link) => link.userId === acesso.id).map((link) => link.serviceFrontId)]);
      return { ...base, grupo: "MANTER", manterAcesso: { id: acesso.id, nome: acesso.name, frentesNovas: frenteIds.filter((id) => !atuais.has(id)).map((id) => frentes.find((front) => front.id === id)!.name) } };
    };
    if (acessoIgual) return manter(acessoIgual);
    // Funcionário de mesmo nome (sem acento/maiúsculas/espaços) e ainda sem acesso: vincula.
    if (iguais.length === 1 && !usadosFuncionario.has(iguais[0].id)) {
      usadosFuncionario.set(iguais[0].id, original.linha);
      const func = iguais[0];
      return { ...base, vinculo: { id: func.id, nome: func.name, funcao: func.jobTitle, semelhanca: func.name === nome ? "Mesmo nome" : SEMELHANCA_ROTULO.IGUAL } };
    }
    // Parecidos (sobrenome faltando, grafia, homônimos): a pessoa decide.
    const opcoes: Opcao[] = [
      ...ativos.map((row) => ({ row, s: semelhanca(nome, row.name) })).filter((item) => item.s && !acessos.some((acesso) => acesso.employeeId === item.row.id))
        .map(({ row, s }) => ({ tipo: "FUNCIONARIO" as const, id: row.id, nome: row.name, detalhe: `${row.jobTitle} · ${row.front}${row.status !== "ATIVO" ? ` · ${row.status.toLowerCase()}` : ""}`, semelhanca: SEMELHANCA_ROTULO[s!] })),
      ...acessos.map((row) => ({ row, s: semelhanca(nome, row.name) })).filter((item) => item.s)
        .map(({ row, s }) => ({ tipo: "ACESSO" as const, id: row.id, nome: row.name, detalhe: `já tem acesso de campo · ${row.jobTitle ?? "—"}${row.status === "ACTIVE" ? "" : " · inativo"}`, semelhanca: SEMELHANCA_ROTULO[s!] })),
    ].slice(0, 6);
    if (opcoes.length) return { ...base, grupo: "PARECIDO", opcoes };
    return base;
  });
  const conta = (grupo: LinhaPrevia["grupo"]) => previa.filter((item) => item.grupo === grupo && !item.paraConferir).length;
  const porFrente = Object.entries(previa.filter((item) => item.grupo !== "ERRO").reduce<Record<string, number>>((acc, item) => { acc[item.frentes[0]] = (acc[item.frentes[0]] ?? 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([nome, total]) => ({ nome, total }));
  return {
    linhas: previa,
    resumo: { total: previa.length, criar: conta("CRIAR"), manter: conta("MANTER"), parecidos: conta("PARECIDO"), conferir: previa.filter((item) => item.paraConferir).length, erros: conta("ERRO"), porFrente },
  };
}

function exigeAdmin(actor: SessionUser) {
  if (actor.profile !== "ADMIN") throw new FieldOperatorError("Só ADMIN importa funcionários de campo.", 403);
}

export async function previewFieldImport(actor: SessionUser, buffer: ArrayBuffer, ajustes: AjustesImportacao) {
  exigeAdmin(actor);
  return montarPrevia(await getDb(), await lerPlanilhaCampo(buffer), ajustes);
}

export async function confirmFieldImport(actor: SessionUser, buffer: ArrayBuffer, ajustes: AjustesImportacao) {
  exigeAdmin(actor);
  const db = await getDb();
  const linhas = await lerPlanilhaCampo(buffer);
  const previa = await montarPrevia(db, linhas, ajustes);
  const pendentes = previa.linhas.filter((item) => item.aprovado && item.grupo === "PARECIDO" && !item.decisao);
  if (pendentes.length) throw new FieldOperatorError(`Decida os nomes parecidos antes de confirmar: ${pendentes.map((item) => item.nome).join(", ")}.`);
  const pinPorLinha = new Map(linhas.map((linha) => [linha.linha, linha.pin]));
  const frentes = await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts);
  const idDaFrente = (nome: string) => frentes.find((front) => front.name === nome)!.id;
  const resultado = { criados: [] as Array<{ nome: string; vinculado: boolean }>, mantidos: [] as Array<{ nome: string; frentesAdicionadas: string[] }>, ignorados: [] as Array<{ linha: number; nome: string; motivo: string }> };
  const funcionarios = await db.select({ id: employees.id, name: employees.name, jobTitle: employees.jobTitle, status: employees.status }).from(employees);
  await db.transaction(async (tx) => {
    const ocupados = new Set((await tx.select({ employeeId: users.employeeId }).from(users).where(isNotNull(users.employeeId))).map((row) => row.employeeId));
    const now = new Date().toISOString();
    const completarFrentes = async (userId: number, nomes: string[]) => {
      if (nomes.length) await tx.insert(userServiceFronts).values(nomes.map((nome) => ({ userId, serviceFrontId: idDaFrente(nome), createdAt: now, updatedAt: now }))).onConflictDoNothing();
    };
    for (const item of previa.linhas) {
      if (!item.aprovado) { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: "Para conferir (não aprovado)" }); continue; }
      if (item.grupo === "ERRO") { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: item.erro! }); continue; }
      const decisao = item.grupo === "PARECIDO" ? item.decisao! : null;
      if (decisao?.acao === "IGNORAR") { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: "Ignorado na prévia" }); continue; }
      // Já está na tela: não duplica e não troca o código; só completa as frentes.
      const manterId = item.grupo === "MANTER" ? item.manterAcesso!.id : decisao?.acao === "MANTER" ? decisao.id! : null;
      if (manterId) {
        const atuais = new Set((await tx.select({ id: userServiceFronts.serviceFrontId }).from(userServiceFronts).where(eq(userServiceFronts.userId, manterId))).map((row) => row.id));
        const acesso = (await tx.select({ name: users.name, serviceFrontId: users.serviceFrontId }).from(users).where(and(eq(users.id, manterId), eq(users.role, "CAMPO"))).limit(1))[0];
        if (!acesso) { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: "Acesso escolhido não existe mais" }); continue; }
        if (acesso.serviceFrontId) atuais.add(acesso.serviceFrontId);
        const novas = item.frentes.filter((nome) => !atuais.has(idDaFrente(nome)));
        await completarFrentes(manterId, novas);
        if (novas.length) await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(manterId), action: "FUNCIONÁRIO DE CAMPO: FRENTES COMPLETADAS NA IMPORTAÇÃO", newValue: JSON.stringify({ frentes: novas }), occurredAt: now });
        resultado.mantidos.push({ nome: acesso.name, frentesAdicionadas: novas });
        continue;
      }
      const funcionarioId = decisao?.acao === "VINCULAR" ? decisao.id! : decisao?.acao === "NOVO" ? null : item.vinculo?.id ?? null;
      const funcionario = funcionarioId ? funcionarios.find((row) => row.id === funcionarioId) : null;
      if (funcionarioId && (!funcionario || funcionario.status === "DEMITIDO" || ocupados.has(funcionarioId))) { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: "Funcionário escolhido não pode ser vinculado (demitido ou já tem acesso)" }); continue; }
      // Função: a do cadastro principal; a sugerida da planilha só para quem não tem cadastro.
      const funcao = (funcionario?.jobTitle || item.funcao).trim();
      if (!funcao) { resultado.ignorados.push({ linha: item.linha, nome: item.nome, motivo: "Sem função (nem no cadastro, nem na planilha)" }); continue; }
      const frontIds = item.frentes.map(idDaFrente);
      await inserirAcesso(tx, actor, { name: funcionario?.name ?? item.nome, jobTitle: funcao, frontIds, code: pinPorLinha.get(item.linha)!, employeeId: funcionario?.id ?? null, active: true, origin: "MANUAL", via: "importação da planilha" });
      if (funcionario) ocupados.add(funcionario.id);
      resultado.criados.push({ nome: funcionario?.name ?? item.nome, vinculado: Boolean(funcionario) });
    }
  });
  return resultado;
}

// O código digitado na tela (4 dígitos) não pode ser óbvio.
export function assertCodeNotObvious(code: string | null) {
  if (code && code.length === 4 && pinObvio(code)) throw new FieldOperatorError("Código fácil de adivinhar (sequência, repetido ou ano): escolha outro.");
}
