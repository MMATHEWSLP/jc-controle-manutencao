import { and, asc, eq, ilike } from "drizzle-orm";
import { getDb } from "../../../db";
import { suppliers } from "../../../db/schema";
import { assertSameOrigin, authorize } from "../../../lib/auth";

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  const auth = await authorize(request, "suppliers.view");
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const q = clean(url.searchParams.get("q"));
  const includeInactive = url.searchParams.get("includeInactive") === "1";
  const db = await getDb();
  const conditions = [q ? ilike(suppliers.name, `%${q}%`) : undefined, includeInactive ? undefined : eq(suppliers.active, true)].filter(Boolean);
  const rows = await db
    .select()
    .from(suppliers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(suppliers.name));
  return Response.json({ suppliers: rows });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "suppliers.create");
  if (auth.response) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const name = clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome do fornecedor." }, { status: 400 });
    const db = await getDb();
    const duplicate = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)).limit(1);
    if (duplicate[0]) return Response.json({ error: "Já existe um fornecedor com este nome." }, { status: 409 });
    const [created] = await db
      .insert(suppliers)
      .values({ name, cnpj: clean(body.cnpj) || null, phone: clean(body.phone) || null, email: clean(body.email) || null, notes: clean(body.notes) || null })
      .returning();
    return Response.json({ supplier: created }, { status: 201 });
  } catch (error) {
    console.error("[suppliers.post]", error);
    return Response.json({ error: "Não foi possível cadastrar o fornecedor agora." }, { status: 500 });
  }
}
