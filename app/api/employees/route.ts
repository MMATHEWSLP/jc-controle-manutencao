import { getDb } from "../../../db";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { showsRegistryFrontButtons } from "../../../lib/active-front";
import { validateEmployee } from "../../../lib/employee-rules";
import { sincronizarComAviso } from "../../../lib/operadores";
import { assertUniqueDocuments, canSeeEmployeeFront, employeeChangeFronts, canSeeSalary, canSeeSensitive, employeeAlerts, employeeErrorResponse, employeeScope, employeeToday, insertEmployee, listCompanies, listEmployees, parseEmployeeBody, requireCompany, restrictedMatches } from "../../../lib/employees";

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
      listEmployees(db, scope, { includeDismissed: url.searchParams.get("includeDismissed") === "1", showSensitive: canSeeSensitive(user) }),
      listCompanies(db, { includeInactive: user.permissions.includes("employees.companies") }),
    ]);
    return Response.json({
      employees: items, fronts, scopeFrontIds: scope, companies, today: employeeToday(), alerts: employeeAlerts(items), frontButtons: showsRegistryFrontButtons(user), changeFrontIds: employeeChangeFronts(user),
      canManage: user.permissions.includes("employees.manage"), canSeeSalary: canSeeSalary(user), canSeeSensitive: canSeeSensitive(user), canManageCompanies: user.permissions.includes("employees.companies"),
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
    // LGPD: CPF, nascimento e salário só pelo ADMIN.
    if (!canSeeSensitive(user)) { input.salary = null; input.cpf = null; input.birthDate = null; }
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
    // A lista de restritos (com motivo) é só do ADMIN: os demais são barrados e orientados a falar com ele.
    if (restricted.length && !canSeeSensitive(user))
      return Response.json({ error: "Este cadastro confere com um funcionário restrito (não pode ser recontratado). Fale com o ADMIN." }, { status: 409 });
    if (restricted.length && body.confirmRestricted !== true)
      return Response.json({ error: "Este cadastro confere com um funcionário restrito (não pode ser recontratado).", restricted }, { status: 409 });
    const created = { id: await insertEmployee(db, user, input, { restrictedConfirmed: restricted.length > 0 || undefined }) };
    // Função que opera equipamento: o acesso de operador nasce agora e o PIN aparece uma vez.
    const acesso = await sincronizarComAviso(db, created.id, user, { jobTitle: input.jobTitle });
    return Response.json({ id: created.id, message: "Funcionário cadastrado.", ...acesso }, { status: 201 });
  } catch (error) {
    const known = employeeErrorResponse(error); if (known) return known;
    console.error("[employees.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário agora." }, { status: 500 });
  }
}
