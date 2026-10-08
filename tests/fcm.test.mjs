// Aviso no app Android pelo Firebase (lib/fcm.ts) contra um Google local: a conta de serviço vira um
// JWT RS256 trocado por token de acesso; o aviso vai só com dados (title, body, url, tag) e prioridade
// alta; token inexistente (UNREGISTERED) marca o aparelho como inválido.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { fcmAccount, sendFcm, useFcmEndpointsForTests } from "../lib/fcm.ts";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { type: "service_account", project_id: "jc-avisos", client_email: "avisos@jc-avisos.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };

test("conta de serviço: JSON, base64 e o \\n do private_key; inválida = desligado", () => {
  const raw = JSON.stringify(account);
  assert.equal(fcmAccount(raw).projectId, "jc-avisos");
  assert.equal(fcmAccount(Buffer.from(raw).toString("base64")).clientEmail, account.client_email);
  // Colado num campo de uma linha: as quebras do private_key viram "\n" literais.
  assert.match(fcmAccount(raw.replace(/\\n/g, "\\\\n")).privateKey, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.equal(fcmAccount(""), null);
  assert.equal(fcmAccount("{ não é json"), null);
  assert.equal(fcmAccount(JSON.stringify({ project_id: "x" })), null);
});

test("envio pelo Firebase: token de acesso, mensagem só com dados, token inválido", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ url: req.url, headers: req.headers, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/token") { res.end(JSON.stringify({ access_token: "ya29.teste", expires_in: 3600 })); return; }
      const message = JSON.parse(body).message;
      if (message.token === "token-velho") { res.statusCode = 404; res.end(JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } })); return; }
      res.end(JSON.stringify({ name: "projects/jc-avisos/messages/1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  useFcmEndpointsForTests({ token: `${base}/token`, fcm: base });
  const before = process.env.FIREBASE_SERVICE_ACCOUNT;
  try {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const off = await sendFcm("abc", { title: "t", body: "b", url: "https://www.jcsistema.online/", tag: null });
    assert.deepEqual(off, { ok: false, invalid: false, error: "FIREBASE_SERVICE_ACCOUNT não configurado na Hostinger" });

    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify(account);
    const ok = await sendFcm("token-bom", { title: "Abastecimento rejeitado", body: "CM-33 · 150 L", url: "https://www.jcsistema.online/?notificacao=7", tag: "convoy.pending:1" });
    assert.deepEqual(ok, { ok: true });
    const [tokenCall, sendCall] = calls;
    // JWT da conta de serviço, assinado com a chave privada (confere com a pública).
    const assertion = new URLSearchParams(tokenCall.body).get("assertion");
    assert.equal(new URLSearchParams(tokenCall.body).get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = assertion.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(claims, "base64url"));
    assert.deepEqual([payload.iss, payload.scope, payload.aud, payload.exp - payload.iat], [account.client_email, "https://www.googleapis.com/auth/firebase.messaging", `${base}/token`, 3600]);
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")), "assinatura RS256 válida");
    assert.equal(sendCall.url, "/v1/projects/jc-avisos/messages:send");
    assert.equal(sendCall.headers.authorization, "Bearer ya29.teste");
    assert.deepEqual(JSON.parse(sendCall.body), { message: { token: "token-bom", data: { title: "Abastecimento rejeitado", body: "CM-33 · 150 L", url: "https://www.jcsistema.online/?notificacao=7", tag: "convoy.pending:1" }, android: { priority: "HIGH", ttl: "86400s" } } });

    const gone = await sendFcm("token-velho", { title: "t", body: "b", url: "https://www.jcsistema.online/", tag: null });
    assert.equal(gone.ok, false);
    assert.equal(gone.invalid, true);
    assert.match(gone.error, /HTTP 404 UNREGISTERED/);
    assert.equal(calls.filter((call) => call.url === "/token").length, 1, "o token de acesso é reaproveitado");
  } finally {
    if (before === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = before;
    server.close();
  }
});
