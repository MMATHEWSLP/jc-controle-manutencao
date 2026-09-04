import assert from "node:assert/strict";
import test from "node:test";
import {
  applyModuleGate,
  canChangeTaskRole,
  canManageOf,
  canSendTo,
  canViewReceivedOf,
  canViewSentOf,
  computeTaskPermissions,
  isRootRole,
} from "../lib/task-authorization.ts";

// Monta um TaskRoleGraph em memória a partir de nomes de cargo e uma lista de conexões
// direcionadas, sem tocar o banco — mesma forma que loadTaskRoleGraph() devolveria.
// rootName é `null` por padrão (nenhum cargo raiz) para que testes de conexão fiquem isolados do
// bypass do cargo raiz — só passe um nome quando o teste for especificamente sobre o cargo raiz.
function buildGraph(roleNames, connections = [], rootName = null) {
  const nameToId = new Map(roleNames.map((name, index) => [name, index + 1]));
  const roles = new Map(roleNames.map((name) => {
    const id = nameToId.get(name);
    return [id, { id, name, visualOrder: id, isRoot: name === rootName, active: true }];
  }));
  const connectionsBySource = new Map();
  for (const c of connections) {
    const row = {
      id: 0, sourceRoleId: nameToId.get(c.from), targetRoleId: nameToId.get(c.to),
      canSend: Boolean(c.send), canViewReceived: Boolean(c.viewReceived), canViewSent: Boolean(c.viewSent), canManage: Boolean(c.manage),
      createdBy: null, updatedBy: null, createdAt: "", updatedAt: "",
    };
    const list = connectionsBySource.get(row.sourceRoleId) ?? [];
    list.push(row);
    connectionsBySource.set(row.sourceRoleId, list);
  }
  return { graph: { roles, rootRoleId: nameToId.get(rootName), connectionsBySource }, id: (name) => nameToId.get(name) };
}

const viewer = (userId, taskRoleId) => ({ id: userId, taskRoleId });
const task = (overrides = {}) => ({ id: 1, createdBy: 100, assigneeId: 200, deletedAt: null, ...overrides });

// --- Cargo raiz e leitura básica das conexões (seção 4, 7) -------------------------------
test("isRootRole reconhece só o cargo marcado is_root, nunca por posição no mapa", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"], [], "ADMIN");
  assert.equal(isRootRole(graph, id("ADMIN")), true);
  assert.equal(isRootRole(graph, id("GESTOR")), false);
  assert.equal(isRootRole(graph, null), false);
});

test("cargo raiz pode enviar/visualizar/gerenciar qualquer cargo, mesmo sem nenhuma conexão configurada", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"], [], "ADMIN");
  assert.equal(canSendTo(graph, id("ADMIN"), id("SUB1")), true);
  assert.equal(canViewReceivedOf(graph, id("ADMIN"), id("SUB1")), true);
  assert.equal(canViewSentOf(graph, id("ADMIN"), id("SUB1")), true);
  assert.equal(canManageOf(graph, id("ADMIN"), id("SUB1")), true);
});

test("sem conexão configurada, nenhum cargo (fora o raiz) tem qualquer permissão sobre outro", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"], [], "ADMIN");
  assert.equal(canSendTo(graph, id("GESTOR"), id("SUB1")), false);
  assert.equal(canViewReceivedOf(graph, id("GESTOR"), id("SUB1")), false);
  assert.equal(canViewSentOf(graph, id("GESTOR"), id("SUB1")), false);
  assert.equal(canManageOf(graph, id("GESTOR"), id("SUB1")), false);
});

test("cenário 4 (mapa): GESTOR → SUB1 com permissão de envio libera só o envio, nada mais", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"], [{ from: "GESTOR", to: "SUB1", send: true }], "ADMIN");
  assert.equal(canSendTo(graph, id("GESTOR"), id("SUB1")), true);
  assert.equal(canViewReceivedOf(graph, id("GESTOR"), id("SUB1")), false);
  assert.equal(canManageOf(graph, id("GESTOR"), id("SUB1")), false);
});

test("cenário 9: relação A → B não concede automaticamente a relação B → A", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", send: true, manage: true }]);
  assert.equal(canSendTo(graph, id("A"), id("B")), true);
  assert.equal(canSendTo(graph, id("B"), id("A")), false);
  assert.equal(canManageOf(graph, id("B"), id("A")), false);
});

test("cenário 10: relação A → B e B → C não concede automaticamente A → C (não transitivo)", () => {
  const { graph, id } = buildGraph(["A", "B", "C"], [
    { from: "A", to: "B", viewReceived: true },
    { from: "B", to: "C", viewReceived: true },
  ]);
  assert.equal(canViewReceivedOf(graph, id("A"), id("B")), true);
  assert.equal(canViewReceivedOf(graph, id("B"), id("C")), true);
  assert.equal(canViewReceivedOf(graph, id("A"), id("C")), false);
});

test("cenário 11/12: visualizar só Recebidas não libera Enviadas, e vice-versa", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", viewReceived: true }]);
  assert.equal(canViewReceivedOf(graph, id("A"), id("B")), true);
  assert.equal(canViewSentOf(graph, id("A"), id("B")), false);
});

test("gerenciar implica visualizar recebidas, mas visualizar recebidas não implica gerenciar", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", manage: true }]);
  assert.equal(canManageOf(graph, id("A"), id("B")), true);
  assert.equal(canViewReceivedOf(graph, id("A"), id("B")), true);
  const onlyView = buildGraph(["A", "B"], [{ from: "A", to: "B", viewReceived: true }]);
  assert.equal(canManageOf(onlyView.graph, onlyView.id("A"), onlyView.id("B")), false);
});

test("seção 7.4: conexão do cargo com ele mesmo (self-loop) só existe se explicitamente configurada", () => {
  const withSelfLoop = buildGraph(["SUB1"], [{ from: "SUB1", to: "SUB1", send: true }]);
  assert.equal(canSendTo(withSelfLoop.graph, withSelfLoop.id("SUB1"), withSelfLoop.id("SUB1")), true);
  const withoutSelfLoop = buildGraph(["SUB1", "SUB2"]);
  assert.equal(canSendTo(withoutSelfLoop.graph, withoutSelfLoop.id("SUB1"), withoutSelfLoop.id("SUB1")), false);
});

// --- Visibilidade de tarefas (seção 16, cenários 5-8, 15, 17-19) -------------------------
test("cenário: o responsável atual sempre vê a tarefa, sem depender de nenhuma conexão", () => {
  const { graph } = buildGraph(["ADMIN", "USUARIO"]);
  const permissions = computeTaskPermissions(graph, viewer(200, 2), task(), 2, 2, false);
  assert.equal(permissions.canView, true);
});

test("cenário: o criador sempre vê a própria tarefa, mesmo não sendo o responsável e sem nenhuma conexão", () => {
  const { graph } = buildGraph(["ADMIN", "USUARIO"]);
  const permissions = computeTaskPermissions(graph, viewer(100, 2), task(), 2, 2, false);
  assert.equal(permissions.canView, true);
});

test("cenário 16.2: quem já foi responsável (everAssignee=true) continua vendo a tarefa mesmo após reatribuída", () => {
  const { graph, id } = buildGraph(["ADMIN", "SUB1", "SUB2"]);
  const t = task({ createdBy: 100, assigneeId: 300 }); // responsável ATUAL agora é outra pessoa (300)
  const formerAssignee = computeTaskPermissions(graph, viewer(200, id("SUB1")), t, id("SUB1"), id("SUB2"), true);
  assert.equal(formerAssignee.canView, true);
  const neverAssignee = computeTaskPermissions(graph, viewer(999, id("SUB1")), t, id("SUB1"), id("SUB2"), false);
  assert.equal(neverAssignee.canView, false);
});

test("terceiro sem conexão e sem papel na tarefa não vê nada (nenhuma permissão)", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"]);
  const outsider = computeTaskPermissions(graph, viewer(999, id("SUB1")), task({ createdBy: 100, assigneeId: 200 }), id("GESTOR"), id("SUB1"), false);
  assert.deepEqual(outsider, { canView: false, canEdit: false, canReassign: false, canDelete: false, canComplete: false, canMarkNotDone: false });
});

test("cargo raiz vê e gerencia qualquer tarefa, mesmo sem nenhuma conexão configurada", () => {
  const { graph, id } = buildGraph(["ADMIN", "GESTOR", "SUB1"], [], "ADMIN");
  const permissions = computeTaskPermissions(graph, viewer(1, id("ADMIN")), task({ createdBy: 100, assigneeId: 200 }), id("GESTOR"), id("SUB1"), false);
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canDelete, true);
});

test("cargo raiz só conclui/não-realiza se ele mesmo for o responsável — não pode agir em nome de outra pessoa", () => {
  const { graph, id } = buildGraph(["ADMIN", "USUARIO"], [], "ADMIN");
  const notAssignee = computeTaskPermissions(graph, viewer(1, id("ADMIN")), task({ createdBy: 100, assigneeId: 200 }), id("USUARIO"), id("USUARIO"), false);
  assert.equal(notAssignee.canComplete, false);
  assert.equal(notAssignee.canMarkNotDone, false);
  const isAssignee = computeTaskPermissions(graph, viewer(1, id("ADMIN")), task({ createdBy: 100, assigneeId: 1 }), id("USUARIO"), id("ADMIN"), false);
  assert.equal(isAssignee.canComplete, true);
});

test("visualizador autorizado (conexão de visualizar recebidas) só lê — nunca edita, reatribui ou exclui", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", viewReceived: true }]);
  const permissions = computeTaskPermissions(graph, viewer(999, id("A")), task({ createdBy: 100, assigneeId: 200 }), id("A"), id("B"), false);
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, false);
  assert.equal(permissions.canReassign, false);
  assert.equal(permissions.canDelete, false);
});

test("conexão de visualizar ENVIADAS do cargo do criador dá acesso, mesmo sem nenhuma conexão para o cargo do responsável", () => {
  const { graph, id } = buildGraph(["A", "B", "C"], [{ from: "A", to: "B", viewSent: true }]);
  const permissions = computeTaskPermissions(graph, viewer(999, id("A")), task({ createdBy: 100, assigneeId: 200 }), id("B"), id("C"), false);
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, false);
});

test("gerenciador autorizado (conexão de gerenciar) edita, reatribui e exclui, mas só conclui se também for o responsável", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", manage: true }]);
  const permissions = computeTaskPermissions(graph, viewer(999, id("A")), task({ createdBy: 100, assigneeId: 200 }), id("A"), id("B"), false);
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canReassign, true);
  assert.equal(permissions.canDelete, true);
  assert.equal(permissions.canComplete, false);
  assert.equal(permissions.canMarkNotDone, false);
});

test("tarefa sem responsável válido (registro legado sem regularização): visível ao criador e ao cargo raiz (que precisa localizar e regularizar — seção 4), não a um terceiro comum", () => {
  const { graph, id } = buildGraph(["ADMIN", "USUARIO"], [], "ADMIN");
  const orphan = task({ assigneeId: null });
  assert.equal(computeTaskPermissions(graph, viewer(100, id("USUARIO")), orphan, id("USUARIO"), null, false).canView, true);
  assert.equal(computeTaskPermissions(graph, viewer(1, id("ADMIN")), orphan, id("USUARIO"), null, false).canView, true);
  assert.equal(computeTaskPermissions(graph, viewer(999, id("USUARIO")), orphan, id("USUARIO"), null, false).canView, false);
});

test("cenário 15: mudar o cargo do observador (ou criar uma nova conexão) muda a visibilidade da mesma tarefa, sem tocar a tarefa", () => {
  const before = buildGraph(["A", "B"]);
  const after = buildGraph(["A", "B"], [{ from: "A", to: "B", viewReceived: true }]);
  const t = task({ createdBy: 100, assigneeId: 200 });
  assert.equal(computeTaskPermissions(before.graph, viewer(999, before.id("A")), t, before.id("B"), before.id("B"), false).canView, false);
  assert.equal(computeTaskPermissions(after.graph, viewer(999, after.id("A")), t, after.id("B"), after.id("B"), false).canView, true);
});

// --- Matriz de permissões / acumulação de papéis (seção 17) ------------------------------
test("responsável comum (não criador, sem conexão de gerenciar) só conclui/não-realiza — nunca edita, reatribui ou exclui", () => {
  const { graph, id } = buildGraph(["ADMIN", "USUARIO"]);
  const permissions = computeTaskPermissions(graph, viewer(200, id("USUARIO")), task(), id("USUARIO"), id("USUARIO"), false);
  assert.equal(permissions.canEdit, false);
  assert.equal(permissions.canReassign, false);
  assert.equal(permissions.canDelete, false);
  assert.equal(permissions.canComplete, true);
  assert.equal(permissions.canMarkNotDone, true);
});

test("criador edita, reatribui e exclui, mas não conclui/não-realiza (a menos que também seja o responsável)", () => {
  const { graph, id } = buildGraph(["ADMIN", "USUARIO"]);
  const permissions = computeTaskPermissions(graph, viewer(100, id("USUARIO")), task({ createdBy: 100, assigneeId: 200 }), id("USUARIO"), id("USUARIO"), false);
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canReassign, true);
  assert.equal(permissions.canDelete, true);
  assert.equal(permissions.canComplete, false);
  assert.equal(permissions.canMarkNotDone, false);
});

test("criador e responsável são a mesma pessoa — permissões acumuladas (união), nada é retirado", () => {
  const { graph, id } = buildGraph(["ADMIN", "USUARIO"]);
  const t = task({ createdBy: 100, assigneeId: 100 });
  const permissions = computeTaskPermissions(graph, viewer(100, id("USUARIO")), t, id("USUARIO"), id("USUARIO"), false);
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canReassign, true);
  assert.equal(permissions.canDelete, true);
  assert.equal(permissions.canComplete, true);
  assert.equal(permissions.canMarkNotDone, true);
});

test("gerenciador que também é o responsável acumula a permissão de concluir/não realizar", () => {
  const { graph, id } = buildGraph(["A", "B"], [{ from: "A", to: "B", manage: true }]);
  const t = task({ createdBy: 100, assigneeId: 999 });
  const permissions = computeTaskPermissions(graph, viewer(999, id("B")), t, id("A"), id("B"), false);
  assert.equal(permissions.canComplete, true);
  assert.equal(permissions.canMarkNotDone, true);
});

// --- Gate de módulo (tasks.edit) ---------------------------------------------------------
test("applyModuleGate zera as ações mutáveis quando falta a permissão de módulo tasks.edit, mas preserva canView", () => {
  const full = { canView: true, canEdit: true, canReassign: true, canDelete: true, canComplete: true, canMarkNotDone: true };
  const gated = applyModuleGate(full, false);
  assert.equal(gated.canView, true);
  assert.equal(gated.canEdit, false);
  assert.equal(gated.canReassign, false);
  assert.equal(gated.canDelete, false);
  assert.equal(gated.canComplete, false);
  assert.equal(gated.canMarkNotDone, false);
});

test("applyModuleGate não altera nada quando a permissão de módulo está presente", () => {
  const full = { canView: true, canEdit: true, canReassign: true, canDelete: true, canComplete: true, canMarkNotDone: true };
  assert.deepEqual(applyModuleGate(full, true), full);
});

// --- Alteração do Cargo de Tarefas (seção 3, 9) ------------------------------------------
test("somente ADMIN pode alterar o Cargo de Tarefas de outro usuário", () => {
  assert.equal(canChangeTaskRole({ id: 1, profile: "ADMIN" }, 2), true);
  assert.equal(canChangeTaskRole({ id: 1, profile: "GESTOR" }, 2), false);
  assert.equal(canChangeTaskRole({ id: 1, profile: "OFICINA" }, 2), false);
  assert.equal(canChangeTaskRole({ id: 1, profile: "OPERADOR" }, 2), false);
  assert.equal(canChangeTaskRole({ id: 1, profile: "ALMOXARIFADO" }, 2), false);
});

test("ninguém pode alterar o próprio Cargo de Tarefas, nem o ADMIN", () => {
  assert.equal(canChangeTaskRole({ id: 1, profile: "ADMIN" }, 1), false);
});
