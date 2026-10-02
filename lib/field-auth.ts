import { and, asc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { employees, fieldLoginAttempts, serviceFronts, users } from "../db/schema";
import { newSalt, passwordHash, verifyPassword } from "./auth";

// ---------------------------------------------------------------------------
// Acesso de campo (perfil CAMPO): funcionário escolhe o nome e digita o código numérico.
// AVISO DE SEGURANÇA: não há senha — quem souber nome + código entra no lugar do colega. É
// aceitável por ser operação interna de campo, com estas contrapartidas:
//  - o código é guardado só em hash (salt:hash) e nunca volta para a tela nem para log;
//  - bloqueio após MAX_FAILS_PER_OPERATOR erros por funcionário e MAX_FAILS_PER_IP por
//    aparelho/IP dentro de LOCK_MINUTES (impede testar os códigos um por um);
//  - sessão curta (FIELD_SESSION_SECONDS em lib/auth.ts) e acesso restrito ao Controle Diário
//    no backend (authorize em lib/auth.ts);
//  - todo registro guarda o usuário que lançou; ADMIN/GESTOR troca o código ou inativa a qualquer momento.
// ---------------------------------------------------------------------------
export const ACCESS_CODE_PATTERN = /^\d{4,8}$/;
export const MAX_FAILS_PER_OPERATOR = 5;
export const MAX_FAILS_PER_IP = 20;
export const LOCK_MINUTES = 15;

export class FieldAuthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function hashAccessCode(code: string) {
  const salt = newSalt();
  return `${salt}:${await passwordHash(code, salt)}`;
}

async function codeMatches(code: string, stored: string | null) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  return verifyPassword(code, salt, hash);
}

// IP de quem fez a requisição. O proxy da Hostinger ACRESCENTA o IP real no fim do
// X-Forwarded-For; o começo da lista pode ter sido escrito pelo próprio cliente (e seria fácil
// trocar a cada tentativa para fugir do bloqueio por aparelho), por isso vale o último item.
export function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean).pop();
  return (forwarded || request.headers.get("x-real-ip") || "desconhecido").slice(0, 64);
}

function normalized(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Busca por nome (mínimo 2 letras) ou matrícula (só números, exata), no máximo 8 resultados —
// devolve só id e nome, nunca código.
export async function searchFieldOperators(query: string) {
  const term = query.trim();
  if (term.length < 2) return [];
  const db = await getDb();
  // Filtra em memória (sem acento/maiúsculas): "joao" acha "JOÃO". São poucos nomes por empresa.
  const rows = await db.select({ id: users.id, name: users.name, registration: employees.registration }).from(users)
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(users.role, "CAMPO"), eq(users.status, "ACTIVE"))).orderBy(asc(users.name));
  if (/^\d+$/.test(term)) {
    const digits = term.replace(/^0+(?=\d)/, "");
    return rows.filter((row) => row.registration && row.registration.replace(/\D/g, "").replace(/^0+(?=\d)/, "") === digits).slice(0, 8).map(({ id, name }) => ({ id, name }));
  }
  const key = normalized(term);
  const words = key.split(" ");
  return rows.filter((row) => { const name = normalized(row.name); return words.every((word) => name.includes(word)); }).slice(0, 8).map(({ id, name }) => ({ id, name }));
}

export async function recentFails(filter: { userId?: number; ip?: string }) {
  const db = await getDb();
  const since = new Date(Date.now() - LOCK_MINUTES * 60_000).toISOString();
  // Por pessoa: só contam os erros depois da última troca de código/PIN (redefinir desbloqueia).
  const rows = filter.userId !== undefined
    ? await db.select({ id: fieldLoginAttempts.id }).from(fieldLoginAttempts).innerJoin(users, eq(users.id, fieldLoginAttempts.userId)).where(and(
      eq(fieldLoginAttempts.success, false), gte(fieldLoginAttempts.attemptedAt, since), eq(fieldLoginAttempts.userId, filter.userId),
      or(isNull(users.accessCodeChangedAt), sql`${fieldLoginAttempts.attemptedAt} > ${users.accessCodeChangedAt}`),
    ))
    : await db.select({ id: fieldLoginAttempts.id }).from(fieldLoginAttempts).where(and(
      eq(fieldLoginAttempts.success, false), gte(fieldLoginAttempts.attemptedAt, since), eq(fieldLoginAttempts.ip, filter.ip!),
    ));
  return rows.length;
}

// Login com senha (tela principal) usa a mesma tabela de tentativas e a mesma janela de bloqueio.
export const MAX_PASSWORD_FAILS_PER_USER = 5;

export async function assertPasswordLoginAllowed(request: Request, userId: number | null) {
  if (await recentFails({ ip: clientIp(request) }) >= MAX_FAILS_PER_IP) throw new FieldAuthError(`Muitas tentativas neste aparelho. Aguarde ${LOCK_MINUTES} minutos e tente de novo.`, 429);
  if (userId !== null && await recentFails({ userId }) >= MAX_PASSWORD_FAILS_PER_USER) throw new FieldAuthError(`Acesso bloqueado por ${LOCK_MINUTES} minutos após várias senhas erradas. Aguarde ou peça ao administrador para trocar a senha.`, 429);
}

export async function recordLoginAttempt(request: Request, userId: number | null, success: boolean) {
  const db = await getDb();
  await db.insert(fieldLoginAttempts).values({ userId, ip: clientIp(request), success, attemptedAt: new Date().toISOString() });
}

// Confere nome (id escolhido na busca) + código. Toda tentativa é registrada; erro não diz se
// o problema foi o nome ou o código.
export async function verifyFieldOperator(request: Request, operatorId: number, code: string) {
  const ip = clientIp(request);
  if (!Number.isInteger(operatorId) || operatorId <= 0) throw new FieldAuthError("Selecione o seu nome na lista.");
  if (await recentFails({ ip }) >= MAX_FAILS_PER_IP) throw new FieldAuthError(`Muitas tentativas neste aparelho. Aguarde ${LOCK_MINUTES} minutos ou procure o encarregado.`, 429);
  if (await recentFails({ userId: operatorId }) >= MAX_FAILS_PER_OPERATOR) throw new FieldAuthError(`Acesso bloqueado por ${LOCK_MINUTES} minutos após várias tentativas erradas. Procure o encarregado se esqueceu o PIN.`, 429);
  const db = await getDb();
  const row = (await db.select({ id: users.id, name: users.name, role: users.role, status: users.status, jobTitle: users.jobTitle, accessCodeHash: users.accessCodeHash, front: serviceFronts.name })
    .from(users).leftJoin(serviceFronts, eq(serviceFronts.id, users.serviceFrontId)).where(eq(users.id, operatorId)).limit(1))[0];
  const valid = Boolean(row && row.role === "CAMPO" && row.status === "ACTIVE" && ACCESS_CODE_PATTERN.test(code) && await codeMatches(code, row.accessCodeHash));
  await db.insert(fieldLoginAttempts).values({ userId: row ? row.id : null, ip, success: valid, attemptedAt: new Date().toISOString() });
  if (!valid || !row) {
    // Ao chegar no limite, avisa já nesta tentativa que o acesso ficou bloqueado.
    if (row && await recentFails({ userId: row.id }) >= MAX_FAILS_PER_OPERATOR) throw new FieldAuthError(`PIN incorreto. Acesso bloqueado por ${LOCK_MINUTES} minutos após ${MAX_FAILS_PER_OPERATOR} tentativas erradas. Procure o encarregado se esqueceu o PIN.`, 429);
    throw new FieldAuthError("Nome ou PIN incorretos.", 401);
  }
  return { id: row.id, name: row.name, jobTitle: row.jobTitle, front: row.front };
}
