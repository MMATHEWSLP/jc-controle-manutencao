import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../db";
import { employeeLeaveCycles, employees } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { validateEmployee } from "../../../../lib/employee-rules";
import { assertUniqueDocuments, canSeeEmployeeFront, canSeeSalary, employeeAudit, employeeDetail, employeeErrorResponse, employeeToday, parseEmployeeBody, requireCompany, requireEmployee } from "../../../../lib/employees";
import { statusForPhase, summarizeStoredCycle } from "../../../../lib/leave-cycle";
import { sincronizarComAviso } from "../../../../lib/operadores";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const id = Number((await params).id);
    const row = await requireEmployee(db, auth.user!, id, "VIEW");
    // De outra frente: consulta e transferência; salário e demais alterações só na frente do login.
    const canChange = canSeeEmployeeFront(auth.user!, row.serviceFrontId, "CHANGE");
    return Response.json({ employee: { ...await employeeDetail(db, id, { showSalary: canSeeSalary(auth.user!) && canChange }), canChange } });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.id.get]", error);
    return Response.json({ error: "Não foi possível carregar o funcionário agora." }, { status: 500 });
  }
}

// Edita o cadastro. A frente NÃO muda aqui — só pela transferência (histórico de frentes). A situação
// só alterna entre Ativo e Afastado: "De folga" acompanha o ciclo e "Demitido" vem do botão Demitir.
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const db = await getDb();
    const id = Number((await params).id);
    await requireEmployee(db, user, id);
    const current = (await db.select().from(employees).where(eq(employees.id, id)).limit(1))[0];
    const input = parseEmployeeBody((await request.json()) as Record<string, unknown>);
    if (!canSeeSalary(user)) input.salary = current.salary;
    const today = employeeToday();
    const open = (await db.select().from(employeeLeaveCycles).where(and(eq(employeeLeaveCycles.employeeId, id), isNull(employeeLeaveCycles.frontArrival), isNull(employeeLeaveCycles.endedAt))).limit(1))[0];
    let status: string = current.status;
    if (current.status === "ATIVO" || current.status === "FOLGA" || current.status === "AFASTADO") {
      if (input.status === "AFASTADO") status = "AFASTADO";
      else if (input.status === "ATIVO" || input.status === "FOLGA") status = statusForPhase("ATIVO", open ? summarizeStoredCycle(open, today).phase : "SEM_CICLO");
    }
    const problem = validateEmployee({ ...input, serviceFrontId: current.serviceFrontId, status }, { requireFront: false, today });
    if (problem) return Response.json({ error: problem }, { status: 400 });
    await requireCompany(db, input.company, current.company);
    await assertUniqueDocuments(db, input, id);
    const next = {
      name: input.name, jobTitle: input.jobTitle, company: input.company, admissionDate: input.admissionDate, status: status as "ATIVO", notes: input.notes,
      registration: input.registration, cpf: input.cpf, birthDate: input.birthDate, city: input.city, salary: input.salary,
      cycleWorkDays: input.cycleWorkDays, cycleOffDays: input.cycleOffDays, updatedAt: new Date().toISOString(),
    };
    await db.transaction(async (tx) => {
      await tx.update(employees).set(next).where(eq(employees.id, id));
      // O ciclo em andamento passa a usar o novo ciclo configurado; os fechados ficam como foram.
      if (open && (open.workDaysTarget !== input.cycleWorkDays || open.offDaysTarget !== input.cycleOffDays))
        await tx.update(employeeLeaveCycles).set({ workDaysTarget: input.cycleWorkDays, offDaysTarget: input.cycleOffDays, updatedAt: new Date().toISOString() }).where(eq(employeeLeaveCycles.id, open.id));
    });
    const hide = (value: typeof current) => (canSeeSalary(user) ? value : { ...value, salary: undefined });
    await employeeAudit(db, user.id, id, "FUNCIONÁRIO EDITADO", hide(current), hide({ ...current, ...next }));
    // Mudou para função que opera equipamento: cria o acesso (PIN uma vez); para uma que não opera: desativa.
    const acesso = await sincronizarComAviso(db, id, user, { jobTitle: input.jobTitle });
    return Response.json({ message: "Cadastro atualizado.", ...acesso });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.id.put]", error);
    return Response.json({ error: "Não foi possível atualizar o funcionário agora." }, { status: 500 });
  }
}
