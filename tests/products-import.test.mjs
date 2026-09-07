import assert from "node:assert/strict";
import test from "node:test";
import {
  GARBAGE_TAGS,
  generalNeedsReview,
  isGenericApplication,
  matchEquipmentModel,
  needsReviewFor,
  normalizeMatchKey,
  parsePrice,
  parseProductsCsv,
} from "../lib/products-import.ts";

test("normalizeMatchKey ignora acento, caixa e espaçamento", () => {
  assert.equal(normalizeMatchKey("  mb  axor 3344  "), "MB AXOR 3344");
  assert.equal(normalizeMatchKey("MOTONIVELADORA CAT 140Gc"), "MOTONIVELADORA CAT 140GC");
  assert.equal(normalizeMatchKey("Não Definido"), "NAO DEFINIDO");
});

test("isGenericApplication detecta o sufixo (modelo a definir), com ou sem acento/caixa", () => {
  assert.equal(isGenericApplication("MB (modelo a definir)"), true);
  assert.equal(isGenericApplication("CAT (MODELO A DEFINIR)"), true);
  assert.equal(isGenericApplication("MB AXOR 3344"), false);
  assert.equal(isGenericApplication(""), false);
});

test("matchEquipmentModel casa por nome normalizado e retorna null sem correspondência", () => {
  const models = [
    { id: 1, name: "MB AXOR 3344" },
    { id: 2, name: "CAT D6N" },
  ];
  assert.equal(matchEquipmentModel("mb axor 3344", models)?.id, 1);
  assert.equal(matchEquipmentModel("CAT D6N", models)?.id, 2);
  assert.equal(matchEquipmentModel("VOLVO L90H", models), null);
});

test("generalNeedsReview marca preço zero ou aplicação genérica", () => {
  assert.equal(generalNeedsReview({ price: 0, applicationIsGeneric: false }), true);
  assert.equal(generalNeedsReview({ price: 10, applicationIsGeneric: true }), true);
  assert.equal(generalNeedsReview({ price: 10, applicationIsGeneric: false }), false);
});

test("parsePrice aceita ponto ou vírgula decimal e rejeita lixo", () => {
  assert.equal(parsePrice("57.00"), 57);
  assert.equal(parsePrice("57,00"), 57);
  assert.equal(parsePrice("1.234,50"), 1234.5);
  assert.equal(parsePrice("0"), 0);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("abc"), null);
  assert.equal(parsePrice("-5"), null);
});

test("GARBAGE_TAGS contém exatamente as 3 linhas de artefato identificadas na curadoria", () => {
  assert.equal(GARBAGE_TAGS.has("teste1"), true);
  assert.equal(GARBAGE_TAGS.has("teste2"), true);
  assert.equal(GARBAGE_TAGS.has("Totais"), true);
  assert.equal(GARBAGE_TAGS.size, 3);
});

test("parseProductsCsv lê cabeçalho, separador ; e campos entre aspas com ; embutido", () => {
  const csv = 'tag;nome;referencia;preco;fornecedor;marca;aplicacao\n2878;ABRAÇADEIRA 14MM 89-108;89-108;11.00;;;\n3298;"MB MANGUEIRA 7/8"" R5 [DIREÇÃO HIDRÁULICA]";MANGUERIA R5;161.30;;;MB (modelo a definir)\n';
  const rows = parseProductsCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { tag: "2878", nome: "ABRAÇADEIRA 14MM 89-108", referencia: "89-108", preco: "11.00", fornecedor: "", marca: "", aplicacao: "" });
  assert.equal(rows[1].nome, 'MB MANGUEIRA 7/8" R5 [DIREÇÃO HIDRÁULICA]');
  assert.equal(rows[1].aplicacao, "MB (modelo a definir)");
});

test("needsReviewFor usa a aba Revisar bundada e sempre marca preço zero como rede de segurança", () => {
  const knownTag = needsReviewFor("1001", 10);
  assert.equal(knownTag.needsReview, true);
  assert.ok(knownTag.reasons.length > 0);

  const unknownTagPaidPrice = needsReviewFor("999999-nao-existe", 10);
  assert.equal(unknownTagPaidPrice.needsReview, false);

  const unknownTagZeroPrice = needsReviewFor("999999-nao-existe", 0);
  assert.equal(unknownTagZeroPrice.needsReview, true);
  assert.ok(unknownTagZeroPrice.reasons.includes("Sem preco unitario"));
});
