// Integração (Postgres de teste já migrado) da central de notificações:
//  - comboio: "N abastecimentos aguardando aprovação" agrupado por frente para quem aprova, o total
//    acompanhando as aprovações; motorista avisado (com a mensagem do "Notificar"), silenciar e desligar;
//  - mudança de frente: pedido para quem aprova (frente atual ou pedida) e resposta para quem pediu;
//  - Tarefas: o aviso do módulo também cai no sino central, com a tarefa para abrir;
//  - rotina diária: trocas vencidas, estoque baixo e tarefas vencendo, só o que é novo;
//  - Web Push de verdade contra um serviço de push local (HTTPS): o aviso chega criptografado
//    (aes128gcm) e assinado (VAPID ES256), e a falha/aparelho desativado ficam no registro; o app
//    Android sem a conta de serviço do Firebase registra a falha com o motivo.
// Só roda com TEST_DATABASE_URL (nunca DATABASE_URL, que costuma ser a produção) e recusa o Supabase.
//   TEST_DATABASE_URL=postgres://localhost/jc_teste npm run test:notificacoes-banco
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { alerts, convoyFuelRecords, dailyRecords, equipment, equipmentMaintenanceTypes, maintenancePlans, maintenanceTypes, notificationDeliveries, notificationDevices, notificationDispatches, notifications, productFrontStock, productStockMovements, products, serviceFrontChangeRequests, serviceFronts, tasks, userServiceFronts, users } from "../db/schema.ts";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { rejectConvoyRecord, requestConvoyCorrection } from "../lib/convoy.ts";
import { notifyConvoyAction, notifyConvoyPending } from "../lib/convoy-notify.ts";
import { notifyFrontAnswer, notifyFrontRequest } from "../lib/daily-notify.ts";
import { reviewFrontRequest } from "../lib/front-requests.ts";
import { runDailyNotifications } from "../lib/notification-daily.ts";
import { defaultSetting } from "../lib/notification-events.ts";
import { dispatchDetail, dispatchLog, flushNotifications, listDevices, listNotifications, notify, registerDevice, saveEventSetting, setMuted, unreadCount } from "../lib/notifications.ts";
import { vapidKeys } from "../lib/push.ts";
import { notifyUser } from "../lib/task-notifications.ts";

const testUrl = process.env.TEST_DATABASE_URL ?? "";
if (/supabase\.(co|com)|pooler\./i.test(testUrl)) throw new Error("TEST_DATABASE_URL aponta para o Supabase: este teste grava dados e só pode rodar num banco de teste.");
const enabled = Boolean(testUrl);
if (enabled) process.env.DATABASE_URL = testUrl;
// O endereço do sistema entra no link do aviso; nos testes, o padrão de produção.
delete process.env.SITE_URL;

const s = Date.now().toString(36).toUpperCase().slice(-5);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza" }).format(new Date());
const session = (row, extra = {}) => ({ id: row.id, name: row.name, username: row.username ?? "", email: row.email, profile: row.role, taskRoleId: null, status: "ACTIVE", theme: "LIGHT", isPrimaryAdmin: false, lastAccessAt: null, createdAt: "", permissions: ALL_PERMISSIONS, serviceFrontId: row.serviceFrontId ?? null, serviceFrontName: null, allServiceFronts: true, serviceFrontIds: [], canExport: true, jobTitle: null, ...extra });

async function person(name, role, fronts = [], extra = {}) {
  const db = await getDb();
  const key = `${name.toLowerCase().replace(/\W+/g, "-")}-${s}`;
  const [row] = await db.insert(users).values({ email: `${key}@notif.local`, username: key, name: `${name} ${s}`, role, serviceFrontId: fronts[0] ?? null, ...extra }).returning();
  if (fronts.length) await db.insert(userServiceFronts).values(fronts.map((serviceFrontId) => ({ userId: row.id, serviceFrontId })));
  return row;
}
const mine = async (userId) => (await listNotifications(userId, 200));

test("comboio: aguardando aprovação agrupado por frente; motorista avisado, silenciar e desligar", { skip: !enabled }, async () => {
  const db = await getDb();
  const [frente, outra] = await db.insert(serviceFronts).values([{ name: `NT${s} FRENTE` }, { name: `NT${s} OUTRA` }]).returning();
  const [cm] = await db.insert(equipment).values({ code: `CM-N${s}`, prefix: `CM-N${s}`, type: "CAMINHÃO", brand: "M", model: "X", controlType: "KM", serviceFrontId: frente.id }).returning();
  const gestor = await person("Gestor frente", "GESTOR", [frente.id]);
  const gestorOutra = await person("Gestor outra", "GESTOR", [outra.id]);
  const motorista = await person("Motorista", "CAMPO", [frente.id], { convoyFuelRegister: true });
  const admin = await person("Admin", "ADMIN");
  const record = (n) => ({ clientUuid: crypto.randomUUID(), status: "PENDENTE", registeredBy: motorista.id, exitKind: "FROTA", equipmentId: cm.id, serviceFrontId: frente.id, operatorName: "Fulano", liters: 100 + n, recordedAt: `${today}T10:0${n}:00Z`, receivedAt: `${today}T10:0${n}:30Z`, recordDate: today });
  const [r1, r2] = await db.insert(convoyFuelRecords).values([record(1), record(2)]).returning();

  await notifyConvoyPending(r1.id);
  await notifyConvoyPending(r2.id);
  const pendentes = (await mine(gestor.id)).filter((item) => item.event === "convoy.pending");
  assert.equal(pendentes.length, 1, "um aviso só, agrupado");
  assert.equal(pendentes[0].title, `2 abastecimentos aguardando aprovação — ${frente.name}`);
  assert.equal(pendentes[0].count, 2);
  assert.deepEqual(pendentes[0].link, { secao: "Combustível", aba: "aprovacao" });
  assert.match(pendentes[0].body, new RegExp(`CM-N${s} · 102 L`));
  assert.equal((await mine(gestorOutra.id)).filter((item) => item.event === "convoy.pending").length, 0, "outra frente não recebe");
  assert.equal((await mine(motorista.id)).length, 0, "o próprio motorista não recebe o aviso de pendente");

  // Rejeitado com mensagem: o motorista recebe o motivo e a mensagem; o total de quem aprova cai para 1.
  await rejectConvoyRecord(session(admin), r1.id, "Foto do painel ilegível");
  await notifyConvoyAction(r1.id, "rejected", { actorId: admin.id, notify: true, message: "Me liga quando puder" });
  const [rejeitado] = await mine(motorista.id);
  assert.equal(rejeitado.title, "Abastecimento rejeitado");
  assert.match(rejeitado.body, /Motivo: Foto do painel ilegível/);
  assert.match(rejeitado.body, /Mensagem: Me liga quando puder/);
  assert.deepEqual(rejeitado.link, { secao: "Abastecimentos" });
  const [agora] = (await mine(gestor.id)).filter((item) => item.event === "convoy.pending");
  assert.equal(agora.title, `1 abastecimento aguardando aprovação — ${frente.name}`);
  assert.equal(agora.readAt, null);

  // Pedir correção sem "Notificar": nada para o motorista; não sobrou pendente = o aviso sai das não lidas.
  await requestConvoyCorrection(session(admin), r2.id, "Confira a leitura");
  await notifyConvoyAction(r2.id, "correction", { actorId: admin.id, notify: false, message: null });
  assert.equal((await mine(motorista.id)).length, 1);
  assert.notEqual((await mine(gestor.id)).find((item) => item.event === "convoy.pending").readAt, null);

  // Silenciado pela pessoa: não recebe. Evento desligado pelo ADMIN: ninguém recebe.
  await setMuted(motorista.id, "convoy.correction", true);
  await db.update(convoyFuelRecords).set({ status: "PENDENTE" }).where(eq(convoyFuelRecords.id, r2.id));
  await requestConvoyCorrection(session(admin), r2.id, "De novo");
  await notifyConvoyAction(r2.id, "correction", { actorId: admin.id, notify: true, message: null });
  assert.equal((await mine(motorista.id)).length, 1, "silenciado");
  await saveEventSetting({ ...defaultSetting("convoy.pending"), enabled: false }, admin.id);
  const [r3] = await db.insert(convoyFuelRecords).values(record(3)).returning();
  await notifyConvoyPending(r3.id);
  assert.equal((await mine(gestor.id)).filter((item) => item.event === "convoy.pending" && !item.readAt).length, 0, "evento desligado");
  await saveEventSetting(defaultSetting("convoy.pending"), admin.id);
  // Aprovações em sequência viram um aviso só para o motorista.
  await notifyConvoyAction(r3.id, "approved", { actorId: admin.id, notify: true, message: null });
  await notifyConvoyAction(r3.id, "approved", { actorId: admin.id, notify: true, message: null });
  const aprovados = (await mine(motorista.id)).filter((item) => item.event === "convoy.approved");
  assert.equal(aprovados.length, 1);
  assert.equal(aprovados[0].title, "2 abastecimentos aprovados");
});

test("mudança de frente: pedido para quem aprova e resposta para quem pediu", { skip: !enabled }, async () => {
  const db = await getDb();
  const [atual, pedida, longe] = await db.insert(serviceFronts).values([{ name: `MF${s} ATUAL` }, { name: `MF${s} PEDIDA` }, { name: `MF${s} LONGE` }]).returning();
  const [tr] = await db.insert(equipment).values({ code: `TR-M${s}`, prefix: `TR-M${s}`, type: "TRATOR", brand: "M", model: "X", controlType: "HOURS", serviceFrontId: atual.id }).returning();
  const operador = await person("Operador", "CAMPO", [atual.id]);
  const gestorPedida = await person("Gestor pedida", "GESTOR", [pedida.id]);
  const gestorLonge = await person("Gestor longe", "GESTOR", [longe.id]);
  const admin = await person("Admin frente", "ADMIN");
  const [pedido] = await db.insert(serviceFrontChangeRequests).values({ equipmentId: tr.id, currentServiceFrontId: atual.id, requestedServiceFrontId: pedida.id, reason: "foi para a outra frente", requestedBy: operador.id, requestedAt: new Date().toISOString(), status: "PENDING" }).returning();
  await db.insert(dailyRecords).values({ equipmentId: tr.id, userId: operador.id, recordDate: today, workedToday: true, serviceFrontId: pedida.id, readingUnit: "HOURS", startReading: 1, endReading: 2, frontChangeRequestId: pedido.id });

  await notifyFrontRequest(pedido.id, true, operador.id);
  const [aviso] = (await mine(gestorPedida.id)).filter((item) => item.event === "front_change.requested");
  assert.equal(aviso.title, `Pedido de mudança de frente: TR-M${s}`);
  assert.equal(aviso.body, `${atual.name} → ${pedida.name} · informado por ${operador.name}`);
  assert.deepEqual(aviso.link, { secao: "Controle Diário", aba: "fronts" });
  assert.equal((await mine(gestorLonge.id)).length, 0);

  await reviewFrontRequest(session(admin), pedido.id, "REJECT", "Equipamento volta amanhã");
  await notifyFrontAnswer(pedido.id, { actorId: admin.id, notify: true, message: null });
  const [resposta] = await mine(operador.id);
  assert.equal(resposta.title, `Mudança de frente recusada: TR-M${s}`);
  assert.match(resposta.body, /Observação: Equipamento volta amanhã/);
});

test("Tarefas: o aviso do módulo também vai para o sino central, abrindo a tarefa", { skip: !enabled }, async () => {
  const db = await getDb();
  const responsavel = await person("Responsável", "GESTOR");
  const [tarefa] = await db.insert(tasks).values({ title: `Trocar lona ${s}`, dueDate: today, assigneeId: responsavel.id }).returning();
  await notifyUser(responsavel.id, tarefa.id, "TASK_RECEIVED", `Você recebeu a tarefa "Trocar lona ${s}" de Fulano.`);
  await flushNotifications();
  const [aviso] = await mine(responsavel.id);
  assert.equal(aviso.title, "Tarefa recebida");
  assert.deepEqual(aviso.link, { secao: "Tarefas", aba: `tarefa:${tarefa.id}` });
  assert.equal(await unreadCount(responsavel.id), 1);
});

test("rotina diária: trocas vencidas, estoque baixo e tarefas vencendo, só o que é novo", { skip: !enabled }, async () => {
  const db = await getDb();
  const [frente] = await db.insert(serviceFronts).values({ name: `RD${s} FRENTE` }).returning();
  const oficina = await person("Oficina", "OFICINA", [frente.id]);
  const almox = await person("Almoxarife", "ALMOXARIFADO", [frente.id]);
  const [tipo] = await db.insert(maintenanceTypes).values({ name: `Motor ${s}`, category: "OLEO" }).returning();
  const maquina = async (prefix) => {
    const [item] = await db.insert(equipment).values({ code: prefix, prefix, type: "TRATOR", brand: "M", model: "X", controlType: "HOURS", serviceFrontId: frente.id }).returning();
    await db.insert(equipmentMaintenanceTypes).values({ equipmentId: item.id, maintenanceTypeId: tipo.id });
    const [plano] = await db.insert(maintenancePlans).values({ equipmentId: item.id, maintenanceTypeId: tipo.id }).returning();
    await db.insert(alerts).values({ equipmentId: item.id, planId: plano.id, level: "OVERDUE", message: "vencida", fingerprint: `PLAN:${item.id}:${plano.id}`, plannedValue: 250 });
    return item;
  };
  await maquina(`TR-A${s}`);
  const [produto] = await db.insert(products).values({ tag: `F-${s}`, name: `Filtro ${s}` }).returning();
  await db.insert(productFrontStock).values({ productId: produto.id, serviceFrontId: frente.id, quantity: 5 });
  await db.insert(productStockMovements).values({ productId: produto.id, serviceFrontId: frente.id, delta: -30, reason: "saída", source: "STOCK_EXIT", movementDate: today });
  const [tarefa] = await db.insert(tasks).values({ title: `Revisar balança ${s}`, dueDate: today, assigneeId: oficina.id, status: "TODO" }).returning();

  const first = await runDailyNotifications(today);
  assert.ok(first.oil >= 1 && first.stock >= 1 && first.tasks >= 1, JSON.stringify(first));
  const oleo = (await mine(oficina.id)).filter((item) => item.event === "oil.overdue");
  assert.equal(oleo.length, 1);
  assert.equal(oleo[0].title, `1 troca de óleo vencida — ${frente.name}`);
  assert.equal(oleo[0].body, `TR-A${s} (Motor ${s})`);
  const estoque = (await mine(almox.id)).filter((item) => item.event === "stock.low");
  assert.equal(estoque.length, 1);
  assert.match(estoque[0].body, new RegExp(`Filtro ${s} \\(saldo 5; uso ~10/mês\\)`));
  const vence = (await mine(oficina.id)).filter((item) => item.event === "task.due_soon");
  assert.deepEqual([vence[0].title, vence[0].body, vence[0].link.aba], ["Tarefa vence hoje", `Revisar balança ${s}`, `tarefa:${tarefa.id}`]);

  // Rodar de novo sem nada novo: nenhuma troca/estoque repetido.
  await runDailyNotifications(today);
  assert.equal((await mine(oficina.id)).filter((item) => item.event === "oil.overdue").length, 1);
  assert.equal((await mine(almox.id)).filter((item) => item.event === "stock.low").length, 1);
  // Venceu mais uma: o aviso fala só dela e do total.
  await maquina(`TR-B${s}`);
  await runDailyNotifications(today);
  const [novo] = (await mine(oficina.id)).filter((item) => item.event === "oil.overdue");
  assert.equal(novo.body, `TR-B${s} (Motor ${s})\nTotal vencidas na frente: 2`);
});

// Serviço de push local (HTTPS com certificado próprio): guarda o que chegou e responde por caminho.
function pushService() {
  const dir = mkdtempSync(join(tmpdir(), "push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const received = [];
  const server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url.startsWith("/ok") ? 201 : req.url.startsWith("/gone") ? 410 : 500;
      res.end(req.url.startsWith("/err") ? "falha do serviço" : "");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, received, base: `https://127.0.0.1:${server.address().port}` })));
}

test("Web Push: aviso criptografado e assinado chega; falha e aparelho desativado ficam no registro", { skip: !enabled }, async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const ece = createRequire(import.meta.url)("http_ece");
  const { server, received, base } = await pushService();
  try {
    const pessoa = await person("Com celular", "GESTOR");
    const outra = await person("Outra pessoa", "GESTOR");
    const browser = crypto.createECDH("prime256v1"); browser.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const keys = { p256dh: browser.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };
    await registerDevice(pessoa.id, { kind: "WEB", token: `${base}/ok/${s}`, ...keys, label: "iPhone · app" });
    await registerDevice(pessoa.id, { kind: "WEB", token: `${base}/gone/${s}`, ...keys, label: "Antigo" });
    await registerDevice(pessoa.id, { kind: "WEB", token: `${base}/err/${s}`, ...keys, label: "Com erro" });

    const result = await notify({ event: "manual", to: [pessoa.id], title: "Parada da balsa", body: "Amanhã às 7h", link: { secao: "Combustível" }, actorId: outra.id });
    assert.equal(result.recipients, 1);
    const ok = received.find((item) => item.path.startsWith("/ok"));
    assert.ok(ok, "o serviço de push recebeu o aviso");
    assert.equal(ok.headers["content-encoding"], "aes128gcm");
    assert.equal(ok.headers.ttl, "86400");
    assert.equal(ok.headers.urgency, "high");
    // Só o aparelho (chave privada + segredo) consegue abrir o conteúdo.
    const payload = JSON.parse(ece.decrypt(ok.body, { version: "aes128gcm", privateKey: browser, authSecret: keys.auth }).toString("utf8"));
    const [aviso] = await mine(pessoa.id);
    assert.deepEqual(payload, { title: "Parada da balsa", body: "Amanhã às 7h", url: `https://www.jcsistema.online/?notificacao=${aviso.id}`, tag: null });
    // Assinatura VAPID: JWT ES256 para a origem do serviço, com a chave pública do sistema.
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(ok.headers.authorization) ?? [];
    const { publicKey } = await vapidKeys();
    assert.equal(k, publicKey);
    const [header, claims, signature] = jwt.split(".");
    const body = JSON.parse(Buffer.from(claims, "base64url").toString());
    assert.equal(body.aud, base);
    assert.equal(body.sub, "https://www.jcsistema.online");
    assert.ok(body.exp * 1000 > Date.now() && body.exp * 1000 <= Date.now() + 24 * 3600 * 1000 + 60_000);
    const point = Buffer.from(publicKey, "base64url");
    const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
    assert.ok(crypto.verify("sha256", Buffer.from(`${header}.${claims}`), { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")), "assinatura VAPID válida");

    // Registro: 1 entregue, 1 aparelho desativado (410), 1 falha (500); o desativado sai da lista.
    const db = await getDb();
    const entregas = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.dispatchId, result.dispatchId));
    assert.deepEqual(entregas.map((item) => item.status).sort(), ["FAILED", "INVALID", "SENT"]);
    assert.match(entregas.find((item) => item.status === "FAILED").error, /HTTP 500/);
    const devices = await listDevices(pessoa.id);
    assert.deepEqual(devices.map((item) => item.label).sort(), ["Com erro", "iPhone · app"]);
    assert.equal(devices.find((item) => item.label === "Com erro").lastError.startsWith("HTTP 500"), true);
    const [linha] = (await dispatchLog({ from: today, to: today, event: "manual", onlyFailures: true })).filter((item) => item.id === result.dispatchId);
    assert.deepEqual([linha.recipients, linha.sent, linha.failed, linha.createdBy], [1, 1, 2, outra.name]);
    assert.equal((await dispatchDetail(result.dispatchId))[0].deliveries.length, 3);

    // App Android (Firebase): sem a conta de serviço na Hostinger, a falha fica no registro com o motivo.
    const before = process.env.FIREBASE_SERVICE_ACCOUNT;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    await registerDevice(outra.id, { kind: "ANDROID", token: `fcm-token-${s}`, label: "Android · app JC Sistema" });
    const android = await notify({ event: "manual", to: [outra.id], title: "Aviso Android", body: "Teste", actorId: pessoa.id });
    const [semFirebase] = await getDb().then((conn) => conn.select().from(notificationDeliveries).where(eq(notificationDeliveries.dispatchId, android.dispatchId)));
    assert.deepEqual([semFirebase.channel, semFirebase.status, semFirebase.error], ["FCM", "FAILED", "FIREBASE_SERVICE_ACCOUNT não configurado na Hostinger"]);
    if (before !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT = before;

    // Outro login no mesmo aparelho: o aparelho passa para ele.
    await registerDevice(outra.id, { kind: "WEB", token: `${base}/ok/${s}`, ...keys, label: "iPhone · app" });
    assert.deepEqual((await listDevices(pessoa.id)).map((item) => item.label), ["Com erro"]);
    const [moved] = await db.select().from(notificationDevices).where(and(eq(notificationDevices.token, `${base}/ok/${s}`)));
    assert.equal(moved.userId, outra.id);
    assert.ok((await db.select().from(notificationDispatches).where(eq(notificationDispatches.id, result.dispatchId))).length);
    assert.ok((await db.select().from(notifications).where(eq(notifications.dispatchId, result.dispatchId))).length);
  } finally {
    server.close();
  }
});
