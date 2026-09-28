import { getDb } from "../../../../db";
import { authorize } from "../../../../lib/auth";
import { lookupEmployees } from "../../../../lib/employees";

// Autocomplete de nomes (Responsável no Combustível, operador no Controle Diário...). Liberado para
// quem pode lançar nesses módulos, mesmo sem acesso ao módulo Funcionários: devolve só nome,
// função, empresa e frente.
const ALLOWED = ["employees.view", "fuel.register", "fuel.manage", "daily.register", "daily.manage", "stock.exits_create", "work_orders.manage"];

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (user.profile === "CAMPO" || !ALLOWED.some((permission) => user.permissions.includes(permission as never)))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const url = new URL(request.url);
    const db = await getDb();
    const items = await lookupEmployees(db, user, url.searchParams.get("q") ?? "", Number(url.searchParams.get("serviceFrontId")) || null);
    return Response.json({ employees: items });
  } catch (error) {
    console.error("[employees.lookup]", error);
    return Response.json({ error: "Não foi possível buscar os funcionários agora." }, { status: 500 });
  }
}
