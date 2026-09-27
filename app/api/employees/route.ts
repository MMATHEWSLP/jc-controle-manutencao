import { getDb } from "../../../db";
import { employees, employeeTransfers } from "../../../db/schema";
import { frentesEmExibicao } from "../../../lib/active-front";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { validateEmployee } from "../../../lib/employee-rules";
import { canSeeEmployeeFront, employeeAudit, employeeVisibleFronts, listEmployees } from "../../../lib/employees";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

// Listagem do módulo Funcionários: frentes em exibição (seletor global) ∩ frentes que a pessoa enxerga.
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const user = auth.user!;
    const url = new URL(request.url);
    const db = await getDb();
    const fronts = await employeeVisibleFronts(db, user);
    const displayed = frentesEmExibicao(user, request);
    const scope = fronts.map((front) => front.id).filter((id) => displayed === "ALL" || displayed.includes(id));
    const items = await listEmployees(db, scope, { includeDismissed: url.searchParams.get("includeDismissed") === "1" });
    return Response.json({ employees: items, fronts, scopeFrontIds: scope, canManage: user.permissions.includes("employees.manage") });
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
    const input = {
      name: text(body.name).replace(/\s+/g, " ").toUpperCase(), jobTitle: text(body.jobTitle), company: text(body.company).toUpperCase(),
      admissionDate: text(body.admissionDate), serviceFrontId: Number(body.serviceFrontId) || null, status: text(body.status) || "ATIVO",
    };
    const problem = validateEmployee(input, { requireFront: true });
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const db = await getDb();
    const fronts = await employeeVisibleFronts(db, user);
    if (!fronts.some((front) => front.id === input.serviceFrontId) || !canSeeEmployeeFront(user, input.serviceFrontId!))
      return Response.json({ error: "Você não tem acesso à frente escolhida." }, { status: 403 });
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(employees).values({ ...input, serviceFrontId: input.serviceFrontId!, status: input.status as "ATIVO", notes: text(body.notes) || null, createdBy: user.id }).returning({ id: employees.id });
      // Primeira frente também entra no histórico de frentes (a partir da admissão).
      await tx.insert(employeeTransfers).values({ employeeId: row.id, previousServiceFrontId: null, newServiceFrontId: input.serviceFrontId!, transferDate: input.admissionDate, transferredBy: user.id, note: "Frente inicial (cadastro)" });
      return row;
    });
    await employeeAudit(db, user.id, created.id, "FUNCIONÁRIO CADASTRADO", undefined, input);
    return Response.json({ id: created.id, message: "Funcionário cadastrado." }, { status: 201 });
  } catch (error) {
    console.error("[employees.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o funcionário agora." }, { status: 500 });
  }
}
