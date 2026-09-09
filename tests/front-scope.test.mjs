import assert from "node:assert/strict";
import test from "node:test";
import {
  canBrowseAllEquipment,
  equipmentScopeSql,
  requireEquipmentAccess,
} from "../lib/front-scope.ts";

const user = (overrides = {}) => ({
  id: 10,
  name: "Usuário de teste",
  username: "teste",
  email: "teste@local",
  profile: "OPERADOR",
  status: "ACTIVE",
  theme: "LIGHT",
  isPrimaryAdmin: false,
  lastAccessAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  permissions: ["equipment.view"],
  serviceFrontId: 2,
  serviceFrontName: "Mamuru",
  allServiceFronts: false,
  serviceFrontIds: [2],
  canExport: false,
  ...overrides,
});

test("usuários comuns ficam limitados às frentes vinculadas em todos os módulos", () => {
  const operational = equipmentScopeSql(user(), "OPERATIONAL");
  assert.equal(operational.clause, "e.service_front_id=ANY(?)");
  assert.deepEqual(operational.values, [[2]]);

  const oil = equipmentScopeSql(user(), "OIL");
  assert.equal(oil.clause, "e.oil_change_enabled=1 AND e.service_front_id=ANY(?)");
  assert.deepEqual(oil.values, [[2]]);
});

test("usuário com várias frentes vinculadas enxerga todas elas, nenhuma outra", () => {
  const multi = user({ serviceFrontIds: [2, 3] });
  const scope = equipmentScopeSql(multi, "OPERATIONAL");
  assert.equal(scope.clause, "e.service_front_id=ANY(?)");
  assert.deepEqual(scope.values, [[2, 3]]);
});

test("all_service_fronts=TRUE enxerga tudo mesmo sem ser ADMIN", () => {
  const allFronts = user({ allServiceFronts: true, serviceFrontIds: [] });
  assert.equal(equipmentScopeSql(allFronts, "MANAGEMENT").clause, "1=1");
  assert.equal(equipmentScopeSql(allFronts, "OPERATIONAL").clause, "1=1");
  assert.equal(equipmentScopeSql(allFronts, "OIL").clause, "e.oil_change_enabled=1");
});

test("equipamentos sem troca de óleo não entram no escopo do módulo de óleo", () => {
  const db = fakeDb({ id: 7, prefix: "JL-48", service_front_id: 2, oil_change_enabled: 0 });
  assert.rejects(() => requireEquipmentAccess(db, user(), 7, "OIL"), /não participa do módulo Troca de Óleo/);
});

test("backend nega equipamento de outra frente ao usuário comum", () => {
  const db = fakeDb({ id: 27, prefix: "CM-27", service_front_id: 3, oil_change_enabled: 1 });
  assert.rejects(() => requireEquipmentAccess(db, user(), 27, "OPERATIONAL"), /não possui acesso/);
});

test("backend libera equipamento de qualquer uma das frentes vinculadas", async () => {
  const db = fakeDb({ id: 27, prefix: "CM-27", service_front_id: 3, oil_change_enabled: 1 });
  const multi = user({ serviceFrontIds: [2, 3] });
  const access = await requireEquipmentAccess(db, multi, 27, "OPERATIONAL");
  assert.equal(access.serviceFrontId, 3);
});

test("permissão de transferência libera a consulta geral somente na gestão", () => {
  const transferUser = user({ permissions: ["equipment.view", "equipment.transfer"] });
  assert.equal(canBrowseAllEquipment(transferUser, "MANAGEMENT"), true);
  assert.equal(canBrowseAllEquipment(transferUser, "OPERATIONAL"), false);
  assert.equal(equipmentScopeSql(transferUser, "MANAGEMENT").clause, "1=1");
  assert.equal(equipmentScopeSql(transferUser, "OPERATIONAL").clause, "e.service_front_id=ANY(?)");
});

test("administrador visualiza todas as frentes, preservando o filtro de óleo", () => {
  const admin = user({ profile: "ADMIN", serviceFrontId: null, serviceFrontName: null, serviceFrontIds: [], permissions: [] });
  assert.equal(equipmentScopeSql(admin, "MANAGEMENT").clause, "1=1");
  assert.equal(equipmentScopeSql(admin, "OPERATIONAL").clause, "1=1");
  assert.equal(equipmentScopeSql(admin, "OIL").clause, "e.oil_change_enabled=1");
});

test("usuário sem nenhuma frente vinculada não recebe equipamentos por padrão", () => {
  const scope = equipmentScopeSql(user({ serviceFrontId: null, serviceFrontName: null, serviceFrontIds: [] }), "OPERATIONAL");
  assert.equal(scope.clause, "1=0");
  assert.deepEqual(scope.values, []);
});

function fakeDb(equipment) {
  return {
    prepare() {
      return {
        bind() {
          return { first: async () => equipment };
        },
      };
    },
  };
}
