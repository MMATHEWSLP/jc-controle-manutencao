// Telas que viraram subabas (lib/assistente-nav.ts): o nome antigo "Abastecimentos" (menu removido)
// abre Combustível → Aprovação; "Custos e Consumo" e "Resumo semanal" abrem o relatório no menu
// RELATÓRIOS; a subaba pedida vale uma vez só e só para a tela certa.
import assert from "node:assert/strict";
import test from "node:test";
import { consumirAba, pedirAba, TELAS_ANTIGAS, telaAtual } from "../lib/assistente-nav.ts";
import { reportById } from "../lib/reports-catalog.ts";

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

// Custos e Consumo e Resumo semanal saíram de EQUIPAMENTOS e foram para o menu RELATÓRIOS.
test("Custos e Consumo e Resumo semanal abrem o relatório no menu RELATÓRIOS", () => {
  assert.equal(telaAtual("Custos e Consumo"), "Relatórios");
  assert.equal(consumirAba("Relatórios")?.aba, "custos-consumo");
  assert.equal(telaAtual("Resumo semanal"), "Relatórios");
  assert.equal(consumirAba("Relatórios")?.aba, "resumo-semanal");
});

test("toda tela antiga que vai para RELATÓRIOS aponta para um relatório do catálogo", () => {
  for (const [nome, destino] of Object.entries(TELAS_ANTIGAS)) {
    if (destino.secao !== "Relatórios") continue;
    assert.ok(reportById(destino.aba), `${nome} → ${destino.aba} não existe em lib/reports-catalog.ts`);
  }
});
