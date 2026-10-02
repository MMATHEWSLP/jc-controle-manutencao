import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employeeAbsences, employeeDismissals, employeeLeaveCycles, employees } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { validateDismissal } from "../../../../../lib/employee-rules";
import { employeeAudit, employeeErrorResponse, employeeToday, requireEmployee } from "../../../../../lib/employees";
import { CYCLE_STEPS } from "../../../../../lib/leave-cycle";
import { sincronizarComAviso } from "../../../../../lib/operadores";

type Context = { params: Promise<{ id: string }> };

// Demitir: grava motivo, data e se pode ser recontratado (Não = lista de Funcionários Restritos).
// O funcionário sai das listas ativas, mas o perfil e o histórico continuam consultáveis. O ciclo de
// folga em andamento é encerrado na data da demissão e ausências em aberto terminam nela.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const employee = await requireEmployee(db, user, Number((await params).id));
    if (employee.status === "DEMITIDO") return Response.json({ error: `${employee.name} já está demitido.` }, { status: 409 });
    const body = (await request.json()) as Record<string, unknown>;
    const input = { dismissedAt: String(body.dismissedAt ?? ""), reason: String(body.reason ?? "").trim(), rehireAllowed: body.rehireAllowed };
    const today = employeeToday();
    const problem = validateDismissal(input, employee.admissionDate, today);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const open = (await db.select().from(employeeLeaveCycles).where(and(eq(employeeLeaveCycles.employeeId, employee.id), isNull(employeeLeaveCycles.frontArrival), isNull(employeeLeaveCycles.endedAt))).limit(1))[0];
    const lastCycleDate = open ? CYCLE_STEPS.map((step) => open[step]).filter(Boolean).sort().pop() : null;
    if (lastCycleDate && input.dismissedAt < lastCycleDate) return Response.json({ error: `A demissão não pode ser antes da última etapa do ciclo de folga (${lastCycleDate.split("-").reverse().join("/")}).` }, { status: 400 });
    await db.transaction(async (tx) => {
      await tx.insert(employeeDismissals).values({ employeeId: employee.id, dismissedAt: input.dismissedAt, reason: input.reason, rehireAllowed: input.rehireAllowed as boolean, previousAdmissionDate: employee.admissionDate, createdBy: user.id });
      await tx.update(employees).set({ status: "DEMITIDO", updatedAt: new Date().toISOString() }).where(eq(employees.id, employee.id));
      if (open) await tx.update(employeeLeaveCycles).set({ endedAt: input.dismissedAt, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, open.id));
      const openAbsences = await tx.select().from(employeeAbsences).where(and(eq(employeeAbsences.employeeId, employee.id), isNull(employeeAbsences.endDate)));
      for (const absence of openAbsences)
        await tx.update(employeeAbsences).set({ endDate: absence.startDate > input.dismissedAt ? absence.startDate : input.dismissedAt, updatedAt: new Date().toISOString() }).where(eq(employeeAbsences.id, absence.id));
    });
    await employeeAudit(db, user.id, employee.id, "FUNCIONÁRIO DEMITIDO", { status: employee.status }, input);
    // Demitido: o acesso de operador é desativado na hora (sem excluir, para manter o histórico).
    const acesso = await sincronizarComAviso(db, employee.id, user);
    return Response.json({ message: `${employee.name} demitido.${input.rehireAllowed ? "" : " Incluído na lista de Funcionários Restritos."}`, ...acesso });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.dismiss]", error);
    return Response.json({ error: "Não foi possível registrar a demissão agora." }, { status: 500 });
  }
}
