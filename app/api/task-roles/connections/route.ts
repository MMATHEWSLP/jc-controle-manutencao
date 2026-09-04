import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { taskRoleConnections, taskRoles } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";
import { logRoleAudit } from "../../../../lib/task-authorization";

type ConnectionInput = { sourceRoleId: number; targetRoleId: number; canSend: boolean; canViewReceived: boolean; canViewSent: boolean; canManage: boolean };

// Salvamento do mapa de conexões: substitui TODO o conjunto de conexões pelo enviado, numa única
// transação (seção 22: "se uma ligação falhar, não salvar o restante do mapa parcialmente").
// Faz diff contra o estado atual em vez de apagar-e-recriar tudo, para preservar created_by/
// created_at das conexões que não mudaram. Exclusivo do ADMIN/cargo raiz.
export async function PUT(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request); if (auth.response) return auth.response;
  if (auth.user!.profile !== "ADMIN") return Response.json({ error: "Somente o administrador pode alterar o Gestor de Cargos de Tarefas." }, { status: 403 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const rawList = Array.isArray(body.connections) ? body.connections : [];
    const seen = new Set<string>();
    const desired: ConnectionInput[] = [];
    for (const raw of rawList as Record<string, unknown>[]) {
      const sourceRoleId = Number(raw.sourceRoleId); const targetRoleId = Number(raw.targetRoleId);
      if (!Number.isInteger(sourceRoleId) || sourceRoleId <= 0 || !Number.isInteger(targetRoleId) || targetRoleId <= 0) return Response.json({ error: "Conexão com cargo inválido." }, { status: 400 });
      const canSend = Boolean(raw.canSend), canViewReceived = Boolean(raw.canViewReceived), canViewSent = Boolean(raw.canViewSent), canManage = Boolean(raw.canManage);
      if (!canSend && !canViewReceived && !canViewSent && !canManage) return Response.json({ error: "Cada conexão precisa de ao menos uma permissão marcada (enviar, visualizar ou gerenciar). Remova a conexão em vez de salvá-la vazia." }, { status: 400 });
      const key = `${sourceRoleId}:${targetRoleId}`;
      if (seen.has(key)) return Response.json({ error: "Há duas conexões entre os mesmos cargos de origem e destino." }, { status: 400 });
      seen.add(key);
      desired.push({ sourceRoleId, targetRoleId, canSend, canViewReceived, canViewSent, canManage });
    }

    const db = await getDb();
    const roleIds = new Set((await db.select({ id: taskRoles.id }).from(taskRoles)).map((row) => row.id));
    for (const connection of desired) if (!roleIds.has(connection.sourceRoleId) || !roleIds.has(connection.targetRoleId)) return Response.json({ error: "Uma das conexões referencia um cargo que não existe mais." }, { status: 400 });

    const existing = await db.select().from(taskRoleConnections);
    const existingByKey = new Map(existing.map((row) => [`${row.sourceRoleId}:${row.targetRoleId}`, row]));
    const desiredByKey = new Map(desired.map((row) => [`${row.sourceRoleId}:${row.targetRoleId}`, row]));
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      for (const row of existing) if (!desiredByKey.has(`${row.sourceRoleId}:${row.targetRoleId}`)) await tx.delete(taskRoleConnections).where(eq(taskRoleConnections.id, row.id));
      for (const connection of desired) {
        const prior = existingByKey.get(`${connection.sourceRoleId}:${connection.targetRoleId}`);
        if (prior) {
          const changed = prior.canSend !== connection.canSend || prior.canViewReceived !== connection.canViewReceived || prior.canViewSent !== connection.canViewSent || prior.canManage !== connection.canManage;
          if (changed) await tx.update(taskRoleConnections).set({ ...connection, updatedBy: auth.user!.id, updatedAt: now }).where(eq(taskRoleConnections.id, prior.id));
        } else {
          await tx.insert(taskRoleConnections).values({ ...connection, createdBy: auth.user!.id, updatedBy: auth.user!.id, updatedAt: now });
        }
      }
    });

    await logRoleAudit(auth.user!.id, "MAP", "TASK_ROLE_MAP_CHANGED",
      existing.map((row) => ({ sourceRoleId: row.sourceRoleId, targetRoleId: row.targetRoleId, canSend: row.canSend, canViewReceived: row.canViewReceived, canViewSent: row.canViewSent, canManage: row.canManage })),
      desired);
    return Response.json({ message: "Mapa de cargos salvo.", connections: desired });
  } catch (error) {
    console.error("[task-roles.connections.put]", error);
    return Response.json({ error: "Não foi possível salvar o mapa de cargos. Nenhuma alteração foi aplicada." }, { status: 500 });
  }
}
