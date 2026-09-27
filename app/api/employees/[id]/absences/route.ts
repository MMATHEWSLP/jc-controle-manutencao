import { getDb } from "../../../../../db";
import { employeeAbsences } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { validateAbsence } from "../../../../../lib/employee-rules";
import { employeeAudit, employeeErrorResponse, requireEmployee } from "../../../../../lib/employees";

type Context = { params: Promise<{ id: string }> };

// Registra folga, férias, atestado, afastamento ou outra ausência (término vazio = em aberto).
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const id = Number((await params).id);
    await requireEmployee(db, auth.user!, id);
    const body = (await request.json()) as Record<string, unknown>;
    const input = { kind: String(body.kind ?? ""), startDate: String(body.startDate ?? ""), endDate: typeof body.endDate === "string" && body.endDate ? body.endDate : null };
    const problem = validateAbsence(input);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    const [row] = await db.insert(employeeAbsences).values({ employeeId: id, kind: input.kind as "FOLGA", startDate: input.startDate, endDate: input.endDate, notes, createdBy: auth.user!.id }).returning({ id: employeeAbsences.id });
    await employeeAudit(db, auth.user!.id, id, "AUSÊNCIA REGISTRADA", undefined, { ...input, notes });
    return Response.json({ id: row.id, message: "Ausência registrada." }, { status: 201 });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.absences.post]", error);
    return Response.json({ error: "Não foi possível registrar a ausência agora." }, { status: 500 });
  }
}
