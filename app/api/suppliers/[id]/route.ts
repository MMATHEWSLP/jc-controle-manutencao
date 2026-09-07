import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { products, suppliers } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

type Context = { params: Promise<{ id: string }> };

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "suppliers.edit");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Fornecedor inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const existing = (await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1))[0];
    if (!existing) return Response.json({ error: "Fornecedor não encontrado." }, { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    const name = body.name === undefined ? existing.name : clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome do fornecedor." }, { status: 400 });
    if (name !== existing.name) {
      const duplicate = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.name, name)).limit(1);
      if (duplicate[0]) return Response.json({ error: "Já existe um fornecedor com este nome." }, { status: 409 });
    }
    const [updated] = await db
      .update(suppliers)
      .set({
        name,
        cnpj: body.cnpj === undefined ? existing.cnpj : clean(body.cnpj) || null,
        phone: body.phone === undefined ? existing.phone : clean(body.phone) || null,
        email: body.email === undefined ? existing.email : clean(body.email) || null,
        notes: body.notes === undefined ? existing.notes : clean(body.notes) || null,
        active: body.active === undefined ? existing.active : Boolean(body.active),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(suppliers.id, id))
      .returning();
    return Response.json({ supplier: updated });
  } catch (error) {
    console.error("[suppliers.put]", error);
    return Response.json({ error: "Não foi possível atualizar o fornecedor agora." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "suppliers.delete");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Fornecedor inválido." }, { status: 400 });
  try {
    const db = await getDb();
    const inUse = await db.select({ id: products.id }).from(products).where(eq(products.supplierId, id)).limit(1);
    if (inUse[0]) return Response.json({ error: "Este fornecedor está em uso por produtos cadastrados — desative-o em vez de excluir." }, { status: 409 });
    const deleted = await db.delete(suppliers).where(eq(suppliers.id, id)).returning({ id: suppliers.id });
    if (!deleted[0]) return Response.json({ error: "Fornecedor não encontrado." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[suppliers.delete]", error);
    return Response.json({ error: "Não foi possível excluir o fornecedor agora." }, { status: 500 });
  }
}
