import { and, asc, eq, ilike, isNull, ne, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { equipment, serviceFronts } from "../../../../db/schema";
import { authorize } from "../../../../lib/auth";

// Busca de Veículo/Máquina do lançamento. Procura em TODAS as frentes de propósito: o equipamento
// de outra frente aparece identificado ("está em Mamuru") para a pessoa perceber antes de
// selecionar — e o lançamento para ele é bloqueado no POST (lib/fuel-rules.ts). Os da frente do
// lançamento vêm primeiro. Só devolve identificação básica, nada de manutenção/leituras.
export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  const user = auth.user!;
  if (!user.permissions.includes("fuel.register") && !user.permissions.includes("fuel.manage"))
    return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    const frontId = Number(url.searchParams.get("serviceFrontId")) || null;
    const db = await getDb();
    const compact = q.replace(/[^a-zA-Z0-9]/g, "");
    // historico=1: correção de lançamento importado — vale qualquer equipamento, inclusive inativo ou
    // vendido depois do abastecimento.
    const historical = url.searchParams.get("historico") === "1";
    const conditions = historical ? [] : [ne(equipment.status, "INACTIVE"), isNull(equipment.soldAt)];
    if (q) conditions.push(or(ilike(equipment.prefix, `%${q}%`), ilike(equipment.code, `%${q}%`), ilike(equipment.model, `%${q}%`), ilike(equipment.plate, `%${q}%`), compact ? ilike(equipment.sortKey, `%${compact.toUpperCase()}%`) : undefined)!);
    else if (frontId) conditions.push(eq(equipment.serviceFrontId, frontId));
    const rows = await db.select({
      id: equipment.id, prefix: equipment.prefix, brand: equipment.brand, model: equipment.model, type: equipment.type,
      controlType: equipment.controlType, currentHours: equipment.currentHours, currentKm: equipment.currentKm,
      serviceFrontId: equipment.serviceFrontId, frontName: serviceFronts.name,
    }).from(equipment).leftJoin(serviceFronts, eq(equipment.serviceFrontId, serviceFronts.id)).where(and(...conditions)).orderBy(asc(equipment.sortKey)).limit(60);
    const items = rows
      .map((row) => ({ ...row, inActiveFront: frontId !== null && row.serviceFrontId === frontId }))
      .sort((a, b) => Number(b.inActiveFront) - Number(a.inActiveFront))
      .slice(0, 25);
    return Response.json({ equipment: items });
  } catch (error) {
    console.error("[fuel.equipment.get]", error);
    return Response.json({ error: "Não foi possível buscar os equipamentos agora." }, { status: 500 });
  }
}
