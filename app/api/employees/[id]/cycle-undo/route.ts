import { getDb } from "../../../../../db";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { employeeAudit, employeeErrorResponse, employeeToday, requireEmployee, undoLastCycleStep } from "../../../../../lib/employees";
import { CYCLE_STEP_LABELS } from "../../../../../lib/leave-cycle";

type Context = { params: Promise<{ id: string }> };

// Desfaz a última etapa do ciclo de folga (lançamento por engano).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const employee = await requireEmployee(db, auth.user!, Number((await params).id));
    if (employee.status === "DEMITIDO") return Response.json({ error: "Funcionário demitido: o histórico de ciclos fica só para consulta." }, { status: 409 });
    const result = await db.transaction((tx) => undoLastCycleStep(tx, employee, employeeToday()));
    await employeeAudit(db, auth.user!.id, employee.id, "CICLO DE FOLGA — ETAPA DESFEITA", { status: employee.status }, result);
    return Response.json({ message: `"${CYCLE_STEP_LABELS[result.undone]}" desfeita.` });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.cycle-undo]", error);
    return Response.json({ error: "Não foi possível desfazer a etapa agora." }, { status: 500 });
  }
}
