import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { auditLogs, serviceFronts, userServiceFronts, userSessions, users } from "../db/schema";
import { frentesVisiveis } from "./access";
import type { SessionUser } from "./auth";
import { ACCESS_CODE_PATTERN, hashAccessCode } from "./field-auth";

// Cadastro dos funcionários de campo (perfil CAMPO). Quem cadastra (daily.field_operators)
// só vê e cria funcionários nas frentes que enxerga. O código nunca é devolvido pela API.
export class FieldOperatorError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type FieldOperatorInput = { name: string; jobTitle: string; code: string | null; serviceFrontIds: number[]; active: boolean };

const clean = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

export function parseFieldOperatorInput(body: Record<string, unknown>, creating: boolean): FieldOperatorInput {
  const name = clean(body.name).toUpperCase();
  const jobTitle = clean(body.jobTitle);
  const code = clean(body.code);
  const serviceFrontIds = Array.isArray(body.serviceFrontIds) ? [...new Set(body.serviceFrontIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : [];
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

export async function listFieldOperators(actor: SessionUser) {
  const db = await getDb();
  const rows = await db.select({ id: users.id, name: users.name, jobTitle: users.jobTitle, status: users.status, serviceFrontId: users.serviceFrontId, lastAccessAt: users.lastAccessAt })
    .from(users).where(eq(users.role, "CAMPO")).orderBy(asc(users.name));
  const links = rows.length ? await db.select().from(userServiceFronts).where(inArray(userServiceFronts.userId, rows.map((row) => row.id))) : [];
  const fronts = frentesVisiveis(actor);
  return rows.map((row) => {
    const frontIds = [...new Set([row.serviceFrontId, ...links.filter((link) => link.userId === row.id).map((link) => link.serviceFrontId)].filter((id): id is number => id !== null))];
    return { id: row.id, name: row.name, jobTitle: row.jobTitle, active: row.status === "ACTIVE", serviceFrontIds: frontIds, lastAccessAt: row.lastAccessAt };
  }).filter((row) => fronts === "ALL" || row.serviceFrontIds.some((id) => fronts.includes(id)));
}

async function validateFrontsExist(frontIds: number[]) {
  const db = await getDb();
  const rows = await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(inArray(serviceFronts.id, frontIds), eq(serviceFronts.active, true)));
  if (rows.length !== frontIds.length) throw new FieldOperatorError("Uma das frentes não existe ou está inativa.");
}

export async function createFieldOperator(actor: SessionUser, input: FieldOperatorInput) {
  assertFronts(actor, input.serviceFrontIds);
  await validateFrontsExist(input.serviceFrontIds);
  const db = await getDb();
  const now = new Date().toISOString();
  const id = await db.transaction(async (tx) => {
    // E-mail/usuário técnicos (as colunas são obrigatórias/únicas); não servem para login por senha.
    const tag = randomUUID();
    const [row] = await tx.insert(users).values({
      name: input.name, jobTitle: input.jobTitle, email: `campo-${tag}@campo.local`, username: `campo-${tag}`, role: "CAMPO",
      status: input.active ? "ACTIVE" : "INACTIVE", serviceFrontId: input.serviceFrontIds[0], accessCodeHash: await hashAccessCode(input.code!),
      createdAt: now, updatedAt: now,
    }).returning({ id: users.id });
    await tx.insert(userServiceFronts).values(input.serviceFrontIds.map((serviceFrontId) => ({ userId: row.id, serviceFrontId, createdAt: now, updatedAt: now })));
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(row.id), action: "FUNCIONÁRIO DE CAMPO CRIADO",
      newValue: JSON.stringify({ name: input.name, jobTitle: input.jobTitle, serviceFrontIds: input.serviceFrontIds, active: input.active }), occurredAt: now });
    return row.id;
  });
  return id;
}

export async function updateFieldOperator(actor: SessionUser, id: number, input: FieldOperatorInput) {
  const current = (await listFieldOperators(actor)).find((row) => row.id === id);
  if (!current) throw new FieldOperatorError("Funcionário não encontrado.", 404);
  assertFronts(actor, input.serviceFrontIds);
  await validateFrontsExist(input.serviceFrontIds);
  const db = await getDb();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(users).set({
      name: input.name, jobTitle: input.jobTitle, status: input.active ? "ACTIVE" : "INACTIVE", serviceFrontId: input.serviceFrontIds[0], updatedAt: now,
      ...(input.code ? { accessCodeHash: await hashAccessCode(input.code) } : {}),
    }).where(and(eq(users.id, id), eq(users.role, "CAMPO")));
    // Inativar ou trocar o código derruba na hora quem estiver logado com o acesso antigo.
    if (!input.active || input.code) await tx.delete(userSessions).where(eq(userSessions.userId, id));
    await tx.delete(userServiceFronts).where(eq(userServiceFronts.userId, id));
    await tx.insert(userServiceFronts).values(input.serviceFrontIds.map((serviceFrontId) => ({ userId: id, serviceFrontId, createdAt: now, updatedAt: now })));
    await tx.insert(auditLogs).values({ userId: actor.id, entityType: "USER", entityId: String(id), action: "FUNCIONÁRIO DE CAMPO ALTERADO",
      previousValue: JSON.stringify(current), occurredAt: now,
      newValue: JSON.stringify({ name: input.name, jobTitle: input.jobTitle, serviceFrontIds: input.serviceFrontIds, active: input.active, codeChanged: Boolean(input.code) }) });
  });
}
