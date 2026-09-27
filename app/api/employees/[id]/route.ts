import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { employees } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { validateEmployee } from "../../../../lib/employee-rules";
import { employeeAudit, employeeDetail, employeeErrorResponse, requireEmployee } from "../../../../lib/employees";

type Context = { params: Promise<{ id: string }> };
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const id = Number((await params).id);
    await requireEmployee(db, auth.user!, id);
    return Response.json({ employee: await employeeDetail(db, id) });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.id.get]", error);
    return Response.json({ error: "Não foi possível carregar o funcionário agora." }, { status: 500 });
  }
}

// Edita o cadastro. A frente NÃO muda aqui — só pela transferência (histórico de frentes).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const id = Number((await params).id);
    await requireEmployee(db, auth.user!, id);
    const current = (await db.select().from(employees).where(eq(employees.id, id)).limit(1))[0];
    const body = (await request.json()) as Record<string, unknown>;
    const input = {
      name: text(body.name).replace(/\s+/g, " ").toUpperCase(), jobTitle: text(body.jobTitle), company: text(body.company).toUpperCase(),
      admissionDate: text(body.admissionDate), serviceFrontId: current.serviceFrontId, status: text(body.status),
    };
    const problem = validateEmployee(input, { requireFront: false });
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const next = { name: input.name, jobTitle: input.jobTitle, company: input.company, admissionDate: input.admissionDate, status: input.status as "ATIVO", notes: text(body.notes) || null, updatedAt: new Date().toISOString() };
    await db.update(employees).set(next).where(eq(employees.id, id));
    await employeeAudit(db, auth.user!.id, id, "FUNCIONÁRIO EDITADO", current, next);
    return Response.json({ message: "Cadastro atualizado." });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.id.put]", error);
    return Response.json({ error: "Não foi possível atualizar o funcionário agora." }, { status: 500 });
  }
}
