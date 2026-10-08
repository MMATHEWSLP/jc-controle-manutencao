// Central de notificações (lib/notification-events.ts): catálogo dos eventos, configuração padrão e
// quem recebe cada aviso (permissão, perfis, pessoas escolhidas e a frente do evento).
import assert from "node:assert/strict";
import test from "node:test";
import { ALL_PERMISSIONS } from "../lib/auth.ts";
import { clip, defaultSetting, EVENTS, eventDef, groupRecipients, manualRecipients, parseSetting } from "../lib/notification-events.ts";

const person = (id, profile, extra = {}) => ({ id, profile, active: true, allServiceFronts: false, serviceFrontIds: [], permissions: [], ...extra });
const people = [
  person(1, "ADMIN", { permissions: ALL_PERMISSIONS }),
  person(2, "GESTOR", { serviceFrontIds: [10], permissions: ["fuel.convoy_approve", "daily.front_requests"] }),
  person(3, "GESTOR", { serviceFrontIds: [20], permissions: ["fuel.convoy_approve"] }),
  person(4, "OFICINA", { serviceFrontIds: [10] }),
  person(5, "CAMPO", { serviceFrontIds: [10], permissions: ["daily.register", "fuel.convoy_register"] }),
  person(6, "GESTOR", { allServiceFronts: true, permissions: ["fuel.convoy_approve"] }),
  person(7, "GESTOR", { serviceFrontIds: [10], permissions: ["fuel.convoy_approve"], active: false }),
];

test("catálogo: chaves únicas, permissões que existem e evento avulso travado", () => {
  assert.equal(new Set(EVENTS.map((item) => item.key)).size, EVENTS.length);
  for (const item of EVENTS) {
    if (item.permission) assert.ok(ALL_PERMISSIONS.includes(item.permission), item.key);
    if (item.audience === "GRUPO") assert.ok(item.permission || item.defaultProfiles?.length, `${item.key} precisa de quem recebe por padrão`);
  }
  assert.equal(eventDef("manual").locked, true);
  assert.equal(eventDef("nao-existe"), null);
  assert.ok(ALL_PERMISSIONS.includes("notifications.configure") && ALL_PERMISSIONS.includes("notifications.send"));
});

test("sem configuração salva vale o padrão do código (perfis padrão do evento)", () => {
  assert.deepEqual(defaultSetting("oil.overdue").profiles, ["ADMIN", "GESTOR", "OFICINA"]);
  assert.deepEqual(parseSetting("convoy.pending", null), defaultSetting("convoy.pending"));
  const saved = parseSetting("convoy.pending", { enabled: false, push: true, includePermission: false, onlyFront: true, profiles: '["GESTOR","XPTO"]', userIds: '[4,"9",-1,"x"]' });
  assert.deepEqual([saved.enabled, saved.profiles, saved.userIds], [false, ["GESTOR"], [4, 9]]);
  assert.deepEqual(parseSetting("convoy.pending", { enabled: true, push: true, includePermission: true, onlyFront: true, profiles: "lixo", userIds: "{}" }).profiles, []);
});

test("grupo: quem tem a permissão e enxerga a frente; inativo e campo ficam fora", () => {
  const def = eventDef("convoy.pending");
  const setting = defaultSetting("convoy.pending");
  assert.deepEqual(groupRecipients(people, setting, def, [10]), [1, 2, 6]);
  assert.deepEqual(groupRecipients(people, setting, def, [20]), [1, 3, 6]);
  // Evento sem frente: todos com a permissão.
  assert.deepEqual(groupRecipients(people, setting, def, []), [1, 2, 3, 6]);
  // Desligar "só quem enxerga a frente".
  assert.deepEqual(groupRecipients(people, { ...setting, onlyFront: false }, def, [10]), [1, 2, 3, 6]);
  // Mudança de frente: basta enxergar uma das frentes (atual ou pedida).
  assert.deepEqual(groupRecipients(people, defaultSetting("front_change.requested"), eventDef("front_change.requested"), [20, 10]), [1, 2]);
});

test("grupo: perfis e pessoas escolhidas pelo ADMIN; campo só pelo nome", () => {
  const def = eventDef("convoy.pending");
  const onlyChosen = { ...defaultSetting("convoy.pending"), includePermission: false, profiles: ["OFICINA"], userIds: [5] };
  assert.deepEqual(groupRecipients(people, onlyChosen, def, [10]), [4, 5]);
  assert.deepEqual(groupRecipients(people, onlyChosen, def, [20]), []);
  assert.deepEqual(groupRecipients(people, { ...onlyChosen, profiles: ["CAMPO"], userIds: [] }, def, [10]), [], "perfil CAMPO não entra pelo perfil");
  const pend = eventDef("pendencia.new");
  assert.deepEqual(groupRecipients(people, defaultSetting("pendencia.new"), pend, [10]), [1, 2, 4, 6]);
});

test("envio avulso: todos, perfis, pessoas e frentes", () => {
  assert.deepEqual(manualRecipients(people, { all: true, profiles: [], userIds: [], frontIds: [] }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(manualRecipients(people, { all: false, profiles: ["GESTOR"], userIds: [], frontIds: [] }), [2, 3, 6]);
  assert.deepEqual(manualRecipients(people, { all: false, profiles: ["GESTOR"], userIds: [], frontIds: [20] }), [3, 6]);
  // Pessoa escolhida pelo nome recebe mesmo fora das frentes escolhidas.
  assert.deepEqual(manualRecipients(people, { all: false, profiles: [], userIds: [5], frontIds: [20] }), [5]);
  assert.deepEqual(manualRecipients(people, { all: false, profiles: [], userIds: [7], frontIds: [] }), [], "inativo não recebe");
});

test("texto curto para o celular", () => {
  assert.equal(clip("abc", 5), "abc");
  assert.equal(clip("abcdefghij", 5), "abcd…");
});
