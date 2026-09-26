import { getDb } from "../../../../db";
import { serviceFronts } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { authorize } from "../../../../lib/auth";
import { canManage, canRegister, canViewAll, loadAssignment, loadEquipmentOptions } from "../../../../lib/daily-records";
import { requiresManualOperator } from "../../../../lib/daily-record-rules";

// Tudo o que o formulário precisa ao abrir: equipamentos que o operador pode escolher,
// frentes ativas, a "memória" do último equipamento e a frente padrão do usuário.
export async function GET(request: Request) {
  const auth = await authorize(request); if (auth.response) return auth.response;
  const user = auth.user!;
  const canFieldOperators = user.permissions.includes("daily.field_operators");
  const canFrontRequests = user.permissions.includes("daily.front_requests");
  if (!canRegister(user) && !canViewAll(user) && !canFieldOperators && !canFrontRequests) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const db = await getDb();
    const [equipment, fronts, assignedEquipmentId] = await Promise.all([
      loadEquipmentOptions(user),
      db.select({ id: serviceFronts.id, name: serviceFronts.name }).from(serviceFronts).where(eq(serviceFronts.active, true)).orderBy(serviceFronts.name),
      loadAssignment(user.id),
    ]);
    return Response.json({
      equipment, fronts,
      assignedEquipmentId: equipment.some((item) => item.id === assignedEquipmentId) ? assignedEquipmentId : null,
      defaultServiceFrontId: user.serviceFrontId,
      userId: user.id, canRegister: canRegister(user), canViewAll: canViewAll(user), canManage: canManage(user), canFieldOperators, canFrontRequests,
      // Login que não é de campo: o formulário pede o nome do operador (lançamento manual).
      manualOperator: requiresManualOperator(user.profile),
    });
  } catch (error) {
    console.error("[daily-records.context]", error);
    return Response.json({ error: "Não foi possível carregar o Controle Diário agora." }, { status: 500 });
  }
}
