// Regras da sessão de login (lib/session-rules.ts): validade deslizante e a decisão do celular de
// só ir para a tela de login quando o servidor disser que a sessão acabou.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RENEW_AFTER_SECONDS, SESSION_COOKIE_SECONDS, SESSION_WINDOW_SECONDS, classifySessionCheck, sessionEndReason, sessionExpiry, sessionKindFor, slidingRenewal,
} from "../lib/session-rules.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-07T12:00:00.000Z");
const ago = (ms) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms) => new Date(now.getTime() + ms).toISOString();

test("tipo e prazo: campo e 'Manter conectado' 30 dias; sem marcar, 12 h sem uso; cookie persistente", () => {
  assert.equal(sessionKindFor("CAMPO", false), "FIELD");
  assert.equal(sessionKindFor("CAMPO", true), "FIELD");
  assert.equal(sessionKindFor("GESTOR", true), "REMEMBER");
  assert.equal(sessionKindFor("ADMIN", false), "SHORT");
  assert.equal(SESSION_WINDOW_SECONDS.FIELD, 30 * 86400);
  assert.equal(SESSION_WINDOW_SECONDS.REMEMBER, 30 * 86400);
  assert.equal(SESSION_WINDOW_SECONDS.SHORT, 12 * 3600);
  assert.equal(SESSION_COOKIE_SECONDS, 30 * 86400);
  assert.equal(sessionExpiry("FIELD", now), ahead(30 * DAY));
  assert.equal(sessionExpiry("SHORT", now), ahead(12 * HOUR));
});

test("sessão deslizante: cada uso empurra a validade (no máximo uma gravação a cada 15 min)", () => {
  // Campo usado ontem: renova para mais 30 dias a partir de agora.
  assert.deepEqual(slidingRenewal({ kind: "FIELD", lastSeenAt: ago(20 * HOUR), expiresAt: ahead(29 * DAY) }, "CAMPO", now), { kind: "FIELD", expiresAt: ahead(30 * DAY) });
  // Usado há 5 min: não grava de novo.
  assert.equal(slidingRenewal({ kind: "FIELD", lastSeenAt: ago(5 * 60_000), expiresAt: ahead(30 * DAY) }, "CAMPO", now), null);
  assert.ok(RENEW_AFTER_SECONDS <= 15 * 60);
  // Sem "Manter conectado": 11 h parado ainda vale e renova para mais 12 h.
  assert.deepEqual(slidingRenewal({ kind: "SHORT", lastSeenAt: ago(11 * HOUR), expiresAt: ahead(1 * HOUR) }, "GESTOR", now), { kind: "SHORT", expiresAt: ahead(12 * HOUR) });
  // Sessão antiga (antes da regra): a de campo passa a deslizar; a administrativa fica como estava.
  assert.deepEqual(slidingRenewal({ kind: null, lastSeenAt: ago(HOUR), expiresAt: ahead(5 * HOUR) }, "CAMPO", now), { kind: "FIELD", expiresAt: ahead(30 * DAY) });
  assert.equal(slidingRenewal({ kind: null, lastSeenAt: ago(HOUR), expiresAt: ahead(5 * DAY) }, "ADMIN", now), null);
  // Nunca encurta uma validade maior.
  assert.equal(slidingRenewal({ kind: "SHORT", lastSeenAt: ago(HOUR), expiresAt: ahead(3 * DAY) }, "ADMIN", now).expiresAt, ahead(3 * DAY));
});

test("motivo do fim da sessão (para o log)", () => {
  assert.equal(sessionEndReason(null, now), "INVALIDA");
  assert.equal(sessionEndReason({ revokedAt: ago(HOUR), revokeReason: "PIN_TROCADO", expiresAt: ahead(DAY), userActive: true }, now), "REVOGADA:PIN_TROCADO");
  assert.equal(sessionEndReason({ revokedAt: null, revokeReason: null, expiresAt: ago(1000), userActive: true }, now), "EXPIROU");
  assert.equal(sessionEndReason({ revokedAt: null, revokeReason: null, expiresAt: ahead(DAY), userActive: false }, now), "INATIVADO");
  assert.equal(sessionEndReason({ revokedAt: null, revokeReason: null, expiresAt: ahead(DAY), userActive: true }, now), null);
});

test("celular: falta de internet ou servidor fora NUNCA vira 'deslogado'", () => {
  assert.equal(classifySessionCheck(null, null), "UNKNOWN", "sem sinal / tempo esgotado");
  assert.equal(classifySessionCheck({ status: 503, offline: true }, { error: "Sem conexão" }), "UNKNOWN", "resposta do modo offline do service worker");
  assert.equal(classifySessionCheck({ status: 503 }, { error: "Não foi possível validar a sessão agora." }), "UNKNOWN", "banco fora");
  assert.equal(classifySessionCheck({ status: 502 }, null), "UNKNOWN", "proxy da Hostinger reiniciando");
  assert.equal(classifySessionCheck({ status: 200 }, null), "UNKNOWN", "resposta cortada");
  assert.equal(classifySessionCheck({ status: 200 }, { user: { id: 7, name: "Ana" } }), "LOGGED_IN");
  assert.equal(classifySessionCheck({ status: 200 }, { user: null }), "LOGGED_OUT", "o servidor disse que a sessão não vale");
  assert.equal(classifySessionCheck({ status: 401 }, { error: "Sessão não autenticada." }), "LOGGED_OUT");
});
