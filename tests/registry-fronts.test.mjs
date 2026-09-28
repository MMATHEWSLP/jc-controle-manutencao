import assert from "node:assert/strict";
import test from "node:test";
import { frentesVisiveisCadastro } from "../lib/access.ts";
import { frentesEmExibicaoCadastro, showsRegistryFrontButtons } from "../lib/active-front.ts";

const user = (overrides = {}) => ({ id: 7, profile: "OPERADOR", permissions: [], allServiceFronts: false, serviceFrontIds: [3], ...overrides });
const request = (url = "http://x/api/employees", cookie = "") => new Request(url, { headers: cookie ? { cookie } : {} });

test("sem a permissão, Equipamentos/Funcionários seguem só as frentes do usuário", () => {
  const plain = user();
  assert.deepEqual(frentesVisiveisCadastro(plain), [3]);
  assert.deepEqual(frentesEmExibicaoCadastro(plain, request("http://x/api/employees?frente=5")), [3]);
  assert.equal(showsRegistryFrontButtons(plain), false);
});

test("com a permissão e uma frente só: vê tudo e escolhe pelos botões do módulo", () => {
  const cross = user({ permissions: ["fronts.cross_registry"] });
  assert.equal(frentesVisiveisCadastro(cross), "ALL");
  assert.equal(showsRegistryFrontButtons(cross), true);
  assert.equal(frentesEmExibicaoCadastro(cross, request()), "ALL");
  assert.deepEqual(frentesEmExibicaoCadastro(cross, request("http://x/api/employees?frente=5")), [5]);
});

test("quem tem o seletor global usa só ele (sem botões no módulo)", () => {
  const multi = user({ permissions: ["fronts.cross_registry"], serviceFrontIds: [3, 4] });
  assert.equal(showsRegistryFrontButtons(multi), false);
  assert.equal(frentesEmExibicaoCadastro(multi, request("http://x/api/employees?frente=5")), "ALL");
  assert.deepEqual(frentesEmExibicaoCadastro(multi, request("http://x/api/employees", "jc_active_front=7:4")), [4]);
});
