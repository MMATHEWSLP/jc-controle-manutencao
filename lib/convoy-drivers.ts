import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, serviceFronts, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import { revokeUserSessions, type SessionUser } from "./auth";
import { ACCESS_CODE_PATTERN, hashAccessCode } from "./field-auth";
import {
  assertCodeNotObvious, convoyEquipmentOptions, createFromEmployees, createManual, fieldAccessCandidates, FieldOperatorError,
  listFieldOperators, parseManualInput, validateConvoyEquipment, type AcessoCriado,
} from "./field-operators";

// Motoristas do comboio (setor ABASTECIMENTOS → Motoristas do comboio). Usam o mesmo acesso de campo
// (perfil CAMPO, nome + PIN) do Controle Diário, mas o cadastro é feito aqui:
//  - convoyFuelRegister = true → entra no app e lança os abastecimentos do dia;
//  - fieldDailyAccess = false (padrão) → NÃO vê o Controle Diário; marque se ele também faz o do caminhão;
//  - convoyEquipmentId → comboio que ele dirige (vai junto em cada abastecimento).
// O PIN só volta na resposta do cadastro (ou da troca), para ser entregue pessoalmente uma vez.
// Quem cadastra precisa de daily.field_operators e só vê/cria nas frentes que enxerga.

type DriverOptions = { convoyEquipmentId: number | null; dailyAccess: boolean };

const optionalId = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new FieldOperatorError("Comboio inválido.");
  return id;
};

export function parseDriverOptions(body: Record<string, unknown>): DriverOptions {
  return { convoyEquipmentId: optionalId(body.convoyEquipmentId), dailyAccess: body.dailyAccess === true };
}

export async function listConvoyDrivers(actor: SessionUser) {
  const db = await getDb();
  const visible = frentesVisiveis(actor);
  const [operators, candidates, convoyOptions, fronts] = await Promise.all([
    listFieldOperators(actor), fieldAccessCandidates(actor), convoyEquipmentOptions(),
    db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(asc(serviceFronts.name)),
  ]);
  return {
    fronts: fronts.filter((front) => visible === "ALL" || visible.includes(front.id)),
    drivers: operators.filter((row) => row.convoyFuelRegister).map((row) => ({
      id: row.id, name: row.name, jobTitle: row.jobTitle, active: row.active, serviceFrontIds: row.serviceFrontIds, lastAccessAt: row.lastAccessAt,
      registration: row.registration, convoyEquipmentId: row.convoyEquipmentId, convoyPrefix: row.convoyPrefix, dailyAccess: row.fieldDailyAccess,
    })),
    // Já têm acesso de campo (Controle Diário): basta marcar como motorista, o PIN continua o mesmo.
    accesses: operators.filter((row) => !row.convoyFuelRegister && row.active).map((row) => ({ id: row.id, name: row.name, jobTitle: row.jobTitle, registration: row.registration })),
    // Funcionários do cadastro principal ainda sem acesso de campo.
    employees: candidates.candidatos.map((row) => ({ id: row.id, name: row.name, jobTitle: row.jobTitle, registration: row.registration, front: row.front, serviceFrontId: row.serviceFrontId })),
    convoyOptions,
  };
}

async function findOperator(actor: SessionUser, id: number) {
  const row = (await listFieldOperators(actor)).find((item) => item.id === id);
  if (!row) throw new FieldOperatorError("Funcionário de campo não encontrado.", 404);
  return row;
}

async function markAsDriver(actor: SessionUser, userId: number, options: DriverOptions, via: string, previous: Record<string, unknown> | null) {
  const db = await getDb();
  await validateConvoyEquipment(db, options.convoyEquipmentId);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ convoyFuelRegister: true, convoyEquipmentId: options.convoyEquipmentId, fieldDailyAccess: options.dailyAccess, updatedAt: now })
      .where(and(eq(users.id, userId), eq(users.role, "CAMPO")));
    // Sem derrubar a sessão: as permissões são recalculadas a cada requisição (lib/auth.ts) e o app
    // confere a sessão ao voltar para a tela, então o motorista já vê o setor certo sem entrar de novo.
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(userId), action: "MOTORISTA DO COMBOIO CADASTRADO",
      previousValue: previous ? JSON.stringify(previous) : null, newValue: JSON.stringify({ ...options, via }), occurredAt: now });
  });
}

// access: o acesso de campo criado agora (com o PIN, para entregar uma única vez); null quando a pessoa já tinha acesso.
export type DriverCreated = { userId: number; name: string; access: AcessoCriado | null };

// mode "access": acesso de campo que já existe; "employee": funcionário do cadastro (cria o acesso);
// "manual": quem não está no cadastro (mesmas regras do cadastro manual do Controle Diário).
export async function createConvoyDriver(actor: SessionUser, body: Record<string, unknown>): Promise<DriverCreated> {
  const options = parseDriverOptions(body);
  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : null;
  if (code && !ACCESS_CODE_PATTERN.test(code)) throw new FieldOperatorError("O PIN deve ter de 4 a 8 números.");
  assertCodeNotObvious(code);
  // Comboio conferido antes de criar o acesso (para não sobrar um acesso de campo pela metade).
  await validateConvoyEquipment(await getDb(), options.convoyEquipmentId);
  if (body.mode === "access") {
    const current = await findOperator(actor, Number(body.userId));
    if (current.convoyFuelRegister) throw new FieldOperatorError(`${current.name} já é motorista do comboio.`);
    if (!current.active) throw new FieldOperatorError(`${current.name} está com o acesso inativo.`);
    // Já fazia o Controle Diário: continua fazendo, a não ser que a pessoa desmarque.
    await markAsDriver(actor, current.id, { ...options, dailyAccess: body.dailyAccess === undefined ? true : options.dailyAccess }, "acesso de campo existente", { convoyFuelRegister: false });
    return { userId: current.id, name: current.name, access: null };
  }
  let created: AcessoCriado;
  if (body.mode === "employee") {
    [created] = await createFromEmployees(actor, [{ employeeId: Number(body.employeeId), extraFrontIds: [], code }]);
  } else if (body.mode === "manual") {
    created = await createManual(actor, { ...parseManualInput(body), code });
  } else throw new FieldOperatorError("Escolha de onde vem o motorista.");
  await markAsDriver(actor, created.userId, options, body.mode === "employee" ? "lista de funcionários" : "manual", null);
  return { userId: created.userId, name: created.name, access: created };
}

// Troca comboio, Controle Diário, ativo/inativo e PIN. Inativar ou trocar o PIN derruba a sessão.
export async function updateConvoyDriver(actor: SessionUser, id: number, body: Record<string, unknown>) {
  const current = await findOperator(actor, id);
  if (!current.convoyFuelRegister) throw new FieldOperatorError(`${current.name} não é motorista do comboio.`, 404);
  const options = parseDriverOptions(body);
  const active = body.active !== false;
  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : null;
  if (code && !ACCESS_CODE_PATTERN.test(code)) throw new FieldOperatorError("O PIN deve ter de 4 a 8 números.");
  assertCodeNotObvious(code);
  const db = await getDb();
  await validateConvoyEquipment(db, options.convoyEquipmentId);
  if (active && !current.active && current.employeeStatus === "DEMITIDO") throw new FieldOperatorError(`${current.name} está demitido no cadastro de Funcionários: o acesso fica inativo.`);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({
      convoyEquipmentId: options.convoyEquipmentId, fieldDailyAccess: options.dailyAccess, status: active ? "ACTIVE" : "INACTIVE", updatedAt: now,
      ...(code ? { accessCodeHash: await hashAccessCode(code), accessCodeChangedAt: now } : {}),
    }).where(and(eq(users.id, id), eq(users.role, "CAMPO")));
    // Só inativar ou trocar o PIN derruba a sessão (mudar comboio/Controle Diário não desloga).
    if (!active || code) await revokeUserSessions(tx, id, !active ? "INATIVADO" : "PIN_TROCADO");
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(id), action: "MOTORISTA DO COMBOIO ALTERADO",
      previousValue: JSON.stringify({ convoyEquipmentId: current.convoyEquipmentId, dailyAccess: current.fieldDailyAccess, active: current.active }),
      newValue: JSON.stringify({ ...options, active, codeChanged: Boolean(code) }), occurredAt: now });
  });
  return { name: current.name };
}

// Deixa de ser motorista: o acesso de campo continua, só com o Controle Diário.
export async function removeConvoyDriver(actor: SessionUser, id: number) {
  const current = await findOperator(actor, id);
  if (!current.convoyFuelRegister) throw new FieldOperatorError(`${current.name} não é motorista do comboio.`, 404);
  const db = await getDb();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ convoyFuelRegister: false, convoyEquipmentId: null, fieldDailyAccess: true, updatedAt: now }).where(and(eq(users.id, id), eq(users.role, "CAMPO")));
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(id), action: "MOTORISTA DO COMBOIO REMOVIDO",
      previousValue: JSON.stringify({ convoyEquipmentId: current.convoyEquipmentId, dailyAccess: current.fieldDailyAccess }), occurredAt: now });
  });
  return { name: current.name };
}
