import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employeeLeaveCycles } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { editCycle, employeeAudit, employeeErrorResponse, employeeToday, requireEmployee } from "../../../../../lib/employees";
import { CYCLE_STEPS, type CycleDates } from "../../../../../lib/leave-cycle";

type Context = { params: Promise<{ cycleId: string }> };

// Corrige as datas (e as metas) de um ciclo já lançado.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const cycle = (await db.select().from(employeeLeaveCycles).where(eq(employeeLeaveCycles.id, Number((await params).cycleId))).limit(1))[0];
    if (!cycle) return Response.json({ error: "Ciclo não encontrado." }, { status: 404 });
    const employee = await requireEmployee(db, user, cycle.employeeId);
    if (employee.status === "DEMITIDO") return Response.json({ error: "Funcionário demitido: o histórico de ciclos fica só para consulta." }, { status: 409 });
    const body = (await request.json()) as Record<string, unknown>;
    const dates = Object.fromEntries(CYCLE_STEPS.map((step) => [step, typeof body[step] === "string" && body[step] ? body[step] : null])) as CycleDates;
    const input = { dates, workDaysTarget: Number(body.workDaysTarget ?? cycle.workDaysTarget), offDaysTarget: Number(body.offDaysTarget ?? cycle.offDaysTarget), notes: typeof body.notes === "string" ? body.notes.trim() || null : cycle.notes };
    await db.transaction((tx) => editCycle(tx, cycle, employee, input, employeeToday()));
    await employeeAudit(db, user.id, employee.id, "CICLO DE FOLGA — DATAS CORRIGIDAS", cycle, { ...input.dates, workDaysTarget: input.workDaysTarget, offDaysTarget: input.offDaysTarget, notes: input.notes });
    return Response.json({ message: `Ciclo ${cycle.cycleNumber} atualizado.` });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.cycles.put]", error);
    return Response.json({ error: "Não foi possível atualizar o ciclo agora." }, { status: 500 });
  }
}
