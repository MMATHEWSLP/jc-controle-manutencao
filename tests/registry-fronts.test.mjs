import assert from "node:assert/strict";
import test from "node:test";
import { frentesVisiveisCadastro } from "../lib/access.ts";
import { frentesEmExibicaoCadastro, showsRegistryFrontButtons } from "../lib/active-front.ts";

const user = (overrides = {}) => ({ id: 7, profile: "OPERADOR", permissions: [], allServiceFronts: false, serviceFrontIds: [3], ...overrides });
const request = (url = "http://x/api/employees", cookie = "") => new Request(url, { headers: cookie ? { cookie } : {} });

test("qualquer pessoa vê todas as frentes em Equipamentos/Funcionários e escolhe pelos botões do módulo", () => {
  const single = user();
  assert.equal(frentesVisiveisCadastro(single), "ALL");
  assert.equal(showsRegistryFrontButtons(single), true);
  assert.equal(frentesEmExibicaoCadastro(single, request()), "ALL");
  assert.deepEqual(frentesEmExibicaoCadastro(single, request("http://x/api/employees?frente=5")), [5]);
});

test("quem tem o seletor global usa só ele (sem botões no módulo)", () => {
  const multi = user({ serviceFrontIds: [3, 4] });
  assert.equal(showsRegistryFrontButtons(multi), false);
  assert.equal(frentesEmExibicaoCadastro(multi, request("http://x/api/employees?frente=5")), "ALL");
  assert.deepEqual(frentesEmExibicaoCadastro(multi, request("http://x/api/employees", "jc_active_front=7:4")), [4]);
});
