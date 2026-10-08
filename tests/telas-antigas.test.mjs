// Telas que viraram subabas (lib/assistente-nav.ts): o nome antigo "Abastecimentos" (menu removido)
// abre Combustível → Aprovação; a subaba pedida vale uma vez só e só para a tela certa.
import assert from "node:assert/strict";
import test from "node:test";
import { consumirAba, pedirAba, telaAtual } from "../lib/assistente-nav.ts";

test("Abastecimentos abre Combustível → Aprovação", () => {
  assert.equal(telaAtual("Abastecimentos"), "Combustível");
  assert.deepEqual(consumirAba("Combustível"), { aba: "aprovacao", detalhe: undefined });
  assert.equal(consumirAba("Combustível"), null, "vale uma vez só");
});

test("tela atual não muda e não pede subaba", () => {
  assert.equal(telaAtual("Combustível"), "Combustível");
  assert.equal(consumirAba("Combustível"), null);
});

test("a subaba pedida é só da tela certa", () => {
  pedirAba("Combustível", "motoristas");
  assert.equal(consumirAba("Produtos"), null);
  assert.equal(consumirAba("Combustível")?.aba, "motoristas");
});
