// Regras puras da importação do sistema de pessoal (lib/personnel-import-rules.ts) e da situação
// calculada / folga vendida. Dados sintéticos — nunca dados reais de funcionários.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonnelPlan, canonicalFunction, duplicateTarget, fixCycleOrder, noInfo, operatesEquipment, parseCycleStart, parseDate, parseMoney, parseMovement, parsePeriod, similarName,
} from "../lib/personnel-import-rules.ts";
import { computeSituation } from "../lib/employee-rules.ts";
import { summarizeStoredCycle } from "../lib/leave-cycle.ts";

test("valores: '-', '—' e vazio = sem informação; datas nos dois formatos; 01/01/0001 descartada; salário", () => {
  for (const value of ["-", "—", "", "  ", null, undefined, "...", "…"]) assert.equal(noInfo(value), null);
  assert.equal(parseDate("10/06/2026"), "2026-06-10");
  assert.equal(parseDate("2026-06-10"), "2026-06-10");
  assert.equal(parseDate("1/2/2026"), "2026-02-01");
  assert.equal(parseDate("01/01/0001"), null);
  assert.equal(parseDate("0001-01-01"), null);
  assert.equal(parseDate("31/02/2026"), null);
  assert.equal(parseDate("-"), null);
  assert.equal(parseMoney("1.732,00"), 1732);
  assert.equal(parseMoney("2.327,50"), 2327.5);
  assert.equal(parseMoney("-"), null);
});

test("colunas grudadas: início do ciclo, período de afastamento e eventos de movimentação", () => {
  assert.deepEqual(parseCycleStart("24/06/2026ciclo 1 · vence 22/09/2026"), { start: "2026-06-24", cycle: 1, due: "2026-09-22" });
  assert.deepEqual(parseCycleStart("10/09/2026ciclo 2 · vence 09/12/2026"), { start: "2026-09-10", cycle: 2, due: "2026-12-09" });
  assert.equal(parseCycleStart("afastado"), null);
  assert.equal(parseCycleStart(null), null);
  assert.deepEqual(parsePeriod("08/07/2025 a 21/09/2026 — Motivo qualquer"), { start: "2025-07-08", end: "2026-09-21", reason: "Motivo qualquer" });
  assert.deepEqual(parsePeriod("26/09/2026 a em aberto"), { start: "2026-09-26", end: null, reason: null });
  assert.deepEqual(parsePeriod("31/08/2026 a 08/09/2026"), { start: "2026-08-31", end: "2026-09-08", reason: null });
  assert.deepEqual(parseMovement("Transferido de MAMURU para ARAPIUNS"), { kind: "TRANSFER", from: "MAMURU", to: "ARAPIUNS" });
  assert.deepEqual(parseMovement("Transferido de - para FLEXAL"), { kind: "TRANSFER", from: null, to: "FLEXAL" });
  assert.deepEqual(parseMovement("Lotado no(a) MAMURU"), { kind: "PLACED", front: "MAMURU" });
  assert.deepEqual(parseMovement("Reativado"), { kind: "REHIRED" });
  assert.deepEqual(parseMovement("Desligado — teste"), { kind: "DISMISSED", reason: "teste", test: true });
  assert.deepEqual(parseMovement("Desligado — sem motivo informado"), { kind: "DISMISSED", reason: null, test: false });
  assert.deepEqual(parseMovement("Desligado — PEDIDO DE DEMISSÃO —"), { kind: "DISMISSED", reason: "PEDIDO DE DEMISSÃO", test: false });
  assert.equal(duplicateTarget("FULANO DE TAL (DUPLICADO - MESCLADO NO #411)", "-"), "411");
  assert.equal(duplicateTarget("FULANO DE TAL", "Registro duplicado - mesclado com o cadastro #291 em 11/09/2026"), "291");
  assert.equal(duplicateTarget("FULANO DE TAL", "PEDIDO DE DEMISSÃO"), null);
});

test("funções: grafias unificadas e 'Opera equipamento' (motosserra e ajudante não)", () => {
  assert.equal(canonicalFunction("MOT. DE CAMINHAO NIVEL III"), "MOTORISTA DE CAMINHAO NIVEL III");
  assert.equal(canonicalFunction("MOT.DE CAMINHÃO NIVEL III"), "MOTORISTA DE CAMINHAO NIVEL III");
  assert.equal(canonicalFunction("AJUDANTE DE OPERADOR DE MOTOSSERRA"), "AJUDANTE OPERADOR DE MOTOSSERRA");
  assert.equal(canonicalFunction("lavador (a) de roupas"), "LAVADEIRA");
  assert.equal(canonicalFunction("COZINHEIRA"), "COZINHEIRA");
  for (const name of ["MOTORISTA DE CAMINHAO NIVEL III", "MOTORISTA DE APOIO", "MOTORISTA DE COMBOIO", "OP. DE PÁ CARREGADEIRA", "OP. DE SKIDDER", "OPERADOR DE TRATOR DE ESTEIRA", "OP. DE MOTONIVELADORA"])
    assert.equal(operatesEquipment(name), true, name);
  for (const name of ["OP. DE MOTOSSERRA - DERRUBA", "OPERADOR DE MOTOSSERRA", "AJUDANTE OPERADOR DE MOTOSSERRA", "AJUD. DE OP. DE TRATOR", "MEC. DE MOTOSSERRA", "EQUIPE DE ARRASTE", "COZINHEIRO"])
    assert.equal(operatesEquipment(name), false, name);
});

test("ciclo com datas fora de ordem: nenhuma etapa fica depois da seguinte (e anota a original)", () => {
  const fixed = fixCycleOrder({ workStart: "2026-05-22", frontDeparture: "2026-08-20", homeArrival: "2026-08-20", homeDeparture: "2026-09-06", frontArrival: "2026-09-05" });
  assert.equal(fixed.dates.homeDeparture, "2026-09-05");
  assert.match(fixed.notes[0], /saída de casa na origem: 06\/09\/2026/);
  assert.equal(fixCycleOrder({ workStart: "2026-06-01", frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null }).notes.length, 0);
});

test("nomes parecidos: até 2 letras ou nome cortado", () => {
  assert.equal(similarName("JOSE DA SILVA SOUZA", "JOSE DA SILVA SOUSA"), true);
  assert.equal(similarName("MARIA APARECIDA FERREIRA DO NASCI", "MARIA APARECIDA FERREIRA DO NASCIMENTO"), true);
  assert.equal(similarName("JOSE DA SILVA SOUZA", "JOAO PEREIRA LIMA"), false);
  assert.equal(similarName("JOSE DA SILVA", "JOSÉ DA SILVA"), false, "igual não é 'parecido' (casa pelo nome)");
});

test("situação calculada e folga vendida", () => {
  const absence = { id: 1, kind: "ATESTADO", startDate: "2026-10-01", endDate: null };
  assert.equal(computeSituation({ status: "DEMITIDO", atHeadquarters: true, absence, phase: "FOLGA" }), "DESLIGADO");
  assert.equal(computeSituation({ status: "ATIVO", atHeadquarters: false, absence, phase: "TRABALHANDO" }), "AFASTADO");
  assert.equal(computeSituation({ status: "ATIVO", atHeadquarters: true, absence: null, phase: null }), "SEDE");
  assert.equal(computeSituation({ status: "FOLGA", atHeadquarters: false, absence: null, phase: "FOLGA" }), "DE_FOLGA");
  assert.equal(computeSituation({ status: "FOLGA", atHeadquarters: false, absence: null, phase: "VIAGEM_IDA" }), "EM_VIAGEM");
  assert.equal(computeSituation({ status: "FOLGA", atHeadquarters: false, absence: null, phase: "VIAGEM_VOLTA" }), "EM_VIAGEM");
  assert.equal(computeSituation({ status: "ATIVO", atHeadquarters: false, absence: { ...absence, kind: "FERIAS" }, phase: "TRABALHANDO" }), "TRABALHANDO");
  const sold = summarizeStoredCycle({ workStart: "2026-07-01", frontDeparture: null, homeArrival: null, homeDeparture: null, frontArrival: null, endedAt: "2026-09-29", leaveKind: "VENDIDA", workDaysTarget: 90, offDaysTarget: 10 }, "2026-10-05");
  assert.equal(sold.phaseLabel, "Folga vendida");
  assert.equal(sold.workedDays, 90);
  assert.equal(sold.alert, null);
});

// Exportação sintética com os casos combinados no mapa.
function exportSheets() {
  const colab = (id, nome, extra = {}) => ({
    "Frente": "ARAPIUNS", "Lista": "Ativos", "Matrícula": "-", "Colaborador": nome, "Colaborador - detalhe": "OP. DE SKIDDER", "Empresa": "JC", "Cidade": "-", "Nascimento": "-",
    "Admissão": "10/06/2026", "Situação": "Trabalhando", "ID sistema": id, "Matrícula (ficha)": null, "Nome (ficha)": nome, "Função (ficha)": "OP. DE SKIDDER", "Empresa (ficha)": "JC",
    "Admissão (ficha)": "2026-06-10", "Nascimento (ficha)": null, "Cidade (ficha)": null, "CPF": "-", "Salário CTPS": "-", "Fica na sede": "Não", "Desligado em": null, "Motivo": null, "Restrição": null, ...extra,
  });
  return {
    "Colaboradores": [
      colab("1", "ALFA TESTE UM", { "Matrícula (ficha)": "501", "Matrícula": "501", "Salário CTPS": "2.000,00", "Função (ficha)": "MOT. DE CAMINHAO NIVEL III" }),
      colab("2", "BETA TESTE DOIS", { "Empresa": "Renascer", "Empresa (ficha)": "Renascer", "Situação": "De folga" }),
      colab("3", "GAMA TESTE TRES", { "Lista": "Desligados", "Situação": null, "Desligado em": "25/09/2026", "Motivo": "PEDIDO DE DEMISSÃO", "Restrição": "Restrito" }),
      colab("4", "GAMA TESTE TRES (DUPLICADO - MESCLADO NO #3)", { "Lista": "Desligados", "Situação": null, "Desligado em": "11/09/2026", "Motivo": "Registro duplicado - mesclado com o cadastro #3 em 11/09/2026" }),
      colab("5", "DELTA TESTE CINCO", { "Situação": "Sede", "Fica na sede": "Sim", "Admissão (ficha)": "0001-01-01", "Admissão": "01/01/0001" }),
      colab("6", "EPSILON TESTE SEIS", { "Situação": "Afastado" }),
      colab("7", "ZETA", { "Admissão (ficha)": "0001-01-01" }),
      colab("8", "ETA TESTE OITO"),
    ],
    "Resumo por pessoa": [{ "ID sistema": "1", "Colaborador": "ALFA TESTE UM", "Função": "MOT. DE CAMINHAO NIVEL III", "Matrícula": "501", "Status": "Ativo", "Frente atual": "ARAPIUNS", "Admissão": "10/06/2026", "Total de assinaturas": "4", "Pendências atuais": "22", "Faltas": "0" }],
    "Ciclos de folga (painel)": [
      { "Colaborador": "ALFA TESTE UM", "Empresa": "JC", "Início do ciclo": "29/09/2026ciclo 2 · vence 28/12/2026", "Situação": "Trabalhando faltam 86 d p/ vencer" },
      { "Colaborador": "BETA TESTE DOIS", "Empresa": "Renascer", "Início do ciclo": "10/06/2026ciclo 1 · vence 08/09/2026", "Situação": "Folga vencida ... venceu há 25 d" },
      { "Colaborador": "EPSILON TESTE SEIS", "Empresa": "JC", "Início do ciclo": "afastado", "Situação": "Afastado afastado há 3 d" },
      { "Colaborador": "ETA TESTE OITO", "Empresa": "JC", "Início do ciclo": "10/06/2026ciclo 1 · vence 08/09/2026", "Situação": "x" },
    ],
    "Histórico de folgas": [
      { "Colaborador": "ALFA TESTE UM", "Emp.": "JC", "Ciclo": "1", "Início": "01/07/2026", "Dias trab.": "90", "Saída": "—", "Chegada casa": "—", "Saída casa": "—", "Chegada frente": "—", "Tipo": "VENDIDA" },
      { "Colaborador": "GAMA TESTE TRES (DUPLICADO - MESCLADO NO #3)", "Emp.": "JC", "Ciclo": "1", "Início": "10/06/2026", "Dias trab.": "80", "Saída": "29/08/2026", "Chegada casa": "30/08/2026", "Saída casa": "09/09/2026", "Chegada frente": "10/09/2026", "Tipo": "Usufruída" },
    ],
    "De folga": [{ "Colaborador": "BETA TESTE DOIS", "Empresa": "Renascer", "Chegou em casa": "02/10/2026", "Término previsto": "12/10/2026", "Dias restantes": "9 d", "Situação": "De folga" }],
    "Em viagem": [{ "Colaborador": "ETA TESTE OITO", "Empresa": "JC", "Saiu da frente": "26/09/2026", "Dias em viagem": "7 d" }],
    "Viagem de retorno": [{ "Aviso": "Nenhum registro encontrado no sistema" }],
    "Faltas": [{ "Aviso": "Nenhum registro encontrado no sistema" }],
    "Afastamentos": [{ "Colaborador": "EPSILON TESTE SEIS", "Colaborador - detalhe": "OP. DE SKIDDER", "Início · Retorno · Motivo": "29/09/2026 a em aberto — Motivo sigiloso" }],
    "Ausências (por pessoa)": [
      { "ID sistema": "6", "Colaborador": "Selecione um colaborador", "Tipo": "Afastamento", "Período": "29/09/2026 a em aberto", "Motivo / observação": "Motivo sigiloso", "Frente": "ARAPIUNS" },
      { "ID sistema": "8", "Colaborador": "Selecione um colaborador", "Tipo": "Afastamento", "Período": "31/08/2026 a 08/09/2026", "Motivo / observação": "ATESTADO", "Frente": "ARAPIUNS" },
      { "ID sistema": "2", "Colaborador": "Selecione um colaborador", "Tipo": "Folga", "Período": "29/09/2026 a em aberto", "Motivo / observação": "-", "Frente": "ARAPIUNS" },
    ],
    "Transferências": [
      { "Data": "27/08/2026", "Colaborador": "ALFA TESTE UM", "Colaborador - detalhe": "· mat. 501", "Empresa": "JC", "De": "MAMURU", "Para": "ARAPIUNS", "Frente": "ARAPIUNS" },
      { "Data": "27/08/2026", "Colaborador": "ALFA TESTE UM", "Colaborador - detalhe": "· mat. 501", "Empresa": "JC", "De": "MAMURU", "Para": "ARAPIUNS", "Frente": "MAMURU" },
    ],
    "Movimentações": [
      { "ID sistema": "1", "Data": "27/08/2026", "Evento": "Transferido de MAMURU para ARAPIUNS" },
      { "ID sistema": "1", "Data": "27/08/2026", "Evento": "Desligado — Não consta na relação" },
      { "ID sistema": "8", "Data": "10/09/2026", "Evento": "Desligado — teste" },
      { "ID sistema": "8", "Data": "10/09/2026", "Evento": "Reativado" },
      { "ID sistema": "3", "Data": "25/09/2026", "Evento": "Desligado — sem motivo informado" },
      { "ID sistema": "3", "Data": "25/09/2026", "Evento": "Reativado" },
      { "ID sistema": "3", "Data": "25/09/2026", "Evento": "Desligado — PEDIDO DE DEMISSÃO" },
      { "ID sistema": "4", "Data": "11/09/2026", "Evento": "Desligado — Registro duplicado - mesclado com o cadastro #3" },
      { "ID sistema": "4", "Data": "13/04/2023", "Evento": "Lotado no(a) MAMURU" },
    ],
    "Lista de restrição": [
      { "Colaborador": "GAMA TESTE TRES", "Empresa": "JC", "Desligado em": "25/09/2026", "Motivo": "PEDIDO DE DEMISSÃO", "Frente": "ARAPIUNS" },
      { "Colaborador": "GAMA TESTE TRES", "Empresa": "JC", "Desligado em": "25/09/2026", "Motivo": "PEDIDO DE DEMISSÃO", "Frente": "MAMURU" },
    ],
  };
}

test("plano: duplicados, teste, desligamentos, ciclos, viagem/folga, afastamentos e restrição", () => {
  const plan = buildPersonnelPlan(exportSheets(), "2026-10-05");
  const by = (id) => plan.people.find((person) => person.externalId === id);
  assert.equal(plan.people.length, 7, "duplicado não vira pessoa");
  assert.ok(plan.ignored.some((row) => /duplicado/.test(row.reason) && row.name === "GAMA TESTE TRES"));
  assert.ok(plan.ignored.some((row) => /teste/.test(row.reason)));
  assert.equal(plan.totals.collaborators, 8);
  assert.equal(plan.totals.dismissed, 2);
  assert.equal(plan.totals.restricted, 1, "restrição deduplicada por pessoa");
  assert.equal(plan.exportDate, "2026-10-02");

  // Ativo com desligamento sem reativação: fica revertido na mesma data; transferência deduplicada.
  const alfa = by("1");
  assert.equal(alfa.jobTitle, "MOTORISTA DE CAMINHAO NIVEL III");
  assert.equal(alfa.salary, 2000);
  assert.equal(alfa.status, "ATIVO");
  assert.equal(alfa.dismissals.length, 1);
  assert.equal(alfa.dismissals[0].rehiredAt, "2026-08-27");
  assert.equal(alfa.transfers.filter((item) => item.from === "MAMURU").length, 1);
  assert.ok(alfa.transfers.some((item) => item.from === null && item.to === "MAMURU" && item.date === "2026-06-10"), "frente inicial na admissão");
  // Folga vendida: ciclo 1 termina quando o ciclo 2 do painel começa.
  assert.equal(alfa.cycles[0].leaveKind, "VENDIDA");
  assert.equal(alfa.cycles[0].endedAt, "2026-09-29");
  assert.equal(alfa.cycles[1].workStart, "2026-09-29");

  // De folga: chegada em casa no ciclo aberto; "Folga" da aba Ausências não vira afastamento.
  const beta = by("2");
  assert.equal(beta.company, "RENASCER");
  assert.equal(beta.cycles[0].homeArrival, "2026-10-02");
  assert.equal(beta.status, "FOLGA");
  assert.equal(beta.absences.length, 0);

  // Desligado restrito: D → R → D no mesmo dia vale só o último; histórico do duplicado vem para ele.
  const gama = by("3");
  assert.equal(gama.status, "DEMITIDO");
  assert.equal(gama.dismissals.length, 1);
  assert.equal(gama.dismissals[0].rehireAllowed, false);
  assert.equal(gama.dismissals[0].reason, "PEDIDO DE DEMISSÃO");
  assert.ok(gama.cycles.some((cycle) => cycle.frontArrival === "2026-09-10"), "ciclo do cadastro duplicado");
  assert.ok(gama.transfers.some((item) => item.to === "MAMURU" && item.date === "2023-04-13"), "lotação do cadastro duplicado");
  assert.ok(gama.cycles.every((cycle) => cycle.frontArrival || cycle.endedAt), "desligado não fica com ciclo aberto");

  // Sede sem admissão válida: erro (não cria pessoa nova); nome sem sobrenome também.
  assert.equal(by("5").atHeadquarters, true);
  assert.ok(by("5").errors.some((error) => /admissão/.test(error)));
  assert.ok(by("7").errors.some((error) => /sobrenome/.test(error)));

  // Afastamento das duas abas sem duplicar; retorno informado → término no dia anterior.
  const epsilon = by("6");
  assert.equal(epsilon.absences.length, 1);
  assert.equal(epsilon.absences[0].endDate, null);
  assert.equal(epsilon.status, "AFASTADO");
  const eta = by("8");
  assert.deepEqual(eta.absences.map((item) => [item.kind, item.startDate, item.endDate]), [["ATESTADO", "2026-08-31", "2026-09-07"]]);
  // "Desligado — teste" + reativação: ignorados; Em viagem: saída da frente no ciclo aberto.
  assert.equal(eta.dismissals.length, 0);
  assert.equal(eta.cycles[0].frontDeparture, "2026-09-26");
  assert.equal(eta.status, "FOLGA");
});
