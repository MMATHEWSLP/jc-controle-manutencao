import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { serviceFronts } from "../../../../db/schema";
import { assertSameOrigin, authorize } from "../../../../lib/auth";

type Context = { params: Promise<{ id: string }> };

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function PUT(request: Request, { params }: Context) {
  if (!assertSameOrigin(request)) return Response.json({ error: "Origem da solicitação não autorizada." }, { status: 403 });
  const auth = await authorize(request, "service_fronts.manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Frente inválida." }, { status: 400 });
  try {
    const db = await getDb();
    const existing = (await db.select().from(serviceFronts).where(eq(serviceFronts.id, id)).limit(1))[0];
    if (!existing) return Response.json({ error: "Frente não encontrada." }, { status: 404 });
    const body = (await request.json()) as Record<string, unknown>;
    const name = body.name === undefined ? existing.name : clean(body.name);
    if (!name) return Response.json({ error: "Informe o nome da frente." }, { status: 400 });
    if (name !== existing.name) {
      const duplicate = await db.select({ id: serviceFronts.id }).from(serviceFronts).where(eq(serviceFronts.name, name)).limit(1);
      if (duplicate[0]) return Response.json({ error: "Já existe uma frente com este nome." }, { status: 409 });
    }
    const [updated] = await db
      .update(serviceFronts)
      .set({
        name,
        location: body.location === undefined ? existing.location : clean(body.location) || null,
        active: body.active === undefined ? existing.active : Boolean(body.active),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(serviceFronts.id, id))
      .returning();
    // Desativar uma frente nunca apaga histórico — equipamentos, usuários e registros antigos
    // continuam apontando para o id normalmente; ela só some dos selects de novos cadastros
    // (activeServiceFronts filtra active=1) e da lista de "frentes ativas" no formulário de usuário.
    return Response.json({ front: updated });
  } catch (error) {
    console.error("[service-fronts.put]", error);
    return Response.json({ error: "Não foi possível atualizar a frente agora." }, { status: 500 });
  }
}
