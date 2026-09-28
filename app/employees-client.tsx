"use client";
// Tipos e utilitários compartilhados pelas telas do módulo Funcionários. Nenhuma conta de dias aqui:
// os números (dias trabalhados, viagem, folga, atraso) chegam prontos da API (lib/leave-cycle.ts).

export type Status = "ATIVO" | "FOLGA" | "AFASTADO" | "DEMITIDO";
export type AbsenceKind = "FOLGA" | "FERIAS" | "ATESTADO" | "AFASTAMENTO" | "OUTRO";
export type CycleStep = "workStart" | "frontDeparture" | "homeArrival" | "homeDeparture" | "frontArrival";
export type Phase = "SEM_CICLO" | "TRABALHANDO" | "VIAGEM_IDA" | "FOLGA" | "VIAGEM_VOLTA" | "FECHADO";
export type Front = { id: number; name: string };
export type Company = { id: number; name: string; active: boolean; employees: number };
export type CycleAlert = null | { kind: "APPROACHING"; level: number; daysLeft: number } | { kind: "WORK_EXCEEDED"; days: number } | { kind: "OFF_OVERDUE"; days: number };
export type CycleSummary = {
  phase: Phase; phaseLabel: string; nextStep: CycleStep | null; workedDays: number | null; travelOutDays: number | null; offDays: number | null;
  travelBackDays: number | null; travelDays: number; daysToLeave: number | null; overdueOffDays: number; alert: CycleAlert;
};
export type Cycle = {
  id: number; employeeId: number; cycleNumber: number; workStart: string | null; frontDeparture: string | null; homeArrival: string | null; homeDeparture: string | null;
  frontArrival: string | null; endedAt: string | null; workDaysTarget: number; offDaysTarget: number; notes: string | null; summary: CycleSummary;
};
export type CurrentAbsence = { id: number; kind: AbsenceKind; kindLabel: string; startDate: string; endDate: string | null; badge: { label: string; returnDate: string | null } | null };
export type Employee = {
  id: number; name: string; jobTitle: string; company: string; admissionDate: string; serviceFrontId: number; frontName: string;
  status: Status; statusLabel: string; notes: string | null; registration: string | null; cpf: string | null; birthDate: string | null; city: string | null;
  salary: number | null; cycleWorkDays: number; cycleOffDays: number; currentAbsence: CurrentAbsence | null; cycle: Cycle | null; daysInFront: number;
};
export type Restricted = { id: number; name: string; jobTitle: string; company: string; registration: string | null; cpf: string | null; frontName: string; dismissedAt: string; reason: string };
export type Alerts = { offOverdue: number; workExceeded: number; approaching: number };
export type User = { permissions: string[] };

export const CYCLE_STEP_LABELS: Record<CycleStep, string> = {
  workStart: "Início do ciclo", frontDeparture: "Saída da frente", homeArrival: "Chegada em casa", homeDeparture: "Saída de casa", frontArrival: "Chegada na frente",
};
export const CYCLE_STEPS: CycleStep[] = ["workStart", "frontDeparture", "homeArrival", "homeDeparture", "frontArrival"];
export const STATUS_OPTIONS: Array<[Status, string]> = [["ATIVO", "Ativo"], ["FOLGA", "De folga"], ["AFASTADO", "Afastado"], ["DEMITIDO", "Demitido"]];
export const ABSENCE_OPTIONS: Array<[AbsenceKind, string]> = [["FERIAS", "Férias"], ["ATESTADO", "Atestado médico"], ["AFASTAMENTO", "Afastamento"], ["OUTRO", "Outro"]];

export const brDay = (value: string | null | undefined) => (value ? value.split("-").reverse().join("/") : "—");

// Etapa do ciclo numa célula só (tabelas sem rolagem lateral): "05/09 → 09/09" e os dias embaixo.
export function StageCell({ from, to, days }: { from: string | null | undefined; to: string | null | undefined; days: number | null | undefined }) {
  if (!from && !to) return <span className="stage-cell muted">—</span>;
  return <span className="stage-cell"><b>{brDay(from)} → {to ? brDay(to) : "…"}</b><small>{days === null || days === undefined ? "—" : `${days} dia${days === 1 ? "" : "s"}`}</small></span>;
}
export const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("");
export const money = (value: number | null) => (value === null ? "—" : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
export const dayCount = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value} ${value === 1 ? "dia" : "dias"}`);
export const fold = (value: string) => value.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "");
export const nameKey = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(data.error ?? "A operação não pôde ser concluída.")), { status: response.status, data });
  return data as T;
}
export const post = (url: string, body: unknown, method = "POST") => api<{ message: string; id?: number }>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const problemText = (problem: unknown, fallback: string) => {
  if (!(problem instanceof Error)) return fallback;
  const list = (problem as Error & { data?: { problems?: string[] } }).data?.problems;
  return list && list.length > 1 ? `${problem.message}\n• ${list.join("\n• ")}` : problem.message;
};

// Fase "efetiva" da pessoa na tela (sem ciclo = trabalhando na frente, só não tem data de início).
export const phaseOf = (item: Employee): Phase => item.cycle?.summary.phase ?? "SEM_CICLO";

// Próxima ação do ciclo para o botão da linha.
export function nextAction(item: Employee): { steps: CycleStep[]; label: string } | null {
  if (item.status === "DEMITIDO") return null;
  const phase = phaseOf(item);
  if (phase === "SEM_CICLO") return { steps: ["workStart"], label: "Iniciar ciclo" };
  if (phase === "TRABALHANDO") return { steps: ["frontDeparture", "homeArrival"], label: "Iniciar folga" };
  if (phase === "VIAGEM_IDA") return { steps: ["homeArrival"], label: "Chegada em casa" };
  if (phase === "FOLGA") return { steps: ["homeDeparture"], label: "Saída de casa" };
  if (phase === "VIAGEM_VOLTA") return { steps: ["frontArrival"], label: "Chegada na frente" };
  return null;
}

export function AlertChip({ alert }: { alert: CycleAlert | undefined }) {
  if (!alert) return null;
  if (alert.kind === "OFF_OVERDUE") return <span className="employee-alert-chip danger" title="Passou dos dias de folga previstos e ainda não saiu de casa">Folga estourada +{alert.days}d</span>;
  if (alert.kind === "WORK_EXCEEDED") return <span className="employee-alert-chip danger" title="Completou os dias trabalhados do ciclo e ainda não saiu de folga">{alert.days === 0 ? "Folga vence hoje" : `Ciclo vencido há ${alert.days}d`}</span>;
  return <span className={`employee-alert-chip level-${alert.level}`} title="Dias que faltam para completar o ciclo de trabalho">Faltam {alert.daysLeft}d p/ folga</span>;
}

export function SituationPills({ item }: { item: Pick<Employee, "status" | "statusLabel" | "currentAbsence"> }) {
  const tone = item.status === "ATIVO" ? "green" : item.status === "FOLGA" ? "blue" : item.status === "AFASTADO" ? "orange" : "gray";
  return (
    <div className="employee-situation">
      <span className={`status-pill ${tone}`}>{item.statusLabel}</span>
      {item.currentAbsence?.badge && item.currentAbsence.kind !== "FOLGA" && (
        <span className="employee-absence-badge" title={`${item.currentAbsence.kindLabel} desde ${brDay(item.currentAbsence.startDate)}`}>
          {item.currentAbsence.badge.label}{item.currentAbsence.badge.returnDate ? ` · volta ${brDay(item.currentAbsence.badge.returnDate)}` : " · sem data de retorno"}
        </span>
      )}
    </div>
  );
}

export function Modal({ eyebrow, title, subtitle, close, children, wide }: { eyebrow: string; title: string; subtitle?: string; close: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className={`modal ${wide ? "equipment-modal" : "transfer-modal"} employee-modal`}>
        <header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{subtitle && <span>{subtitle}</span>}</div><button onClick={close}>×</button></header>
        {children}
      </section>
    </div>
  );
}

export function FormError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="equipment-form-error full"><span>!</span><strong style={{ whiteSpace: "pre-line" }}>{error}</strong></div>;
}
