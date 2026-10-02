import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { employeeDismissals, employees, employeeTransfers, serviceFronts } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { canSeeEmployeeFront, employeeAudit, employeeErrorResponse, employeeToday, requireEmployee } from "../../../../../lib/employees";
import { sincronizarComAviso } from "../../../../../lib/operadores";

type Context = { params: Promise<{ id: string }> };

// Readmissão de um demitido: nova data de admissão (a anterior fica guardada na demissão), volta a
// Ativo e começa sem ciclo de folga. Restrito (não pode ser recontratado) exige confirmação.
export async function POST(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const employee = await requireEmployee(db, user, Number((await params).id));
    if (employee.status !== "DEMITIDO") return Response.json({ error: `${employee.name} não está demitido.` }, { status: 409 });
    const body = (await request.json()) as Record<string, unknown>;
    const admissionDate = String(body.admissionDate ?? "");
    const dismissal = (await db.select().from(employeeDismissals).where(eq(employeeDismissals.employeeId, employee.id)).orderBy(desc(employeeDismissals.dismissedAt), desc(employeeDismissals.id)).limit(1))[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(admissionDate)) return Response.json({ error: "Informe a data da readmissão." }, { status: 400 });
    if (admissionDate > employeeToday()) return Response.json({ error: "A data da readmissão não pode ser futura." }, { status: 400 });
    if (dismissal && admissionDate < dismissal.dismissedAt) return Response.json({ error: "A readmissão não pode ser antes da demissão." }, { status: 400 });
    if (dismissal && !dismissal.rehireAllowed && body.confirmRestricted !== true)
      return Response.json({ error: `${employee.name} está na lista de Funcionários Restritos (motivo: ${dismissal.reason}). Confirme para readmitir mesmo assim.`, restricted: true }, { status: 409 });
    const frontId = Number(body.serviceFrontId) || employee.serviceFrontId;
    const front = (await db.select({ id: serviceFronts.id }).from(serviceFronts).where(and(eq(serviceFronts.id, frontId), eq(serviceFronts.active, true))).limit(1))[0];
    if (!front || !canSeeEmployeeFront(user, front.id)) return Response.json({ error: "Escolha uma frente de serviço que você acessa." }, { status: 400 });
    await db.transaction(async (tx) => {
      await tx.update(employees).set({ status: "ATIVO", admissionDate, serviceFrontId: front.id, updatedAt: new Date().toISOString() }).where(eq(employees.id, employee.id));
      if (dismissal) await tx.update(employeeDismissals).set({ rehiredAt: admissionDate, rehiredBy: user.id, updatedAt: new Date().toISOString() }).where(eq(employeeDismissals.id, dismissal.id));
      // A permanência na frente recomeça na readmissão.
      await tx.insert(employeeTransfers).values({ employeeId: employee.id, previousServiceFrontId: employee.serviceFrontId, newServiceFrontId: front.id, transferDate: admissionDate, transferredBy: user.id, note: "Readmissão" });
    });
    await employeeAudit(db, user.id, employee.id, "FUNCIONÁRIO READMITIDO", { status: "DEMITIDO", admissionDate: employee.admissionDate }, { status: "ATIVO", admissionDate, serviceFrontId: front.id, restrictedConfirmed: dismissal && !dismissal.rehireAllowed ? true : undefined });
    // Readmitido em função que opera equipamento: acesso reativado com PIN novo (mostrado uma vez).
    const acesso = await sincronizarComAviso(db, employee.id, user);
    return Response.json({ message: `${employee.name} readmitido.`, ...acesso });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.rehire]", error);
    return Response.json({ error: "Não foi possível readmitir o funcionário agora." }, { status: 500 });
  }
}
