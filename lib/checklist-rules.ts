// ---------------------------------------------------------------------------
// Regras puras do checklist pré-uso (sem banco), para a tela e o servidor usarem as mesmas.
// ---------------------------------------------------------------------------
export type ChecklistStatus = "OK" | "PENDENCIA" | "BLOQUEADO";
export type ChecklistItem = { id: number; label: string; blocking: boolean; photoRequired: boolean };
export type ChecklistAnswerDraft = { itemId: number; ok: boolean | null; comment: string; hasPhoto: boolean };

export const CHECKLIST_STATUS_LABELS: Record<ChecklistStatus, string> = { OK: "Tudo OK", PENDENCIA: "Com pendência", BLOQUEADO: "Bloqueado — não operar" };

// Erros por item (chave = id do item). Todo item precisa de resposta; "Não OK" precisa de
// comentário e, se o item pedir, de foto.
export function validateChecklist(items: ChecklistItem[], answers: ChecklistAnswerDraft[]) {
  const errors: Record<number, string> = {};
  const byItem = new Map(answers.map((answer) => [answer.itemId, answer]));
  for (const item of items) {
    const answer = byItem.get(item.id);
    if (!answer || answer.ok === null) { errors[item.id] = "Marque OK ou Não OK."; continue; }
    if (answer.ok) continue;
    if (answer.comment.trim().length < 3) errors[item.id] = "Descreva o problema.";
    else if (item.photoRequired && !answer.hasPhoto) errors[item.id] = "Tire uma foto do problema.";
  }
  return errors;
}

export function checklistStatus(items: ChecklistItem[], answers: Array<{ itemId: number; ok: boolean | null }>): ChecklistStatus {
  const failed = new Set(answers.filter((answer) => answer.ok === false).map((answer) => answer.itemId));
  if (!failed.size) return "OK";
  return items.some((item) => item.blocking && failed.has(item.id)) ? "BLOQUEADO" : "PENDENCIA";
}

// Texto da O.S. aberta pelo checklist: um item por linha, com o comentário do operador.
export function workOrderDescription(prefix: string, operator: string, failed: Array<{ label: string; comment: string; blocking: boolean }>) {
  const lines = failed.map((item) => `• ${item.label}${item.blocking ? " (BLOQUEIA)" : ""}: ${item.comment.trim()}`);
  return `Checklist pré-uso do ${prefix} (${operator}) com ${failed.length} item(ns) Não OK:\n${lines.join("\n")}`.slice(0, 2000);
}
