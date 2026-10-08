import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { notify, syncGroup } from "./notifications";
import { clip } from "./notification-events";

// ---------------------------------------------------------------------------
// Notificações do comboio: o aprovador fica sabendo do que chegou ("5 abastecimentos aguardando
// aprovação", agrupado por frente) e o motorista do que foi feito com o abastecimento dele.
// As rotas chamam por runAfterResponse (depois da resposta, sem derrubar a ação).
// ---------------------------------------------------------------------------
type Summary = { id: number; driverId: number; driverName: string; frontId: number | null; front: string | null; label: string; liters: number; date: string; status: string; rejectionReason: string | null; correctionNote: string | null };

const br = (day: string) => day.split("-").reverse().join("/");
const liters = (value: number) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} L`;

async function summary(id: number): Promise<Summary | null> {
  const db = await getDb();
  const result = await db.execute(sql`SELECT r.id, r.registered_by, d.name AS driver, r.service_front_id, sf.name AS front, r.liters, r.record_date, r.status, r.rejection_reason, r.correction_note,
      coalesce(e.prefix, nullif(r.third_party_description, ''), tp.name || coalesce(' · ' || tv.plate, ' · ' || te.name, ''), r.pending_company, 'Terceiro') AS label
    FROM convoy_fuel_records r JOIN users d ON d.id = r.registered_by LEFT JOIN service_fronts sf ON sf.id = r.service_front_id
    LEFT JOIN equipment e ON e.id = r.equipment_id LEFT JOIN third_parties tp ON tp.id = r.third_party_id
    LEFT JOIN third_party_vehicles tv ON tv.id = r.third_party_vehicle_id LEFT JOIN third_party_employees te ON te.id = r.third_party_employee_id
    WHERE r.id = ${id}`);
  const row = (result as unknown as { rows: Record<string, unknown>[] }).rows[0];
  if (!row) return null;
  return {
    id, driverId: Number(row.registered_by), driverName: String(row.driver), frontId: row.service_front_id === null ? null : Number(row.service_front_id), front: row.front === null ? null : String(row.front),
    label: String(row.label), liters: Number(row.liters), date: String(row.record_date), status: String(row.status),
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason), correctionNote: row.correction_note === null ? null : String(row.correction_note),
  };
}

const pendingKey = (frontId: number | null) => `convoy.pending:${frontId ?? 0}`;
const pendingTitle = (count: number, front: string | null) => `${count} abastecimento${count === 1 ? "" : "s"} aguardando aprovação${front ? ` — ${front}` : ""}`;

async function pendingIn(frontId: number | null) {
  const db = await getDb();
  const result = await db.execute(sql`SELECT count(*)::int AS total FROM convoy_fuel_records WHERE status = 'PENDENTE' AND ${frontId === null ? sql`service_front_id IS NULL` : sql`service_front_id = ${frontId}`}`);
  return Number((result as unknown as { rows: { total: number }[] }).rows[0]?.total ?? 0);
}

// Chegou (ou voltou corrigido) um abastecimento pendente: avisa quem aprova naquela frente.
export async function notifyConvoyPending(id: number, corrected = false) {
  const item = await summary(id);
  if (!item || item.status !== "PENDENTE") return;
  const count = await pendingIn(item.frontId);
  await notify({
    event: "convoy.pending", frontId: item.frontId, actorId: item.driverId,
    title: pendingTitle(count, item.front),
    body: `${corrected ? "Corrigido pelo motorista" : "Último"}: ${item.label} · ${liters(item.liters)} · ${br(item.date)} · ${item.driverName}`,
    link: { secao: "Combustível", aba: "aprovacao" },
    group: { key: pendingKey(item.frontId), count, title: (total) => pendingTitle(total, item.front) },
  });
}

// O que o aprovador fez com o abastecimento: avisa o motorista (se "Notificar" estiver marcado) e
// acerta o total do aviso "aguardando aprovação" de quem aprova.
export async function notifyConvoyAction(id: number, action: "approved" | "rejected" | "correction", options: { actorId: number; notify: boolean; message: string | null }) {
  const item = await summary(id);
  if (!item) return;
  const remaining = await pendingIn(item.frontId);
  await syncGroup(pendingKey(item.frontId), remaining, pendingTitle(remaining, item.front));
  if (!options.notify) return;
  const what = `${item.label} · ${liters(item.liters)} · ${br(item.date)}`;
  const extra = options.message ? `\nMensagem: ${clip(options.message, 300)}` : "";
  const link = { secao: "Abastecimentos" };
  if (action === "approved") {
    await notify({
      event: "convoy.approved", to: [item.driverId], actorId: options.actorId, frontId: item.frontId, link,
      title: "Abastecimento aprovado", body: `${what}${extra}`,
      // Vários aprovados seguidos viram um aviso só ("3 abastecimentos aprovados"), a não ser que tenha mensagem.
      group: extra ? null : { key: `convoy.approved:${item.driverId}`, title: (total) => total > 1 ? `${total} abastecimentos aprovados` : "Abastecimento aprovado" },
    });
  } else if (action === "rejected") {
    await notify({ event: "convoy.rejected", to: [item.driverId], actorId: options.actorId, frontId: item.frontId, link, title: "Abastecimento rejeitado", body: `${what}\nMotivo: ${item.rejectionReason ?? "—"}${extra}` });
  } else {
    await notify({ event: "convoy.correction", to: [item.driverId], actorId: options.actorId, frontId: item.frontId, link, title: "Corrija o abastecimento", body: `${what}\nO que corrigir: ${item.correctionNote ?? "—"}${extra}` });
  }
}
