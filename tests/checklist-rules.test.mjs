import assert from "node:assert/strict";
import test from "node:test";
import { checklistStatus, validateChecklist, workOrderDescription } from "../lib/checklist-rules.ts";

const items = [
  { id: 1, label: "Óleo do motor", blocking: true, photoRequired: true },
  { id: 2, label: "Luzes", blocking: false, photoRequired: false },
  { id: 3, label: "Extintor", blocking: false, photoRequired: true },
];

test("todo item precisa de resposta; Não OK precisa de comentário e foto quando pedida", () => {
  const errors = validateChecklist(items, [
    { itemId: 1, ok: false, comment: "", hasPhoto: true },
    { itemId: 2, ok: false, comment: "farol queimado", hasPhoto: false },
    { itemId: 3, ok: false, comment: "vencido", hasPhoto: false },
  ]);
  assert.deepEqual(errors, { 1: "Descreva o problema.", 3: "Tire uma foto do problema." });
  assert.deepEqual(validateChecklist(items, [{ itemId: 1, ok: true, comment: "", hasPhoto: false }]), { 2: "Marque OK ou Não OK.", 3: "Marque OK ou Não OK." });
});

test("situação: OK, pendência e bloqueado quando item que bloqueia falha", () => {
  assert.equal(checklistStatus(items, [{ itemId: 1, ok: true }, { itemId: 2, ok: true }, { itemId: 3, ok: true }]), "OK");
  assert.equal(checklistStatus(items, [{ itemId: 1, ok: true }, { itemId: 2, ok: false }, { itemId: 3, ok: true }]), "PENDENCIA");
  assert.equal(checklistStatus(items, [{ itemId: 1, ok: false }, { itemId: 2, ok: true }, { itemId: 3, ok: true }]), "BLOQUEADO");
});

test("descrição da O.S. lista os itens com problema", () => {
  const text = workOrderDescription("CM-10", "João", [{ label: "Óleo do motor", comment: "abaixo do mínimo", blocking: true }]);
  assert.match(text, /CM-10 \(João\)/);
  assert.match(text, /• Óleo do motor \(BLOQUEIA\): abaixo do mínimo/);
});
