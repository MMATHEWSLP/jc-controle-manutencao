// Regras puras da tela Funcionários de campo: nomes parecidos, códigos do lote e a planilha.
import assert from "node:assert/strict";
import test from "node:test";
import { codigosDoLote, lerPin, mapearCabecalho, semelhanca, separarFrentes } from "../lib/field-operators-rules.ts";

test("nomes: igual sem acento/maiúsculas/espaços; parecidos para decidir", () => {
  assert.equal(semelhanca("JOSÉ SALVADOR CARDOSO MELO", "jose  salvador cardoso melo"), "IGUAL");
  assert.equal(semelhanca("JOAO PEDRO SANTOS", "JOÃO PEDRO DA SILVA SANTOS"), "SOBRENOME_FALTANDO");
  assert.equal(semelhanca("CLAUDILSOM RIBEIRO DA SILVA", "CLAUDILSON RIBEIRO DA SILVA"), "GRAFIA");
  assert.equal(semelhanca("ANTONIO CARLOS LIMA", "ANTONIO MARCOS LIMA"), "PRIMEIRO_E_ULTIMO");
  assert.equal(semelhanca("ANTONIO CARLOS LIMA", "PEDRO HENRIQUE SOUZA"), null);
  assert.equal(semelhanca("JOSE", "JOSE SILVA"), null, "um nome só não é 'sobrenome faltando'");
});

test("códigos do lote: digitado vale, gerado sem óbvios e sem repetir", () => {
  const sequencia = [7391, 1234, 7391, 1111, 4826, 5820];
  let i = 0;
  const { codigos, erros } = codigosDoLote([{ codigo: "7391" }, { codigo: null }, { codigo: null }], () => sequencia[i++ % sequencia.length]);
  assert.deepEqual(erros, [null, null, null]);
  assert.equal(codigos[0], "7391");
  assert.equal(new Set(codigos).size, 3);
  assert.ok(codigos.every((codigo) => /^\d{4}$/.test(codigo) && !["1234", "1111"].includes(codigo)));
  const ruins = codigosDoLote([{ codigo: "1234" }, { codigo: "12" }, { codigo: "5820" }, { codigo: "5820" }, { codigo: "1990", anoNascimento: "1990" }], () => 4826).erros;
  assert.match(ruins[0], /fácil/);
  assert.match(ruins[1], /4 a 8/);
  assert.equal(ruins[2], null);
  assert.match(ruins[3], /repetido/);
  assert.match(ruins[4], /fácil/);
});

test("planilha: cabeçalho, frentes e PIN que o Excel virou número", () => {
  const { indices, faltando } = mapearCabecalho(["Nome", "Função sugerida", "Frente principal", "Outras frentes", "Equipamentos (setembro)", "Lançamentos em setembro", "PIN", "Conferir"]);
  assert.deepEqual(indices, { nome: 0, funcao: 1, frentePrincipal: 2, outrasFrentes: 3, equipamentos: 4, lancamentos: 5, pin: 6, conferir: 7 });
  assert.deepEqual(faltando, []);
  assert.deepEqual(mapearCabecalho(["Nome", "Função"]).faltando, ["Frente principal", "PIN"]);
  assert.deepEqual(separarFrentes("Arapiuns, Mamuru"), ["Arapiuns", "Mamuru"]);
  assert.deepEqual(separarFrentes("Arapiuns e Mamuru; Porto"), ["Arapiuns", "Mamuru", "Porto"]);
  assert.deepEqual(separarFrentes(""), []);
  assert.equal(lerPin(581), "0581");
  assert.equal(lerPin("0581"), "0581");
  assert.equal(lerPin(" 4826 "), "4826");
});
