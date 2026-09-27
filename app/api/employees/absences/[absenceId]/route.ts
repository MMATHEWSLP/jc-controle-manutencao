import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employeeAbsences } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { validateAbsence } from "../../../../../lib/employee-rules";
import { employeeAudit, employeeErrorResponse, requireEmployee } from "../../../../../lib/employees";

type Context = { params: Promise<{ absenceId: string }> };

async function load(request: Request, params: Context["params"]) {
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return { response: auth.response } as const;
  const db = await getDb();
  const absence = (await db.select().from(employeeAbsences).where(eq(employeeAbsences.id, Number((await params).absenceId))).limit(1))[0];
  if (!absence) return { response: Response.json({ error: "Ausência não encontrada." }, { status: 404 }) } as const;
  await requireEmployee(db, auth.user!, absence.employeeId);
  return { db, user: auth.user!, absence } as const;
}

// Edita o período (ex.: informar a data de retorno de um afastamento que estava em aberto).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  try {
    const loaded = await load(request, params);
    if ("response" in loaded) return loaded.response;
    const { db, user, absence } = loaded;
    const body = (await request.json()) as Record<string, unknown>;
    const input = { kind: String(body.kind ?? absence.kind), startDate: String(body.startDate ?? absence.startDate), endDate: typeof body.endDate === "string" && body.endDate ? body.endDate : null };
    const problem = validateAbsence(input);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : absence.notes;
    await db.update(employeeAbsences).set({ kind: input.kind as "FOLGA", startDate: input.startDate, endDate: input.endDate, notes, updatedAt: new Date().toISOString() }).where(eq(employeeAbsences.id, absence.id));
    await employeeAudit(db, user.id, absence.employeeId, "AUSÊNCIA EDITADA", absence, { ...input, notes });
    return Response.json({ message: "Ausência atualizada." });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.absences.put]", error);
    return Response.json({ error: "Não foi possível atualizar a ausência agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  try {
    const loaded = await load(request, params);
    if ("response" in loaded) return loaded.response;
    const { db, user, absence } = loaded;
    await db.delete(employeeAbsences).where(eq(employeeAbsences.id, absence.id));
    await employeeAudit(db, user.id, absence.employeeId, "AUSÊNCIA EXCLUÍDA", absence, undefined);
    return Response.json({ message: "Ausência excluída." });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.absences.delete]", error);
    return Response.json({ error: "Não foi possível excluir a ausência agora." }, { status: 500 });
  }
}
