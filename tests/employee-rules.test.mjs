import assert from "node:assert/strict";
import test from "node:test";
import { absenceBadge, currentAbsence, nextDay, validateAbsence, validateEmployee } from "../lib/employee-rules.ts";

const valid = { name: "João da Silva", jobTitle: "Operador de Baldeio", company: "JC Serviços Florestais", admissionDate: "2025-03-10", serviceFrontId: 2, status: "ATIVO" };

test("cadastro exige todos os campos obrigatórios", () => {
  assert.equal(validateEmployee(valid, { requireFront: true }), null);
  assert.match(validateEmployee({ ...valid, name: "João" }, { requireFront: true }), /nome completo/);
  assert.match(validateEmployee({ ...valid, jobTitle: " " }, { requireFront: true }), /função/);
  assert.match(validateEmployee({ ...valid, company: "" }, { requireFront: true }), /empresa/);
  assert.match(validateEmployee({ ...valid, admissionDate: "10/03/2025" }, { requireFront: true }), /admissão/);
  assert.match(validateEmployee({ ...valid, serviceFrontId: null }, { requireFront: true }), /frente/);
  assert.equal(validateEmployee({ ...valid, serviceFrontId: null }, { requireFront: false }), null);
  assert.match(validateEmployee({ ...valid, status: "X" }, { requireFront: true }), /situação/);
});

test("ausência: tipo, início obrigatório e término não pode ser antes do início", () => {
  assert.equal(validateAbsence({ kind: "FERIAS", startDate: "2026-09-01", endDate: "2026-09-30" }), null);
  assert.equal(validateAbsence({ kind: "ATESTADO", startDate: "2026-09-01", endDate: null }), null);
  assert.match(validateAbsence({ kind: "FOLGA", startDate: "2026-09-10", endDate: "2026-09-01" }), /antes do início/);
  assert.match(validateAbsence({ kind: "NADA", startDate: "2026-09-10", endDate: null }), /tipo/);
});

test("ausência vigente e badge com data de retorno", () => {
  const absences = [
    { id: 1, kind: "FERIAS", startDate: "2026-08-01", endDate: "2026-08-30" },
    { id: 2, kind: "FOLGA", startDate: "2026-09-26", endDate: "2026-09-28" },
    { id: 3, kind: "ATESTADO", startDate: "2026-10-05", endDate: null },
  ];
  assert.equal(currentAbsence(absences, "2026-09-27").id, 2);
  assert.equal(currentAbsence(absences, "2026-09-29"), null);
  assert.equal(currentAbsence(absences, "2026-12-01").id, 3); // em aberto continua valendo
  assert.deepEqual(absenceBadge(absences[1]), { label: "De folga", returnDate: "2026-09-29" });
  assert.deepEqual(absenceBadge(absences[2]), { label: "Afastado", returnDate: null });
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

test("situações, CPF, matrícula e ciclo configurável", async () => {
  const { EMPLOYEE_STATUSES, isValidCpf, formatCpf, validateDismissal, nameKey } = await import("../lib/employee-rules.ts");
  assert.deepEqual([...EMPLOYEE_STATUSES], ["ATIVO", "FOLGA", "AFASTADO", "DEMITIDO"]);
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false);
  assert.equal(formatCpf("52998224725"), "529.982.247-25");
  assert.equal(validateEmployee({ ...valid, registration: "12345", cpf: "52998224725", birthDate: "1990-01-01", salary: 2500, cycleWorkDays: 60, cycleOffDays: 15 }, { requireFront: true }), null);
  assert.match(validateEmployee({ ...valid, registration: "12A" }, { requireFront: true }), /matrícula/);
  assert.match(validateEmployee({ ...valid, cpf: "12345678900" }, { requireFront: true }), /CPF/);
  assert.match(validateEmployee({ ...valid, birthDate: "2026-01-01" }, { requireFront: true }), /nascimento/);
  assert.match(validateEmployee({ ...valid, cycleWorkDays: 0 }, { requireFront: true }), /Dias trabalhados/);
  assert.match(validateEmployee({ ...valid, admissionDate: "2026-10-01" }, { requireFront: true, today: "2026-09-27" }), /futura/);
  assert.equal(validateDismissal({ dismissedAt: "2026-09-20", reason: "Pedido de demissão", rehireAllowed: true }, "2025-01-01", "2026-09-27"), null);
  assert.match(validateDismissal({ dismissedAt: "2026-09-20", reason: "x", rehireAllowed: true }, "2025-01-01", "2026-09-27"), /motivo/);
  assert.match(validateDismissal({ dismissedAt: "2026-09-20", reason: "Justa causa", rehireAllowed: undefined }, "2025-01-01", "2026-09-27"), /recontratado/);
  assert.equal(nameKey("João  da Silva"), "JOAO DA SILVA");
});
