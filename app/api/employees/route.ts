import { getDb } from "../../../db";
import { employees, employeeTransfers } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { showsRegistryFrontButtons } from "../../../lib/active-front";
import { validateEmployee } from "../../../lib/employee-rules";
import { assertUniqueDocuments, canSeeEmployeeFront, canSeeSalary, employeeAlerts, employeeAudit, employeeErrorResponse, employeeScope, employeeToday, listCompanies, listEmployees, parseEmployeeBody, requireCompany, restrictedMatches } from "../../../lib/employees";

// Listagem do módulo Funcionários: frentes em exibição (seletor global) ∩ frentes que a pessoa enxerga.
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const db = await getDb();
    const { fronts, scope } = await employeeScope(db, user, request);
    const [items, companies] = await Promise.all([
      listEmployees(db, scope, { includeDismissed: url.searchParams.get("includeDismissed") === "1", showSalary: canSeeSalary(user) }),
      listCompanies(db, { includeInactive: user.permissions.includes("employees.companies") }),
    ]);
    return Response.json({
      employees: items, fronts, scopeFrontIds: scope, companies, today: employeeToday(), alerts: employeeAlerts(items), frontButtons: showsRegistryFrontButtons(user),
      canManage: user.permissions.includes("employees.manage"), canSeeSalary: canSeeSalary(user), canManageCompanies: user.permissions.includes("employees.companies"),
    });
  } catch (error) {
    console.error("[employees.get]", error);
    return Response.json({ error: "Não foi possível carregar os funcionários agora." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const body = (await request.json()) as Record<string, unknown>;
    const input = parseEmployeeBody(body);
    if (!canSeeSalary(user)) input.salary = null;
    // "De folga" vem do ciclo e "Demitido" do botão Demitir: o cadastro nasce Ativo ou Afastado.
    if (input.status !== "AFASTADO") input.status = "ATIVO";
    const problem = validateEmployee(input, { requireFront: true, today: employeeToday() });
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const db = await getDb();
    const { fronts } = await employeeScope(db, user, request);
    if (!fronts.some((front) => front.id === input.serviceFrontId) || !canSeeEmployeeFront(user, input.serviceFrontId!))
      return Response.json({ error: "Você não tem acesso à frente escolhida." }, { status: 403 });
    await requireCompany(db, input.company);
    await assertUniqueDocuments(db, input);
    const restricted = await restrictedMatches(db, input);
    if (restricted.length && body.confirmRestricted !== true)
      return Response.json({ error: "Este cadastro confere com um funcionário restrito (não pode ser recontratado).", restricted }, { status: 409 });
    const { notes, ...fields } = input;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(employees).values({ ...fields, serviceFrontId: input.serviceFrontId!, status: input.status as "ATIVO", notes, createdBy: user.id }).returning({ id: employees.id });
      // Primeira frente também entra no histórico de frentes (a partir da admissão).
      await tx.insert(employeeTransfers).values({ employeeId: row.id, previousServiceFrontId: null, newServiceFrontId: input.serviceFrontId!, transferDate: input.admissionDate, transferredBy: user.id, note: "Frente inicial (cadastro)" });
      return row;
    });
    await employeeAudit(db, user.id, created.id, "FUNCIONÁRIO CADASTRADO", undefined, { ...input, restrictedConfirmed: restricted.length > 0 || undefined });
    return Response.json({ id: created.id, message: "Funcionário cadastrado." }, { status: 201 });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário agora." }, { status: 500 });
  }
}
