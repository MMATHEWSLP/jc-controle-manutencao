import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { taskRoleConnections, taskRoles, users } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";

// Mapa completo do Gestor de Cargos de Tarefas — cargos (incluindo inativos, com contagem de
// usuários vinculados) e todas as conexões. Exclusivo do ADMIN/cargo raiz: mesmo alterando a URL
// ou chamando a API diretamente, quem não é ADMIN recebe 403.
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente o administrador pode abrir o Gestor de Cargos de Tarefas." }, { status: 403 });
  try {
    const db = await getDb();
    const [roleRows, userCounts, connectionRows] = await Promise.all([
      db.select().from(taskRoles).orderBy(asc(taskRoles.visualOrder)),
      db.select({ taskRoleId: users.taskRoleId, count: sql<number>`count(*)::int` }).from(users).where(eq(users.status, "ACTIVE")).groupBy(users.taskRoleId),
      db.select().from(taskRoleConnections),
    ]);
    const countByRole = new Map(userCounts.filter((row) => row.taskRoleId !== null).map((row) => [row.taskRoleId as number, row.count]));
    const roles = roleRows.map((role) => ({ ...role, userCount: countByRole.get(role.id) ?? 0 }));
    return Response.json({ roles, connections: connectionRows });
  } catch (error) {
    console.error("[task-roles.map.get]", error);
    return Response.json({ error: "Não foi possível carregar o mapa de cargos." }, { status: 500 });
  }
}
