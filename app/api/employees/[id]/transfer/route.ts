import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employees, employeeTransfers, serviceFronts } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { canSeeEmployeeFront, employeeAudit, employeeErrorResponse, employeeToday, requireEmployee } from "../../../../../lib/employees";
import { sincronizarComAviso } from "../../../../../lib/operadores";

type Context = { params: Promise<{ id: string }> };

// Transferência de frente, no mesmo padrão dos equipamentos: grava o histórico com a data e só
// então muda a frente atual.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const id = Number((await params).id);
    const employee = await requireEmployee(db, user, id, "VIEW");
    const body = (await request.json()) as Record<string, unknown>;
    const newFrontId = Number(body.newServiceFrontId);
    const transferDate = typeof body.transferDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.transferDate) ? body.transferDate : employeeToday();
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const front = (await db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(and(eq(serviceFronts.id, newFrontId), eq(serviceFronts.active, true))).limit(1))[0];
    if (!front) return Response.json({ error: "Escolha a frente de destino." }, { status: 400 });
    if (!canSeeEmployeeFront(user, front.id, "VIEW")) return Response.json({ error: "Você não tem acesso à frente de destino." }, { status: 403 });
    if (front.id === employee.serviceFrontId) return Response.json({ error: `O funcionário já está em ${front.name}.` }, { status: 409 });
    if (transferDate > employeeToday()) return Response.json({ error: "A data da transferência não pode ser futura." }, { status: 400 });
    await db.transaction(async (tx) => {
      await tx.insert(employeeTransfers).values({ employeeId: id, previousServiceFrontId: employee.serviceFrontId, newServiceFrontId: front.id, transferDate, transferredBy: user.id, note });
      await tx.update(employees).set({ serviceFrontId: front.id, updatedAt: new Date().toISOString() }).where(eq(employees.id, id));
    });
    await employeeAudit(db, user.id, id, "FUNCIONÁRIO TRANSFERIDO", { serviceFrontId: employee.serviceFrontId }, { serviceFrontId: front.id, transferDate, note });
    // O operador passa a enxergar só a frente nova.
    const acesso = await sincronizarComAviso(db, id, user);
    return Response.json({ message: `${employee.name} transferido para ${front.name}.`, ...acesso });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.transfer]", error);
    return Response.json({ error: "Não foi possível transferir o funcionário agora." }, { status: 500 });
  }
}
