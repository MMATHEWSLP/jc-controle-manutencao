import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { auditLogs, employees, fieldLoginAttempts, jobFunctions, serviceFronts, userServiceFronts, userSessions, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { hashAccessCode, LOCK_MINUTES, MAX_FAILS_PER_OPERATOR } from "./field-auth";
import { deveTerAcesso, gerarPin, normalizarFuncao, type StatusAcesso } from "./operadores-regras";
import { createOperatorAccessPdf, type OperatorAccessPdfRow } from "./pdf";

// ---------------------------------------------------------------------------
// Acesso automático dos operadores (motoristas e operadores de máquina).
//  - O acesso é um usuário do perfil CAMPO (login simplificado: nome ou matrícula + PIN, só o
//    Controle Diário, só a frente do funcionário) ligado ao funcionário por users.employee_id.
//  - sincronizarAcessoOperador é chamado em TODO lugar que salva o funcionário (cadastro, edição,
//    demissão, readmissão, transferência, cadastro de Funções e importação): cria, atualiza,
//    reativa (com PIN novo) ou desativa o acesso. Nunca exclui: o histórico fica.
//  - O PIN (4 dígitos aleatórios, sem sequências óbvias) só existe em texto na resposta que o mostra
//    uma vez; no banco fica só o hash.
// ---------------------------------------------------------------------------
type Db = Awaited<ReturnType<typeof getDb>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export class OperadorError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

// PIN igual para todos só se o administrador definir OPERATOR_DEFAULT_PIN (4 números).
export function novoPin(anoNascimento?: string | null) {
  const padrao = process.env.OPERATOR_DEFAULT_PIN?.trim();
  if (padrao && /^\d{4}$/.test(padrao)) return padrao;
  return gerarPin((limite) => randomInt(limite), anoNascimento);
}

// Garante a função no cadastro de Funções (nasce sem "Opera equipamento").
export async function garantirFuncao(db: Conn, jobTitle: string) {
  const nome = normalizarFuncao(jobTitle);
  if (nome) await db.insert(jobFunctions).values({ name: nome }).onConflictDoNothing();
}

async function funcaoOpera(db: Conn, jobTitle: string) {
  const nome = normalizarFuncao(jobTitle);
  if (!nome) return false;
  const row = (await db.select({ operates: jobFunctions.operatesEquipment }).from(jobFunctions).where(and(eq(jobFunctions.name, nome), eq(jobFunctions.active, true))).limit(1))[0];
  return row?.operates === true;
}

export type AcessoGerado = { userId: number; employeeId: number; nome: string; matricula: string | null; funcao: string; frente: string; pin: string };
export type ResultadoAcesso = {
  acao: "CRIADO" | "REATIVADO" | "VINCULADO" | "DESATIVADO" | "ATUALIZADO" | "PENDENTE" | "NENHUMA";
  mensagem: string | null;
  acesso?: AcessoGerado;
};

async function carregarFuncionario(db: Conn, employeeId: number) {
  return (await db.select({
    id: employees.id, name: employees.name, jobTitle: employees.jobTitle, status: employees.status, registration: employees.registration, birthDate: employees.birthDate,
    serviceFrontId: employees.serviceFrontId, front: serviceFronts.name, frontActive: serviceFronts.active,
  }).from(employees).leftJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId)).where(eq(employees.id, employeeId)).limit(1))[0];
}

async function auditar(db: Conn, actorId: number | null, userId: number, action: string, newValue?: unknown) {
  await db.insert(auditLogs).values({ userId: actorId, entityType: "USER", entityId: String(userId), action, newValue: newValue === undefined ? null : JSON.stringify(newValue), occurredAt: new Date().toISOString() });
}

async function definirFrente(db: Conn, userId: number, frontId: number, agora: string) {
  await db.delete(userServiceFronts).where(eq(userServiceFronts.userId, userId));
  await db.insert(userServiceFronts).values({ userId, serviceFrontId: frontId, createdAt: agora, updatedAt: agora });
}

// opcoes.criar = false: só desativa/atualiza (ex.: importação, marcação de função) — quem ficou sem
// acesso aparece como pendente em Usuários > Operadores, para criar com o PDF dos PINs.
export async function sincronizarAcessoOperador(db: Db, employeeId: number, actorId: number | null, opcoes: { criar?: boolean; motivo?: string } = {}): Promise<ResultadoAcesso> {
  const criar = opcoes.criar !== false;
  return db.transaction(async (tx) => {
    const funcionario = await carregarFuncionario(tx, employeeId);
    if (!funcionario) return { acao: "NENHUMA", mensagem: null };
    const deve = deveTerAcesso(funcionario.status, await funcaoOpera(tx, funcionario.jobTitle)) && funcionario.frontActive === true;
    const usuario = (await tx.select().from(users).where(eq(users.employeeId, employeeId)).limit(1))[0];
    const agora = new Date().toISOString();
    if (!deve) {
      if (usuario && usuario.status === "ACTIVE") {
        await tx.update(users).set({ status: "INACTIVE", updatedAt: agora }).where(eq(users.id, usuario.id));
        await tx.delete(userSessions).where(eq(userSessions.userId, usuario.id));
        const motivo = funcionario.status === "DEMITIDO" ? "funcionário demitido" : "função não opera equipamento";
        await auditar(tx, actorId, usuario.id, "ACESSO DE OPERADOR DESATIVADO", { employeeId, motivo: opcoes.motivo ?? motivo });
        return { acao: "DESATIVADO", mensagem: `Acesso de operador de ${funcionario.name} desativado (${motivo}).` };
      }
      return { acao: "NENHUMA", mensagem: null };
    }
    const dados = { name: funcionario.name, jobTitle: funcionario.jobTitle, serviceFrontId: funcionario.serviceFrontId };
    const gerado = (userId: number, pin: string): AcessoGerado => ({ userId, employeeId, nome: funcionario.name, matricula: funcionario.registration, funcao: funcionario.jobTitle, frente: funcionario.front ?? "—", pin });
    if (!usuario) {
      if (!criar) return { acao: "PENDENTE", mensagem: `${funcionario.name} vai precisar de acesso de operador (crie em Usuários > Operadores).` };
      const pin = novoPin(funcionario.birthDate?.slice(0, 4));
      const tag = randomUUID();
      const [row] = await tx.insert(users).values({
        ...dados, email: `operador-${tag}@campo.local`, username: `operador-${tag}`, role: "CAMPO", status: "ACTIVE",
        accessCodeHash: await hashAccessCode(pin), accessCodeChangedAt: agora, employeeId, createdAt: agora, updatedAt: agora,
      }).returning({ id: users.id });
      await definirFrente(tx, row.id, funcionario.serviceFrontId, agora);
      await auditar(tx, actorId, row.id, "ACESSO DE OPERADOR CRIADO", { employeeId, ...dados });
      return { acao: "CRIADO", mensagem: `Acesso de operador criado para ${funcionario.name}.`, acesso: gerado(row.id, pin) };
    }
    if (usuario.status !== "ACTIVE") {
      if (!criar) return { acao: "PENDENTE", mensagem: `${funcionario.name} tem acesso de operador desativado (reative em Usuários > Operadores).` };
      const pin = novoPin(funcionario.birthDate?.slice(0, 4));
      await tx.update(users).set({ ...dados, status: "ACTIVE", accessCodeHash: await hashAccessCode(pin), accessCodeChangedAt: agora, updatedAt: agora }).where(eq(users.id, usuario.id));
      await definirFrente(tx, usuario.id, funcionario.serviceFrontId, agora);
      await auditar(tx, actorId, usuario.id, "ACESSO DE OPERADOR REATIVADO", { employeeId, ...dados });
      return { acao: "REATIVADO", mensagem: `Acesso de operador de ${funcionario.name} reativado com PIN novo.`, acesso: gerado(usuario.id, pin) };
    }
    // Ativo: acompanha nome, função e frente do cadastro.
    if (usuario.name !== dados.name || usuario.jobTitle !== dados.jobTitle || usuario.serviceFrontId !== dados.serviceFrontId) {
      await tx.update(users).set({ ...dados, updatedAt: agora }).where(eq(users.id, usuario.id));
      if (usuario.serviceFrontId !== dados.serviceFrontId) await definirFrente(tx, usuario.id, funcionario.serviceFrontId, agora);
      await auditar(tx, actorId, usuario.id, "ACESSO DE OPERADOR ATUALIZADO", { employeeId, ...dados });
      return { acao: "ATUALIZADO", mensagem: null };
    }
    return { acao: "NENHUMA", mensagem: null };
  });
}

// Todos os funcionários de uma função (ao marcar/desmarcar "Opera equipamento").
export async function sincronizarFuncao(db: Db, funcao: string, actorId: number) {
  const lista = await db.select({ id: employees.id }).from(employees).where(eq(employees.jobTitle, normalizarFuncao(funcao)));
  const resultado = { desativados: 0, pendentes: 0 };
  for (const item of lista) {
    const r = await sincronizarAcessoOperador(db, item.id, actorId, { criar: false });
    if (r.acao === "DESATIVADO") resultado.desativados++;
    if (r.acao === "PENDENTE") resultado.pendentes++;
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Lista (Usuários > Operadores), bloqueio e redefinição de PIN
// ---------------------------------------------------------------------------
export async function falhasRecentes(db: Conn, userIds: number[]) {
  const mapa = new Map<number, number>();
  if (!userIds.length) return mapa;
  const desde = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  const rows = await db.select({ userId: fieldLoginAttempts.userId, total: sql<number>`count(*)::int` }).from(fieldLoginAttempts)
    .innerJoin(users, eq(users.id, fieldLoginAttempts.userId))
    .where(and(inArray(fieldLoginAttempts.userId, userIds), eq(fieldLoginAttempts.success, false), gte(fieldLoginAttempts.attemptedAt, desde),
      or(isNull(users.accessCodeChangedAt), sql`${fieldLoginAttempts.attemptedAt} > ${users.accessCodeChangedAt}`)))
    .groupBy(fieldLoginAttempts.userId);
  for (const row of rows) mapa.set(row.userId!, Number(row.total));
  return mapa;
}

const enxerga = (actor: SessionUser) => frentesVisiveis(actor);

export async function listarOperadores(db: Db, actor: SessionUser) {
  const frentes = enxerga(actor);
  const rows = await db.select({
    id: users.id, name: users.name, jobTitle: users.jobTitle, status: users.status, lastAccessAt: users.lastAccessAt, serviceFrontId: users.serviceFrontId, front: serviceFronts.name,
    employeeId: users.employeeId, registration: employees.registration, employeeStatus: employees.status, createdAt: users.createdAt,
  }).from(users).leftJoin(serviceFronts, eq(serviceFronts.id, users.serviceFrontId)).leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(users.role, "CAMPO"), frentes === "ALL" ? undefined : frentes.length ? inArray(users.serviceFrontId, frentes) : sql`false`)).orderBy(asc(users.name));
  const falhas = await falhasRecentes(db, rows.map((row) => row.id));
  const operadores = rows.map((row) => {
    const status: StatusAcesso = row.status !== "ACTIVE" ? "DESATIVADO" : (falhas.get(row.id) ?? 0) >= MAX_FAILS_PER_OPERATOR ? "BLOQUEADO" : "ATIVO";
    return { ...row, statusAcesso: status, falhas: falhas.get(row.id) ?? 0 };
  });
  const previa = await previaCriacaoEmMassa(db, actor);
  return { operadores, pendentes: previa.total, podeGerenciar: true };
}

async function operadorVisivel(db: Db, actor: SessionUser, userId: number) {
  const row = (await db.select().from(users).where(and(eq(users.id, userId), eq(users.role, "CAMPO"))).limit(1))[0];
  const frentes = enxerga(actor);
  if (!row || (frentes !== "ALL" && (!row.serviceFrontId || !frentes.includes(row.serviceFrontId)))) throw new OperadorError("Operador não encontrado.", 404);
  return row;
}

export async function redefinirPin(db: Db, actor: SessionUser, userId: number): Promise<AcessoGerado> {
  const usuario = await operadorVisivel(db, actor, userId);
  if (usuario.status !== "ACTIVE") throw new OperadorError("Acesso desativado: reative o funcionário (ou a função) para gerar um PIN novo.", 409);
  const funcionario = usuario.employeeId ? await carregarFuncionario(db, usuario.employeeId) : null;
  const pin = novoPin(funcionario?.birthDate?.slice(0, 4));
  const agora = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ accessCodeHash: await hashAccessCode(pin), accessCodeChangedAt: agora, updatedAt: agora }).where(eq(users.id, usuario.id));
    // O PIN antigo deixa de valer na hora (sessões abertas caem) e o bloqueio por tentativas zera.
    await tx.delete(userSessions).where(eq(userSessions.userId, usuario.id));
    await auditar(tx, actor.id, usuario.id, "PIN DE OPERADOR REDEFINIDO");
  });
  const frente = usuario.serviceFrontId ? (await db.select({ name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.id, usuario.serviceFrontId)).limit(1))[0]?.name : null;
  return { userId: usuario.id, employeeId: usuario.employeeId ?? 0, nome: usuario.name, matricula: funcionario?.registration ?? null, funcao: usuario.jobTitle ?? "—", frente: frente ?? "—", pin };
}

// ---------------------------------------------------------------------------
// Criação em massa: prévia (sem gravar) e criação com o PDF dos PINs.
// ---------------------------------------------------------------------------
export type LinhaPrevia = { employeeId: number; nome: string; matricula: string | null; funcao: string; frente: string; situacao: string; acao: "CRIAR" | "REATIVAR" | "VINCULAR"; userId?: number };

export async function previaCriacaoEmMassa(db: Db, actor: SessionUser) {
  const frentes = enxerga(actor);
  const operam = (await db.select({ name: jobFunctions.name }).from(jobFunctions).where(and(eq(jobFunctions.operatesEquipment, true), eq(jobFunctions.active, true)))).map((row) => row.name);
  const candidatos = operam.length ? await db.select({
    id: employees.id, name: employees.name, registration: employees.registration, jobTitle: employees.jobTitle, status: employees.status,
    serviceFrontId: employees.serviceFrontId, front: serviceFronts.name, frontActive: serviceFronts.active,
  }).from(employees).leftJoin(serviceFronts, eq(serviceFronts.id, employees.serviceFrontId))
    .where(and(inArray(employees.jobTitle, operam), sql`${employees.status} <> 'DEMITIDO'`, frentes === "ALL" ? undefined : frentes.length ? inArray(employees.serviceFrontId, frentes) : sql`false`))
    .orderBy(asc(serviceFronts.name), asc(employees.name)) : [];
  const vinculados = candidatos.length ? await db.select({ id: users.id, employeeId: users.employeeId, status: users.status }).from(users).where(inArray(users.employeeId, candidatos.map((row) => row.id))) : [];
  // Acesso de campo antigo (sem vínculo) com o mesmo nome: vincula e mantém o código atual.
  const soltos = await db.select({ id: users.id, name: users.name, status: users.status }).from(users).where(and(eq(users.role, "CAMPO"), isNull(users.employeeId)));
  const chave = (nome: string) => nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const linhas: LinhaPrevia[] = [];
  const foraPorDados: Array<{ nome: string; funcao: string; motivo: string }> = [];
  for (const row of candidatos) {
    const base = { employeeId: row.id, nome: row.name, matricula: row.registration, funcao: row.jobTitle, frente: row.front ?? "—", situacao: row.status };
    if (!row.serviceFrontId || !row.front) { foraPorDados.push({ nome: row.name, funcao: row.jobTitle, motivo: "sem frente" }); continue; }
    if (!row.frontActive) { foraPorDados.push({ nome: row.name, funcao: row.jobTitle, motivo: `frente ${row.front} inativa` }); continue; }
    if (row.name.trim().split(/\s+/).length < 2) { foraPorDados.push({ nome: row.name, funcao: row.jobTitle, motivo: "nome incompleto (precisa nome e sobrenome)" }); continue; }
    const vinculado = vinculados.find((user) => user.employeeId === row.id);
    if (vinculado?.status === "ACTIVE") continue;
    if (vinculado) { linhas.push({ ...base, acao: "REATIVAR", userId: vinculado.id }); continue; }
    const iguais = soltos.filter((user) => chave(user.name) === chave(row.name));
    const homonimos = candidatos.filter((item) => chave(item.name) === chave(row.name)).length;
    if (iguais.length === 1 && homonimos === 1) { linhas.push({ ...base, acao: "VINCULAR", userId: iguais[0].id }); continue; }
    linhas.push({ ...base, acao: "CRIAR" });
  }
  const contar = (campo: "frente" | "funcao") => Object.entries(linhas.reduce<Record<string, number>>((acc, linha) => { acc[linha[campo]] = (acc[linha[campo]] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([nome, total]) => ({ nome, total }));
  return {
    total: linhas.length, criar: linhas.filter((linha) => linha.acao === "CRIAR").length, reativar: linhas.filter((linha) => linha.acao === "REATIVAR").length,
    vincular: linhas.filter((linha) => linha.acao === "VINCULAR").length, porFrente: contar("frente"), porFuncao: contar("funcao"), linhas, foraPorDados, funcoesQueOperam: operam,
  };
}

export async function criarAcessosEmMassa(db: Db, actor: SessionUser) {
  const previa = await previaCriacaoEmMassa(db, actor);
  const pins: OperatorAccessPdfRow[] = [];
  const resultado = { criados: 0, reativados: 0, vinculados: 0, falhas: [] as Array<{ nome: string; erro: string }> };
  for (const linha of previa.linhas) {
    try {
      if (linha.acao === "VINCULAR") {
        const agora = new Date().toISOString();
        const funcionario = await carregarFuncionario(db, linha.employeeId);
        await db.transaction(async (tx) => {
          await tx.update(users).set({ employeeId: linha.employeeId, name: funcionario!.name, jobTitle: funcionario!.jobTitle, serviceFrontId: funcionario!.serviceFrontId, updatedAt: agora }).where(and(eq(users.id, linha.userId!), isNull(users.employeeId)));
          await definirFrente(tx, linha.userId!, funcionario!.serviceFrontId, agora);
          await auditar(tx, actor.id, linha.userId!, "ACESSO DE CAMPO VINCULADO AO FUNCIONÁRIO", { employeeId: linha.employeeId });
        });
        // Acesso que estava desativado volta com PIN novo; o ativo mantém o código que já usa.
        const sync = await sincronizarAcessoOperador(db, linha.employeeId, actor.id);
        if (sync.acesso) pins.push(paraPdf(sync.acesso, "acesso antigo reativado com PIN novo"));
        resultado.vinculados++;
        continue;
      }
      const sync = await sincronizarAcessoOperador(db, linha.employeeId, actor.id);
      if (sync.acesso) {
        pins.push(paraPdf(sync.acesso, sync.acao === "REATIVADO" ? "acesso reativado" : undefined));
        if (sync.acao === "CRIADO") resultado.criados++; else resultado.reativados++;
      }
    } catch (error) {
      console.error("[operadores.massa]", error);
      resultado.falhas.push({ nome: linha.nome, erro: "não foi possível criar este acesso" });
    }
  }
  const gerado = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Fortaleza" }).format(new Date());
  const pdf = pins.length ? createOperatorAccessPdf({ title: "Acessos dos operadores", generatedAt: gerado, generatedBy: actor.name, rows: pins.sort((a, b) => a.front.localeCompare(b.front) || a.name.localeCompare(b.name)) }) : null;
  await db.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: "OPERADORES", action: "ACESSOS DE OPERADORES CRIADOS EM MASSA", newValue: JSON.stringify({ ...resultado, total: previa.total }), occurredAt: new Date().toISOString() });
  return { ...resultado, pdfBase64: pdf ? Buffer.from(pdf).toString("base64") : null, comPin: pins.length };
}

function paraPdf(acesso: AcessoGerado, note?: string): OperatorAccessPdfRow {
  return { name: acesso.nome, registration: acesso.matricula ?? "", jobTitle: acesso.funcao, front: acesso.frente, pin: acesso.pin, note };
}

export function pdfDeUmAcesso(acesso: AcessoGerado, geradoPor: string, titulo = "Acesso do operador") {
  const gerado = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Fortaleza" }).format(new Date());
  return Buffer.from(createOperatorAccessPdf({ title: titulo, generatedAt: gerado, generatedBy: geradoPor, rows: [paraPdf(acesso)] })).toString("base64");
}

// Para as rotas de Funcionários: sincroniza e devolve o que a tela mostra (PIN uma vez, com o PDF
// para imprimir) sem nunca derrubar o salvamento do funcionário por causa do acesso.
export async function sincronizarComAviso(db: Db, employeeId: number, actor: SessionUser, opcoes: { jobTitle?: string } = {}) {
  try {
    if (opcoes.jobTitle) await garantirFuncao(db, opcoes.jobTitle);
    const resultado = await sincronizarAcessoOperador(db, employeeId, actor.id);
    return {
      ...(resultado.acesso ? { acessoOperador: { ...resultado.acesso, pdfBase64: pdfDeUmAcesso(resultado.acesso, actor.name) } } : {}),
      ...(resultado.mensagem ? { avisoAcesso: resultado.mensagem } : {}),
    };
  } catch (error) {
    console.error("[operadores.sync]", error);
    return { avisoAcesso: "O funcionário foi salvo, mas o acesso de operador não foi atualizado. Confira em Usuários > Operadores." };
  }
}
