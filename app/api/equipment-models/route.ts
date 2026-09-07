import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { equipmentModels } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  const auth = await authorize(request, "products.view");
  if (auth.response) return auth.response;
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";
  const db = await getDb();
  const rows = includeInactive
    ? await db.select().from(equipmentModels).orderBy(asc(equipmentModels.name))
    : await db.select().from(equipmentModels).where(eq(equipmentModels.active, true)).orderBy(asc(equipmentModels.name));
  return Response.json({
    models: rows.map((row) => ({ id: row.id, name: row.name, manufacturer: row.manufacturer, category: row.category, active: row.active })),
  });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "products.manage_models");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const name = clean(body.name).toUpperCase();
    if (!name) return Response.json({ error: "Informe o nome do modelo." }, { status: 400 });
    const db = await getDb();
    const duplicate = await db.select({ id: equipmentModels.id }).from(equipmentModels).where(eq(equipmentModels.name, name)).limit(1);
    if (duplicate[0]) return Response.json({ error: "Já existe um modelo com este nome." }, { status: 409 });
    const [created] = await db
      .insert(equipmentModels)
      .values({ name, manufacturer: clean(body.manufacturer) || null, category: clean(body.category) || null })
      .returning();
    return Response.json({ model: created }, { status: 201 });
  } catch (error) {
    console.error("[equipment-models.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o modelo agora." }, { status: 500 });
  }
}
