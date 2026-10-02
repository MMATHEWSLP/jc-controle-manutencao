import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { auditLogs, jobFunctions } from "../../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../../lib/auth";
import { sincronizarFuncao } from "../../../../../lib/operadores";

type Context = { params: Promise<{ functionId: string }> };

// Marcar/desmarcar "Opera equipamento" (ADMIN/GESTOR com employees.manage). Desmarcar desativa na
// hora os acessos de operador dessa função; marcar deixa os funcionários como pendentes para
// "Criar acessos" em Usuários > Operadores (que gera o PDF dos PINs).
export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "employees.manage");
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (user.profile !== "ADMIN" && user.profile !== "GESTOR") return Response.json({ error: "Só ADMIN e GESTOR alteram as funções." }, { status: 403 });
  const id = Number((await params).functionId);
  try {
    const body = (await request.json()) as { operatesEquipment?: unknown };
    if (typeof body.operatesEquipment !== "boolean") return Response.json({ error: "Informe se a função opera equipamento." }, { status: 400 });
    const db = await getDb();
    const current = (await db.select().from(jobFunctions).where(eq(jobFunctions.id, id)).limit(1))[0];
    if (!current) return Response.json({ error: "Função não encontrada." }, { status: 404 });
    await db.update(jobFunctions).set({ operatesEquipment: body.operatesEquipment, updatedAt: new Date().toISOString() }).where(eq(jobFunctions.id, id));
    await db.insert(auditLogs).values({ userId: user.id, entityType: "JOB_FUNCTION", entityId: String(id), action: "FUNÇÃO: OPERA EQUIPAMENTO", previousValue: JSON.stringify({ operatesEquipment: current.operatesEquipment }), newValue: JSON.stringify({ name: current.name, operatesEquipment: body.operatesEquipment }) });
    const resultado = await sincronizarFuncao(db, current.name, user.id);
    const partes = [resultado.desativados ? `${resultado.desativados} acesso(s) desativado(s)` : "", resultado.pendentes ? `${resultado.pendentes} funcionário(s) aguardando acesso em Usuários > Operadores` : ""].filter(Boolean);
    return Response.json({ message: `${current.name}: ${body.operatesEquipment ? "opera" : "não opera"} equipamento.${partes.length ? ` ${partes.join("; ")}.` : ""}`, ...resultado });
  } catch (error) {
    console.error("[employees.functions.put]", error);
    return Response.json({ error: "Não foi possível alterar a função agora." }, { status: 500 });
  }
}
