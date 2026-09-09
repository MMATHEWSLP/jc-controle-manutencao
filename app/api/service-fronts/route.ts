import { asc, eq } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { serviceFronts } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";
import { activeServiceFronts } from "../../../lib/front-scope";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("includeInactive") === "1") {
      if (!auth.user!.permissions.includes("service_fronts.manage")) return Response.json({ error: "Você não possui permissão para esta ação." }, { status: 403 });
      const db = await getDb();
      const rows = await db.select().from(serviceFronts).orderBy(asc(serviceFronts.name));
      return Response.json({ fronts: rows });
    }
    return Response.json({ fronts: await activeServiceFronts(await getD1()) });
  } catch (error) {
    console.error("[service-fronts.get]", error);
    return Response.json({ error: "Não foi possível carregar as frentes de serviço." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "service_fronts.manage");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const name = clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome da frente." }, { status: 400 });
    const db = await getDb();
    const duplicate = await db.select({ id: serviceFronts.id }).from(serviceFronts).where(eq(serviceFronts.name, name)).limit(1);
    if (duplicate[0]) return Response.json({ error: "Já existe uma frente com este nome." }, { status: 409 });
    const [created] = await db.insert(serviceFronts).values({ name, location: clean(body.location) || null }).returning();
    return Response.json({ front: created }, { status: 201 });
  } catch (error) {
    console.error("[service-fronts.post]", error);
    return Response.json({ error: "Não foi possível cadastrar a frente agora." }, { status: 500 });
  }
}
