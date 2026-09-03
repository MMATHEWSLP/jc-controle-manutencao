import assert from "node:assert/strict";
import test from "node:test";
import {
  HIERARCHY_LEVELS,
  applyModuleGate,
  canChangeHierarchyLevel,
  computeTaskPermissions,
  isHierarchyLevel,
  isSuperiorLevel,
} from "../lib/task-authorization.ts";

const viewer = (id, hierarchyLevel) => ({ id, hierarchyLevel });
const task = (overrides = {}) => ({ id: 1, createdBy: 100, assigneeId: 200, deletedAt: null, ...overrides });

// --- Ordem da hierarquia -----------------------------------------------------------------
test("ordem exata da hierarquia: ADMIN, GESTOR, SUB1, SUB2, SUB3, USUARIO", () => {
  assert.deepEqual(HIERARCHY_LEVELS, ["ADMIN", "GESTOR", "SUB1", "SUB2", "SUB3", "USUARIO"]);
});

test("isSuperiorLevel segue a ordem: ADMIN > GESTOR > SUB1 > SUB2 > SUB3 > USUARIO", () => {
  assert.equal(isSuperiorLevel("ADMIN", "GESTOR"), true);
  assert.equal(isSuperiorLevel("ADMIN", "SUB1"), true);
  assert.equal(isSuperiorLevel("ADMIN", "SUB2"), true);
  assert.equal(isSuperiorLevel("ADMIN", "SUB3"), true);
  assert.equal(isSuperiorLevel("ADMIN", "USUARIO"), true);
  assert.equal(isSuperiorLevel("GESTOR", "SUB1"), true);
  assert.equal(isSuperiorLevel("GESTOR", "SUB2"), true);
  assert.equal(isSuperiorLevel("GESTOR", "SUB3"), true);
  assert.equal(isSuperiorLevel("GESTOR", "USUARIO"), true);
  assert.equal(isSuperiorLevel("SUB1", "SUB2"), true);
  assert.equal(isSuperiorLevel("SUB1", "SUB3"), true);
  assert.equal(isSuperiorLevel("SUB1", "USUARIO"), true);
  assert.equal(isSuperiorLevel("SUB2", "SUB3"), true);
  assert.equal(isSuperiorLevel("SUB2", "USUARIO"), true);
  assert.equal(isSuperiorLevel("SUB3", "USUARIO"), true);
});

test("usuários do mesmo nível nunca são superiores entre si (nem ADMIN-ADMIN)", () => {
  for (const level of HIERARCHY_LEVELS) assert.equal(isSuperiorLevel(level, level), false);
});

test("um nível inferior nunca é superior a um nível acima dele", () => {
  assert.equal(isSuperiorLevel("USUARIO", "SUB3"), false);
  assert.equal(isSuperiorLevel("SUB3", "SUB2"), false);
  assert.equal(isSuperiorLevel("SUB2", "SUB1"), false);
  assert.equal(isSuperiorLevel("SUB1", "GESTOR"), false);
  assert.equal(isSuperiorLevel("GESTOR", "ADMIN"), false);
});

test("isHierarchyLevel valida somente os 6 valores aceitos", () => {
  for (const level of HIERARCHY_LEVELS) assert.equal(isHierarchyLevel(level), true);
  assert.equal(isHierarchyLevel("SUPERADMIN"), false);
  assert.equal(isHierarchyLevel(""), false);
  assert.equal(isHierarchyLevel(null), false);
  assert.equal(isHierarchyLevel(42), false);
});

// --- Visibilidade (seção 5 e cenários 3-8, 15, 16) ---------------------------------------
test("cenário 3: o responsável vê a tarefa atribuída a ele", () => {
  const permissions = computeTaskPermissions(viewer(200, "USUARIO"), task(), "USUARIO");
  assert.equal(permissions.canView, true);
});

test("cenário 4: o criador vê a tarefa que criou, mesmo não sendo o responsável", () => {
  const permissions = computeTaskPermissions(viewer(100, "USUARIO"), task(), "USUARIO");
  assert.equal(permissions.canView, true);
});

test("cenário 5: um usuário de nível superior ao responsável vê a tarefa", () => {
  const permissions = computeTaskPermissions(viewer(999, "GESTOR"), task(), "SUB1");
  assert.equal(permissions.canView, true);
});

test("cenário 6: um usuário do mesmo nível do responsável NÃO vê, salvo se for criador", () => {
  const sameLevelStranger = computeTaskPermissions(viewer(999, "SUB1"), task(), "SUB1");
  assert.equal(sameLevelStranger.canView, false);
  const sameLevelButCreator = computeTaskPermissions(viewer(100, "SUB1"), task({ createdBy: 100 }), "SUB1");
  assert.equal(sameLevelButCreator.canView, true);
});

test("cenário 7: um usuário de nível inferior NÃO vê, salvo se for criador ou responsável", () => {
  const inferiorStranger = computeTaskPermissions(viewer(999, "USUARIO"), task(), "SUB1");
  assert.equal(inferiorStranger.canView, false);
  const inferiorButAssignee = computeTaskPermissions(viewer(200, "USUARIO"), task({ assigneeId: 200 }), "USUARIO");
  assert.equal(inferiorButAssignee.canView, true);
});

test("cenário 8 (lógica): um usuário sem nenhum papel (nem criador, nem responsável, nem superior do responsável) não recebe nenhuma permissão", () => {
  const outsider = computeTaskPermissions(viewer(999, "SUB3"), task({ createdBy: 100, assigneeId: 200 }), "SUB1");
  assert.deepEqual(outsider, { canView: false, canEdit: false, canReassign: false, canDelete: false, canComplete: false, canMarkNotDone: false });
});

test("tarefa sem responsável válido (registro legado) só é visível ao criador", () => {
  const orphan = task({ assigneeId: null });
  assert.equal(computeTaskPermissions(viewer(100, "USUARIO"), orphan, null).canView, true); // criador
  assert.equal(computeTaskPermissions(viewer(999, "ADMIN"), orphan, null).canView, false); // nem ADMIN, sem ser criador
});

test("cenário 16: tarefas concluídas ou não realizadas seguem a mesma regra de visibilidade (status não entra na conta)", () => {
  const t = task();
  const asAssignee = computeTaskPermissions(viewer(200, "USUARIO"), t, "USUARIO");
  const asStranger = computeTaskPermissions(viewer(999, "USUARIO"), t, "USUARIO");
  // computeTaskPermissions nem recebe o status como parâmetro — a regra de visibilidade é
  // estruturalmente a mesma independentemente de a tarefa estar pendente, concluída ou não realizada.
  assert.equal(asAssignee.canView, true);
  assert.equal(asStranger.canView, false);
});

test("cenário 15: alterar o nível hierárquico do observador muda a visibilidade da mesma tarefa", () => {
  const t = task({ createdBy: 100, assigneeId: 200 });
  const beforePromotion = computeTaskPermissions(viewer(999, "SUB2"), t, "SUB1");
  const afterPromotion = computeTaskPermissions(viewer(999, "GESTOR"), t, "SUB1");
  assert.equal(beforePromotion.canView, false);
  assert.equal(afterPromotion.canView, true);
});

// --- Matriz de permissões (seção 6, cenários 9, 12, 13, 14) ------------------------------
test("cenário 9 / matriz: responsável comum (não criador, não superior) só conclui/não-realiza — nunca edita, reatribui ou exclui", () => {
  const permissions = computeTaskPermissions(viewer(200, "USUARIO"), task(), "USUARIO");
  assert.equal(permissions.canEdit, false);
  assert.equal(permissions.canReassign, false);
  assert.equal(permissions.canDelete, false);
  assert.equal(permissions.canComplete, true);
  assert.equal(permissions.canMarkNotDone, true);
});

test("cenário 12 / matriz: criador edita, reatribui e exclui, mas não conclui/não-realiza (a menos que seja o responsável)", () => {
  const permissions = computeTaskPermissions(viewer(100, "USUARIO"), task({ createdBy: 100, assigneeId: 200 }), "USUARIO");
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canReassign, true);
  assert.equal(permissions.canDelete, true);
  assert.equal(permissions.canComplete, false);
  assert.equal(permissions.canMarkNotDone, false);
});

test("cenário 12 / matriz: superior hierárquico do responsável edita, reatribui e exclui", () => {
  const permissions = computeTaskPermissions(viewer(999, "ADMIN"), task({ createdBy: 100, assigneeId: 200 }), "USUARIO");
  assert.equal(permissions.canEdit, true);
  assert.equal(permissions.canReassign, true);
  assert.equal(permissions.canDelete, true);
  assert.equal(permissions.canComplete, false);
  assert.equal(permissions.canMarkNotDone, false);
});

test("cenário 13 / matriz: outro usuário (nenhum papel) não recebe nenhuma permissão", () => {
  const permissions = computeTaskPermissions(viewer(999, "USUARIO"), task({ createdBy: 100, assigneeId: 200 }), "USUARIO");
  assert.deepEqual(permissions, { canView: false, canEdit: false, canReassign: false, canDelete: false, canComplete: false, canMarkNotDone: false });
});

test("cenário 14: criador e responsável são a mesma pessoa — permissões acumuladas (união), nada é retirado", () => {
  const t = task({ createdBy: 100, assigneeId: 100 });
  const permissions = computeTaskPermissions(viewer(100, "USUARIO"), t, "USUARIO");
  assert.equal(permissions.canView, true);
  assert.equal(permissions.canEdit, true); // via papel de criador
  assert.equal(permissions.canReassign, true); // via papel de criador
  assert.equal(permissions.canDelete, true); // via papel de criador
  assert.equal(permissions.canComplete, true); // via papel de responsável
  assert.equal(permissions.canMarkNotDone, true); // via papel de responsável
});

test("superior que também é o responsável acumula permissão de concluir/não realizar", () => {
  const t = task({ createdBy: 100, assigneeId: 999 });
  const permissions = computeTaskPermissions(viewer(999, "GESTOR"), t, "GESTOR");
  // 999 é o próprio responsável aqui — não é "superior de si mesmo" (mesmo nível), mas é o assignee.
  assert.equal(permissions.canComplete, true);
  assert.equal(permissions.canMarkNotDone, true);
  assert.equal(permissions.canEdit, false); // não é criador, e não é superior de si mesmo
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

// --- Alteração do nível hierárquico (seção 3) --------------------------------------------
test("somente ADMIN pode alterar o nível hierárquico de outro usuário", () => {
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "ADMIN" }, 2), true);
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "GESTOR" }, 2), false);
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "OFICINA" }, 2), false);
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "OPERADOR" }, 2), false);
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "ALMOXARIFADO" }, 2), false);
});

test("ninguém pode alterar o próprio nível hierárquico, nem o ADMIN", () => {
  assert.equal(canChangeHierarchyLevel({ id: 1, profile: "ADMIN" }, 1), false);
});
