// Regras puras dos lançamentos pendentes e da voz do Assistente JC (sem banco).
import assert from "node:assert/strict";
import test from "node:test";
import { numeroFalado } from "../lib/assistente/numeros.ts";
import { buscarPessoa, buscarPorNome, buscarProduto, descreverItem, fecharAvaliacao, lerData, palavras } from "../lib/assistente/pendentes-regras.ts";
import { textoParaLeitura } from "../lib/assistente-voz.ts";

test("números falados e escritos", () => {
  assert.equal(numeroFalado("cento e quarenta mil e novecentos"), 140900);
  assert.equal(numeroFalado("dois"), 2);
  assert.equal(numeroFalado("duas"), 2);
  assert.equal(numeroFalado("meia dúzia"), 6);
  assert.equal(numeroFalado("uma dúzia"), 12);
  assert.equal(numeroFalado("um e meio"), 1.5);
  assert.equal(numeroFalado("trezentos litros"), 300);
  assert.equal(numeroFalado("dois mil e quinhentos"), 2500);
  assert.equal(numeroFalado("140.900"), 140900);
  assert.equal(numeroFalado("140 900"), 140900);
  assert.equal(numeroFalado("1,5"), 1.5);
  assert.equal(numeroFalado("300l"), 300);
  assert.equal(numeroFalado("140900 km"), 140900);
  assert.equal(numeroFalado(42), 42);
  assert.equal(numeroFalado("filtro"), null);
  assert.equal(numeroFalado(""), null);
});

const PRODUTOS = [
  { id: 1, tag: "11", nome: "FILTRO DE COMBUSTÍVEL PC200" },
  { id: 2, tag: "12", nome: "FILTRO DE COMBUSTÍVEL CAMINHÃO AXOR" },
  { id: 3, tag: "300", nome: "LIMA REDONDA STIHL 5,5MM" },
  { id: 4, tag: "108", nome: "CORRENTE STIHL 42 DENTES ROLO 819D", referencias: ["819D"] },
  { id: 5, tag: "0069", nome: "ÓLEO SAE 15W40 20L" },
];

test("produto: TAG tem prioridade; nome sem acento/maiúsculas; mais de um = pergunta (até 5)", () => {
  assert.equal(buscarProduto(PRODUTOS, { texto: "filtro de combustível", tag: "11" }).escolhido?.id, 1);
  assert.equal(buscarProduto(PRODUTOS, { texto: "filtro de combustível TAG 11" }).escolhido?.id, 1);
  assert.equal(buscarProduto(PRODUTOS, { tag: "69" }).escolhido?.id, 5, "zeros à esquerda na TAG");
  const ambiguo = buscarProduto(PRODUTOS, { texto: "filtro de combustivel" });
  assert.equal(ambiguo.escolhido, null);
  assert.deepEqual(ambiguo.opcoes.map((item) => item.id).sort(), [1, 2]);
  assert.equal(buscarProduto(PRODUTOS, { texto: "lima redonda" }).escolhido?.id, 3);
  assert.equal(buscarProduto(PRODUTOS, { texto: "correntes 42 dentes" }).escolhido?.id, 4, "plural");
  assert.equal(buscarProduto(PRODUTOS, { texto: "819d" }).escolhido?.id, 4, "referência");
  const trocada = buscarProduto(PRODUTOS, { texto: "lima redonda", tag: "11" });
  assert.equal(trocada.escolhido?.id, 1);
  assert.match(trocada.aviso ?? "", /não parece ser/);
  assert.equal(buscarProduto(PRODUTOS, { texto: "parafuso sextavado" }).escolhido, null);
  assert.equal(buscarProduto(PRODUTOS, { tag: "999" }).escolhido, null);
});

const PESSOAS = [
  { id: 1, nome: "CLAUDILSON SOUZA LIMA", ativo: true, frenteId: 1 },
  { id: 2, nome: "VANDERSON PEREIRA", ativo: true, frenteId: 1 },
  { id: 3, nome: "JOSÉ PEREIRA", ativo: true, frenteId: 1 },
  { id: 4, nome: "JOSÉ SANTOS", ativo: true, frenteId: 2 },
  { id: 5, nome: "FABRÍCIO ALVES", ativo: true, frenteId: 1 },
  { id: 6, nome: "MARCOS DEMITIDO", ativo: false, frenteId: 1 },
];

test("colaborador: primeiro nome único escolhe; ambíguo ou parecido pergunta; demitido não", () => {
  assert.equal(buscarPessoa(PESSOAS, "Claudilson").escolhido?.id, 1);
  assert.equal(buscarPessoa(PESSOAS, "fabricio").escolhido?.id, 5);
  const jose = buscarPessoa(PESSOAS, "José", 2);
  assert.equal(jose.escolhido, null);
  assert.deepEqual(jose.opcoes.map((item) => item.id), [4, 3], "a frente do lançamento vem primeiro");
  assert.equal(buscarPessoa(PESSOAS, "José Santos").escolhido?.id, 4);
  const parecido = buscarPessoa(PESSOAS, "Claudilsom");
  assert.equal(parecido.escolhido, null, "nome parecido nunca é escolhido sozinho");
  assert.deepEqual(parecido.opcoes.map((item) => item.id), [1]);
  const demitido = buscarPessoa(PESSOAS, "Marcos Demitido");
  assert.equal(demitido.escolhido, null);
  assert.match(demitido.motivo ?? "", /demitido/);
  assert.match(buscarPessoa(PESSOAS, "Ninguém Aqui").motivo ?? "", /não está no cadastro/);
});

test("cadastros por nome, datas e status", () => {
  const deps = [{ id: 1, nome: "ALIMENTAÇÃO" }, { id: 2, nome: "MANUTENÇÃO DA FROTA" }];
  assert.equal(buscarPorNome(deps, "alimentacao").escolhido?.id, 1);
  assert.equal(buscarPorNome(deps, "manutenção").escolhido?.id, 2);
  assert.equal(lerData("hoje", "2026-10-02"), "2026-10-02");
  assert.equal(lerData("ontem", "2026-10-01"), "2026-09-30");
  assert.equal(lerData("25/09", "2026-10-02"), "2026-09-25");
  assert.equal(lerData("5/9/26", "2026-10-02"), "2026-09-05");
  assert.equal(lerData("amanhã cedo", "2026-10-02"), null);
  assert.equal(fecharAvaliacao([], [], []).status, "PRONTO");
  assert.equal(fecharAvaliacao([], ["estoque vai ficar baixo"], []).status, "ATENCAO");
  assert.equal(fecharAvaliacao(["estoque insuficiente"], ["aviso"], []).status, "BLOQUEADO");
  const incompleto = fecharAvaliacao([], [], ["Qual produto?"]);
  assert.equal(incompleto.status, "BLOQUEADO");
  assert.equal(incompleto.incompleto, true);
  assert.deepEqual(palavras("Correntes de 42 Dentes"), ["corrente", "42", "dente"]);
});

test("descrição curta do item", () => {
  const base = { frente: { id: 1, nome: "Arapiuns" }, data: "2026-10-02", observacao: null, duvidas: {}, alertas: {} };
  assert.equal(descreverItem({ ...base, tipo: "SAIDA_PRODUTO", produto: { id: 1, tag: "11", nome: "FILTRO" }, quantidade: 1, destino: "EQUIPAMENTO", equipamento: { id: 1, prefixo: "PC-20" }, colaborador: null, departamento: null, terceiro: null, veiculoTerceiro: null, recebidoPor: null }),
    "1 FILTRO (TAG 11) para PC-20");
  assert.equal(descreverItem({ ...base, tipo: "SAIDA_COMBUSTIVEL", combustivel: { id: 1, nome: "Diesel S10" }, estoque: "FRENTE", litros: 300, alvo: "FROTA", equipamento: { id: 2, prefixo: "CM-35", controle: "KM" }, terceiro: null, veiculo: null, leitura: 140900, tanqueCheio: true, responsavel: { id: 5, nome: "FABRÍCIO ALVES" } }),
    "300 L de Diesel S10 no CM-35 (km 140.900), motorista FABRÍCIO ALVES");
});

test("leitura em voz alta: só o texto principal, nunca tabelas", () => {
  const texto = "Saldo em **Arapiuns**: 8.055 L\n\n| Frente | Litros |\n|---|---|\n| Arapiuns | 8.055 |\n- Consumo 4 km/L";
  const lido = textoParaLeitura(texto);
  assert.doesNotMatch(lido, /\|/);
  assert.doesNotMatch(lido, /\*\*/);
  assert.match(lido, /8\.055 litros/);
  assert.match(lido, /quilômetros por litro/);
});
