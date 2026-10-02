import { asc, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { jobFunctions } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";

// Cadastro de Funções: todas as funções com quantos funcionários (não demitidos / total) e o
// "Opera equipamento" (dá acesso de operador ao Controle Diário).
export async function GET(request: Request) {
  const auth = await authorize(request, "employees.view");
  if (auth.response) return auth.response;
  try {
    const db = await getDb();
    const rows = await db.select({
      id: jobFunctions.id, name: jobFunctions.name, operatesEquipment: jobFunctions.operatesEquipment, active: jobFunctions.active,
      ativos: sql<number>`(SELECT count(*)::int FROM employees e WHERE e.job_title = ${jobFunctions.name} AND e.status <> 'DEMITIDO')`,
      total: sql<number>`(SELECT count(*)::int FROM employees e WHERE e.job_title = ${jobFunctions.name})`,
    }).from(jobFunctions).orderBy(asc(jobFunctions.name));
    const user = auth.user!;
    return Response.json({ functions: rows, canManage: user.permissions.includes("employees.manage") && (user.profile === "ADMIN" || user.profile === "GESTOR") });
  } catch (error) {
    console.error("[employees.functions.get]", error);
    return Response.json({ error: "Não foi possível carregar as funções agora." }, { status: 500 });
  }
}
