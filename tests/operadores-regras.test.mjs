// Regras puras do acesso dos operadores (PIN) e dos funcionários de terceiros.
import assert from "node:assert/strict";
import test from "node:test";
import { deveTerAcesso, gerarPin, normalizarFuncao, pinObvio } from "../lib/operadores-regras.ts";
import { FUEL_PURPOSE_LABELS, parseThirdPartyEmployee, purposeText } from "../lib/third-party-rules.ts";
import { finalidadeTexto, lerFinalidade } from "../lib/assistente/pendentes-regras.ts";

test("PIN óbvio: repetidos, sequências, pares, anos e ano de nascimento", () => {
  for (const pin of ["0000", "1111", "1234", "4321", "0123", "9876", "1212", "1122", "1985", "2024"]) assert.equal(pinObvio(pin), true, pin);
  assert.equal(pinObvio("7391"), false);
  assert.equal(pinObvio("7391", "7391"), true, "ano de nascimento");
  assert.equal(pinObvio("123"), true, "menos de 4 dígitos");
  assert.equal(pinObvio("12a4"), true);
});

test("gerarPin: 4 dígitos e pula os óbvios", () => {
  const sequencia = [1234, 1111, 1990, 5820];
  let i = 0;
  assert.equal(gerarPin(() => sequencia[i++]), "5820");
  assert.equal(gerarPin(() => 47), "0047");
  for (let n = 0; n < 200; n++) { const pin = gerarPin((limite) => Math.floor(Math.random() * limite)); assert.match(pin, /^\d{4}$/); assert.equal(pinObvio(pin), false); }
  assert.throws(() => gerarPin(() => 1111), /PIN/);
});

test("quem tem acesso: não demitido e função que opera equipamento", () => {
  assert.equal(deveTerAcesso("ATIVO", true), true);
  assert.equal(deveTerAcesso("FOLGA", true), true);
  assert.equal(deveTerAcesso("AFASTADO", true), true);
  assert.equal(deveTerAcesso("DEMITIDO", true), false);
  assert.equal(deveTerAcesso("ATIVO", false), false);
  assert.equal(normalizarFuncao("  op. de  skidder "), "OP. DE SKIDDER");
});

test("funcionário de terceiro: nome obrigatório, CPF opcional com 11 dígitos", () => {
  assert.deepEqual(parseThirdPartyEmployee({ name: "joão silva", jobTitle: "motosserrista", cpf: "123.456.789-01", phone: " 93 9999-0000 " }).value,
    { name: "JOÃO SILVA", jobTitle: "MOTOSSERRISTA", cpf: "12345678901", phone: "93 9999-0000" });
  assert.match(parseThirdPartyEmployee({ name: "jo" }).error, /nome/);
  assert.match(parseThirdPartyEmployee({ name: "JOÃO", cpf: "123" }).error, /CPF/);
  assert.equal(parseThirdPartyEmployee({ name: "JOÃO" }).value.cpf, null);
});

test("finalidade: rótulos, texto de Outros e a fala da assistente", () => {
  assert.equal(FUEL_PURPOSE_LABELS.GALAO, "Galão / reserva");
  assert.equal(purposeText("OUTROS", "roçadeira"), "Outros: roçadeira");
  assert.equal(purposeText("GERADOR", null), "Gerador");
  assert.deepEqual(lerFinalidade("pra motosserra"), { finalidade: "MOTOSSERRA", texto: null });
  assert.deepEqual(lerFinalidade("moto serra"), { finalidade: "MOTOSSERRA", texto: null });
  assert.deepEqual(lerFinalidade("galão de reserva"), { finalidade: "GALAO", texto: null });
  assert.deepEqual(lerFinalidade("MAQUINA_NAO_CADASTRADA"), { finalidade: "MAQUINA_NAO_CADASTRADA", texto: null });
  assert.deepEqual(lerFinalidade("roçadeira"), { finalidade: "OUTROS", texto: "roçadeira" });
  assert.deepEqual(lerFinalidade("OUTROS"), { finalidade: "OUTROS", texto: null });
  assert.equal(lerFinalidade("  "), null);
  assert.equal(finalidadeTexto("OUTROS", "bomba d'água"), "Outros: bomba d'água");
});
