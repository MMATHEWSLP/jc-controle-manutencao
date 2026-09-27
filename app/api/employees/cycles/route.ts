import { inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { employees } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { applyCycleSteps, canSeeEmployeeFront, employeeAudit, employeeErrorResponse, employeeToday, EmployeeError } from "../../../../lib/employees";
import { CYCLE_STEP_LABELS, CYCLE_STEPS, type CycleDates } from "../../../../lib/leave-cycle";

// Registra etapas do ciclo de folga para um ou vários funcionários (lote). Ex.: "Iniciar folga em
// lote" = saída da frente (+ chegada em casa opcional). Tudo ou nada: se algum funcionário não puder
// receber a etapa, nada é gravado e a resposta lista os motivos.
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const body = (await request.json()) as { employeeIds?: unknown; dates?: Record<string, unknown> };
    const ids = [...new Set(Array.isArray(body.employeeIds) ? body.employeeIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [])];
    if (ids.length === 0) return Response.json({ error: "Selecione ao menos um funcionário." }, { status: 400 });
    if (ids.length > 300) return Response.json({ error: "Selecione no máximo 300 funcionários por vez." }, { status: 400 });
    const dates: Partial<CycleDates> = Object.fromEntries(CYCLE_STEPS.flatMap((step) => (typeof body.dates?.[step] === "string" && body.dates[step] ? [[step, body.dates[step]]] : [])));
    if (Object.keys(dates).length === 0) return Response.json({ error: "Informe a data da etapa." }, { status: 400 });
    const db = await getDb();
    const rows = await db.select({ id: employees.id, name: employees.name, status: employees.status, serviceFrontId: employees.serviceFrontId, cycleWorkDays: employees.cycleWorkDays, cycleOffDays: employees.cycleOffDays })
      .from(employees).where(inArray(employees.id, ids));
    if (rows.length !== ids.length) return Response.json({ error: "Funcionário não encontrado." }, { status: 404 });
    if (rows.some((row) => !canSeeEmployeeFront(user, row.serviceFrontId))) return Response.json({ error: "Você não tem acesso a um dos funcionários selecionados." }, { status: 403 });
    const today = employeeToday();
    const problems: string[] = [];
    const results = await db.transaction(async (tx) => {
      const applied = [];
      for (const row of rows) {
        try { applied.push({ row, result: await applyCycleSteps(tx, row, dates, user.id, today) }); }
        catch (error) { if (error instanceof EmployeeError) problems.push(error.message); else throw error; }
      }
      if (problems.length) throw new EmployeeError("PROBLEMS");
      return applied;
    }).catch((error) => { if (error instanceof EmployeeError && error.message === "PROBLEMS") return null; throw error; });
    if (!results) return Response.json({ error: problems.length === 1 ? problems[0] : `Nada foi gravado — ${problems.length} funcionários não podem receber esta etapa.`, problems }, { status: 400 });
    const label = Object.keys(dates).map((step) => CYCLE_STEP_LABELS[step as keyof CycleDates]).join(" + ");
    for (const { row, result } of results) await employeeAudit(db, user.id, row.id, "CICLO DE FOLGA — ETAPA REGISTRADA", { status: row.status }, { ...dates, status: result.status, cycleId: result.cycleId, batch: ids.length > 1 || undefined });
    return Response.json({ message: ids.length === 1 ? `${label} registrada para ${rows[0].name}.` : `${label} registrada para ${ids.length} funcionários.` });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.cycles.post]", error);
    return Response.json({ error: "Não foi possível registrar a etapa agora." }, { status: 500 });
  }
}
