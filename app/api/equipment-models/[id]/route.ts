import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { equipmentModels } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.manage_models");
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId) || modelId <= 0) return Response.json({ error: "Modelo inválido." }, { status: 400 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const db = await getDb();
    const existing = (await db.select().from(equipmentModels).where(eq(equipmentModels.id, modelId)).limit(1))[0];
    if (!existing) return Response.json({ error: "Modelo não encontrado." }, { status: 404 });
    const name = body.name === undefined ? existing.name : clean(body.name).toUpperCase();
    if (!name) return Response.json({ error: "Informe o nome do modelo." }, { status: 400 });
    if (name !== existing.name) {
      const duplicate = await db.select({ id: equipmentModels.id }).from(equipmentModels).where(eq(equipmentModels.name, name)).limit(1);
      if (duplicate[0]) return Response.json({ error: "Já existe um modelo com este nome." }, { status: 409 });
    }
    const active = body.active === undefined ? existing.active : Boolean(body.active);
    const [updated] = await db
      .update(equipmentModels)
      .set({
        name,
        manufacturer: body.manufacturer === undefined ? existing.manufacturer : clean(body.manufacturer) || null,
        category: body.category === undefined ? existing.category : clean(body.category) || null,
        active,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(equipmentModels.id, modelId))
      .returning();
    return Response.json({ model: updated });
  } catch (error) {
    console.error("[equipment-models.put]", error);
    return Response.json({ error: "Não foi possível atualizar o modelo agora." }, { status: 500 });
  }
}
