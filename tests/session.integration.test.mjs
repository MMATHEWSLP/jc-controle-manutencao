// Sessão de login num Postgres de teste já migrado (inclui a migração 0053).
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:sessao-banco
// Cobre: cookie persistente (Max-Age, Secure, HttpOnly, SameSite=Lax); campo 30 dias e "Manter
// conectado" 30 dias renovando a cada uso; sem marcar, cai depois de 12 h sem uso; fim da sessão só
// por Sair, PIN/senha trocados, acesso inativado ou validade vencida — cada um registrado no log.
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { auditLogs, serviceFronts, userSessions, users } from "../db/schema.ts";
import { authorize, createSession, destroySession, readSession, revokeUserSessions, SESSION_COOKIE } from "../lib/auth.ts";
import { hashAccessCode } from "../lib/field-auth.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) { process.env.DATABASE_URL = testUrl; process.env.INITIAL_ADMIN_PASSWORD ||= "senha-de-teste-123"; }

const HOUR = 3_600_000, DAY = 24 * HOUR;
const request = (token, path = "/api/auth/session", headers = {}) => new Request(`https://www.jcsistema.online${path}`, { headers: { ...(token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}), "user-agent": "Teste iPhone", "x-jc-display": "app", ...headers } });
const cookieToken = (header) => decodeURIComponent(/maintenance_session=([^;]*)/.exec(header ?? "")?.[1] ?? "");
const near = (iso, ms) => Math.abs(Date.parse(iso) - (Date.now() + ms)) < 60_000;

test("sessão: persistente, deslizante, fim só por motivo explícito e registrado no log", { skip: !enabled }, async () => {
  const db = await getDb();
  const s = Date.now().toString(36).toUpperCase();
  const [front] = await db.insert(serviceFronts).values({ name: `FRENTE SESSAO ${s}` }).returning();
  const [field] = await db.insert(users).values({ email: `campo-${s}@campo.local`, username: `campo-${s}`, name: `OPERADOR ${s}`, role: "CAMPO", serviceFrontId: front.id, accessCodeHash: await hashAccessCode("4826") }).returning();
  const [manager] = await db.insert(users).values({ email: `gestor-${s}@teste.local`, username: `gestor-${s}`, name: `GESTOR ${s}`, role: "GESTOR", serviceFrontId: front.id }).returning();
  const rowFor = async (userId) => (await db.select().from(userSessions).where(eq(userSessions.userId, userId))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const endLogs = async (userId) => (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "SESSAO_ENCERRADA"), eq(auditLogs.entityId, String(userId))))).map((row) => JSON.parse(row.newValue).motivo);

  // 1. Login de campo pela rota real: cookie persistente de 30 dias, Secure, HttpOnly, SameSite=Lax.
  const { POST: fieldLogin } = await import("../app/api/auth/field/login/route.ts");
  const login = await fieldLogin(new Request("https://www.jcsistema.online/api/auth/field/login", { method: "POST", headers: { "content-type": "application/json", origin: "https://www.jcsistema.online" }, body: JSON.stringify({ operatorId: field.id, code: "4826" }) }));
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  for (const part of ["Max-Age=2592000", "Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) assert.ok(setCookie.includes(part), `${part} em ${setCookie}`);
  assert.ok(!/Domain=/i.test(setCookie), "cookie só do domínio oficial (o sem www redireciona)");
  const fieldToken = cookieToken(setCookie);
  let row = await rowFor(field.id);
  assert.equal(row.kind, "FIELD"); assert.ok(near(row.expiresAt, 30 * DAY));

  // 2. Reabrir o app (checagem da sessão): reenvia o cookie e confirma o usuário.
  const { GET: sessionCheck } = await import("../app/api/auth/session/route.ts");
  let response = await sessionCheck(request(fieldToken));
  assert.equal((await response.json()).user.id, field.id);
  assert.ok(response.headers.get("set-cookie").includes("Max-Age=2592000"));

  // 3. Várias horas sem usar (20 h): continua valendo e renova para mais 30 dias.
  await db.update(userSessions).set({ lastSeenAt: new Date(Date.now() - 20 * HOUR).toISOString(), expiresAt: new Date(Date.now() + 29 * DAY).toISOString() }).where(eq(userSessions.id, row.id));
  assert.equal((await readSession(request(fieldToken))).user.id, field.id);
  row = await rowFor(field.id);
  assert.ok(near(row.expiresAt, 30 * DAY), "renovada");

  // 4. Sessão aberta antes da regra (sem tipo, validade de 12 h): o campo passa a deslizar 30 dias.
  const legacyToken = await createSession(field.id, "FIELD");
  await db.update(userSessions).set({ kind: null, expiresAt: new Date(Date.now() + 2 * HOUR).toISOString() }).where(eq(userSessions.id, (await rowFor(field.id)).id));
  assert.ok((await readSession(request(legacyToken))).user);
  assert.equal((await rowFor(field.id)).kind, "FIELD");

  // 5. Sem "Manter conectado": 11 h parado ainda vale; 13 h parado expira (registrado como EXPIROU, uma vez só).
  const shortToken = await createSession(manager.id, "SHORT");
  let short = await rowFor(manager.id);
  assert.ok(near(short.expiresAt, 12 * HOUR));
  await db.update(userSessions).set({ lastSeenAt: new Date(Date.now() - 11 * HOUR).toISOString(), expiresAt: new Date(Date.now() + 1 * HOUR).toISOString() }).where(eq(userSessions.id, short.id));
  assert.ok((await readSession(request(shortToken))).user, "11 h sem uso ainda vale");
  short = await rowFor(manager.id);
  assert.ok(near(short.expiresAt, 12 * HOUR), "e renova");
  await db.update(userSessions).set({ lastSeenAt: new Date(Date.now() - 13 * HOUR).toISOString(), expiresAt: new Date(Date.now() - 1 * HOUR).toISOString() }).where(eq(userSessions.id, short.id));
  const expired = await authorize(request(shortToken, "/api/fuel"));
  assert.equal(expired.response.status, 401);
  assert.ok(expired.response.headers.get("set-cookie").includes("Max-Age=0"), "o 401 apaga o cookie");
  await authorize(request(shortToken, "/api/fuel"));
  assert.deepEqual(await endLogs(manager.id), ["EXPIROU"], "registra uma vez só");
  response = await sessionCheck(request(shortToken));
  assert.deepEqual(await response.json(), { user: null }, "só esta resposta leva o app ao login");
  assert.ok(response.headers.get("set-cookie").includes("Max-Age=0"));

  // 6. "Manter conectado": 30 dias.
  const rememberToken = await createSession(manager.id, "REMEMBER");
  assert.ok(near((await db.select().from(userSessions).where(eq(userSessions.userId, manager.id))).find((item) => item.kind === "REMEMBER").expiresAt, 30 * DAY));
  // Sair: encerra na hora (motivo LOGOUT, já registrado — sem outra linha no log).
  await destroySession(request(rememberToken));
  assert.equal((await readSession(request(rememberToken))).ended, "REVOGADA:LOGOUT");
  assert.deepEqual(await endLogs(manager.id), ["EXPIROU"]);

  // 7. PIN trocado pelo administrador: cai na hora com o motivo no log.
  await revokeUserSessions(db, field.id, "PIN_TROCADO");
  const revoked = await readSession(request(fieldToken));
  assert.equal(revoked.user, null); assert.equal(revoked.ended, "REVOGADA:PIN_TROCADO");
  const log = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "SESSAO_ENCERRADA"), eq(auditLogs.entityId, String(field.id)))))[0];
  const detail = JSON.parse(log.newValue);
  assert.deepEqual([detail.motivo, detail.tipo, detail.modo, detail.aparelho], ["REVOGADA:PIN_TROCADO", "FIELD", "app", "Teste iPhone"]);

  // 8. Acesso inativado com sessão aberta: INATIVADO. Cookie desconhecido: INVALIDA.
  const inactiveToken = await createSession(manager.id, "REMEMBER");
  await db.update(users).set({ status: "INACTIVE" }).where(eq(users.id, manager.id));
  assert.equal((await readSession(request(inactiveToken))).ended, "INATIVADO");
  assert.equal((await readSession(request("token-que-nao-existe"))).ended, "INVALIDA");
  assert.deepEqual((await endLogs(manager.id)).sort(), ["EXPIROU", "INATIVADO"]);
});
