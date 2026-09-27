import assert from "node:assert/strict";
import test from "node:test";
import { findSimilarNames, nameSimilarity, nextSequentialTag, normalizeReference, parseReferenceList } from "../lib/product-rules.ts";
import { parseActiveFrontCookie, scopeFronts } from "../lib/active-front.ts";

test("referência normalizada ignora espaço, traço, ponto, barra e caixa", () => {
  assert.equal(normalizeReference("w 950"), "W950");
  assert.equal(normalizeReference("W-950"), "W950");
  assert.equal(normalizeReference("89.108/A"), "89108A");
});

test("lista de referências remove vazias e duplicadas pela chave normalizada", () => {
  assert.deepEqual(parseReferenceList(["w950", " W-950 ", "", "PSL 55"]), ["W950", "PSL 55"]);
  assert.deepEqual(parseReferenceList("FD25R / VD04;LB 719"), ["FD25R", "VD04", "LB 719"]);
  assert.deepEqual(parseReferenceList(null), []);
});

test("próxima TAG segue o maior número da base, ignorando TAGs não numéricas", () => {
  assert.equal(nextSequentialTag(["2878", "3067", "3049", "teste", "P-10"]), "3068");
  assert.equal(nextSequentialTag(["0009", "0010"]), "0011");
  assert.equal(nextSequentialTag([]), "1");
});

test("nomes parecidos: erro de digitação, acento e ordem das palavras", () => {
  assert.ok(nameSimilarity("ABRAÇADEIRA 14MM 89-108", "ABRACADEIRA 14MM 89-108") >= 0.98);
  assert.ok(nameSimilarity("FILTRO DE OLEO MOTOR", "FILTRO OLEO DO MOTOR") >= 0.82);
  assert.ok(nameSimilarity("MANCHAO VD04 A FRIO DIAGONAL", "MANCHAO VD04 A FRIO DIAGONL") >= 0.82);
});

test("medidas diferentes não contam como o mesmo produto", () => {
  assert.ok(nameSimilarity("ABRAÇADEIRA 14MM", "ABRAÇADEIRA 32MM") < 0.82);
  assert.ok(nameSimilarity("FAROL DA F4000", "PARAFUSO SEXTAVADO") < 0.5);
});

test("findSimilarNames devolve os mais parecidos primeiro e ignora nomes curtos", () => {
  const catalog = [{ name: "FILTRO DE AR PRIMARIO" }, { name: "FILTRO DE AR PRIMÁRIO JD" }, { name: "PARAFUSO M10" }];
  const result = findSimilarNames("FILTRO AR PRIMARIO", catalog);
  assert.equal(result[0].item.name, "FILTRO DE AR PRIMARIO");
  assert.ok(!result.some((entry) => entry.item.name === "PARAFUSO M10"));
  assert.deepEqual(findSimilarNames("FI", catalog), []);
});

test("cookie do seletor global só vale para o próprio usuário", () => {
  assert.equal(parseActiveFrontCookie("7:3", 7), 3);
  assert.equal(parseActiveFrontCookie("7:ALL", 7), "ALL");
  assert.equal(parseActiveFrontCookie("8:3", 7), "ALL");
  assert.equal(parseActiveFrontCookie("lixo", 7), "ALL");
});

test("seletor global só restringe, nunca amplia a visibilidade", () => {
  assert.deepEqual(scopeFronts("ALL", 3), [3]);
  assert.equal(scopeFronts("ALL", "ALL"), "ALL");
  assert.deepEqual(scopeFronts([2, 3], 3), [3]);
  assert.deepEqual(scopeFronts([2], 5), [2]);
});
