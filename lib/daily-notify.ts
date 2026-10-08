import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { clip } from "./notification-events";
import { notify } from "./notifications";

// ---------------------------------------------------------------------------
// Notificações do Controle Diário e do checklist: pedido e resposta de mudança de frente, problema
// informado pelo operador e checklist com pendência ou bloqueado. Chamadas pelas rotas com
// runAfterResponse (depois da resposta, sem derrubar o lançamento).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const first = async (query: ReturnType<typeof sql>) => ((await (await getDb()).execute(query)) as unknown as { rows: Row[] }).rows[0] ?? null;
const br = (day: string) => day.slice(0, 10).split("-").reverse().join("/");
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

async function frontRequest(id: number) {
  const row = await first(sql`SELECT r.id, r.status, r.requested_by, r.current_service_front_id, r.requested_service_front_id, r.review_note, e.prefix,
      coalesce(cf.name, 'Sem frente') AS current_front, coalesce(rf.name, 'Sem frente') AS requested_front, u.name AS requester,
      (SELECT array_agg(DISTINCT dr.user_id) FROM daily_records dr WHERE dr.front_change_request_id = r.id) AS operators,
      (SELECT coalesce(dr.operator_name, du.name) FROM daily_records dr JOIN users du ON du.id = dr.user_id WHERE dr.front_change_request_id = r.id ORDER BY dr.id DESC LIMIT 1) AS last_operator
    FROM service_front_change_requests r JOIN equipment e ON e.id = r.equipment_id JOIN users u ON u.id = r.requested_by
    LEFT JOIN service_fronts cf ON cf.id = r.current_service_front_id LEFT JOIN service_fronts rf ON rf.id = r.requested_service_front_id
    WHERE r.id = ${id}`);
  if (!row) return null;
  return {
    status: String(row.status), requestedBy: Number(row.requested_by), prefix: String(row.prefix), currentFront: String(row.current_front), requestedFront: String(row.requested_front),
    fronts: [row.current_service_front_id, row.requested_service_front_id].filter((value) => value !== null).map(Number),
    operators: ((row.operators as number[] | null) ?? []).map(Number), who: text(row.last_operator) ?? String(row.requester), reviewNote: text(row.review_note),
  };
}

// Operador informou outra frente no Controle Diário: avisa quem aprova (frente atual ou pedida).
export async function notifyFrontRequest(requestId: number, created: boolean, actorId: number) {
  const item = await frontRequest(requestId);
  if (!item || item.status !== "PENDING") return;
  await notify({
    event: "front_change.requested", frontIds: item.fronts, frontId: item.fronts[1] ?? item.fronts[0] ?? null, actorId,
    title: created ? `Pedido de mudança de frente: ${item.prefix}` : `Nova indicação de mudança de frente: ${item.prefix}`,
    body: `${item.currentFront} → ${item.requestedFront} · informado por ${item.who}`,
    link: { secao: "Controle Diário", aba: "fronts" },
  });
}

// Pedido aprovado ou recusado: avisa quem pediu e os operadores que indicaram a mesma mudança.
export async function notifyFrontAnswer(requestId: number, options: { actorId: number; notify: boolean; message: string | null }) {
  if (!options.notify) return;
  const item = await frontRequest(requestId);
  if (!item || item.status === "PENDING") return;
  const approved = item.status === "APPROVED";
  await notify({
    event: "front_change.answered", to: [item.requestedBy, ...item.operators], actorId: options.actorId, frontId: item.fronts[1] ?? null,
    title: `Mudança de frente ${approved ? "aprovada" : "recusada"}: ${item.prefix}`,
    body: [`${item.currentFront} → ${item.requestedFront}${approved ? "" : ` (continua em ${item.currentFront})`}`, item.reviewNote ? `Observação: ${item.reviewNote}` : null, options.message ? `Mensagem: ${clip(options.message, 300)}` : null].filter(Boolean).join("\n"),
    link: { secao: "Controle Diário" },
  });
}

// Operador marcou "inativo ou com problema" no Controle Diário.
export async function notifyDailyProblem(recordId: number, actorId: number) {
  const row = await first(sql`SELECT d.problem_reason, d.record_date, d.inactive_or_problem, e.prefix, e.service_front_id, coalesce(d.operator_name, u.name) AS operator
    FROM daily_records d JOIN equipment e ON e.id = d.equipment_id JOIN users u ON u.id = d.user_id WHERE d.id = ${recordId}`);
  if (!row || !row.inactive_or_problem) return;
  await notify({
    event: "pendencia.new", frontId: row.service_front_id === null ? null : Number(row.service_front_id), actorId,
    title: `Problema informado no Controle Diário: ${String(row.prefix)}`,
    body: `${clip(text(row.problem_reason) ?? "Equipamento inativo ou com problema", 300)}\n${String(row.operator)} · ${br(String(row.record_date))}`,
    link: { secao: "Controle Diário", aba: "history" },
  });
}

// Checklist pré-uso com item reprovado: pendência (ou bloqueio) do equipamento, e a O.S. aberta, se houver.
export async function notifyChecklistProblem(submissionId: number, actorId: number) {
  const row = await first(sql`SELECT s.status, s.checklist_date, s.operator_name, s.service_front_id, s.work_order_id, e.prefix,
      (SELECT string_agg(a.label || coalesce(': ' || nullif(a.comment, ''), ''), '; ' ORDER BY a.id) FROM checklist_answers a WHERE a.submission_id = s.id AND NOT a.ok) AS failed
    FROM checklist_submissions s JOIN equipment e ON e.id = s.equipment_id WHERE s.id = ${submissionId}`);
  if (!row || row.status === "OK") return;
  const blocked = row.status === "BLOQUEADO";
  await notify({
    event: "pendencia.new", frontId: row.service_front_id === null ? null : Number(row.service_front_id), actorId,
    title: `Checklist ${blocked ? "BLOQUEADO" : "com pendência"}: ${String(row.prefix)}`,
    body: `${clip(text(row.failed) ?? "Item reprovado", 300)}\n${text(row.operator_name) ?? ""} · ${br(String(row.checklist_date))}${row.work_order_id ? ` · O.S. aberta` : ""}`,
    link: { secao: "Controle Diário", aba: "checklist" },
  });
}
