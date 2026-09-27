import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { employeeAlerts, employeeScope, listEmployees } from "../../../../lib/employees";

// Contador do menu (notificação para quem gerencia os funcionários da frente): folgas estouradas e
// ciclos de trabalho vencidos nas frentes em exibição.
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const { scope } = await employeeScope(db, auth.user!, request);
    return Response.json({ alerts: employeeAlerts(await listEmployees(db, scope)) });
  } catch (error) {
    console.error("[employees.alerts]", error);
    return Response.json({ error: "Não foi possível carregar os alertas agora." }, { status: 500 });
  }
}
